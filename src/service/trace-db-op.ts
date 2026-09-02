import { mapMongoDriverError } from '../errors/index.ts';
import type { LoggerLike } from '../utils/logger.ts';

/** Structured metadata attached to every logged DB operation. */
export interface DbOpMeta {
  collection: string;
  physicalCollection?: string;
  db: string;
  op: string;
  /**
   * What was sent to the database (filter / document / update / pipeline /
   * options). Surfaced in the ignex debugbar as the span's `params`, so the
   * dashboard shows exactly what the query carried — not just its name.
   * Optional: ops without a payload worth showing omit it.
   */
  params?: unknown;
}

export interface TraceDbOpOptions {
  /** Map driver errors to typed DomainError/InfraError before rethrowing. */
  wrapMongoErrors?: boolean;
  /**
   * Test/advanced seam: inject the ignex-debugbar `debugQuery` implementation
   * directly. Omitted (production) → probed lazily via `@ignex/core/debug`.
   * `null` forces the plain pass-through without touching the probe cache.
   */
  debugQuery?: DebugQuery | null;
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
  params: unknown,
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
 * Make a captured param payload JSON-safe before it reaches the debugbar: a
 * JSON round-trip strips `undefined` keys, RegExps, class instances and other
 * values that would otherwise crash `JSON.stringify` downstream (the live API
 * and the SQLite history both serialize span attrs). Mongo filters may carry
 * such values (`_id` ObjectIds serialize to their hex string; Dates to ISO
 * strings — exactly what a developer wants to see). Falls back to `String()`
 * when even the round-trip fails.
 */
const sanitizeDebugParams = (value: unknown): unknown => {
  try {
    return JSON.parse(JSON.stringify(value));
  } catch {
    try {
      return String(value);
    } catch {
      return '[unserializable]';
    }
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
 *
 * Caveat: the hook only fires when the dynamic `@ignex/core/debug` probe
 * resolves to the SAME module instance as the app's debugbar plugin (the
 * plugin's tracer gates on its own `tracingEnabled`). That is the case for a
 * normal npm install of both packages — but if this ORM is `bun link`-ed into
 * an app whose build cannot resolve `@ignex/core/debug` from the linked path,
 * the bundler externalizes the probe and it silently no-ops (no `db` spans).
 * Install `@ignex/core` alongside the app (npm-style) to keep the integration.
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
    // First op only: resolve the optional ignex-debugbar hook. An explicitly
    // injected `options.debugQuery` (tests / advanced hosts) wins over the
    // lazily-probed `@ignex/core/debug` helper.
    let debugQuery = options.debugQuery;
    if (debugQuery === undefined) {
      if (debugQueryCache === undefined) await probeDebugQuery();
      debugQuery = debugQueryCache;
    }
    // Pass WHAT WAS SENT (filter/doc/pipeline/…) as the span's params so the
    // debugbar shows the actual query payload, not just `collection.op`.
    const params = meta.params === undefined ? undefined : sanitizeDebugParams(meta.params);
    const result = debugQuery
      ? ((await debugQuery(`${meta.collection}.${meta.op}`, params, () => fn())) as T)
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
