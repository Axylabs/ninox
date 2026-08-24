import type { ClientSession } from 'mongodb';
import {
  type createMongoCapabilitiesStore,
  readMongoTransactionsEnvOverride,
} from './capabilities.ts';
import { isTransactionUnsupportedError, mapMongoDriverError } from './errors/index.ts';
import type { LoggerLike } from './utils/logger.ts';

/** Minimal transaction runner surface (satisfied by the service `transaction`). */
export interface MongoTransactionRunner {
  transaction: <T>(fn: (session: ClientSession | null) => Promise<T>) => Promise<T>;
}

export interface GracefulTransactionOptions {
  capabilities?: ReturnType<typeof createMongoCapabilitiesStore>;
  urlHint?: string;
  logger?: LoggerLike;
  /** Map driver errors to typed DomainError/InfraError before rethrowing (default true). */
  wrapMongoErrors?: boolean;
}

/**
 * Run `fn` inside a transaction when the deployment supports it; otherwise run
 * with a `null` session (no-op fallback). Also handles "transactions
 * unsupported" errors by re-running with a null session.
 *
 * When capability state is UNKNOWN (probe failed/timed out and no URL hint or
 * env override says otherwise), we ATTEMPT the real transaction rather than
 * silently downgrading — a transient startup blip must not turn an atomic
 * write into a non-atomic one. The catch path still falls back cleanly on a
 * genuinely unsupported deployment (at the cost of one failed round trip).
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
  if (!enabled) return fn(null);

  try {
    return await runner.transaction(fn);
  } catch (err) {
    if (isTransactionUnsupportedError(err)) {
      options.logger?.warn?.(
        { error: err instanceof Error ? err.message : String(err) },
        'transactions unsupported, falling back',
      );
      return fn(null);
    }
    if (options.wrapMongoErrors !== false) {
      throw mapMongoDriverError(err, { op: 'transaction' });
    }
    throw err;
  }
};
