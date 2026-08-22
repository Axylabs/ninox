/**
 * Smoke demo for ninox.
 *
 * Run against a local MongoDB (see .env) with:
 *   bun run index.ts
 *
 * Exercises: schema DSL → $jsonSchema validator, connection pooling, CRUD,
 * fluent query builder, $facet pagination, DataLoader relation population,
 * query cache + in-flight dedup, transactions.
 */
import {
  belongsTo,
  createMongoCapabilitiesStore,
  createMongoToolkit,
  defineCollection,
  defineCollections,
  type InferDoc,
  s,
  withGracefulMongoTransaction,
} from './src/index.ts';

const MONGO_URL = process.env.MONGO_URL ?? 'mongodb://admin:admin@localhost:27017/';

// Collection names live on the schemas themselves.
const userSchema = s.object(
  {
    _id: s.objectId(),
    email: s.string(),
    name: s.string().optional(),
    age: s.integer({ minimum: 0 }).optional(),
    role: s.enum(['admin', 'user', 'guest'] as const),
    createdAt: s.date(),
  },
  { name: 'users' },
);
type User = InferDoc<typeof userSchema>;

const orderSchema = s.object(
  {
    _id: s.objectId(),
    userId: s.objectId(),
    total: s.number({ minimum: 0 }),
    status: s.enum(['pending', 'paid', 'shipped'] as const),
  },
  { name: 'orders' },
);
type Order = InferDoc<typeof orderSchema>;

// `defineCollection` attaches a name + indexes; `defineCollections` derives the
// keyed map. The toolkit options just tune the default cache (perf is on by
// default).
const toolkit = createMongoToolkit(
  {
    primary: {
      name: 'ninox_orm_demo',
      dbUrl: MONGO_URL,
      collections: defineCollections(
        defineCollection('users', userSchema, {
          indexes: [{ key: { email: 1 }, options: { unique: true } }],
        }),
        orderSchema,
      ),
    },
  },
  {
    logger: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} },
    // Query cache + in-flight dedup are ON by default; `cache` accepts options.
    cache: { maxSize: 100 },
  },
);

const { service } = toolkit;
const caps = createMongoCapabilitiesStore();

const run = async (): Promise<void> => {
  // 1) Open connections + build managers; provision collections with validators.
  await service.makeConnections();
  const users = service.db.primaryClient;

  await users.client.dropCollection('users').catch(() => {});
  await users.client.dropCollection('orders').catch(() => {});
  await users.createSchema('users');
  await users.createSchema('orders');

  // 2) CRUD + optimistic locking.
  const created = await users.insertOne('users', {
    email: 'ada@example.com',
    name: 'Ada Lovelace',
    role: 'admin',
    createdAt: new Date(),
  });
  const userId = created.insertedId;

  await users.insertMany('orders', [
    { userId, total: 199.99, status: 'paid' },
    { userId, total: 59.5, status: 'pending' },
  ]);

  const v1 = await users.updateWithVersion('users', { _id: userId }, { $set: { name: 'Ada' } });
  const v2 = await users.updateWithVersion('users', { _id: userId }, { $set: { name: 'Ada L.' } });
  console.log('versioned updates:', v1.ok, v2.ok);

  // 3) Fluent query builder (projection pushed to driver).
  const admins = await users
    .query('users')
    .where({ role: 'admin' })
    .select(['_id', 'email', 'name'])
    .limit(10)
    .many();
  console.log(
    'query builder ->',
    admins.map((u) => (u as User).email),
  );

  // 4) $facet pagination (one round trip).
  const page = await users.paginateFlexible(
    'orders',
    { userId },
    { page: 1, limit: 1, sort: { total: -1 } },
  );
  console.log('pagination ->', {
    total: page.totalCount,
    pages: page.totalPages,
    data: page.data.length,
  });

  // 5) DataLoader relation population (batched $in, no N+1).
  const orders = await users.findMany('orders', { userId });
  const populated = await users.populate(orders, [
    belongsTo({ collection: 'users', localField: 'userId', as: 'customer' }),
  ]);
  console.log('populated customer ->', populated[0]?.customer?.email);

  // 6) Query cache: warm the cache, then a cache hit performs zero driver calls.
  await users.findMany('users', { role: 'admin' });
  const cached = await users.findMany('users', { role: 'admin' });
  console.log('cached rows ->', cached.length);

  // 7) In-flight dedup: many identical concurrent reads → one driver call.
  const deduped = await Promise.all([
    users.countDocuments('orders', { status: 'paid' }),
    users.countDocuments('orders', { status: 'paid' }),
    users.countDocuments('orders', { status: 'paid' }),
  ]);
  console.log('deduped counts ->', deduped);

  // 8) Graceful transaction (falls back to non-transactional on standalone).
  await withGracefulMongoTransaction(
    { transaction: users.transaction },
    async (session) => {
      await users.insertOne(
        'orders',
        { userId, total: 9.99, status: 'pending' },
        { ...(session != null ? { session } : {}) },
      );
    },
    { capabilities: caps, urlHint: MONGO_URL },
  );

  const total = await users.countDocuments('orders', {});
  console.log('final order count ->', total);

  // Brief drain lets the driver finish any in-flight connection setup before the
  // pool closes (avoids a noisy PoolClosedError on shutdown).
  await new Promise((resolve) => setTimeout(resolve, 50));
  await service.closeConnections();
  console.log('✅ demo complete');
};

run().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
