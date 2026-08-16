import type {
  AggregateOptions,
  AggregationCursor,
  ClientSession,
  Db,
  Document,
  Filter,
  Hint,
} from 'mongodb';
import { BadRequest } from '../errors.ts';
import { DEFAULT_MAX_LIMIT } from '../shared/constants.ts';
import type { FilterInput } from '../shared/filter-types.ts';
import { normalizePageLimit } from '../shared/pagination-math.ts';
import { buildPaginationResult, type PaginationResult } from '../shared/pagination-result.ts';
import type {
  DbClientsDefinition,
  ExtractCollectionNames,
  ExtractCollectionType,
  ExtractDbNames,
} from '../types.ts';
import type { LoggerLike } from '../utils/logger.ts';
import { buildSearchStages, type SearchConfig } from './aggregation-pipeline.ts';
import { type AggregationStages, buildAggregationStages } from './aggregation-stages.ts';
import { type CrudOpDeps, defineCrudOp } from './crud-op.ts';
import { PipelineBuilder } from './pipeline-builder.ts';
import type { QueryOptions } from './query-options.ts';
import { type DbOpMeta, traceDbOp } from './trace-db-op.ts';

export interface GroupByConfig {
  /** Group key: a field name or a document of `$`-expressions. */
  groupBy: string | Record<string, unknown>;
  /** Accumulator expressions, e.g. `{ revenue: { $sum: '$total' } }`. */
  accumulate?: Record<string, unknown>;
  /** Sort the grouped output. */
  sort?: Record<string, 1 | -1>;
  /** Cap the number of groups returned. */
  limit?: number;
}

export interface DateRangeConfig {
  /** Date field to bucket on (must exist on every doc). */
  dateField: string;
  /** Inclusive range start. */
  startDate: Date;
  /** Inclusive range end. */
  endDate: Date;
  /** Bucket granularity (default `day`). */
  granularity?: 'hour' | 'day' | 'week' | 'month' | 'year';
}

export interface LookupConfig {
  /** Related (logical) collection to join. */
  fromCollection: string;
  /** Field on the source docs holding the foreign key. */
  localField: string;
  /** Field on the foreign docs to match. */
  foreignField: string;
  /** Output field name for the joined array. */
  as: string;
  /** Optional `$pipeline` limiting/filtering the joined docs. */
  pipeline?: Document[];
  /** When true, `$unwind` the joined array (preserving nulls). */
  unwindSingle?: boolean;
}

export interface PipelineCustomization {
  /** Stages prepended before the generated aggregation. */
  prePipeline?: Document[];
  /** Stages appended after the generated aggregation. */
  postPipeline?: Document[];
}

type DocOf<
  TClients extends DbClientsDefinition,
  TDb extends ExtractDbNames<TClients>,
  C extends ExtractCollectionNames<TClients, TDb>,
> = ExtractCollectionType<TClients, TDb, C>;

export interface AggregationOpsOptions {
  resolveCollectionName: (logical: string) => string;
  wrapMongoErrors?: boolean;
}

const mergeAggOptions = (
  driverOpts: Record<string, unknown>,
  sdk: { session?: ClientSession; maxTimeMS?: number; hint?: Hint; batchSize?: number },
): AggregateOptions => ({
  ...(driverOpts as AggregateOptions),
  session: sdk.session,
  maxTimeMS: sdk.maxTimeMS,
  hint: sdk.hint,
  batchSize: sdk.batchSize,
});

const DATE_PART_FORMATS: Record<NonNullable<DateRangeConfig['granularity']>, string> = {
  hour: '%Y-%m-%dT%H',
  day: '%Y-%m-%d',
  week: '%Y-W%V',
  month: '%Y-%m',
  year: '%Y',
};

export const makeAggregationOps = <
  TClients extends DbClientsDefinition,
  TDb extends ExtractDbNames<TClients>,
>(
  client: Db,
  dbLabel: string,
  logger: LoggerLike,
  opts: AggregationOpsOptions,
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
  const coll = (collection: C) => client.collection<Document>(resolve(String(collection)));

  /** Low-level aggregate: returns a live cursor wrapped in the op pipeline. */
  const aggregate = async <X extends C, TResult extends Document = Document>(
    collection: X,
    pipelineBuilder: (stages: AggregationStages<DocOf2<X>, TClients, TDb>) => Document[],
    options?: AggregateOptions & QueryOptions,
  ): Promise<AggregationCursor<TResult>> => {
    const stages = buildAggregationStages<DocOf2<X>, TClients, TDb>();
    const pipeline = pipelineBuilder(stages);
    return defineCrudOp(
      deps,
      collection,
      'mongo.aggregate',
      (r) => coll(collection).aggregate<TResult>(pipeline, mergeAggOptions(r.driverOpts, r.sdk)),
      options,
    );
  };

  /**
   * Fully type-safe, chainable pipeline builder. Each stage is typed against
   * the current document shape, `$lookup` sub-pipelines are scoped to the
   * related collection, and `$facet` branches get typed sub-builders — the
   * result type of `.toArray()` / `.first()` is inferred through the chain.
   */
  const pipeline = <const X extends C>(
    collection: X,
    options?: AggregateOptions & QueryOptions,
  ): PipelineBuilder<TClients, TDb, DocOf2<X>> =>
    new PipelineBuilder<TClients, TDb, DocOf2<X>>({
      logical: collection,
      coll: () => coll(collection),
      crudDeps: deps as unknown as CrudOpDeps<string>,
      mergeDriver: mergeAggOptions,
      options,
    });

  /** Group documents by a key with optional accumulators/sort/limit (e.g. revenue per status). */
  const groupBy = async <X extends C, TResult extends Document = Document>(
    collection: X,
    baseFilter: FilterInput<DocOf2<X>>,
    config: GroupByConfig,
    customization: PipelineCustomization = {},
    options?: AggregateOptions & QueryOptions,
  ): Promise<TResult[]> => {
    if (config.limit !== undefined && (!Number.isFinite(config.limit) || config.limit < 0)) {
      throw new BadRequest('groupBy: `limit` must be a non-negative finite number');
    }
    const pipeline: Document[] = [
      ...(customization.prePipeline ?? []),
      { $match: baseFilter },
      { $group: { _id: config.groupBy, ...(config.accumulate ?? {}) } },
      ...(config.sort && Object.keys(config.sort).length > 0 ? [{ $sort: config.sort }] : []),
      ...(config.limit !== undefined ? [{ $limit: config.limit }] : []),
      ...(customization.postPipeline ?? []),
    ];
    return defineCrudOp(
      deps,
      collection,
      'mongo.groupBy',
      (r) =>
        coll(collection)
          .aggregate<TResult>(pipeline, mergeAggOptions(r.driverOpts, r.sdk))
          .toArray(),
      options,
    );
  };

  /** Full-text / regex search with `$facet` pagination and optional score-sorting. */
  const textSearch = async <X extends C>(
    collection: X,
    baseFilter: FilterInput<DocOf2<X>>,
    searchConfig: SearchConfig,
    paginationConfig: {
      page?: number;
      limit?: number;
      sort?: Record<string, 1 | -1>;
      maxLimit?: number;
    } = {},
    customization: PipelineCustomization = {},
    options?: AggregateOptions & QueryOptions,
  ): Promise<PaginationResult<DocOf2<X> & { searchScore?: number }>> => {
    const normalized = normalizePageLimit(
      { page: paginationConfig.page, limit: paginationConfig.limit },
      paginationConfig.maxLimit ?? DEFAULT_MAX_LIMIT,
    );
    const searchStages = buildSearchStages(
      baseFilter as unknown as Filter<DocOf2<X>>,
      searchConfig,
    );
    const pipeline: Document[] = [
      ...(customization.prePipeline ?? []),
      ...searchStages,
      {
        $facet: {
          data: [
            ...(searchConfig.sortByScore
              ? [{ $sort: { searchScore: { $meta: 'textScore' } } }]
              : []),
            ...(paginationConfig.sort && Object.keys(paginationConfig.sort).length > 0
              ? [{ $sort: paginationConfig.sort }]
              : []),
            { $skip: normalized.offset },
            { $limit: normalized.limit },
            ...(customization.postPipeline ?? []),
          ],
          totalCount: [{ $count: 'count' }],
        },
      },
    ];
    return defineCrudOp(
      deps,
      collection,
      'mongo.textSearch',
      async (r) => {
        const rows = await coll(collection)
          .aggregate(pipeline, mergeAggOptions(r.driverOpts, r.sdk))
          .toArray();
        const row = rows[0] as
          | {
              data?: Array<DocOf2<X> & { searchScore?: number }>;
              totalCount?: Array<{ count: number }>;
            }
          | undefined;
        const data = row?.data ?? [];
        const totalCount = row?.totalCount?.[0]?.count ?? 0;
        return buildPaginationResult(data, totalCount, normalized.page, normalized.limit);
      },
      options,
    );
  };

  /** Aggregate a metric over date buckets (hour/day/week/month/year) within a range. */
  const dateRangeAnalysis = async <X extends C, TResult extends Document = Document>(
    collection: X,
    baseFilter: FilterInput<DocOf2<X>>,
    dateConfig: DateRangeConfig,
    analysisConfig: {
      accumulate?: Record<string, unknown>;
      sort?: Record<string, 1 | -1>;
      limit?: number;
    } = {},
    customization: PipelineCustomization = {},
    options?: AggregateOptions & QueryOptions,
  ): Promise<TResult[]> => {
    if (
      analysisConfig.limit !== undefined &&
      (!Number.isFinite(analysisConfig.limit) || analysisConfig.limit < 0)
    ) {
      throw new BadRequest('dateRangeAnalysis: `limit` must be a non-negative finite number');
    }
    const granularity = dateConfig.granularity ?? 'day';
    const format = DATE_PART_FORMATS[granularity];
    const datePart = {
      $dateToString: { format, date: `$${dateConfig.dateField}` },
    };
    const pipeline: Document[] = [
      ...(customization.prePipeline ?? []),
      {
        $match: {
          ...baseFilter,
          [dateConfig.dateField]: { $gte: dateConfig.startDate, $lte: dateConfig.endDate },
        },
      },
      { $group: { _id: datePart, ...(analysisConfig.accumulate ?? {}) } },
      ...(analysisConfig.sort && Object.keys(analysisConfig.sort).length > 0
        ? [{ $sort: analysisConfig.sort }]
        : []),
      ...(analysisConfig.limit !== undefined ? [{ $limit: analysisConfig.limit }] : []),
      ...(customization.postPipeline ?? []),
    ];
    return defineCrudOp(
      deps,
      collection,
      'mongo.dateRangeAnalysis',
      (r) =>
        coll(collection)
          .aggregate<TResult>(pipeline, mergeAggOptions(r.driverOpts, r.sdk))
          .toArray(),
      options,
    );
  };

  /** Join related docs via `$lookup` + optional `$unwind` (single collection hop). */
  const lookupJoin = async <X extends C, TResult extends Document = DocOf2<X>>(
    collection: X,
    baseFilter: FilterInput<DocOf2<X>>,
    lookups: LookupConfig[],
    customization: PipelineCustomization = {},
    options?: AggregateOptions & QueryOptions,
  ): Promise<TResult[]> => {
    const pipeline: Document[] = [
      ...(customization.prePipeline ?? []),
      { $match: baseFilter },
      ...lookups.map((lookup) => ({
        $lookup: {
          from: resolve(lookup.fromCollection),
          localField: lookup.localField,
          foreignField: lookup.foreignField,
          as: lookup.as,
          ...(lookup.pipeline ? { pipeline: lookup.pipeline } : {}),
        },
      })),
      ...lookups
        .filter((lookup) => lookup.unwindSingle)
        .map((lookup) => ({
          $unwind: { path: `$${lookup.as}`, preserveNullAndEmptyArrays: true },
        })),
      ...(customization.postPipeline ?? []),
    ];
    return defineCrudOp(
      deps,
      collection,
      'mongo.lookupJoin',
      (r) =>
        coll(collection)
          .aggregate<TResult>(pipeline, mergeAggOptions(r.driverOpts, r.sdk))
          .toArray(),
      options,
    );
  };

  return { aggregate, pipeline, groupBy, textSearch, dateRangeAnalysis, lookupJoin };
};
