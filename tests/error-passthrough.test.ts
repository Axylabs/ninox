import { describe, expect, test } from 'bun:test';
import { AppError, mapMongoDriverError } from '../src/errors/index.ts';
import { traceDbOp } from '../src/service/trace-db-op.ts';
import type { LoggerLike } from '../src/utils/logger.ts';

const noopLogger: LoggerLike = { debug() {}, info() {}, warn() {}, error() {} };

/** An application-level error (the shape ignex's ConflictError/HTTPError has:
 * NOT a Mongo driver error, carries its own HTTP status). */
class AppConflictError extends Error {
  readonly status = 409;
  readonly code = 'CONFLICT';
}

describe('error passthrough (app errors survive the wrap path)', () => {
  test('mapMongoDriverError returns non-driver errors unchanged (identity)', () => {
    const appErr = new AppConflictError('Milestone already funded');
    const mapped = mapMongoDriverError(appErr, { db: 'safo', op: 'transaction' });
    expect(mapped).toBe(appErr); // same object — status 409 preserved
  });

  test('mapMongoDriverError still maps real driver errors', () => {
    const mapped = mapMongoDriverError({
      name: 'MongoServerError',
      code: 11000,
      message: 'E11000 duplicate key',
    } as unknown as Error);
    expect(mapped instanceof AppError).toBe(true);
    expect((mapped as AppError).code).toBe('DUPLICATE_KEY');
  });

  test('traceDbOp with wrapMongoErrors rethrows app errors unchanged', async () => {
    const appErr = new AppConflictError('nope');
    await expect(
      traceDbOp(
        noopLogger,
        { db: 'x', collection: 'orders', op: 'mongo.updateOne' },
        () => {
          throw appErr;
        },
        { wrapMongoErrors: true },
      ),
    ).rejects.toBe(appErr);
  });

  test('traceDbOp still maps driver errors when wrapMongoErrors is on', async () => {
    await expect(
      traceDbOp(
        noopLogger,
        { db: 'x', collection: 'users', op: 'mongo.insertOne' },
        () => {
          throw Object.assign(new Error('E11000 duplicate key'), {
            name: 'MongoServerError',
            code: 11000,
          });
        },
        { wrapMongoErrors: true },
      ),
    ).rejects.toMatchObject({ code: 'DUPLICATE_KEY' });
  });
});
