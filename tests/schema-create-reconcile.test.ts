/**
 * `createSchema` is IDEMPOTENT and SELF-RECONCILING — the behavior an app
 * needs when it provisions collections on every boot:
 *
 *  1. A NEW collection is created with its `$jsonSchema` validator + declared
 *     indexes (unchanged behavior).
 *  2. Re-running `createSchema` on an EXISTING collection no longer throws
 *     `COLLECTION_EXISTS` — it is a no-op when the schema is unchanged.
 *  3. When the app schema CHANGED between boots, re-running `createSchema`
 *     hot-swaps the DB validator (`collMod`) to the current schema, so Mongo
 *     validation follows the app.
 *  4. Newly-declared indexes are created additively on re-run; undeclared
 *     (other-service) indexes are NOT dropped automatically (that stays the
 *     explicit job of `syncIndexes`).
 */
import { afterAll, expect, test } from 'bun:test';
import type { Db, Document } from 'mongodb';
import type { ObjectField } from '../src/schema/index.ts';
import { defineCollection, defineCollections, s } from '../src/schema/index.ts';
import { createMongoService } from '../src/service/index.ts';
import type { LoggerLike } from '../src/utils/logger.ts';
import { maybeDescribe, probe } from './helpers.ts';

const maybe = maybeDescribe(await probe());

const noopLogger: LoggerLike = { debug() {}, info() {}, warn() {}, error() {} };

/** The ORM surface a test needs (cast — type inference is not the point here). */
interface Mgr {
  client: Db;
  createSchema: (collection: string) => Promise<void>;
  insertOne: (collection: string, doc: Document) => Promise<{ insertedId: unknown }>;
}

interface Booted {
  mgr: Mgr;
  close: () => Promise<void>;
}

interface DeclaredIndex {
  key: Record<string, 1 | -1>;
}

/** Boot a tiny service with a single `gadgets` collection against `dbName`. */
const bootService = async (
  dbName: string,
  schema: ObjectField,
  indexes?: DeclaredIndex[],
): Promise<Booted> => {
  const gadget = defineCollection('gadgets', schema, indexes !== undefined ? { indexes } : {});
  const service = createMongoService(
    {
      primary: {
        name: dbName,
        dbUrl: process.env.MONGO_URL ?? 'mongodb://admin:admin@localhost:27017/',
        collections: defineCollections(gadget),
      },
    },
    { logger: noopLogger },
  ) as unknown as {
    db: { primaryClient: Mgr };
    makeConnections: () => Promise<void>;
    closeConnections: () => Promise<void>;
  };
  await service.makeConnections();
  return {
    mgr: service.db.primaryClient,
    close: () => service.closeConnections(),
  };
};

/** The validator MongoDB currently has installed on `gadgets`. */
const installedValidator = async (db: Db): Promise<Document | undefined> => {
  const info = (await db.listCollections({ name: 'gadgets' }).next()) as
    | { options?: { validator?: Document } }
    | undefined;
  return info?.options?.validator;
};

const v1 = s.object({ _id: s.objectId(), label: s.string() }, { name: 'gadgets' });
const v2 = s.object(
  { _id: s.objectId(), label: s.string(), qty: s.integer() },
  { name: 'gadgets' },
);

maybe('createSchema is idempotent + reconciles', () => {
  const opened: Booted[] = [];

  afterAll(async () => {
    for (const { mgr, close } of opened) {
      await mgr.client.dropDatabase().catch(() => {});
      await close().catch(() => {});
    }
  });

  const boot = async (
    name: string,
    schema: ObjectField,
    indexes?: DeclaredIndex[],
  ): Promise<Booted> => {
    const b = await bootService(name, schema, indexes);
    opened.push(b);
    return b;
  };

  test('re-running createSchema on an existing collection does not throw and leaves the validator untouched', async () => {
    const { mgr } = await boot('ninox_create_reconcile_rerun', v1);
    await mgr.createSchema('gadgets');

    const before = await installedValidator(mgr.client);
    expect(before).toBeDefined();

    // Previously this threw `COLLECTION_EXISTS` — now it must reconcile (no-op).
    await expect(mgr.createSchema('gadgets')).resolves.toBeUndefined();

    const after = await installedValidator(mgr.client);
    expect(JSON.stringify(after)).toBe(JSON.stringify(before));
  });

  test('a changed app schema is hot-swapped onto the existing collection on the next boot', async () => {
    // Boot 1: old schema.
    const boot1 = await boot('ninox_create_reconcile_upgrade', v1);
    await boot1.mgr.createSchema('gadgets');
    await expect(boot1.mgr.insertOne('gadgets', { label: 'old-shape' })).resolves.toBeDefined();

    // Boot 2: app schema now requires `qty` — provisioning must upgrade Mongo.
    const boot2 = await boot('ninox_create_reconcile_upgrade', v2);
    await boot2.mgr.createSchema('gadgets');

    const validator = await installedValidator(boot2.mgr.client);
    expect((validator?.$jsonSchema as { required?: string[] } | undefined)?.required).toContain(
      'qty',
    );

    // Old-shape doc is now rejected by the (updated) DB validator...
    await expect(
      boot2.mgr.insertOne('gadgets', { label: 'still-old' } as never),
    ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });

    // ...and the new shape passes.
    await expect(
      boot2.mgr.insertOne('gadgets', { label: 'new-shape', qty: 1 } as never),
    ).resolves.toBeDefined();
  });

  test('newly-declared indexes are added on re-run; undeclared indexes are not dropped', async () => {
    const { mgr } = await boot('ninox_create_reconcile_indexes', v1);
    await mgr.createSchema('gadgets');

    // Simulate an index owned by another service / manual tooling.
    await mgr.client.collection('gadgets').createIndex({ extra: 1 });
    expect(
      (await mgr.client.collection('gadgets').indexes()).some((i) => i.name === 'extra_1'),
    ).toBe(true);

    // Next boot declares `label_1` — createSchema must add it without dropping `extra_1`.
    const boot2 = await boot('ninox_create_reconcile_indexes', v1, [{ key: { label: 1 } }]);
    await boot2.mgr.createSchema('gadgets');

    const names = (await boot2.mgr.client.collection('gadgets').indexes()).map((i) => i.name);
    expect(names).toContain('label_1');
    expect(names).toContain('extra_1'); // additive — untouched
  });
});
