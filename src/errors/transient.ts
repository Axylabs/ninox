/**
 * Transient-error detection: which MongoDB errors are safe to retry. This is a
 * leaf module (no folder imports) so both `driver-map.ts` and `http-status.ts`
 * can depend on it without cycles.
 */

/**
 * Server error codes MongoDB raises that are safe to retry (network hiccups,
 * not-primary, sharding moves, interrupted queries). Mirrors the reference set.
 *
 * Frozen + typed `ReadonlySet` so a consumer can't mutate the shared instance
 * (it is a module-level singleton, re-exported through the barrel).
 */
export const TRANSIENT_MONGO_ERROR_CODES: ReadonlySet<number> = Object.freeze(
  new Set<number>([
    6, // HostUnreachable
    7, // HostNotFound
    89, // NetworkTimeout
    91, // ShutdownInProgress
    189, // PrimarySteppedDown
    251, // NoSuchTransaction (stepdown mid-transaction)
    262, // ExceededTimeLimit (part of the retryable transaction set)
    9001, // SocketException
    10058, // NotWritablePrimary (legacy server code)
    10107, // NotWritablePrimary
    11600, // InterruptedAtShutdown
    11602, // InterruptedDueToReplStateChange
    13435, // NotPrimaryNoSecondaryOk
    13436, // NotPrimaryOrSecondary
  ]),
);

const TRANSIENT_NAME =
  /MongoNetworkError|PoolClearedError|MongoWriteConcernError|MongoNotPrimaryError|MongoNodeIsRecoveringError|MongoNetworkTimeoutError|MongoServerSelectionError/;

/** True when the error is a transient Mongo failure that retry can recover from. */
export const isMongoTransientError = (error: unknown): boolean => {
  if (!error || typeof error !== 'object') return false;
  const e = error as {
    name?: unknown;
    code?: unknown;
    errInfo?: unknown;
    hasErrorLabel?: unknown;
  };
  if (
    typeof e.hasErrorLabel === 'function' &&
    (e.hasErrorLabel as (label: string) => boolean)('TransientTransactionError')
  ) {
    return true;
  }
  if (typeof e.name === 'string' && TRANSIENT_NAME.test(e.name)) return true;
  if (typeof e.code === 'number' && TRANSIENT_MONGO_ERROR_CODES.has(e.code)) return true;
  return false;
};

/** True when the error is a duplicate-key violation (code 11000 / E11000 message). */
export const isMongoDuplicateKeyError = (error: unknown): boolean => {
  if (!error || typeof error !== 'object') return false;
  const e = error as { code?: unknown; message?: unknown };
  if (e.code === 11000) return true;
  if (typeof e.message === 'string' && /E11000|duplicate key/i.test(e.message)) return true;
  return false;
};

/**
 * True when the deployment cannot run transactions at all (standalone mongod,
 * or storage engine without retryable writes) — callers fall back to
 * non-transactional execution. Shared by BOTH fallback layers
 * (`withGracefulMongoTransaction` and the service `transaction` op) so they
 * classify identically.
 */
export const isTransactionUnsupportedError = (error: unknown): boolean => {
  const code = (error as { code?: unknown } | null)?.code;
  if (code === 20) return true; // IllegalOperation — "Transaction numbers are only allowed..."
  const message = error instanceof Error ? error.message : '';
  return (
    /Transaction numbers are only allowed/i.test(message) ||
    /transactions are not supported/i.test(message) ||
    /does not support retryable writes/i.test(message)
  );
};

const MONGO_ERROR_NAME =
  /MongoError|MongoServerError|MongoBulkWriteError|MongoNetworkError|MongoNetworkTimeoutError|MongoWriteConcernError|MongoNotPrimaryError|MongoNodeIsRecoveringError|MongoCursorExhaustedError|PoolClearedError|MongoTopologyClosedError|MongoServerSelectionError/;

/**
 * Server codes that identify an error as coming from MongoDB even when the
 * `name` is absent — writeErrors[] entries, rethrown callbacks, and plain
 * objects users pass to `mapMongoDriverError` carry only `{ code }`.
 */
const DRIVER_ERROR_CODES: ReadonlySet<number> = Object.freeze(
  new Set<number>([
    20, // IllegalOperation (transactions unsupported)
    26, // NamespaceNotFound
    48, // NamespaceExists
    50, // MaxTimeMSExpired
    112, // WriteConflict
    121, // DocumentValidationFailure
    11000, // DuplicateKey
    11001, // DuplicateKey (legacy)
    ...TRANSIENT_MONGO_ERROR_CODES,
  ]),
);

/**
 * True when the error is a MongoDB DRIVER error rather than an application
 * error thrown inside a callback/transaction.
 *
 * Name-based (not instanceof) on purpose: the driver instance that raised the
 * error and the one this module imports may be different copies of the
 * `mongodb` package. A known numeric server code or duplicate-key message
 * also qualifies, so nameless-but-coded shapes (`{ code: 11000 }`) are still
 * recognized; application errors with arbitrary numeric codes are not.
 */
export const isMongoDriverError = (error: unknown): boolean => {
  if (!error || typeof error !== 'object') return false;
  const e = error as { name?: unknown; code?: unknown; message?: unknown };
  if (typeof e.name === 'string' && MONGO_ERROR_NAME.test(e.name)) return true;
  if (typeof e.code === 'number' && DRIVER_ERROR_CODES.has(e.code)) return true;
  if (typeof e.message === 'string' && /E11000 duplicate key/i.test(e.message)) return true;
  return false;
};
