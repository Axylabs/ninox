import type {
  Collection,
  Document,
  Filter,
  FindCursor,
  FindOptions,
  Hint,
  Sort,
  WithId,
} from 'mongodb';
import { BadRequest } from '../errors/index.ts';
import type { QueryOptions } from '../service/query-options.ts';
import { DEFAULT_FIND_LIMIT } from '../shared/constants.ts';
import type { FilterInput } from '../shared/filter-types.ts';

/**
 * Execution context provided by the CRUD layer. `run` participates in the
 * uniform trace + retry + cache + in-flight-dedup pipeline and returns the
 * merged driver options to the execute closure.
 */
export interface QueryBuilderContext<TDoc extends Document> {
  physicalName: string;
  collection: Collection<TDoc>;
  run: <T>(
    opName: string,
    filter: FilterInput<TDoc>,
    execute: (driverOpts: FindOptions) => Promise<T>,
    options?: QueryOptions,
  ) => Promise<T>;
}

/**
 * Merge an incoming filter into the current one WITHOUT silently dropping
 * clauses: plain-object values are treated as operator documents
 * (`{ $gte: 18 }`) and deep-merged per key so
 * `.where({ age: { $gte: 18 } }).where({ age: { $lte: 65 } })`
 * yields `{ age: { $gte: 18, $lte: 65 } }` instead of losing the `$gte`.
 * Scalars/arrays replace (last write wins), matching Mongo semantics.
 */
const mergeFilterKey = (prev: unknown, next: unknown): unknown => {
  if (
    prev !== null &&
    typeof prev === 'object' &&
    !Array.isArray(prev) &&
    next !== null &&
    typeof next === 'object' &&
    !Array.isArray(next)
  ) {
    return { ...(prev as Document), ...(next as Document) };
  }
  return next;
};

/**
 * Lazy, fluent, IMMUTABLE, schema-typed query builder. Every chain method
 * returns a NEW builder — a stored base query can be safely reused as a
 * template without derived chains contaminating it:
 *
 *   const admins = users.query('users').where({ role: 'admin' });
 *   await admins.where({ age: { $gte: 18 } }).many(); // base unchanged
 *
 * Nothing hits the database until an executor (`one`/`many`/`cursor`/`count`/
 * `exists`) is called. Projections via `select` are pushed to the driver so
 * only requested fields are transferred.
 */
export class QueryBuilder<TDoc extends Document, TSelection = TDoc> {
  private _filter: FilterInput<TDoc> = {};
  private _sort?: Sort;
  private _skip?: number;
  private _limit?: number;
  private _projection?: Document;
  private _options: QueryOptions = {};

  constructor(private readonly ctx: QueryBuilderContext<TDoc>) {}

  get filter(): FilterInput<TDoc> {
    return this._filter;
  }

  /** Copy-on-write fork used by every chain method. */
  private fork(): QueryBuilder<TDoc, TSelection> {
    const next = new QueryBuilder<TDoc, TSelection>(this.ctx);
    next._filter = this._filter;
    if (this._sort !== undefined) next._sort = this._sort;
    if (this._skip !== undefined) next._skip = this._skip;
    if (this._limit !== undefined) next._limit = this._limit;
    if (this._projection !== undefined) next._projection = this._projection;
    next._options = { ...this._options };
    return next;
  }

  /** Merge a filter into the current one (operator docs deep-merge per key). */
  where(filter: FilterInput<TDoc>): QueryBuilder<TDoc, TSelection> {
    const next = this.fork();
    const merged: Document = { ...(next._filter as Document) };
    for (const [key, value] of Object.entries(filter as Document)) {
      merged[key] = key in merged ? mergeFilterKey(merged[key], value) : value;
    }
    next._filter = merged as FilterInput<TDoc>;
    return next;
  }

  /** AND-combine the current filter with a new one (stays flat across repeats). */
  and(filter: FilterInput<TDoc>): QueryBuilder<TDoc, TSelection> {
    const next = this.fork();
    const current = next._filter as Document;
    const existing = Array.isArray(current.$and)
      ? (current.$and as Document[])
      : Object.keys(current).length > 0
        ? [current]
        : [];
    next._filter = { $and: [...existing, filter] } as unknown as FilterInput<TDoc>;
    return next;
  }

  /**
   * OR-combine: current filter AND (filter1 OR filter2 ...). Requires at least
   * one filter — an empty `$or` is rejected by the server.
   */
  or(...filters: Array<FilterInput<TDoc>>): QueryBuilder<TDoc, TSelection> {
    if (filters.length === 0) {
      throw new BadRequest('QueryBuilder.or() requires at least one filter');
    }
    return this.and((filters.length === 1 ? filters[0]! : { $or: filters }) as FilterInput<TDoc>);
  }

  /** Set the sort order (`{ field: 1 | -1 }`). */
  sort(sort: Sort): QueryBuilder<TDoc, TSelection> {
    const next = this.fork();
    next._sort = sort;
    return next;
  }

  /** Skip the first `n` matching documents. */
  skip(n: number): QueryBuilder<TDoc, TSelection> {
    const next = this.fork();
    next._skip = n;
    return next;
  }

  /** Limit the result set to `n` documents. */
  limit(n: number): QueryBuilder<TDoc, TSelection> {
    const next = this.fork();
    next._limit = n;
    return next;
  }

  /** Project only the given fields — the projection is pushed to the driver. */
  select<const K extends keyof TSelection>(
    fields: readonly K[],
  ): QueryBuilder<TDoc, Pick<TSelection, K>> {
    const next = this.fork() as unknown as QueryBuilder<TDoc, Pick<TSelection, K>>;
    const projection: Record<string, 1> = {};
    for (const field of fields) projection[field as string] = 1;
    (next as unknown as { _projection?: Document })._projection = projection;
    return next;
  }

  /** Raw projection document (`{ field: 1 }` / `{ field: 0 }`). */
  project(projection: Document): QueryBuilder<TDoc, TSelection> {
    const next = this.fork();
    next._projection = projection;
    return next;
  }

  /** Set the index hint. */
  hint(hint: Hint): QueryBuilder<TDoc, TSelection> {
    const next = this.fork();
    next._options.hint = hint;
    return next;
  }

  /** Set the driver cursor batch size. */
  batchSize(n: number): QueryBuilder<TDoc, TSelection> {
    const next = this.fork();
    next._options.batchSize = n;
    return next;
  }

  /** Run the query inside a transaction session. */
  session(session: NonNullable<QueryOptions['session']>): QueryBuilder<TDoc, TSelection> {
    const next = this.fork();
    next._options.session = session;
    return next;
  }

  /** Cap server-side execution time. */
  maxTimeMS(ms: number): QueryBuilder<TDoc, TSelection> {
    const next = this.fork();
    next._options.maxTimeMS = ms;
    return next;
  }

  /** Bypass the read cache for this query when `false`. */
  cache(on: boolean): QueryBuilder<TDoc, TSelection> {
    const next = this.fork();
    next._options.cache = on;
    return next;
  }

  /** Override in-flight dedup for this query when set. */
  dedupe(on: boolean): QueryBuilder<TDoc, TSelection> {
    const next = this.fork();
    next._options.dedupe = on;
    return next;
  }

  /** Compile the builder into driver options (does not execute). */
  private compile(): FindOptions & QueryOptions {
    const out: FindOptions & QueryOptions = { ...this._options };
    if (this._sort) out.sort = this._sort;
    if (this._skip !== undefined) out.skip = this._skip;
    if (this._limit !== undefined) out.limit = this._limit;
    if (this._projection) out.projection = this._projection;
    return out;
  }

  private countOptions(): FindOptions & QueryOptions {
    // countDocuments accepts skip/limit/session/hint/maxTimeMS but NOT sort/projection.
    const out: FindOptions & QueryOptions = { ...this._options };
    if (this._skip !== undefined) out.skip = this._skip;
    if (this._limit !== undefined) out.limit = this._limit;
    return out;
  }

  /** Fetch one document (limit forced to 1). */
  async one(): Promise<WithId<TSelection> | null> {
    const options = this.compile();
    if (options.limit === undefined) options.limit = 1;
    return this.ctx.run<WithId<TSelection> | null>(
      'mongo.getOne',
      this._filter,
      (opts) =>
        this.ctx.collection.findOne(
          this._filter as unknown as Filter<TDoc>,
          opts,
        ) as unknown as Promise<WithId<TSelection> | null>,
      options,
    );
  }

  /** Fetch many documents (default limit 100 when unset). */
  async many(): Promise<WithId<TSelection>[]> {
    const options = this.compile();
    if (options.limit === undefined) options.limit = DEFAULT_FIND_LIMIT;
    return this.ctx.run<WithId<TSelection>[]>(
      'mongo.findMany',
      this._filter,
      (opts) =>
        this.ctx.collection
          .find(this._filter as unknown as Filter<TDoc>, opts)
          .toArray() as unknown as Promise<WithId<TSelection>[]>,
      options,
    );
  }

  /** Streaming cursor (raw driver cursor; no retry/cache/drift — caller-owned). */
  cursor(): FindCursor<WithId<TDoc>> {
    return this.ctx.collection.find(
      this._filter as unknown as Filter<TDoc>,
      this.compile() as FindOptions,
    );
  }

  /** Count matching documents. */
  async count(): Promise<number> {
    return this.ctx.run(
      'mongo.countDocuments',
      this._filter,
      (opts) => this.ctx.collection.countDocuments(this._filter as unknown as Filter<TDoc>, opts),
      this.countOptions() as QueryOptions,
    );
  }

  /** True when at least one document matches (`_id`-only projection — no doc transfer). */
  async exists(): Promise<boolean> {
    const options = this.compile();
    if (options.limit === undefined) options.limit = 1;
    options.projection = { _id: 1 };
    const doc = await this.ctx.run<WithId<TDoc> | null>(
      'mongo.exists',
      this._filter,
      (opts) =>
        this.ctx.collection.findOne(
          this._filter as unknown as Filter<TDoc>,
          opts,
        ) as unknown as Promise<WithId<TDoc> | null>,
      options,
    );
    return doc !== null;
  }
}
