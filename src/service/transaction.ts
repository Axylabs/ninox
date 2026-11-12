import { randomUUID } from 'node:crypto';
import type {
  ClientSession,
  Db,
  MongoClient,
  TransactionOptions as MongoTransactionOptions,
} from 'mongodb';
import { InfraError, isTransactionUnsupportedError, mapMongoDriverError } from '../errors/index.ts';
import type { LoggerLike } from '../utils/logger.ts';

export interface TransactionOptions extends MongoTransactionOptions {
  /** Explicitly permit non-atomic execution when transactions are unsupported. */
  allowNonTransactionalFallback?: boolean;
}

export interface TransactionOpsOptions {
  migrationCollectionPhysical: string;
  wrapMongoErrors?: boolean;
  allowNonTransactionalFallback?: boolean;
}

/** Transaction + fenced idempotent-migration ops for one database handle. */
export const makeTransactionOps = (
  client: MongoClient,
  handle: Db,
  logger: LoggerLike,
  _config: Record<string, unknown>,
  opts: TransactionOpsOptions,
) => {
  let warnedUnsupported = false;
  let journalIndexReady = false;
  const MIGRATE_LEASE_MS = 120_000;

  const transaction = async <T>(
    fn: (session: ClientSession | null) => Promise<T>,
    options: TransactionOptions = {},
  ): Promise<T> => {
    const { allowNonTransactionalFallback, ...driverOptions } = options;
    const allowFallback =
      allowNonTransactionalFallback ?? opts.allowNonTransactionalFallback ?? false;
    const session = client.startSession();
    try {
      return await session.withTransaction(async () => fn(session), driverOptions);
    } catch (err) {
      if (isTransactionUnsupportedError(err)) {
        if (!allowFallback) {
          if (opts.wrapMongoErrors) {
            throw new InfraError(
              'TRANSACTIONS_UNSUPPORTED',
              'MongoDB deployment does not support transactions; enable allowNonTransactionalFallback to run non-atomically',
              { db: handle.databaseName, op: 'transaction' },
            );
          }
          throw err;
        }
        if (!warnedUnsupported) {
          warnedUnsupported = true;
          logger.warn?.(
            { error: err instanceof Error ? err.message : String(err) },
            'transactions unsupported; running explicitly requested non-transactional fallback',
          );
        }
        return fn(null);
      }
      if (opts.wrapMongoErrors) {
        throw mapMongoDriverError(err, { db: handle.databaseName, op: 'transaction' });
      }
      throw err;
    } finally {
      await session.endSession().catch(() => {});
    }
  };

  const migrate = async (
    name: string,
    fn: (session: ClientSession | null) => Promise<void>,
    filePath?: string,
    options: { allowNonTransactionalFallback?: boolean } = {},
  ): Promise<void> => {
    const journal = handle.collection<{
      name: string;
      appliedAt: Date;
      status?: string;
      file?: string;
      expiresAt?: Date;
      claimId?: string;
    }>(opts.migrationCollectionPhysical);

    if (!journalIndexReady) {
      await journal.createIndex({ name: 1 }, { unique: true });
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
      const claimId = randomUUID();

      const stole = (await journal.findOneAndUpdate(
        {
          name,
          status: { $exists: true, $nin: ['applied', 'rolling_back'] },
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
            claimId,
            ...(filePath ? { file: filePath } : {}),
          },
        },
        { returnDocument: 'before', ...sessionOpts },
      )) as Document | null;
      if (stole !== null) {
        await runClaimed(session, claimId);
        return;
      }

      try {
        await journal.insertOne(
          {
            name,
            appliedAt: now,
            status: 'running',
            expiresAt,
            claimId,
            ...(filePath ? { file: filePath } : {}),
          },
          sessionOpts,
        );
      } catch (err) {
        if (!isDupKeyError(err)) throw err;
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
      await runClaimed(session, claimId);
    }, options);

    async function runClaimed(session: ClientSession | null, claimId: string): Promise<void> {
      const sessionOpts = session ? { session } : {};
      const heartbeat =
        session === null
          ? setInterval(() => {
              void journal
                .updateOne(
                  { name, claimId, status: 'running' },
                  { $set: { expiresAt: new Date(Date.now() + MIGRATE_LEASE_MS) } },
                )
                .catch(() => {});
            }, MIGRATE_LEASE_MS / 2)
          : undefined;
      heartbeat?.unref?.();
      try {
        await fn(session);
        const res = await journal.updateOne(
          { name, claimId, status: 'running' },
          { $set: { status: 'applied' }, $unset: { expiresAt: '', claimId: '' } },
          sessionOpts,
        );
        if (res.matchedCount === 0) {
          throw new Error(`Migration "${name}" lost its claim before it could be marked applied`);
        }
      } catch (err) {
        await journal.deleteOne({ name, claimId, status: 'running' }, sessionOpts).catch(() => {});
        throw err;
      } finally {
        if (heartbeat !== undefined) clearInterval(heartbeat);
      }
    }
  };

  return { transaction, migrate };
};

type Document = Record<string, unknown>;
