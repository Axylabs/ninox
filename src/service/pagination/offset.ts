/**
 * Offset pagination strategy — `paginateFlexible`, via a **single `$facet`
 * aggregation round-trip**: `$match` + `$facet { data: [sort/skip/limit/post],
 * totalCount: [$count] }`. One network call returns both the page and the total
 * — the ORM's key pagination perf win vs the classic count-then-find pattern.
 */
import type { Document } from 'mongodb';
import { DEFAULT_MAX_LIMIT } from '../../shared/constants.ts';
import type { FilterInput } from '../../shared/filter-types.ts';
import { normalizePageLimit } from '../../shared/pagination-math.ts';
import { buildPaginationResult, type PaginationResult } from '../../shared/pagination-result.ts';
import type { DbClientsDefinition, ExtractCollectionNames, ExtractDbNames } from '../../types.ts';
import { defineCrudOp } from '../crud-op.ts';
import { checkDocsDrift } from '../drift.ts';
import { resolveDriftMode } from '../query-options.ts';
import type { PaginationConfig, PaginationCtx, PaginationDocOf } from './types.ts';

/** Build the `paginateFlexible` closure from the shared pagination context. */
export const makePaginateFlexible = <
  TClients extends DbClientsDefinition,
  TDb extends ExtractDbNames<TClients>,
>(
  ctx: PaginationCtx<TClients, TDb>,
) => {
  type C = ExtractCollectionNames<TClients, TDb>;
  type DocOf2<X extends C> = PaginationDocOf<TClients, TDb, X>;

  const { client, dbLabel, logger, opts, resolve, deps } = ctx;

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

  return { paginateFlexible };
};
