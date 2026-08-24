# Changelog

All notable changes to `ninox` are documented here. The format is
based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this
project adheres to [Semantic Versioning](https://semver.org/).

## [Unreleased]

### Fixed

- **CRUD cache-key identity** — the cache key now includes the op name (and
  `distinct`'s field), so `getOne` / `countDocuments` / `distinct` on the same
  filter can never be served each other's cached results. The key hash is a
  dual-round ~64-bit digest instead of single-round djb2, and it is computed
  once per read and shared with the dedup key. Pure retry knobs (`maxAttempts`,
  `retryDelayMs`, `dedupe`, `cache`, `retryWrites`) no longer fragment keys;
  `drift` still does (a `'throw'` read must never serve an unvalidated entry).
- **Migration journal** — claims are now lease-based (`leaseMs`, auto-renewed
  during long `up()`s) with a unique index on the journal `name`. A crashed
  runner's claim is stolen only after lease expiry, live claims are never
  stolen, `markApplied` re-inserts when its row vanished concurrently (no more
  silent re-application), journal rows sort by NUMERIC prefix, `down(target)`
  validates the target before rolling anything back, and `create()` scaffolds
  atomically (`wx`) so concurrent calls can't clobber files. New runner
  options: `db` (which connected database to target in multi-DB services),
  `leaseMs`.
- **Connection strings** — `mongodb+srv://` URIs no longer get
  `directConnection=true` appended (the driver rejects that combination), and
  multi-host seed lists are normalized correctly (manual query parsing — the
  WHATWG parser rejects `h1:27017,h2:27017`).
- **Connections** — concurrent `makeConnections()` share one connect promise
  per URL (the check-then-act race used to leak the losing client's pool).
- **Transactions** — one shared `isTransactionUnsupportedError` predicate for
  both fallback layers; unknown capability state now ATTEMPTS the transaction
  instead of silently downgrading; the unsupported warning fires once.
- **Schema numeric kinds** — `s.double()` emits `bsonType: ['double','int','long']`
  and `s.integer()`/`s.long()` emit wire unions with `multipleOf: 1`: type-correct
  TS numbers (`3_000_000_000`, `{ rating: 5 }`) pass the DB validator again while
  server-side integrality is preserved. Enums fall back to the numeric union when
  members exceed int32 range.
- **Populate** — joins attach to COPIES of the source docs (a populated result
  set can no longer poison the shared query cache), independent relations run
  concurrently, relations sharing a target collection+field share one `$in`
  batch, and m:n targets are deduped across duplicate pivot rows.
- **QueryBuilder** — chains are immutable (stored base queries are safe as
  templates), `where()` deep-merges operator docs (`$gte` + `$lte` compose
  instead of the last write silently winning), repeated `and()` stays flat,
  `or()` without filters throws instead of building an invalid `$or`, and
  `exists()` transfers `_id` only.
- **Transient classification** — `MongoServerSelectionError` (failover), codes
  251/262/10058, and the `TransientTransactionError` error label are retryable;
  nameless-but-coded errors (`{code: 11000}`) map correctly again.
- **HotCache** — in-flight dedup keys include the generation (post-invalidation
  readers start fresh loads instead of joining doomed ones); a failed
  `start()` is retried on the next read instead of disabling freshness forever;
  watcher loops cannot float unhandled rejections; lazy watch-db accessors that
  throw are retried; reconnect backoff resets after sustained health; the
  standalone fallback warns about unbounded staleness; ticker sweeps have an
  in-flight budget.
- **Health** — an empty manager record reports `ok: false`; per-db failures
  carry the error message; timeouts stay honest under load.
- **QueryCache memory** — capacity evictions, TTL expiry and version-guard
  drops now unregister dead keys from every secondary index (no unbounded
  index growth on long-running processes).
- **Drift validator** — compiled string patterns are memoized per schema field
  and reserved-key sets hoisted (less allocation per validated doc); `Long`
  values above 2^53 no longer false-positive drift.

### Changed

- **Internal refactor — no API changes.** Source tree reorganized for
  maintainability: the biggest files were split into same-named folders with
  barrel re-exports (`crud/`, `hot-cache/`, `validate-doc/`, `pagination/`,
  `aggregation/`, `errors/`, `migrations/`); the service composition root
  (`service/index.ts`) was slimmed into `config.ts` / `manager.ts` / `health.ts`;
  connection helpers moved under `service/`; `utils/cache.ts` renamed to
  `utils/memoize.ts`; and a shared `op-deps.ts` now dedupes the `{ trace, meta }`
  boilerplate across op factories. All 216 barrel exports, types, and the dist
  output are unchanged. `TRANSIENT_MONGO_ERROR_CODES` is now a frozen
  `ReadonlySet`. Added `scripts/check-api.ts` (`bun run check:api`) to keep the
  barrel and `API.md` in sync.

### Added

- **HotCache id-level watch (`idsOf` + `invalidateIds`)** — a watch ref may
  declare an `idsOf(args)` extractor mapping loader arguments to the document
  ids (or groups of ids) a result depends on. Replica change streams then purge
  only the entries depending on a changed `documentKey._id`, and manual
  `hot.invalidateIds(collection, ids)` does the same in any mode (e.g. wired to
  ORM after-write hooks). Queries without an extractor keep burst semantics —
  any change purges their whole LRU (the right default for aggregations).
  ObjectId/hex and other representations normalize to comparable keys;
  failing extractors degrade conservatively; `stats()` gains per-query
  `idDrops`.
- `isTransactionUnsupportedError` predicate export; `defineCollections` /
  `defineCollection` fail fast when `timestamps` fields are missing from the
  schema (strict validation would otherwise reject every stamped write);
  `estimateSize` covers Map/Set/Buffers/cycles; `withRetry` backoff jitter;
  `mergeMongoFilters` deep-merges operator docs and concatenates `$and`/`$or`.

## [0.1.3] — 2026-08-18

### Added

- **Cached aggregation** — write-through cache with in-flight dedup for
  aggregation results (`service/aggregation/cached-read.ts`; `db.aggregate`
  gains cache options).

### Fixed

- **`cacheWatch`** — stop retrying permanent change-stream errors and unref the
  watcher backoff, so an unwatchable collection (e.g. a non-replica-set server)
  no longer keeps the process alive or retries forever.

## [0.1.2] — 2026-08-16

### Fixed

- Repository URL in `package.json` points at the canonical repo.

## [0.1.1] — 2026-08-16

### Added

- Aggregation operations: `aggregate` (callback + typed pipeline),
  `groupBy` / `dateRangeAnalysis`, `textSearch`, and `lookupJoin`
  (`service/aggregation/`).
- Compile-time type-assertion suite for schema-driven type safety
  (`tests/types.ts`, run by `tsc --noEmit`).

### Changed

- Package references renamed to `@ignex/ninox` across docs, examples, and
  generated migration templates.
- Error-module imports streamlined through barrels (`errors/index.ts`).

## [0.1.0] — 2026-08-16

### Added

- **Schema-first typed DSL → MongoDB `$jsonSchema`** — strict by default
  (`additionalProperties: false`), ORM lifecycle fields reserved (`_id`, `__v`,
  `deletedAt`), `createSchema` / `updateSchema` / `syncIndexes`, read-side drift
  detection (`off` / `report` / `throw`), and an `s.jsonSchema` raw escape hatch
  for anything the DSL doesn't model.
- **CRUD + performance by default** — read-through `QueryCache` with
  per-collection write-through invalidation, in-flight dedup, `stats()`;
  `cacheWatch: true` opts into change-stream invalidation for external writers
  (replica sets).
- **Hot cache (`createHotCache`)** — global read-through LRU with replica
  change-stream or standalone-ticker freshness, manual invalidation, `stats()`,
  `maxValueBytes`, and `mode` pinning.
- Typed aggregation pipeline builder (`db.pipeline()`), keyset/cursor
  pagination, geo (`s.geoPoint` / `$geoNear`), auto-timestamps, repository
  layer, health checks, text search, graceful transactions with fallback,
  file-based migrations, DataLoader-batched relations.
- Error taxonomy (`DomainError` / `InfraError`) with HTTP status mapping,
  `serializeError`, and `wrapMongoErrors` on by default.

### Fixed

- **HotCache write-after-invalidate race** — a generation guard prevents an
  in-flight load from re-storing stale data after an invalidation.
- **Multi-DB cache/dedup collision** — cache and in-flight-dedup keys are
  namespaced by database, so same-named collections in different databases can
  never share (or coalesce) entries.
- `_id` declared-type mismatch between `InferDoc` and the DB validator (a
  user-declared `_id` is now respected).
- Failed DataLoader batches are no longer cached (a later load retries).
- Mixed/null enum `bsonType` unions; the unsupported `format` keyword is no
  longer emitted into `$jsonSchema`.

### Changed

- **Public surface cleanup (breaking)** — internal helpers were removed from the
  barrel; update payloads are fully precise, rejecting unknown keys in both
  literals and non-literal patches.
- Drift detection defaults to `'report'`; change-stream reconnects drop missed
  entries and retry with jittered backoff.
