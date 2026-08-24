/**
 * The `_migrations` journal — lease-based bookkeeping so concurrent runners
 * can't apply the same migration twice:
 *
 *   - `claim` atomically inserts a fresh `running` row carrying a LEASE
 *     (`expiresAt`). An existing row is only stolen when its lease has
 *     expired (hard-crash recovery) and NEVER when `status: 'applied'`.
 *     A unique index on `name` arbitrates concurrent inserts.
 *   - `renew` extends the lease while a long `up()` is still running, so a
 *     slow backfill can't be stolen out from under a live runner.
 *   - `markApplied` flips `status` AFTER `up()` succeeds; if the running row
 *     vanished concurrently it re-inserts an `applied` row so the migration
 *     is never silently re-applied on the next run.
 *
 * All operations are best-effort where losing a race is harmless.
 */
import type { Document } from 'mongodb';
import { JOURNAL_COLLECTION, type JournalManager } from './types.ts';

export interface MigrationJournal {
  /** Names considered applied (status `applied` or legacy rows with no status). */
  appliedNames(): Promise<Set<string>>;
  /**
   * Atomically claim a migration under a lease of `leaseMs`. Returns true only
   * for the winning runner: fresh insert, or steal of an EXPIRED non-applied
   * row. Live claims held by other runners are never stolen.
   */
  claim(name: string, file: string, leaseMs: number): Promise<boolean>;
  /** Extend the lease of a still-running claim (heartbeat during long `up()`s). */
  renew(name: string, leaseMs: number): Promise<void>;
  /** Flip a claimed migration to `applied` (after `up()` succeeded). */
  markApplied(name: string): Promise<void>;
  /** Remove a `running` row (on failure, so the migration can be re-run). */
  removeRunning(name: string): Promise<void>;
  /** Delete a migration's journal row (rollback). */
  unrecord(name: string): Promise<void>;
}

const isDuplicateKeyError = (err: unknown): boolean => {
  const code = (err as { code?: number } | null)?.code;
  if (code === 11000 || code === 11001) return true;
  return /E11000 duplicate key/.test(String((err as Error | null)?.message ?? ''));
};

/** Build the journal operations over a `JournalManager` (a connected manager). */
export const createMigrationJournal = (manager: JournalManager): MigrationJournal => {
  // Idempotent uniqueness guard: two runners racing `claim` must not both be
  // able to INSERT a fresh row. Created lazily once per journal instance;
  // failure is tolerated (single-runner setups still work).
  let indexReady = false;
  const ensureIndex = async (): Promise<void> => {
    if (indexReady) return;
    try {
      await manager.createIndex?.(JOURNAL_COLLECTION, { name: 1 }, { unique: true });
    } catch {
      // Best-effort: managers without createIndex (or a failed creation)
      // still work single-runner.
    }
    indexReady = true;
  };

  const appliedNames = async (): Promise<Set<string>> => {
    const rows = await manager.findMany(JOURNAL_COLLECTION);
    return new Set(
      rows
        // `status` is absent on legacy (pre-status) rows — treat those as applied.
        .filter((row) => row.status === undefined || row.status === 'applied')
        .map((row) => row.name as string),
    );
  };

  /**
   * Rows another runner may take over: an unapplied row whose lease expired,
   * or any legacy/corrupt row without `status: 'running'|'applied'`.
   * (`$ne`/`$nin` match missing fields in Mongo, so status-less legacy rows
   * land in the last branch.)
   */
  const stealableFilter = (name: string, now: Date, staleCutoff: Date): Document => ({
    name,
    status: { $ne: 'applied' },
    $or: [
      { expiresAt: { $lt: now } },
      { expiresAt: { $exists: false }, appliedAt: { $lt: staleCutoff } },
      { status: { $nin: ['running', 'applied'] } },
    ],
  });

  const claim = async (name: string, file: string, leaseMs: number): Promise<boolean> => {
    await ensureIndex();
    const now = new Date();
    const expiresAt = new Date(Date.now() + leaseMs);

    // Step 1 — steal an existing STEALABLE row (expired lease / legacy crash).
    const stole = await manager.findOneAndUpdate(
      JOURNAL_COLLECTION,
      stealableFilter(name, now, new Date(Date.now() - leaseMs)),
      { $set: { status: 'running', appliedAt: now, file, expiresAt } },
      { returnDocument: 'before' },
    );
    if (stole !== null) return true;

    // Step 2 — either the row exists but is NOT stealable (applied, or a live
    // claim), or it doesn't exist yet. Try a fresh insert; the unique index
    // decides who wins a concurrent race.
    try {
      await manager.insertOne(JOURNAL_COLLECTION, {
        name,
        appliedAt: now,
        status: 'running',
        file,
        expiresAt,
      });
      return true;
    } catch (err) {
      if (isDuplicateKeyError(err)) return false;
      throw err;
    }
  };

  const renew = async (name: string, leaseMs: number): Promise<void> => {
    await manager.updateOne(
      JOURNAL_COLLECTION,
      { name, status: 'running' },
      { $set: { expiresAt: new Date(Date.now() + leaseMs) } },
    );
  };

  const markApplied = async (name: string): Promise<void> => {
    const res = (await manager.updateOne(
      JOURNAL_COLLECTION,
      { name, status: 'running' },
      { $set: { status: 'applied' } },
    )) as { matchedCount?: number } | unknown | null;
    // updateOne RESOLVES (never rejects) on zero matches — if the running row
    // was removed concurrently we MUST restore an applied row, otherwise the
    // next `up()` re-runs an already-applied migration.
    if ((res as { matchedCount?: number })?.matchedCount === 0) {
      await manager
        .insertOne(JOURNAL_COLLECTION, { name, appliedAt: new Date(), status: 'applied' })
        .catch(() => {});
    }
  };

  const removeRunning = async (name: string): Promise<void> => {
    await manager.deleteOne(JOURNAL_COLLECTION, { name, status: 'running' }).catch(() => {});
  };

  const unrecord = async (name: string): Promise<void> => {
    await manager.deleteOne(JOURNAL_COLLECTION, { name });
  };

  return { appliedNames, claim, renew, markApplied, removeRunning, unrecord };
};
