# STRUCTURE — ninox

Layered like `@platform-tooling/sdk-db`: **pure helpers → op factories →
per-database manager**. All imports use `.ts` extensions (bundler resolution).

```
index.ts                       # runnable smoke demo (bun run index.ts)
src/
  index.ts                     # public barrel (named exports)
  types.ts                     # DBClientDefinition / CollectionDefinition / Extract* inference
  errors.ts                    # AppError taxonomy + ERROR_HTTP_STATUS + mapMongoDriverError / serializeError
  mongo-helpers.ts             # withRetry (transient errors) + withTransaction
  collection-name.ts           # logical → physical name resolution (prefix/overrides)
  connection-uri.ts            # normalizeMongoUrl (retryWrites/w/directConnection)
  capabilities.ts              # transaction capability probe + env override
  graceful-transaction.ts      # transaction-or-null fallback wrapper
  migrations.ts                # file-based migration runner (NNN_name.ts, _migrations journal)
  toolkit.ts                   # createMongoToolkit = service + migrations

  schema/                      # ★ typed schema DSL → $jsonSchema (the core feature)
    types.ts                   # field builders (s.*, incl. s.jsonSchema escape hatch) + Chainable modifiers
    collections.ts             # ★ defineCollection / defineCollections — schema-driven names
    infer.ts                   # InferField / InferDoc (TS type from schema)
    json-schema.ts             # MongoJsonSchema fragment type (shared by DSL + converter)
    to-mongo-schema.ts         # toMongoSchema / toMongoValidator ($jsonSchema conversion)
    validate-doc.ts            # ★ runtime read-side drift check: validateDoc(schema, doc) → DriftIssue[]
    index.ts

  repository/                  # ★ optional domain-typed wrapper over a manager
    repository.ts              # createRepository(manager, collection) — getById/create/page/populate…

  shared/                      # backend-neutral helpers
    constants.ts               # DEFAULT_MAX_LIMIT / DEFAULT_FIND_LIMIT
    pagination-math.ts         # normalizePageLimit
    pagination-result.ts       # buildPaginationResult / PaginationResult
    soft-delete.ts             # buildMongoActiveFilter / mergeMongoActiveFilter
    strip-primary-key.ts       # stripDocumentId
    merge-filters.ts           # mergeMongoFilters
    keyset.ts                  # ★ keyset pagination: buildKeysetFilter + cursor codec
    types.ts                   # RemoveIndexSignature / GeoPoint
    index.ts

  utils/                       # zero-dep utilities
    lru.ts                     # hand-rolled LRU
    logger.ts                  # LoggerLike + console/noop loggers
    timeout.ts                 # withTimeout / sleep
    hash.ts                    # stableStringify / stableHash (cache keys)
    cache.ts                   # createCached(Async)Factory (in-flight dedup)
    index.ts

  service/                     # op factories → one manager per DB
    index.ts                   # createMongoService → buildManager (spreads all ops) + health()
    connection.ts              # one MongoClient per URL + rollback-on-failure
    query-options.ts           # SDK vs driver option split
    crud-op.ts                 # defineCrudOp (resolve → trace → retry)
    trace-db-op.ts             # structured start/ok/error logging
    crud.ts                    # makeCrudOps (all CRUD + cache + dedup + hooks + timestamps)
    pagination.ts              # makePaginationOps → paginateFlexible ($facet) + paginateCursor (keyset)
    aggregation.ts             # makeAggregationOps (groupBy/textSearch/dateRange/lookupJoin/aggregate/pipeline)
    aggregation-stages.ts      # buildAggregationStages (collection-typed callback stages + $geoNear)
    aggregation-pipeline.ts    # regex/$text search stage builders
    pipeline-builder.ts        # ★ PipelineBuilder — chained, fully type-safe db.pipeline() (+ $geoNear)
    pipeline-types.ts          # ★ type model: Projection/Grouped/Unwound/LookupSpecFor/FacetSpec/GeoNearSpec/…
    schema-ops.ts              # makeSchemaOps (createSchema/updateSchema + indexes)
    drift.ts                   # ★ shared drift checker (report/throw on schema drift for read ops)
    transaction.ts             # makeTransactionOps (transaction/migrate)
    update-format.ts           # formatUpdateFilter ($set wrap)

  query-builder/               # fluent, lazy, schema-typed query builder
    query-builder.ts           # .where/.or/.sort/.limit/.select → .one/.many/.cursor/...

  loader/                      # ★ perf: batching
    dataloader.ts              # DataLoader (microtask flush, batch, cache, keyOf)

  relation/                    # ★ perf: N+1 elimination
    relation.ts                # belongsTo / hasMany / manyToMany (schema-validated, typed as fields)
    populate.ts                # makePopulator → batched $in population

  cache/                       # ★ perf: caching
    query-cache.ts             # LRU + TTL + per-collection invalidation
    in-flight.ts               # InFlight (concurrent identical query coalescing)
    hot-cache.ts               # ★ createHotCache — opt-in LRU read cache
                               #   (replica → change-stream invalidation,
                               #    standalone → global refresh ticker)
    index.ts

  hooks/                       # lifecycle middleware
    hooks.ts                   # HookMap / runHooks

tests/                         # bun:test suites (see README)
  pipeline.test.ts             # runtime suite for the typed aggregation pipeline
  hot-cache.test.ts            # HotCache unit + standalone ticker + replica fallback
  hot-cache-mongo.test.ts      # HotCache real-Mongo data-integrity / no-side-effects
bench/
  run-bench.ts                 # optimization harness → results/summary.json
  results/summary.json         # latest benchmark output
examples/                      # runnable live-Mongo examples (bun run examples/<file>.ts)
  shared/schema.ts             # canonical schema registry (defineCollections)
  shared/setup.ts              # connect/close helpers (unique DB per example)
  01-crud.ts … 09-perf-defaults.ts
  10-typed-pipeline.ts         # db.pipeline() — type-safe aggregation
  11-timestamps.ts             # auto createdAt/updatedAt
  12-keyset-pagination.ts      # paginateCursor
  13-geo.ts                    # s.geoPoint() + $geoNear
  14-repository.ts             # createRepository()
  15-hot-cache.ts              # global HotCache (replica watch / standalone ticker)
  16-hooks.ts                  # per-collection lifecycle hooks
  17-crud-advanced.ts          # bulkWrite/bulkUpsert/distinct/replaceOne/…
  18-health-watch.ts           # service.health() + eachDb + watchCollection
  19-text-search.ts            # textSearch ($text/$regex) + lookupJoin
  20-cache-watch.ts            # cacheWatch: change-stream cache invalidation
```

## Data flow

```
createMongoToolkit(dbClients, config)
  └─ createMongoService            (service/index.ts)
       └─ makeConnections          (connection.ts: one MongoClient per URL)
            └─ buildManager        (service/index.ts: spreads make*Ops)
                 ├─ makeCrudOps        → CRUD (cache/dedup/hooks aware)
                 ├─ makePaginationOps  → paginateFlexible
                 ├─ makeAggregationOps → groupBy/textSearch/…/aggregate
                 ├─ makeSchemaOps      → createSchema/updateSchema
                 ├─ makeTransactionOps → transaction/migrate
                 ├─ populate           → DataLoader-batched relations
                 └─ client             → raw Db() escape hatch
```

Every op funnels through `defineCrudOp` = `resolveQueryOptions` (SDK vs driver)
→ `traceDbOp` (structured logs) → `withRetry` (transient-only). Reads go through
`read()` which layers the optional query cache and in-flight dedup on top.
