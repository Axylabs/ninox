/**
 * `undefined`-value handling on writes (real MongoDB).
 *
 * TS signals "absent" with `undefined`, and spreads leave optional fields as
 * `undefined`. The driver serializes explicit `undefined` as `null`, which a
 * strict `$jsonSchema` validator rejects for string/date fields. The ORM must
 * strip `undefined` keys on insert/update/replace — never store `null`.
 */
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { defineCollection, defineCollections, s } from '../src/schema/index.ts';
import { createMongoService } from '../src/service/index.ts';
import { MONGO_URL, maybeDescribe, noopLogger, probe } from './helpers.ts';

const available = await probe();
const maybe = maybeDescribe(available);

const itemSchema = s.object({
  _id: s.objectId(),
  name: s.string(),
  note: s.string().optional(),
  meta: s.string().optional(),
  createdAt: s.date().optional(),
  updatedAt: s.date().optional(),
});
const items = defineCollection('items', itemSchema, { timestamps: true });

maybe('undefined-value stripping on writes (real MongoDB)', () => {
  const service = createMongoService(
    {
      primary: {
        name: 'ninox_omit_undefined_test',
        dbUrl: MONGO_URL,
        collections: defineCollections(items),
      },
    },
    { logger: noopLogger },
  );

  beforeAll(async () => {
    await service.makeConnections();
    const db = service.db.primaryClient;
    await db.createSchema('items');
    await db.deleteMany('items', {});
  });

  afterAll(async () => {
    await service.closeConnections();
  });

  test('insertOne with undefined optional fields stores them absent (not null)', async () => {
    const db = service.db.primaryClient;
    const { insertedId } = await db.insertOne(
      'items',
      { name: 'a', note: undefined, meta: 'present' } as never,
    );
    const row = (await db.getOne('items', { _id: insertedId })) as Record<string, unknown>;
    expect(row).not.toBeNull();
    expect(row.meta).toBe('present');
    expect(row.note).toBeUndefined();
  });

  test('insertMany strips undefined per doc', async () => {
    const db = service.db.primaryClient;
    await db.insertMany('items', [
      { name: 'b1', note: undefined } as never,
      { name: 'b2', meta: 'm2' } as never,
    ]);
    const rows = await db.findMany('items', { name: { $in: ['b1', 'b2'] } });
    expect(rows.length).toBe(2);
    expect((rows[0] as { note?: unknown }).note).toBeUndefined();
  });

  test('updateOne plain patch with undefined strips the key (no null)', async () => {
    const db = service.db.primaryClient;
    const { insertedId } = await db.insertOne('items', { name: 'c' } as never);
    await db.updateOne('items', { _id: insertedId }, { meta: undefined } as never);
    const row = (await db.getOne('items', { _id: insertedId })) as Record<string, unknown>;
    expect(row.meta).toBeUndefined();
  });

  test('updateOne $set operator with undefined strips the key inside $set', async () => {
    const db = service.db.primaryClient;
    const { insertedId } = await db.insertOne('items', { name: 'd', meta: 'old' } as never);
    await db.updateOne(
      'items',
      { _id: insertedId },
      { $set: { meta: 'new', note: undefined } } as never,
    );
    const row = (await db.getOne('items', { _id: insertedId })) as Record<string, unknown>;
    expect(row.meta).toBe('new');
    expect(row.note).toBeUndefined();
  });

  test('upsert with undefined in the update does not fail', async () => {
    const db = service.db.primaryClient;
    await db.upsert(
      'items',
      { name: 'e' },
      { $set: { meta: 'e-meta', note: undefined } } as never,
    );
    const row = (await db.getOne('items', { name: 'e' })) as Record<string, unknown>;
    expect(row.meta).toBe('e-meta');
  });
});
