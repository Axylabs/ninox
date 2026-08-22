import { mapMongoDriverError } from '../errors/index.ts';
import type { LoggerLike } from '../utils/logger.ts';

/** Structured metadata attached to every logged DB operation. */
export interface DbOpMeta {
  collection: string;
  physicalCollection?: string;
  db: string;
  op: string;
}

export interface TraceDbOpOptions {
  /** Map driver errors to typed DomainError/InfraError before rethrowing. */
  wrapMongoErrors?: boolean;
}

/**
 * The ignex-debugbar `debugQuery` free helper (`@ignex/core/debug`), resolved
 * lazily so the ORM stays standalone: `undefined` until probed, `null` when
 * `@ignex/core` is not installed (plain ORM usage), the function otherwise.
 * `debugQuery` itself is a zero-cost pass-through when no request trace is
 * active, so production ignex apps pay nothing either.
 */
type DebugQuery = (
  sql: string,
  params: unknown[] | undefined,
  fn: () => unknown | Promise<unknown>,
) => Promise<unknown>;

let debugQueryCache: DebugQuery | null | undefined;

/** Probe once per process; the failed dynamic import is caught and cached. */
const probeDebugQuery = async (): Promise<void> => {
  if (debugQueryCache !== undefined) return;
  try {
    const mod = (await import('@ignex/core/debug')) as { debugQuery?: DebugQuery };
    debugQueryCache = typeof mod.debugQuery === 'function' ? mod.debugQuery : null;
  } catch {
    debugQueryCache = null;
  }
};

/**
 * Wrap a DB operation with start/ok/error structured logging (duration, op,
 * collection, db). When `wrapMongoErrors` is set, driver errors are mapped to
 * the ORM's typed error classes before being rethrown.
 *
 * When the app runs inside ignex with the debugbar enabled, every operation
 * is ALSO recorded as a `db` span in the current request's trace (`kind:
 * "db"`) — it shows up in the debugbar waterfall, the Queries tab and the
 * per-request db-time aggregate. The integration is optional and automatic:
 * it activates only when `@ignex/core` is installed AND a request trace is
 * active, and costs a single cached module probe otherwise.
 */
export const traceDbOp = async <T>(
  logger: LoggerLike,
  meta: DbOpMeta,
  fn: () => T | Promise<T>,
  options: TraceDbOpOptions = {},
): Promise<T> => {
  const start = performance.now();
  logger.debug({ ...meta, operation: 'start' }, 'start');
  try {
    // First op only: resolve the optional ignex-debugbar hook.
    if (debugQueryCache === undefined) await probeDebugQuery();
    const debugQuery = debugQueryCache;
    const result = debugQuery
      ? ((await debugQuery(`${meta.collection}.${meta.op}`, undefined, () => fn())) as T)
      : await fn();
    const durationMs = performance.now() - start;
    logger.info({ ...meta, durationMs }, 'ok');
    return result;
  } catch (err) {
    const durationMs = performance.now() - start;
    const loggable =
      err instanceof Error
        ? { name: err.name, message: err.message, code: (err as { code?: unknown }).code }
        : err;
    logger.error({ ...meta, durationMs, error: loggable }, 'error');
    if (options.wrapMongoErrors) throw mapMongoDriverError(err, meta);
    throw err;
  }
};
