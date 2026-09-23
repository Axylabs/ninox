/**
 * Framework-facing error helpers: `httpStatusForError` (effective HTTP status
 * for any thrown value) and `serializeError` (reduce any thrown value to a
 * stable, client-safe payload).
 */

import { redactText } from '../utils/redact.ts';
import { AppError, type ErrorContext, genericStatusMessage } from './classes.ts';
import { mapMongoDriverError } from './driver-map.ts';
import { isMongoTransientError } from './transient.ts';

/** Effective HTTP status for any thrown value: AppError-aware, raw → 500 (503 transient). */
export const httpStatusForError = (err: unknown): number => {
  if (err instanceof AppError) return err.statusCode;
  if (isMongoTransientError(err)) return 503;
  return 500;
};

/** Options for {@link serializeError}. */
export interface SerializeErrorOptions {
  /**
   * Include the real message (and `extra`) even for a non-exposed error — the
   * development / trusted-caller path. It is still credential-masked.
   */
  expose?: boolean;
}

/**
 * Reduce any thrown value to a stable, CLIENT-SAFE error payload:
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
 *
 * Fail-closed by default: a 4xx message/extra is the caller's contract, while a
 * 5xx message is replaced by the canonical reason phrase (`Internal Server
 * Error`, `Service Unavailable`, …) and `extra` is dropped — a driver message
 * that quotes a host, a query or a stored value never reaches a client. The
 * detail stays on the error itself for logs; pass `{ expose: true }` (or a
 * per-error `expose`) to opt out for a trusted caller.
 */
export const serializeError = (
  err: unknown,
  ctx: ErrorContext = {},
  options: SerializeErrorOptions = {},
): Record<string, unknown> => {
  const mapped = mapMongoDriverError(err, ctx);
  if (mapped instanceof AppError) return mapped.toClientPayload(options);

  const statusCode = httpStatusForError(mapped);
  const name = mapped instanceof Error ? mapped.name : 'UnknownError';
  if (options.expose !== true) {
    return { name, code: 'UNKNOWN', message: genericStatusMessage(statusCode), statusCode };
  }
  return {
    name,
    code: 'UNKNOWN',
    message: redactText(mapped instanceof Error ? mapped.message : String(mapped)),
    statusCode,
  };
};
