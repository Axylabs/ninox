import { describe, expect, test } from 'bun:test';
import type { Document } from 'mongodb';
import { createMigrationJournal } from '../src/migrations/journal.ts';
import type { JournalManager } from '../src/migrations/types.ts';

const matches = (doc: Document, filter: Document): boolean => {
  for (const [key, expected] of Object.entries(filter)) {
    if (key === '$or') {
      if (!(expected as Document[]).some((branch) => matches(doc, branch))) return false;
      continue;
    }
    const actual = doc[key];
    if (expected !== null && typeof expected === 'object' && !Array.isArray(expected)) {
      const operator = expected as Document;
      if ('$nin' in operator && (operator.$nin as unknown[]).includes(actual)) return false;
      if ('$in' in operator && !(operator.$in as unknown[]).includes(actual)) return false;
      if ('$lt' in operator && !(actual < operator.$lt)) return false;
      if ('$exists' in operator && (actual !== undefined) !== operator.$exists) return false;
      continue;
    }
    if (actual !== expected) return false;
  }
  return true;
};

const makeManager = (failIndex = false) => {
  const docs: Document[] = [];
  const applyUpdate = (doc: Document, update: Document) => {
    Object.assign(doc, update.$set ?? {});
    for (const key of Object.keys(update.$unset ?? {})) delete doc[key];
  };
  const manager: JournalManager = {
    createIndex: async () => {
      if (failIndex) throw new Error('index permission denied');
    },
    findMany: async (_collection, filter = {}) => docs.filter((doc) => matches(doc, filter)),
    findOneAndUpdate: async (_collection, filter, update) => {
      const doc = docs.find((candidate) => matches(candidate, filter));
      if (!doc) return null;
      const before = { ...doc };
      applyUpdate(doc, update);
      return before;
    },
    insertOne: async (_collection, doc) => {
      if (docs.some((existing) => existing.name === doc.name)) {
        throw new Error('E11000 duplicate key');
      }
      docs.push({ ...doc });
    },
    updateOne: async (_collection, filter, update) => {
      const doc = docs.find((candidate) => matches(candidate, filter));
      if (!doc) return { matchedCount: 0 };
      applyUpdate(doc, update);
      return { matchedCount: 1 };
    },
    deleteOne: async (_collection, filter) => {
      const index = docs.findIndex((candidate) => matches(candidate, filter));
      if (index < 0) return { deletedCount: 0 };
      docs.splice(index, 1);
      return { deletedCount: 1 };
    },
    deleteMany: async () => ({}),
  };
  return { manager, docs };
};

describe('migration journal fencing', () => {
  test('a stale worker cannot renew, finish, or remove a stolen up claim', async () => {
    const { manager, docs } = makeManager();
    const journal = createMigrationJournal(manager);
    const first = await journal.claim('001_users', '001_users.ts', 10);
    expect(first).toBeString();
    await Bun.sleep(15);
    const second = await journal.claim('001_users', '001_users.ts', 60_000);
    expect(second).toBeString();
    expect(second).not.toBe(first);

    const oldExpiry = docs[0]!.expiresAt as Date;
    await journal.renew('001_users', first!, 60_000);
    expect(docs[0]!.expiresAt).toBe(oldExpiry);
    await expect(journal.markApplied('001_users', first!)).rejects.toThrow(/lost its claim/);
    await journal.removeRunning('001_users', first!);
    expect(docs[0]!.claimId).toBe(second);

    await journal.markApplied('001_users', second!);
    expect(docs[0]!.status).toBe('applied');
  });

  test('rollback claims are exclusive and fenced after takeover', async () => {
    const { manager, docs } = makeManager();
    const journal = createMigrationJournal(manager);
    const upClaim = await journal.claim('001_users', '001_users.ts', 60_000);
    await journal.markApplied('001_users', upClaim!);

    const first = await journal.claimRollback('001_users', '001_users.ts', 10);
    expect(first).toBeString();
    expect(await journal.claimRollback('001_users', '001_users.ts', 10)).toBeNull();
    expect(await journal.claim('001_users', '001_users.ts', 10)).toBeNull();
    expect(await journal.appliedNames()).toEqual(new Set(['001_users']));

    await Bun.sleep(15);
    const second = await journal.claimRollback('001_users', '001_users.ts', 60_000);
    expect(second).not.toBe(first);
    await expect(journal.unrecord('001_users', first!)).rejects.toThrow(/lost its rollback claim/);
    expect(docs).toHaveLength(1);
    await journal.unrecord('001_users', second!);
    expect(docs).toHaveLength(0);
  });

  test('claiming fails closed when the unique index cannot be created', async () => {
    const { manager } = makeManager(true);
    await expect(
      createMigrationJournal(manager).claim('001_users', '001_users.ts', 1000),
    ).rejects.toThrow('index permission denied');
  });
});
