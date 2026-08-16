import type { Db, Document, FindOptions } from 'mongodb';
import { BadRequest } from '../errors.ts';
import type { ObjectField } from '../schema/types.ts';
import type { DriftMode } from '../schema/validate-doc/index.ts';
import { DEFAULT_FIND_LIMIT, DEFAULT_MAX_LIMIT } from '../shared/constants.ts';
import type { FilterInput } from '../shared/filter-types.ts';
import { buildKeysetFilter, decodeCursor, encodeCursor } from '../shared/keyset.ts';
import { normalizePageLimit } from '../shared/pagination-math.ts';
import { buildPaginationResult, type PaginationResult } from '../shared/pagination-result.ts';
import type {
  DbClientsDefinition,
  ExtractCollectionNames,
  ExtractCollectionType,
  ExtractDbNames,
} from '../types.ts';
import type { LoggerLike } from '../utils/logger.ts';
import { defineCrudOp } from './crud-op.ts';
import { checkDocsDrift } from './drift.ts';
import { type QueryOptions, resolveDriftMode } from './query-options.ts';
import { type DbOpMeta, traceDbOp } from './trace-db-op.ts';

export interface PaginationConfig {
  page?: number;
  limit?: number;
  sort?: Record<string, 1 | -1>;
  /** Cap on the requested limit (default DEFAULT_MAX_LIMIT=1000). */
  maxLimit?: number;
  /** Stages prepended to the data facet (e.g. extra $match). */
  prePipeline?: Document[];
  /** Stages appended inside the data facet. */
  postPipeline?: Document[];
  queryOptions?: QueryOptions;
}

export interface CursorPaginationConfig<T = Document> {
  limit?: number;
  /**
   * Sort keys (1 ascending / -1 descending). MUST include a unique tiebreaker —
   * typically `_id` — so cursor boundaries are unambiguous. Sort fields should
   * exist on every document for deterministic ordering.
   */
  sort: Record<string, 1 | -1>;
  /** Opaque cursor from a previous `nextCursor` — fetch the page after it. */
  after?: string;
  /** Opaque cursor — fetch the page before it (backward navigation). */
  before?: string;
  /** Cap on the requested limit (default DEFAULT_MAX_LIMIT). */
  maxLimit?: number;
  queryOptions?: QueryOptions;
}

export interface CursorPage<T> {
  data: T[];
  /** Opaque cursor for the next page in the queried direction, or null when exhausted. */
  nextCursor: string | null;
  /** True when another page exists in the queried direction. */
  hasMore: boolean;
}

type DocOf<
  TClients extends DbClientsDefinition,
  TDb extends ExtractDbNames<TClients>,
  C extends ExtractCollectionNames<TClients, TDb>,
> = ExtractCollectionType<TClients, TDb, C>;

export interface PaginationOpsOptions {
  resolveCollectionName: (logical: string) => string;
  wrapMongoErrors?: boolean;
  /** Service-level schema-drift policy for reads (default `'report'`). */
  drift?: DriftMode;
  /** Resolve the declared schema for a logical collection (drift detection). */
  getSchema?: (logical: string) => ObjectField | undefined;
}

/**
 * Pagination via a **single `$facet` aggregation round-trip**: `$match` +
 * `$facet { data: [sort/skip/limit/post], totalCount: [$count] }`. One network
 * call returns both the page and the total — the ORM's key pagination perf win
 * vs the classic count-then-find pattern.
 */
export const makePaginationOps = <
  TClients extends DbClientsDefinition,
  TDb extends ExtractDbNames<TClients>,
>(
  client: Db,
  dbLabel: string,
  logger: LoggerLike,
  opts: PaginationOpsOptions,
) => {
  type C = ExtractCollectionNames<TClients, TDb>;
  type DocOf2<X extends C> = DocOf<TClients, TDb, X>;

  const resolve = opts.resolveCollectionName;
  const trace = <T>(meta: DbOpMeta, fn: () => T | Promise<T>): Promise<T> =>
    traceDbOp(logger, meta, fn, { wrapMongoErrors: opts.wrapMongoErrors === true });
  const meta = (collection: C, op: string): DbOpMeta => ({
    collection: String(collection),
    physicalCollection: resolve(String(collection)),
    db: dbLabel,
    op,
  });
  const deps = { trace, meta };

  const paginateFlexible = async <X extends C>(
    collection: X,
    baseFilter: FilterInput<DocOf2<X>>,
    config: PaginationConfig = {},
  ): Promise<PaginationResult<DocOf2<X>>> => {
    const normalized = normalizePageLimit(
      { page: config.page, limit: config.limit },
      config.maxLimit ?? DEFAULT_MAX_LIMIT,
    );

    const dataStages: Document[] = [
      ...(config.prePipeline ?? []),
      ...(config.sort && Object.keys(config.sort).length > 0 ? [{ $sort: config.sort }] : []),
      { $skip: normalized.offset },
      { $limit: normalized.limit },
      ...(config.postPipeline ?? []),
    ];

    const pipeline: Document[] = [
      { $match: baseFilter },
      {
        $facet: {
          data: dataStages,
          totalCount: [{ $count: 'count' }],
        },
      },
    ];

    return defineCrudOp(
      deps,
      collection,
      'mongo.paginateFlexible',
      async (r) => {
        const aggOptions = {
          ...(r.driverOpts as Record<string, unknown>),
          session: r.sdk.session,
          maxTimeMS: r.sdk.maxTimeMS,
          hint: r.sdk.hint,
          batchSize: r.sdk.batchSize,
        };
        const rows = await client
          .collection<Document>(resolve(String(collection)))
          .aggregate(pipeline, aggOptions)
          .toArray();
        const row = rows[0] as
          | { data?: DocOf2<X>[]; totalCount?: Array<{ count: number }> }
          | undefined;
        const data = row?.data ?? [];
        const totalCount = row?.totalCount?.[0]?.count ?? 0;
        checkDocsDrift(
          {
            logger,
            db: dbLabel,
            drift: resolveDriftMode(config.queryOptions?.drift, opts.drift),
            getSchema: opts.getSchema,
          },
          String(collection),
          'mongo.paginateFlexible',
          data as Document[],
        );
        return buildPaginationResult(data, totalCount, normalized.page, normalized.limit);
      },
      config.queryOptions,
    );
  };

  /**
   * Keyset (cursor) pagination — O(log n) per page, stable under concurrent
   * writes, no total count. `after` walks forward from a `nextCursor`;
   * `before` walks backward. Sort must include a unique tiebreaker (`_id`).
   */
  const paginateCursor = async <X extends C>(
    collection: X,
    baseFilter: FilterInput<DocOf2<X>>,
    config: CursorPaginationConfig<DocOf2<X>>,
  ): Promise<CursorPage<DocOf2<X>>> => {
    const sortKeys = Object.entries(config.sort);
    if (sortKeys.length === 0) {
      throw new BadRequest(
        'paginateCursor: `sort` is required (include a unique tiebreaker like `_id`)',
      );
    }
    if (config.before !== undefined && config.after !== undefined) {
      throw new BadRequest('paginateCursor: provide either `after` or `before`, not both');
    }
    const limit = normalizePageLimit(
      { page: 1, limit: config.limit },
      config.maxLimit ?? DEFAULT_MAX_LIMIT,
      { limit: DEFAULT_FIND_LIMIT },
    ).limit;

    const backwards = config.before !== undefined && config.after === undefined;
    // In reversed space "after the cursor" == "before the cursor" in forward space.
    const effectiveSort: Record<string, 1 | -1> = backwards
      ? Object.fromEntries(sortKeys.map(([f, d]) => [f, (d * -1) as 1 | -1]))
      : config.sort;

    let filter: Document = baseFilter as Document;
    if (config.after !== undefined || config.before !== undefined) {
      const cursor = (config.after ?? config.before) as string;
      const decoded = decodeCursor(cursor);
      // Sort keys are ORDER-SENSITIVE: key precedence (primary/secondary/…)
      // defines the ordering, so a cursor built with a different key order is a
      // *different* sort and must be rejected — values are positional per key.
      if (JSON.stringify(decoded.sort) !== JSON.stringify(config.sort)) {
        throw new BadRequest('paginateCursor: cursor was created with a different sort');
      }
      if (decoded.values.length !== sortKeys.length) {
        throw new BadRequest('paginateCursor: cursor was created with a different sort');
      }
      filter = {
        $and: [baseFilter as Document, buildKeysetFilter(effectiveSort, decoded.values, 'after')],
      };
    }

    const rows = await defineCrudOp(
      deps,
      collection,
      'mongo.paginateCursor',
      async (r) => {
        const findOpts: FindOptions = {
          ...(r.driverOpts as FindOptions),
          session: r.sdk.session,
          maxTimeMS: r.sdk.maxTimeMS,
          hint: r.sdk.hint,
        };
        return client
          .collection<Document>(resolve(String(collection)))
          .find(filter, findOpts)
          .sort(effectiveSort as Document)
          .limit(limit + 1)
          .toArray();
      },
      config.queryOptions,
    );

    const hasMore = rows.length > limit;
    const page = backwards ? rows.slice(0, limit).reverse() : rows.slice(0, limit);
    checkDocsDrift(
      {
        logger,
        db: dbLabel,
        drift: resolveDriftMode(config.queryOptions?.drift, opts.drift),
        getSchema: opts.getSchema,
      },
      String(collection),
      'mongo.paginateCursor',
      page as unknown as Document[],
    );
    const boundary = backwards ? rows[limit] : page[page.length - 1];
    const nextCursor =
      hasMore && boundary !== undefined
        ? encodeCursor({
            sort: config.sort,
            values: sortKeys.map(([f]) => (boundary as Document)[f]),
          })
        : null;
    return { data: page as unknown as DocOf2<X>[], nextCursor, hasMore };
  };

  return { paginateFlexible, paginateCursor };
};
