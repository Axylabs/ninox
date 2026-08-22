---
name: ninox-query-caching-pagination
description: The default-fast read path of @ignex/ninox — QueryBuilder + CRUD reads funneling through QueryCache and in-flight dedup, and $facet/keyset pagination. Use when touching read ops, cache keys, dedup, or pagination.
---

# ninox: Query, Caching & Pagination

The **default path is the fast path**: every CRUD read funnels through the
shared `QueryCache` + `InFlight` dedup, and pagination is either one `$facet`
round trip (offset) or a keyset cursor. Know this pipeline before touching reads.

## When to use
- Changing CRUD read/write behavior (`getOne`, `findMany`, `insert*`, `update*`…).
- Modifying cache keys, TTL, invalidation, or in-flight dedup semantics.
- Working on `paginateFlexible` / `paginateCursor` or the query builder.

## Key files
| File | Role |
| --- | --- |
| `src/query-builder/query-builder.ts` | `QueryBuilder` chain (`.where/.or/.sort/.skip/.limit/.select/.hint/.cache/.dedupe…`) → `.one/.many/.cursor/.count/.exists` |
| `src/service/crud/read-ops.ts` | Read ops (all through the shared read pipeline) |
| `src/service/crud/write-ops.ts` | Write ops (write-through invalidation) |
| `src/service/crud/context.ts` | `CrudContext.read()` — the cache/dedup/drift/timestamps pipeline |
| `src/service/crud-op.ts` | `defineCrudOp` = `resolveQueryOptions` → `traceDbOp` → `withRetry` |
| `src/service/op-deps.ts` | Shared `makeOpDeps({ trace, meta })` — dedupe across op factories |
| `src/cache/query-cache.ts` | `QueryCache`: LRU+TTL, `set(key,value,ttlMs?,collections?,versions?)`, `versionOf`, write-after-invalidate guard, `stats()` |
| `src/cache/in-flight.ts` | `InFlight` — coalesces concurrent identical queries |
| `src/cache/index.ts` | `cacheCollectionKey` — keys namespaced by DB |
| `src/service/config.ts` | `cache: null` disables, `perf: false` master switch, `cacheWatch` |
| `src/service/pagination/offset.ts` | `paginateFlexible` — `$facet` single round trip with totals |
| `src/service/pagination/cursor.ts` | `paginateCursor` — keyset, opaque cursor, O(log n) |
| `src/loader/dataloader.ts` | `DataLoader` + `canonicalKey` (relation batching) |
| `src/relation/` | `belongsTo` / `hasMany` / `manyToMany` + `makePopulator` (batched `$in`) |

## Rules of the pipeline
- Reads go through `read()` in `crud/context.ts`: optional query cache → in-flight
  dedup → drift check → timestamps — in that order.
- **Cache invalidation is write-through**: every mutating op invalidates the
  affected collections; a write between read and cache-store must invalidate
  (generation guard). Don't bypass it without a reason.
- Cache keys are **namespaced by database** — same-named collections in
  different DBs must never share or coalesce entries.
- Failed DataLoader batches are never cached (a later load retries).

## Conventions
- Keep pure helpers side-effect free: `src/shared/` (`pagination-math.ts`,
  `pagination-result.ts`, `keyset.ts`, `merge-filters.ts`) has no driver I/O.
- Pagination: prefer `paginateFlexible` when totals are needed, `paginateCursor`
  for large/deep collections (keyset, opaque cursor, no `skip`).

## Verify
- `bun test` — cache, cache-invalidation, dataloader, query-builder,
  pagination-related, crud, keyset suites.
- `bun run bench` — keep `bench/results/summary.json` in range (17,000 → 340
  queries population is the headline contract).
