import { expect, test } from 'bun:test';
import type { Db } from 'mongodb';
import { s } from '../src/schema/index.ts';
import { makeSchemaOps } from '../src/service/schema-ops.ts';
import { noopLogger } from './helpers.ts';

test('createSchema never drops a collection after an index failure', async () => {
  let drops = 0;
  const handle = {
    listIndexes: () => ({ toArray: async () => [] }),
    createIndex: async () => {
      throw Object.assign(new Error('index conflict'), { code: 85 });
    },
  };
  const client = {
    createCollection: async () => ({}),
    collection: () => handle,
    dropCollection: async () => {
      drops++;
    },
  } as unknown as Db;
  const ops = makeSchemaOps(client, noopLogger, {
    resolveCollectionName: (name) => name,
    getDefinition: () => ({
      schema: s.object({ name: s.string() }),
      indexes: [{ key: { name: 1 }, options: { name: 'conflict' } }],
    }),
  });

  await expect(ops.createSchema('items')).rejects.toThrow(/Cannot apply declared index/);
  expect(drops).toBe(0);
});
