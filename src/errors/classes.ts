/**
 * The ORM's error classes (`AppError` → `DomainError` / `InfraError` /
 * `BadRequest`), their type guards, and the `ERROR_HTTP_STATUS` table that sets
 * each error's `statusCode` at construction.
 *
 * A leaf module: nothing else in `src/errors/` imports this (so `driver-map.ts`
 * and `http-status.ts` can depend on it without cycles).
 */
import { maskCredentials } from '../utils/redact.ts';
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

/**
 * Canonical reason phrase per status, used when a message is NOT client-visible.
 *
 * Written out rather than read from `Response.statusText` (which is empty unless
 * a server supplied one), so a masked 5xx still says something a caller can act
 * on: "Service Unavailable" instead of an empty string.
 */
export const STATUS_MESSAGES: Record<number, string> = {
  400: 'Bad Request',
  401: 'Unauthorized',
  403: 'Forbidden',
  404: 'Not Found',
  409: 'Conflict',
  422: 'Unprocessable Entity',
  429: 'Too Many Requests',
  500: 'Internal Server Error',
  502: 'Bad Gateway',
  503: 'Service Unavailable',
  504: 'Gateway Timeout',
};

/** The generic message for a status (unknown 5xx → "Internal Server Error"). */
export const genericStatusMessage = (statusCode: number): string =>
  STATUS_MESSAGES[statusCode] ?? (statusCode >= 500 ? 'Internal Server Error' : 'Request failed');

export class AppError extends Error {
  readonly code: string;
  readonly statusCode: number;
  readonly extra?: Record<string, unknown>;
  /**
   * Whether `message`/`extra` may be sent to a CLIENT.
   *
   * Fail-closed: a 4xx message is the caller's contract, a 5xx message is an
   * operator detail that may quote a driver, a host or a query. Pass `expose`
   * explicitly to override — only for a 5xx whose text was written for callers
   * (e.g. `new InfraError("DRAINING", "queue is draining", extra, true)`).
   */
  readonly expose: boolean;

  constructor(
    code: string,
    message: string,
    statusCode = 500,
    extra?: Record<string, unknown>,
    expose?: boolean,
  ) {
    super(message);
    this.name = 'AppError';
    this.code = code;
    this.statusCode = statusCode;
    this.expose = expose ?? statusCode < 500;
    if (extra !== undefined) this.extra = extra;
  }

  /**
   * Full, stack-free shape for LOGS and typed consumers:
   * `{ name, code, message, statusCode, ...(extra) }`.
   *
   * It carries the real message, so it is NOT the client path — use
   * {@link toClientPayload} (or `serializeError`) for anything a caller sees, and
   * prefer `logger.error({ err })` so pino's own serializer keeps the stack in the
   * log rather than in a payload.
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

  /**
   * The client-safe payload — the same shape as {@link toJSON}, except that a
   * non-exposed error's `message` is replaced by the canonical reason phrase and
   * its `extra` is dropped. A framework can forward this (or `serializeError`'s
   * result) without auditing what the message might contain.
   *
   * @param options - `expose: true` forces the real (masked) message + extra.
   * @returns The client payload.
   */
  toClientPayload(options: { expose?: boolean } = {}): Record<string, unknown> {
    const expose = options.expose === true || this.expose;
    const payload: Record<string, unknown> = {
      name: this.name,
      code: this.code,
      message: expose ? maskCredentials(this.message) : genericStatusMessage(this.statusCode),
      statusCode: this.statusCode,
    };
    if (expose && this.extra !== undefined) payload.extra = this.extra;
    return payload;
  }
}

export class DomainError extends AppError {
  constructor(code: string, message: string, extra?: Record<string, unknown>, expose?: boolean) {
    super(code, message, ERROR_HTTP_STATUS[code] ?? 400, extra, expose);
    this.name = 'DomainError';
  }
}

export class InfraError extends AppError {
  constructor(code: string, message: string, extra?: Record<string, unknown>, expose?: boolean) {
    super(code, message, ERROR_HTTP_STATUS[code] ?? 500, extra, expose);
    this.name = 'InfraError';
  }
}

export class BadRequest extends DomainError {
  constructor(message: string, extra?: Record<string, unknown>, expose?: boolean) {
    super('BAD_REQUEST', message, extra, expose);
    this.name = 'BadRequest';
  }
}

export const isAppError = (err: unknown): err is AppError => err instanceof AppError;

export const isDomainError = (err: unknown): err is DomainError => err instanceof DomainError;

export const isInfraError = (err: unknown): err is InfraError => err instanceof InfraError;
