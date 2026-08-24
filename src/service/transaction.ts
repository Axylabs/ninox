import type { ClientSession, Db, MongoClient, TransactionOptions } from 'mongodb';
import { isTransactionUnsupportedError, mapMongoDriverError } from '../errors/index.ts';
import type { LoggerLike } from '../utils/logger.ts';

export interface TransactionOpsOptions {
  migrationCollectionPhysical: string;
  /** Map driver errors to typed DomainError/InfraError before rethrowing. */
  wrapMongoErrors?: boolean;
}

/**
 * Transaction + idempotent-migration ops for one database handle.
 */
export const makeTransactionOps = (
  client: MongoClient,
  handle: Db,
  logger: LoggerLike,
  _config: Record<string, unknown>,
  opts: TransactionOpsOptions,
) => {
  let warnedUnsupported = false;
  let journalIndexReady = false;

  /** Migration claim lease in ms — mirrors `MongoMigrationRunnerOptions.leaseMs` default. */
  const MIGRATE_LEASE_MS = 120_000;

  /**
   * Run `fn(session)` inside a transaction. On standalone servers where
   * transactions are unsupported (error code 20 / message sniff), falls back
   * to running `fn(null)`. The fallback warning fires once per handle — not
   * per call.
   */
  const transaction = async <T>(
    fn: (session: ClientSession | null) => Promise<T>,
    options?: TransactionOptions,
  ): Promise<T> => {
    const session = client.startSession();
    try {
      return await session.withTransaction(async () => fn(session), options);
    } catch (err) {
      // Standalone (and deployments without retryable writes) can't run
      // transactions; fall back to running `fn(null)` non-transactionally.
      if (isTransactionUnsupportedError(err)) {
        if (!warnedUnsupported) {
          warnedUnsupported = true;
          logger.warn?.(
            { error: err instanceof Error ? err.message : String(err) },
            'transactions unsupported on this deployment, falling back to non-transactional',
          );
        }
        return fn(null);
      }
      if (opts.wrapMongoErrors) {
        throw mapMongoDriverError(err, { db: handle.databaseName, op: 'transaction' });
      }
      throw err;
    } finally {
      await session.endSession();
    }
  };

  /**
   * Idempotent migration claim — lease-based, mirroring `migrations/journal.ts`:
   *
   *   - A unique index on `name` (best-effort, created once per handle)
   *     arbitrates concurrent fresh claims.
   *   - An EXISTING row is only STOLEN when `status: 'running'` (or another
   *     non-applied marker) AND its lease has EXPIRED (hard-crash recovery).
   *     A LIVE claim held by another runner is never taken over — concurrent
   *     `migrate(name)` calls can no longer execute `fn` twice.
   *   - Legacy rows without `status` are treated as applied (never stolen).
   *   - On failure the claim is deleted so the migration can be retried; if
   *     the claim vanished mid-run, an `applied` row is restored instead of
   *     silently allowing a future re-run.
   */
  const migrate = async (
    name: string,
    fn: (session: ClientSession | null) => Promise<void>,
    filePath?: string,
  ): Promise<void> => {
    const journal = handle.collection<{
      name: string;
      appliedAt: Date;
      status?: string;
      file?: string;
      expiresAt?: Date;
    }>(opts.migrationCollectionPhysical);

    // createIndex can't run inside a transaction — do it before claiming.
    // Best-effort: single-runner setups still work without uniqueness.
    if (!journalIndexReady) {
      try {
        await journal.createIndex({ name: 1 }, { unique: true });
      } catch {
        /* restricted permissions or conflicting index — claim still works single-runner */
      }
      journalIndexReady = true;
    }

    const isDupKeyError = (err: unknown): boolean => {
      const code = (err as { code?: number } | null)?.code;
      if (code === 11000 || code === 11001) return true;
      return /E11000 duplicate key/.test(String((err as Error | null)?.message ?? ''));
    };

    await transaction(async (session) => {
      const sessionOpts = session ? { session } : {};
      const now = new Date();
      const expiresAt = new Date(Date.now() + MIGRATE_LEASE_MS);

      // Step 1 — steal an EXPIRED non-applied claim (crashed runner). Live
      // leases and applied/status-less (legacy) rows never match.
      const stole = (await journal.findOneAndUpdate(
        {
          name,
          status: { $exists: true, $nin: ['applied'] },
          $or: [
            { expiresAt: { $lt: now } },
            {
              expiresAt: { $exists: false },
              appliedAt: { $lt: new Date(now.getTime() - MIGRATE_LEASE_MS) },
            },
          ],
        },
        {
          $set: {
            status: 'running',
            appliedAt: now,
            expiresAt,
            ...(filePath ? { file: filePath } : {}),
          },
        },
        { returnDocument: 'before', ...sessionOpts },
      )) as Document | null;
      if (stole !== null) {
        await runClaimed(session);
        return;
      }

      // Step 2 — fresh claim; the unique index decides concurrent inserts.
      try {
        await journal.insertOne(
          {
            name,
            appliedAt: now,
            status: 'running',
            expiresAt,
            ...(filePath ? { file: filePath } : {}),
          },
          sessionOpts,
        );
      } catch (err) {
        if (!isDupKeyError(err)) throw err;
        // Lost the race: applied (or legacy) → done; live claim → skip.
        const existing = (await journal.findOne(
          { name },
          { projection: { status: 1 }, ...sessionOpts },
        )) as Document | null;
        const status = existing?.status;
        if (status === undefined || status === 'applied') {
          logger.info({ name }, 'migration already applied, skipping');
        } else {
          logger.warn({ name }, 'migration claim held by another runner, skipping');
        }
        return;
      }
      await runClaimed(session);
    });

    async function runClaimed(session: ClientSession | null): Promise<void> {
      const sessionOpts = session ? { session } : {};
      // Heartbeat extends the lease while a long `fn` runs — only possible in
      // fallback (non-transactional) mode: inside a transaction the row is
      // invisible/locked to outside updates until commit.
      const heartbeat =
        session === null
          ? setInterval(() => {
              void journal
                .updateOne(
                  { name, status: 'running' },
                  { $set: { expiresAt: new Date(Date.now() + MIGRATE_LEASE_MS) } },
                )
                .catch(() => {});
            }, MIGRATE_LEASE_MS / 2)
          : undefined;
      heartbeat?.unref?.();
      try {
        await fn(session);
        const res = (await journal.updateOne(
          { name, status: 'running' },
          { $set: { status: 'applied' } },
          sessionOpts,
        )) as unknown as Document & { matchedCount?: number };
        // Zero matches = the running row vanished concurrently — restore an
        // applied row so the migration is never silently re-run later.
        if (res?.matchedCount === 0) {
          await journal
            .insertOne({ name, appliedAt: new Date(), status: 'applied' }, sessionOpts)
            .catch(() => {});
        }
      } catch (err) {
        await journal.deleteOne({ name }, sessionOpts).catch(() => {});
        throw err;
      } finally {
        if (heartbeat !== undefined) clearInterval(heartbeat);
      }
    }
  };

  return { transaction, migrate };
};

type Document = Record<string, unknown>;
