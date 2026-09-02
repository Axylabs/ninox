import { describe, expect, test } from 'bun:test';
import { defineCrudOp, type CrudOpDeps } from '../src/service/crud-op.ts';
import { traceDbOp, type TraceDbOpOptions } from '../src/service/trace-db-op.ts';
import type { DbOpMeta } from '../src/service/trace-db-op.ts';
import type { LoggerLike } from '../src/utils/logger.ts';

const noopLogger: LoggerLike = { debug() {}, info() {}, warn() {}, error() {} };

/** Build options that inject a capturing fake `debugQuery` (no probe involved). */
const withDebugQuery = (calls: Array<[string, unknown]>): TraceDbOpOptions => ({
  debugQuery: async (sql, params, fn) => {
    calls.push([sql, params]);
    return fn();
  },
});

describe('debugbar "what was sent" params capture', () => {
  test('defineCrudOp forwards params into the traced meta', async () => {
    let seenMeta: DbOpMeta | undefined;
    const deps: CrudOpDeps<string> = {
      meta: (collection, op, params) => ({
        collection,
        db: 'app',
        op,
        ...(params !== undefined ? { params } : {}),
      }),
      trace: async (meta, fn) => {
        seenMeta = meta;
        return fn();
      },
    };

    const sent = { filter: { _id: 'x' }, update: { $set: { a: 1 } } };
    const out = await defineCrudOp(
      deps,
      'users',
      'mongo.updateOne',
      async () => 42,
      undefined,
      true,
      sent,
    );

    expect(out).toBe(42);
    expect(seenMeta?.params).toEqual(sent);
  });

  test('defineCrudOp omits params from the meta when none are given', async () => {
    let seenMeta: DbOpMeta | undefined;
    const deps: CrudOpDeps<string> = {
      meta: (collection, op, params) => ({
        collection,
        db: 'app',
        op,
        ...(params !== undefined ? { params } : {}),
      }),
      trace: async (meta, fn) => {
        seenMeta = meta;
        return fn();
      },
    };

    await defineCrudOp(deps, 'users', 'mongo.countDocuments', async () => 3);
    expect(seenMeta?.params).toBeUndefined();
  });

  test('traceDbOp hands what-was-sent (filter/doc/pipeline) to debugQuery', async () => {
    const calls: Array<[string, unknown]> = [];
    const sent = { doc: { name: 'Ada', role: 'admin' } };
    const out = await traceDbOp(
      noopLogger,
      { db: 'app', collection: 'users', op: 'mongo.insertOne', params: sent },
      async () => 'inserted',
      withDebugQuery(calls),
    );

    expect(out).toBe('inserted');
    expect(calls).toHaveLength(1);
    // The debugbar label is `<collection>.<op>` and params are what was sent.
    expect(calls[0]![0]).toBe('users.mongo.insertOne');
    expect(calls[0]![1]).toEqual(sent);
  });

  test('traceDbOp sanitizes non-JSON payloads before handing them to the debugbar', async () => {
    const calls: Array<[string, unknown]> = [];
    // A RegExp has no JSON representation — it must not blow up downstream
    // serialization (it collapses to `{}`); values with a `toJSON` (ObjectId,
    // Date) collapse to their readable form instead.
    const sent = {
      filter: {
        re: /abc/g,
        id: { toJSON() { return 'o1' } },
        at: new Date('2026-09-01T00:00:00.000Z'),
      },
    };
    await traceDbOp(
      noopLogger,
      { db: 'app', collection: 'logs', op: 'mongo.findMany', params: sent },
      async () => [],
      withDebugQuery(calls),
    );

    const captured = calls[0]![1] as { filter: Record<string, unknown> };
    expect(captured.filter.re).toEqual({});
    expect(captured.filter.id).toBe('o1');
    expect(captured.filter.at).toBe('2026-09-01T00:00:00.000Z');
  });

  test('traceDbOp passes undefined params when meta.params is omitted', async () => {
    const calls: Array<[string, unknown]> = [];
    await traceDbOp(
      noopLogger,
      { db: 'app', collection: 'logs', op: 'mongo.countDocuments' },
      async () => 0,
      withDebugQuery(calls),
    );
    // debugQuery is still invoked (to time the op) but with undefined params.
    expect(calls).toHaveLength(1);
    expect(calls[0]![1]).toBeUndefined();
  });
});
