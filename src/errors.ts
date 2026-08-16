/**
 * Error taxonomy for the ORM — a self-contained replacement for the sdk-core
 * error classes the reference delegates to:
 *
 *   DomainError  → expected business violations (NOT_FOUND, DUPLICATE_KEY, ...)
 *   InfraError   → infrastructure failures (timeouts, query errors, ...)
 *   BadRequest   → malformed input from the caller
 *
 * plus driver-error mapping (`mapMongoDriverError`) and transient-error
 * detection used by the retry wrapper.
 */
export interface ErrorContext {
  db?: string;
  collection?: string;
  op?: string;
}

/**
 * Canonical HTTP status for each error code. `AppError.statusCode` is set from
 * this table at construction (falling back to the class default: 400 for
 * `DomainError`, 500 for `InfraError`), so a framework can respond with
 * `err.statusCode` directly and still get correct REST semantics:
 *   NOT_FOUND → 404, DUPLICATE_KEY/VERSION_CONFLICT/COLLECTION_EXISTS → 409,
 *   VALIDATION_FAILED → 422, MONGO_TIMEOUT → 504.
 */
export const ERROR_HTTP_STATUS: Record<string, number> = {
  BAD_REQUEST: 400,
  NOT_FOUND: 404,
  DUPLICATE_KEY: 409,
  VERSION_CONFLICT: 409,
  COLLECTION_EXISTS: 409,
  SCHEMA_DRIFT: 409,
  VALIDATION_FAILED: 422,
  MONGO_TIMEOUT: 504,
};

export class AppError extends Error {
  readonly code: string;
  readonly statusCode: number;
  readonly extra?: Record<string, unknown>;

  constructor(code: string, message: string, statusCode = 500, extra?: Record<string, unknown>) {
    super(message);
    this.name = 'AppError';
    this.code = code;
    this.statusCode = statusCode;
    this.extra = extra;
  }

  /**
   * Stable, client-safe serialization for framework error middleware: a
   * framework can forward `JSON.stringify(error)` (or `error.toJSON()`) straight
   * to the client — no parsing of server internals. `stack` is dropped; the
   * shape is always `{ name, code, message, statusCode, ...(extra) }`.
   */
  toJSON(): Record<string, unknown> {
    return {
      name: this.name,
      code: this.code,
      message: this.message,
      statusCode: this.statusCode,
      ...(this.extra !== undefined ? { extra: this.extra } : {}),
    };
  }
}

export class DomainError extends AppError {
  constructor(code: string, message: string, extra?: Record<string, unknown>) {
    super(code, message, ERROR_HTTP_STATUS[code] ?? 400, extra);
    this.name = 'DomainError';
  }
}

export class InfraError extends AppError {
  constructor(code: string, message: string, extra?: Record<string, unknown>) {
    super(code, message, ERROR_HTTP_STATUS[code] ?? 500, extra);
    this.name = 'InfraError';
  }
}

export class BadRequest extends DomainError {
  constructor(message: string, extra?: Record<string, unknown>) {
    super('BAD_REQUEST', message, extra);
    this.name = 'BadRequest';
  }
}

export const isAppError = (err: unknown): err is AppError => err instanceof AppError;

export const isDomainError = (err: unknown): err is DomainError => err instanceof DomainError;

export const isInfraError = (err: unknown): err is InfraError => err instanceof InfraError;

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
    9001, // SocketException
    10107, // NotWritablePrimary
    11600, // InterruptedAtShutdown
    11602, // InterruptedDueToReplStateChange
    13435, // NotPrimaryNoSecondaryOk
    13436, // NotPrimaryOrSecondary
  ]),
);

const TRANSIENT_NAME =
  /MongoNetworkError|PoolClearedError|MongoWriteConcernError|MongoNotPrimaryError|MongoNodeIsRecoveringError|MongoNetworkTimeoutError/;

/** True when the error is a transient Mongo failure that retry can recover from. */
export const isMongoTransientError = (error: unknown): boolean => {
  if (!error || typeof error !== 'object') return false;
  const e = error as { name?: unknown; code?: unknown; errInfo?: unknown };
  if (typeof e.name === 'string' && TRANSIENT_NAME.test(e.name)) return true;
  if (typeof e.code === 'number' && TRANSIENT_MONGO_ERROR_CODES.has(e.code)) return true;
  return false;
};

export const isMongoDuplicateKeyError = (error: unknown): boolean => {
  if (!error || typeof error !== 'object') return false;
  const e = error as { code?: unknown; message?: unknown };
  if (e.code === 11000) return true;
  if (typeof e.message === 'string' && /E11000|duplicate key/i.test(e.message)) return true;
  return false;
};

const isBulkWriteError = (error: unknown): boolean =>
  typeof error === 'object' &&
  error !== null &&
  'writeErrors' in (error as { writeErrors?: unknown }) &&
  Array.isArray((error as { writeErrors?: unknown[] }).writeErrors);

interface WriteErrorLike {
  code?: number;
  errmsg?: string;
  keyPattern?: Record<string, unknown>;
  keyValue?: Record<string, unknown>;
  errInfo?: unknown;
}

/** Shape of the `errInfo` MongoDB attaches to a `$jsonSchema` validation failure (code 121). */
interface MongoErrInfo {
  failingDocumentId?: unknown;
  details?: {
    schemaRulesNotSatisfied?: Array<{
      propertyName?: string;
      propertiesNotSatisfied?: Array<{ propertyName?: string }>;
      /** Unknown-key violations are reported as a list here (not propertiesNotSatisfied). */
      additionalProperties?: string[];
    }>;
  };
}

/**
 * Flatten the offending field paths from a `$jsonSchema` validation error so a
 * `VALIDATION_FAILED` error can name exactly which fields were rejected.
 * Covers missing/type-mismatched properties (`propertiesNotSatisfied`) and
 * unknown-key violations (`additionalProperties`).
 */
export const extractValidationPaths = (errInfo: unknown): string[] => {
  if (!errInfo || typeof errInfo !== 'object') return [];
  const info = errInfo as MongoErrInfo;
  const out: string[] = [];
  for (const rule of info.details?.schemaRulesNotSatisfied ?? []) {
    if (typeof rule.propertyName === 'string') out.push(rule.propertyName);
    for (const prop of rule.propertiesNotSatisfied ?? []) {
      if (typeof prop.propertyName === 'string') out.push(prop.propertyName);
    }
    for (const prop of rule.additionalProperties ?? []) {
      if (typeof prop === 'string') out.push(prop);
    }
  }
  return [...new Set(out)];
};

/** Enrich a mapped-error context with the failing document id + offending field paths. */
const addValidationContext = (context: Record<string, unknown>, errInfo: unknown): void => {
  if (!errInfo || typeof errInfo !== 'object') return;
  const info = errInfo as MongoErrInfo;
  if (info.failingDocumentId !== undefined) context.documentId = info.failingDocumentId;
  const fields = extractValidationPaths(errInfo);
  if (fields.length > 0) context.fields = fields;
  if (info.details !== undefined) context.details = info.details;
};

/**
 * Map a raw driver error to a typed DomainError/InfraError. Mirrors the sdk-db
 * mapping table (codes 11000 → DUPLICATE_KEY, 112 → VERSION_CONFLICT,
 * 50 → MONGO_TIMEOUT, 121 → VALIDATION_FAILED, everything else → MONGO_QUERY_ERROR).
 * When the error is already an AppError it is returned unchanged.
 */
export const mapMongoDriverError = (error: unknown, ctx: ErrorContext = {}): unknown => {
  if (error instanceof AppError) return error;

  const context: Record<string, unknown> = { ...(ctx as Record<string, unknown>) };
  if (isMongoDuplicateKeyError(error)) {
    const e = error as { keyPattern?: Record<string, unknown>; keyValue?: Record<string, unknown> };
    if (e.keyPattern) context.keyPattern = e.keyPattern;
    if (e.keyValue) context.keyValue = e.keyValue;
    return new DomainError('DUPLICATE_KEY', 'Duplicate key error', context);
  }

  if (isBulkWriteError(error)) {
    const first = (error as { writeErrors: WriteErrorLike[] }).writeErrors[0];
    if (first?.code === 11000) {
      if (first.keyPattern) context.keyPattern = first.keyPattern;
      if (first.keyValue) context.keyValue = first.keyValue;
      return new DomainError('DUPLICATE_KEY', first.errmsg ?? 'Duplicate key error', context);
    }
    if (first?.code === 121) {
      addValidationContext(context, first.errInfo);
      return new DomainError('VALIDATION_FAILED', 'Document failed schema validation', context);
    }
    return new InfraError('MONGO_QUERY_ERROR', 'Bulk write failed', context);
  }

  const code = (error as { code?: unknown }).code;
  switch (code) {
    case 112:
      return new DomainError('VERSION_CONFLICT', 'Document version conflict', context);
    case 50:
      return new InfraError('MONGO_TIMEOUT', 'MongoDB operation timed out', context);
    case 121: {
      addValidationContext(context, (error as { errInfo?: unknown }).errInfo);
      return new DomainError('VALIDATION_FAILED', 'Document failed schema validation', context);
    }
    default:
      break;
  }

  if (isMongoTransientError(error)) {
    const e = error as { message?: string };
    return new InfraError('MONGO_QUERY_ERROR', e.message ?? 'Transient MongoDB error', context);
  }

  const msg = (error as { message?: string }).message ?? 'MongoDB query error';
  return new InfraError('MONGO_QUERY_ERROR', msg, context);
};

export const isMappedMongoError = (error: unknown): error is AppError => error instanceof AppError;

/** Effective HTTP status for any thrown value: AppError-aware, raw → 500 (503 transient). */
export const httpStatusForError = (err: unknown): number => {
  if (err instanceof AppError) return err.statusCode;
  if (isMongoTransientError(err)) return 503;
  return 500;
};

/**
 * Reduce any thrown value to a stable, client-safe error payload:
 * `{ name, code, message, statusCode, ...(extra) }`.
 *
 * Raw driver errors are mapped through `mapMongoDriverError` first, so a
 * framework can forward the result directly without parsing Mongo server
 * internals (`errInfo`, `writeErrors`, `keyPattern`, ...):
 *
 *   app.use((err, _req, res, _next) => {
 *     const payload = serializeError(err, { db, collection, op });
 *     res.status(payload.statusCode).json(payload);
 *   });
 */
export const serializeError = (err: unknown, ctx: ErrorContext = {}): Record<string, unknown> => {
  const mapped = mapMongoDriverError(err, ctx);
  if (mapped instanceof AppError) return mapped.toJSON();
  if (mapped instanceof Error) {
    return { name: mapped.name, code: 'UNKNOWN', message: mapped.message, statusCode: 500 };
  }
  return { name: 'UnknownError', code: 'UNKNOWN', message: String(mapped), statusCode: 500 };
};
