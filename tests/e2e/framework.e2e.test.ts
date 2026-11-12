import { afterEach, beforeEach, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ObjectId } from 'mongodb';
import {
  belongsTo,
  createMongoMigrationRunner,
  createMongoService,
  createRepository,
  DomainError,
  encodeCursor,
  probeMongoCapabilities,
  s,
} from '../../src/index.ts';
import { MONGO_URL, maybeDescribe, noopLogger, probe } from '../helpers.ts';

const available = await probe();
if (!available && process.env.E2E_REQUIRED === '1') {
  throw new Error(`E2E tests require MongoDB at ${MONGO_URL}`);
}
const maybe = maybeDescribe(available);
const DB_NAME = 'ninox_public_api_e2e';
const SECONDARY_DB_NAME = 'ninox_public_api_e2e_secondary';
const DEFAULT_ACTOR_ID = new ObjectId();
const hookEvents: string[] = [];

const users = {
  schema: s.object({
    _id: s.objectId(),
    email: s.string({ format: 'email' }),
    name: s.string().optional(),
    role: s.enum(['admin', 'user'] as const),
    createdBy: s.objectId().default(DEFAULT_ACTOR_ID),
    createdAt: s.date().optional(),
    updatedAt: s.date().optional(),
    deletedAt: s.date().optional(),
    __v: s.integer().optional(),
  }),
  indexes: [{ key: { email: 1 as const }, options: { unique: true } }],
  timestamps: true,
  hooks: {
    beforeCreate: () => {
      hookEvents.push('beforeCreate');
    },
    afterCreate: () => {
      hookEvents.push('afterCreate');
    },
  },
};

const posts = s.object({
  _id: s.objectId(),
  authorId: s.objectId(),
  title: s.string(),
  views: s.integer().default(0),
});

const makeService = () =>
  createMongoService(
    {
      primary: { name: DB_NAME, dbUrl: MONGO_URL, collections: { users, posts } },
      secondary: {
        name: SECONDARY_DB_NAME,
        dbUrl: MONGO_URL,
        collections: { users, posts },
      },
    },
    { logger: noopLogger, cache: { clone: true, ttlMs: 5_000 } },
  );

maybe('public API end-to-end workflows', () => {
  let service: ReturnType<typeof makeService>;
  let db: ReturnType<typeof makeService>['db']['primaryClient'];
  let secondary: ReturnType<typeof makeService>['db']['secondaryClient'];

  beforeEach(async () => {
    hookEvents.length = 0;
    service = makeService();
    await service.makeConnections();
    db = service.db.primaryClient;
    secondary = service.db.secondaryClient;
    await Promise.all([db.client.dropDatabase(), secondary.client.dropDatabase()]);
    for (const manager of [db, secondary]) {
      await manager.createSchema('users');
      await manager.createSchema('posts');
    }
  });

  afterEach(async () => {
    await Promise.all([db.client.dropDatabase(), secondary.client.dropDatabase()]);
    await service.closeConnections();
  });

  test('schema, repository, defaults, timestamps, hooks, and typed errors work together', async () => {
    const repository = createRepository(db, 'users');
    const created = await repository.create({ email: 'ada@example.com', role: 'admin' });
    const user = await repository.getById(created.insertedId);

    expect(user?.email).toBe('ada@example.com');
    expect(user?.createdBy).toBeInstanceOf(ObjectId);
    expect(user?.createdBy?.toHexString()).toBe(DEFAULT_ACTOR_ID.toHexString());
    expect(user?.createdAt).toBeInstanceOf(Date);
    expect(user?.updatedAt).toBeInstanceOf(Date);
    expect(hookEvents).toEqual(['beforeCreate', 'afterCreate']);

    await expect(
      repository.create({ email: 'ada@example.com', role: 'user' }),
    ).rejects.toMatchObject({ code: 'DUPLICATE_KEY', statusCode: 409 });
    await expect(
      repository.create({ email: 'bad@example.com', role: 'invalid' } as never),
    ).rejects.toMatchObject({ code: 'VALIDATION_FAILED', statusCode: 422 });
    await expect(repository.findOneOrFail({ email: 'missing@example.com' })).rejects.toBeInstanceOf(
      DomainError,
    );
    await expect(repository.create({ email: 'not-an-email', role: 'user' })).rejects.toMatchObject({
      code: 'VALIDATION_FAILED',
    });
  });

  test('query builder, relations, aggregation, and offset pagination compose', async () => {
    const { insertedId: authorId } = await db.insertOne('users', {
      email: 'author@example.com',
      role: 'user',
    });
    await db.insertMany('posts', [
      { authorId, title: 'First', views: 4 },
      { authorId, title: 'Second', views: 8 },
      { authorId, title: 'Third', views: 12 },
    ]);

    const selected = await db
      .query('posts')
      .where({ authorId })
      .where({ views: { $gte: 8 } })
      .sort({ views: -1 })
      .select(['_id', 'title', 'views'])
      .many();
    expect(selected.map((post) => post.title)).toEqual(['Third', 'Second']);

    const [populated] = await db.populate(await db.findMany('posts', { title: 'First' }), [
      belongsTo({ collection: 'users', localField: 'authorId', as: 'author' }),
    ]);
    expect(populated?.author?.email).toBe('author@example.com');

    const grouped = await db
      .pipeline('posts')
      .match({ authorId })
      .group({ _id: '$authorId', views: { $sum: '$views' } })
      .toArray();
    expect(grouped).toEqual([{ _id: authorId, views: 24 }]);

    const page = await db.paginateFlexible(
      'posts',
      { authorId },
      { page: 2, limit: 1, sort: { views: 1 } },
    );
    expect(page.totalCount).toBe(3);
    expect(page.totalPages).toBe(3);
    expect(page.data[0]?.title).toBe('Second');
    await expect(db.paginateFlexible('posts', {}, { page: 10_002, limit: 1 })).rejects.toThrow(
      /maxOffset/,
    );
    await expect(db.paginateCursor('posts', {}, { sort: { title: 1 } })).rejects.toThrow(
      /unique tiebreaker/,
    );
  });

  test('cache writes, optimistic locking, and soft deletes preserve read consistency', async () => {
    const { insertedId } = await db.insertOne('users', {
      email: 'cache@example.com',
      role: 'user',
    });
    expect((await db.getOne('users', { _id: insertedId }))?.role).toBe('user');

    const cached = await db.getOne('users', { _id: insertedId });
    if (cached) cached.email = 'mutated@example.com';
    expect((await db.getOne('users', { _id: insertedId }))?.email).toBe('cache@example.com');

    await db.updateOne('users', { _id: insertedId }, { $set: { role: 'admin' } });
    expect((await db.getOne('users', { _id: insertedId }))?.role).toBe('admin');

    const versioned = await db.updateWithVersion(
      'users',
      { _id: insertedId },
      { $set: { name: 'Versioned' } },
    );
    expect(versioned.ok).toBe(true);
    if (versioned.ok) expect(versioned.doc.__v).toBe(1);

    await db.softDeleteOne('users', { _id: insertedId });
    expect(await db.findActiveOne('users', { _id: insertedId })).toBeNull();
    expect((await db.getOne('users', { _id: insertedId }))?.deletedAt).toBeInstanceOf(Date);
  });

  test('keyset pagination walks forward and backward without gaps or duplicates', async () => {
    const { insertedId: authorId } = await db.insertOne('users', {
      email: 'pages@example.com',
      role: 'user',
    });
    await db.insertMany(
      'posts',
      ['A', 'B', 'C', 'D', 'E'].map((title) => ({ authorId, title })),
    );
    const sort = { _id: 1 } as const;
    const ids = (rows: Array<{ _id: ObjectId }>) => rows.map((row) => row._id.toHexString());

    const first = await db.paginateCursor('posts', {}, { sort, limit: 2 });
    const second = await db.paginateCursor(
      'posts',
      {},
      {
        sort,
        limit: 2,
        after: first.nextCursor!,
      },
    );
    const third = await db.paginateCursor(
      'posts',
      {},
      {
        sort,
        limit: 2,
        after: second.nextCursor!,
      },
    );
    expect(third.data).toHaveLength(1);

    const thirdStart = encodeCursor({ sort, values: [third.data[0]!._id] });
    const backToSecond = await db.paginateCursor(
      'posts',
      {},
      {
        sort,
        limit: 2,
        before: thirdStart,
      },
    );
    expect(ids(backToSecond.data)).toEqual(ids(second.data));
    expect(backToSecond.hasMore).toBe(true);

    const backToFirst = await db.paginateCursor(
      'posts',
      {},
      {
        sort,
        limit: 2,
        before: backToSecond.nextCursor!,
      },
    );
    expect(ids(backToFirst.data)).toEqual(ids(first.data));
    expect(backToFirst.hasMore).toBe(false);
  });

  test('file migrations apply, report status, and roll back through the public toolkit API', async () => {
    const migrationDir = await mkdtemp(join(tmpdir(), 'ninox-e2e-migrations-'));
    try {
      const runner = createMongoMigrationRunner(service, { migrationDir });
      const file = await runner.create('seed_e2e_user');
      await Bun.write(
        file,
        `export const up = async ({ service }) => {
          await service.db.primaryClient.insertOne('users', {
            email: 'migration@example.com', role: 'user'
          });
        };
        export const down = async ({ service }) => {
          await service.db.primaryClient.deleteOne('users', { email: 'migration@example.com' });
        };
        `,
      );

      await runner.up();
      await runner.up();
      expect(await db.countDocuments('users', { email: 'migration@example.com' })).toBe(1);
      expect(await runner.status()).toEqual({ applied: ['001_seed_e2e_user'], pending: [] });

      await runner.down('001_seed_e2e_user');
      expect(await db.countDocuments('users', { email: 'migration@example.com' })).toBe(0);
      expect(await runner.status()).toEqual({ applied: [], pending: ['001_seed_e2e_user'] });
    } finally {
      await rm(migrationDir, { recursive: true, force: true });
    }
  });

  test('manager migrations execute once under concurrent standalone claims', async () => {
    const capabilities = await probeMongoCapabilities(db.client);
    if (capabilities.transactionsSupported) return;

    let executions = 0;
    await Promise.all(
      Array.from({ length: 8 }, () =>
        db.migrate(
          'concurrent_e2e',
          async (session) => {
            executions++;
            await db.insertOne(
              'users',
              { email: 'concurrent-migration@example.com', role: 'user' },
              { ...(session ? { session } : {}) },
            );
          },
          undefined,
          { allowNonTransactionalFallback: true },
        ),
      ),
    );
    expect(executions).toBe(1);
    expect(await db.countDocuments('users', { email: 'concurrent-migration@example.com' })).toBe(1);
  });

  test('transactions commit and roll back on replica sets, or explicitly fall back on standalone', async () => {
    const capabilities = await probeMongoCapabilities(db.client);
    expect(capabilities.probed).toBe(true);

    if (capabilities.transactionsSupported) {
      await expect(
        db.transaction(async (session) => {
          await db.insertOne(
            'users',
            { email: 'rollback@example.com', role: 'user' },
            { session: session! },
          );
          throw new Error('force rollback');
        }),
      ).rejects.toThrow('force rollback');
      expect(
        await db.countDocuments('users', { email: 'rollback@example.com' }, { cache: false }),
      ).toBe(0);

      await db.transaction(async (session) => {
        await db.insertOne(
          'users',
          { email: 'commit@example.com', role: 'user' },
          { session: session! },
        );
      });
      expect(await db.countDocuments('users', { email: 'commit@example.com' })).toBe(1);
    } else {
      let attempts = 0;
      await expect(
        db.transaction(async (session) => {
          attempts++;
          await db.insertOne(
            'users',
            { email: 'rejected@example.com', role: 'user' },
            { session: session! },
          );
        }),
      ).rejects.toMatchObject({ code: 'TRANSACTIONS_UNSUPPORTED' });
      expect(attempts).toBe(1);
      expect(await db.countDocuments('users', { email: 'rejected@example.com' })).toBe(0);

      let fallbackSession: unknown = 'not called';
      await db.transaction(
        async (session) => {
          fallbackSession = session;
          await db.insertOne(
            'users',
            { email: 'fallback@example.com', role: 'user' },
            { ...(session !== null ? { session } : {}) },
          );
        },
        { allowNonTransactionalFallback: true },
      );
      expect(fallbackSession).toBeNull();
      expect(await db.countDocuments('users', { email: 'fallback@example.com' })).toBe(1);
    }
  });

  test('multi-database managers, health checks, and shutdown use real connections', async () => {
    await db.insertOne('users', { email: 'shared@example.com', role: 'admin' });
    await secondary.insertOne('users', { email: 'shared@example.com', role: 'user' });

    expect((await db.getOne('users', { email: 'shared@example.com' }))?.role).toBe('admin');
    expect((await secondary.getOne('users', { email: 'shared@example.com' }))?.role).toBe('user');

    const health = await service.health();
    expect(health.ok).toBe(true);
    expect(health.dbs.map((result) => result.name).sort()).toEqual(['primary', 'secondary']);
    const managers = await service.eachDb(async (manager) => manager);
    expect(managers).toHaveLength(2);

    await Promise.all([service.makeConnections(), service.makeConnections()]);
    await service.closeConnections();
    expect(service.db.primaryClient).toBeUndefined();
    expect((await service.health()).ok).toBe(false);

    await service.makeConnections();
    db = service.db.primaryClient;
    secondary = service.db.secondaryClient;
    expect((await db.getOne('users', { email: 'shared@example.com' }))?.role).toBe('admin');
    expect((await secondary.getOne('users', { email: 'shared@example.com' }))?.role).toBe('user');
  });
});
