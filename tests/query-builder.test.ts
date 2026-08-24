import { describe, expect, test } from 'bun:test';
import type { Document } from 'mongodb';
import { QueryBuilder } from '../src/query-builder/query-builder.ts';

interface UserDoc extends Document {
  _id: unknown;
  email: string;
  role: string;
  createdAt: Date;
}

interface Capture {
  filter?: Document;
  options?: Record<string, unknown>;
  op?: string;
}

const makeBuilder = (capture: Capture) => {
  const collection = {
    find: (filter: Document, options: Record<string, unknown>) => {
      capture.filter = filter;
      capture.options = options;
      return { toArray: async (): Promise<UserDoc[]> => [] };
    },
    findOne: (filter: Document, options: Record<string, unknown>) => {
      capture.filter = filter;
      capture.options = options;
      return Promise.resolve(null);
    },
    countDocuments: (filter: Document, options: Record<string, unknown>) => {
      capture.filter = filter;
      capture.options = options;
      return Promise.resolve(0);
    },
  } as never;
  const ctx = {
    physicalName: 'users',
    collection,
    run: async <T>(
      op: string,
      filter: unknown,
      execute: (opts: never) => Promise<T>,
      options: unknown,
    ): Promise<T> => {
      capture.op = op;
      void filter;
      void options;
      return execute(options as never);
    },
  } as never;
  return new QueryBuilder<UserDoc>(ctx);
};

describe('QueryBuilder', () => {
  test('compiles where + sort + limit into driver find options', async () => {
    const capture: Capture = {};
    const qb = makeBuilder(capture);
    await qb.where({ role: 'admin' }).sort({ createdAt: -1 }).limit(5).many();
    expect(capture.filter).toEqual({ role: 'admin' });
    expect(capture.options?.sort).toEqual({ createdAt: -1 });
    expect(capture.options?.limit).toBe(5);
  });

  test('select pushes a projection to the driver', async () => {
    const capture: Capture = {};
    const qb = makeBuilder(capture);
    await qb.where({ role: 'admin' }).select(['email', 'role']).many();
    expect(capture.options?.projection).toEqual({ email: 1, role: 1 });
  });

  test('one() forces limit 1', async () => {
    const capture: Capture = {};
    const qb = makeBuilder(capture);
    await qb.where({ email: 'a@b.c' }).one();
    expect(capture.op).toBe('mongo.getOne');
    expect(capture.options?.limit).toBe(1);
  });

  test('many() defaults limit to 100', async () => {
    const capture: Capture = {};
    const qb = makeBuilder(capture);
    await qb.where({}).many();
    expect(capture.options?.limit).toBe(100);
  });

  test('and() / or() compose filters', async () => {
    const capture: Capture = {};
    const qb = makeBuilder(capture);
    await qb.where({ role: 'user' }).or({ age: 1 }, { age: 2 }).limit(10).many();
    expect(capture.filter?.$and).toHaveLength(2);
    expect(((capture.filter as Document).$and as Document[])[1]!.$or).toHaveLength(2);
  });

  test('chains are immutable — derived builders never contaminate the base', async () => {
    const capture: Capture = {};
    const qb = makeBuilder(capture);
    const base = qb.where({ role: 'admin' });
    await base.where({ age: { $gte: 18 } }).many();
    expect((capture.filter as Document).age).toEqual({ $gte: 18 });
    // The base builder is untouched by the derived chain.
    expect(base.filter).toEqual({ role: 'admin' });
  });

  test('where() deep-merges operator docs per key (no silent clause loss)', () => {
    const capture: Capture = {};
    const qb = makeBuilder(capture);
    const merged = qb
      .where({ role: 'user' })
      .where({ age: { $gte: 18 } })
      .where({ age: { $lte: 65 } });
    expect(merged.filter).toEqual({
      role: 'user',
      age: { $gte: 18, $lte: 65 },
    });
  });

  test('repeated and() stays flat (no quadratic $and nesting)', () => {
    const capture: Capture = {};
    const qb = makeBuilder(capture);
    let q = qb.where({});
    for (let i = 0; i < 5; i++) q = q.and({ i } as never);
    const filter = q.filter as Document;
    // Flat $and of the 5 clauses — empty base filters are dropped, not nested.
    expect(filter.$and).toHaveLength(5);
    for (let i = 0; i < 5; i++) expect((filter.$and as Document[])[i]).toEqual({ i });
  });

  test('or() without filters throws BadRequest instead of building an invalid $or', () => {
    const capture: Capture = {};
    const qb = makeBuilder(capture);
    expect(() => qb.or()).toThrow();
  });

  test('exists() projects _id only and reports match/no-match', async () => {
    const capture: Capture = {};
    const ctx = makeBuilder(capture) as unknown as { ctx: unknown };
    void ctx;
    // exists uses the same fake run/collection; findOne resolves null → false.
    const noneCapture: Capture = {};
    expect(await makeBuilder(noneCapture).exists()).toBe(false);

    const someCapture: Capture = {};
    const collection = {
      find: () => ({ toArray: async () => [] }),
      findOne: (_f: Document, options: Record<string, unknown>) => {
        someCapture.options = options;
        return Promise.resolve({ _id: 'x' });
      },
      countDocuments: () => Promise.resolve(0),
    } as never;
    const ctxSome = {
      physicalName: 'users',
      collection,
      run: async <T>(
        op: string,
        _f: unknown,
        execute: (o: never) => Promise<T>,
        o: unknown,
      ): Promise<T> => {
        someCapture.op = op;
        return execute(o as never);
      },
    } as never;
    expect(await new QueryBuilder<UserDoc>(ctxSome).exists()).toBe(true);
    expect(someCapture.options?.projection).toEqual({ _id: 1 });
    expect(someCapture.op).toBe('mongo.exists');
  });
});
