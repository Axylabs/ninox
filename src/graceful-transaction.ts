import type { ClientSession } from 'mongodb';
import {
  type createMongoCapabilitiesStore,
  readMongoTransactionsEnvOverride,
} from './capabilities.ts';
import { InfraError, isTransactionUnsupportedError, mapMongoDriverError } from './errors/index.ts';
import type { LoggerLike } from './utils/logger.ts';

/** Minimal transaction runner surface (satisfied by the service `transaction`). */
export interface MongoTransactionRunner {
  transaction: <T>(
    fn: (session: ClientSession | null) => Promise<T>,
    options?: { allowNonTransactionalFallback?: boolean },
  ) => Promise<T>;
}

export interface GracefulTransactionOptions {
  capabilities?: ReturnType<typeof createMongoCapabilitiesStore>;
  urlHint?: string;
  logger?: LoggerLike;
  /** Map driver errors to typed DomainError/InfraError before rethrowing (default true). */
  wrapMongoErrors?: boolean;
  /** Explicitly permit non-atomic execution on deployments without transactions. */
  allowNonTransactionalFallback?: boolean;
}

/**
 * Run `fn` inside a transaction. Unsupported deployments throw unless
 * `allowNonTransactionalFallback: true` explicitly permits a `null` session.
 *
 * When capability state is UNKNOWN (probe failed/timed out and no URL hint or
 * env override says otherwise), we ATTEMPT the real transaction rather than
 * silently downgrading — a transient startup blip must not turn an atomic
 * write into a non-atomic one. The catch path still falls back cleanly on a
 * genuinely unsupported deployment only after explicit opt-in.
 */
export const withGracefulMongoTransaction = async <T>(
  runner: MongoTransactionRunner,
  fn: (session: ClientSession | null) => Promise<T>,
  options: GracefulTransactionOptions = {},
): Promise<T> => {
  let enabled = true;
  if (options.capabilities !== undefined) {
    const env = readMongoTransactionsEnvOverride();
    if (env !== undefined) {
      enabled = env;
    } else {
      const state = options.capabilities.get();
      if (state.probed) {
        enabled = state.transactionsSupported;
      } else if (options.urlHint) {
        enabled = /replicaSet=|mongodb\+srv:/i.test(options.urlHint);
      } // else UNKNOWN → keep `true` and let the attempt/fallback decide.
    }
  }
  const unsupported = () =>
    new InfraError(
      'TRANSACTIONS_UNSUPPORTED',
      'MongoDB deployment does not support transactions; set allowNonTransactionalFallback to run non-atomically',
    );
  if (!enabled) {
    if (options.allowNonTransactionalFallback === true) return fn(null);
    throw unsupported();
  }

  try {
    return await runner.transaction(fn, {
      ...(options.allowNonTransactionalFallback !== undefined
        ? { allowNonTransactionalFallback: options.allowNonTransactionalFallback }
        : {}),
    });
  } catch (err) {
    if (isTransactionUnsupportedError(err)) {
      if (options.allowNonTransactionalFallback !== true) throw err;
      options.logger?.warn?.(
        { error: err instanceof Error ? err.message : String(err) },
        'transactions unsupported; running explicitly requested non-transactional fallback',
      );
      return fn(null);
    }
    if (options.wrapMongoErrors !== false) {
      throw mapMongoDriverError(err, { op: 'transaction' });
    }
    throw err;
  }
};
