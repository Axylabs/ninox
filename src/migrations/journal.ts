import { randomUUID } from 'node:crypto';
import type { Document } from 'mongodb';
import { JOURNAL_COLLECTION, type JournalManager } from './types.ts';

export interface MigrationJournal {
  appliedNames(): Promise<Set<string>>;
  /** Returns a unique ownership token only to the runner that won the claim. */
  claim(name: string, file: string, leaseMs: number): Promise<string | null>;
  /** Claim an applied migration for rollback without allowing `up()` to rerun it. */
  claimRollback(name: string, file: string, leaseMs: number): Promise<string | null>;
  renew(name: string, claimId: string, leaseMs: number): Promise<void>;
  markApplied(name: string, claimId: string): Promise<void>;
  removeRunning(name: string, claimId: string): Promise<void>;
  unrecord(name: string, claimId: string): Promise<void>;
}

const isDuplicateKeyError = (err: unknown): boolean => {
  const code = (err as { code?: number } | null)?.code;
  if (code === 11000 || code === 11001) return true;
  return /E11000 duplicate key/.test(String((err as Error | null)?.message ?? ''));
};

const expiredLeaseFilter = (now: Date, staleCutoff: Date): Document => ({
  $or: [
    { expiresAt: { $lt: now } },
    { expiresAt: { $exists: false }, appliedAt: { $lt: staleCutoff } },
  ],
});

/** Build the journal operations over a `JournalManager` (a connected manager). */
export const createMigrationJournal = (manager: JournalManager): MigrationJournal => {
  let indexReady = false;
  const ensureIndex = async (): Promise<void> => {
    if (indexReady) return;
    // Without uniqueness, concurrent fresh claims are not safe. Real managers
    // always implement createIndex; the optional branch supports tiny test doubles.
    if (manager.createIndex) {
      await manager.createIndex(JOURNAL_COLLECTION, { name: 1 }, { unique: true });
    }
    indexReady = true;
  };

  const appliedNames = async (): Promise<Set<string>> => {
    const rows = await manager.findMany(JOURNAL_COLLECTION, {}, { cache: false });
    return new Set(
      rows
        .filter(
          (row) =>
            row.status === undefined || row.status === 'applied' || row.status === 'rolling_back',
        )
        .map((row) => row.name as string),
    );
  };

  const claim = async (name: string, file: string, leaseMs: number): Promise<string | null> => {
    await ensureIndex();
    const now = new Date();
    const staleCutoff = new Date(Date.now() - leaseMs);
    const claimId = randomUUID();
    const stole = await manager.findOneAndUpdate(
      JOURNAL_COLLECTION,
      {
        name,
        status: { $nin: ['applied', 'rolling_back'] },
        ...expiredLeaseFilter(now, staleCutoff),
      },
      {
        $set: {
          status: 'running',
          appliedAt: now,
          file,
          expiresAt: new Date(Date.now() + leaseMs),
          claimId,
        },
      },
      { returnDocument: 'before', cache: false },
    );
    if (stole !== null) return claimId;

    try {
      await manager.insertOne(JOURNAL_COLLECTION, {
        name,
        appliedAt: now,
        status: 'running',
        file,
        expiresAt: new Date(Date.now() + leaseMs),
        claimId,
      });
      return claimId;
    } catch (err) {
      if (isDuplicateKeyError(err)) return null;
      throw err;
    }
  };

  const claimRollback = async (
    name: string,
    file: string,
    leaseMs: number,
  ): Promise<string | null> => {
    await ensureIndex();
    const now = new Date();
    const claimId = randomUUID();
    const claimed = await manager.findOneAndUpdate(
      JOURNAL_COLLECTION,
      {
        name,
        $or: [
          { status: 'applied' },
          { status: 'rolling_back', ...expiredLeaseFilter(now, new Date(Date.now() - leaseMs)) },
        ],
      },
      {
        $set: {
          status: 'rolling_back',
          file,
          claimId,
          expiresAt: new Date(Date.now() + leaseMs),
        },
      },
      { returnDocument: 'before', cache: false },
    );
    return claimed === null ? null : claimId;
  };

  const renew = async (name: string, claimId: string, leaseMs: number): Promise<void> => {
    await manager.updateOne(
      JOURNAL_COLLECTION,
      { name, claimId, status: { $in: ['running', 'rolling_back'] } },
      { $set: { expiresAt: new Date(Date.now() + leaseMs) } },
      { cache: false },
    );
  };

  const markApplied = async (name: string, claimId: string): Promise<void> => {
    const res = await manager.updateOne(
      JOURNAL_COLLECTION,
      { name, claimId, status: 'running' },
      { $set: { status: 'applied' }, $unset: { expiresAt: '', claimId: '' } },
      { cache: false },
    );
    if ((res as { matchedCount?: number })?.matchedCount === 0) {
      // Restore a journal row only when no successor claimed the name. Either
      // way, report lost ownership so the operator can inspect the migration.
      await manager
        .insertOne(JOURNAL_COLLECTION, { name, appliedAt: new Date(), status: 'applied' })
        .catch(() => {});
      throw new Error(`Migration "${name}" lost its claim before it could be marked applied`);
    }
  };

  const removeRunning = async (name: string, claimId: string): Promise<void> => {
    await manager
      .deleteOne(JOURNAL_COLLECTION, { name, claimId, status: 'running' }, { cache: false })
      .catch(() => {});
  };

  const unrecord = async (name: string, claimId: string): Promise<void> => {
    const result = await manager.deleteOne(
      JOURNAL_COLLECTION,
      { name, claimId, status: 'rolling_back' },
      { cache: false },
    );
    if ((result as { deletedCount?: number })?.deletedCount === 0) {
      throw new Error(`Migration "${name}" lost its rollback claim`);
    }
  };

  return { appliedNames, claim, claimRollback, renew, markApplied, removeRunning, unrecord };
};
