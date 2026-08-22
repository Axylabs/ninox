---
name: ninox-hot-cache-hooks-observability
description: The high-throughput path of @ignex/ninox — the global createHotCache (change-stream replica mode / standalone ticker), lifecycle hooks, error taxonomy, and health/observability surfaces. Use when touching the hot cache, hooks, errors, or health.
---

# ninox: Hot Cache, Hooks & Observability

The opt-in high-throughput layer: a global in-memory read cache refreshed by
change streams (replica mode) or a background ticker (standalone mode), plus
lifecycle hooks and the error taxonomy / health surfaces.

## When to use
- Changing `createHotCache` / `HotCache` behavior or failure semantics.
- Adding hooks or hook semantics; changing error classes / HTTP mapping.
- Touching `service.health()`, `eachDb`, metrics, or the `@ignex/core/debug` probe.

## Key files
| File | Role |
| --- | --- |
| `src/cache/hot-cache/index.ts` | `HotCache` coordinator + `createHotCache` + public API |
| `src/cache/hot-cache/types.ts` | `HotCacheOptions` / `HotQueryConfig` / stats types + constants |
| `src/cache/hot-cache/size.ts` | `estimateSize` — BSON-aware byte probe for `maxValueBytes` |
| `src/cache/hot-cache/ticker.ts` | `RefreshTicker` — standalone background-refresh interval |
| `src/cache/hot-cache/watcher.ts` | `WatchCoordinator` — replica change-stream watchers |
| `src/service/cache-invalidation.ts` | `CacheInvalidator` — `cacheWatch` change-stream invalidation |
| `src/hooks/hooks.ts` | `HOOK_NAMES` + `runHooks` (before/after create/update/delete + afterRead) |
| `src/errors/` | `classes.ts` (AppError/DomainError/InfraError/BadRequest + `ERROR_HTTP_STATUS`), `transient.ts` (frozen `TRANSIENT_MONGO_ERROR_CODES`), `driver-map.ts`, `http-status.ts`, `index.ts` |
| `src/service/health.ts` | `service.health()` + `DbHealthResult` |
| `src/capabilities.ts` | `probeMongoCapabilities` + `createMongoCapabilitiesStore` |
| `src/service/trace-db-op.ts` | Structured op logging + optional lazy `@ignex/core/debug` probe |

## Hot-cache semantics (verified against code)
- Options: `probe`, `mode: 'replica'|'standalone'`, `defaultTtlMs`,
  `tickIntervalMs` (default 1000), `autoRefresh`, `maxValueBytes`, `clone`.
- API: `register` / `has` / `invalidate(name)` / `invalidateParams` /
  `invalidateCollection` / `stats` / `start` / `stop` (**`stop()` is terminal**).
- **Failure semantics — the staleness window**: a refresh failure does NOT fail
  reads; the entry serves until TTL and the refresher retries with jittered
  backoff (watcher logs `hot cache change stream error`, backoff 1s → 5s).
- `cacheWatch: true` opts the shared `QueryCache` into change-stream
  invalidation for external writers (replica sets only).

## Conventions
- Hooks: `afterRead` returns clones (no accidental mutation of cached docs).
- Errors: always map driver errors through `mapMongoDriverError`; HTTP mapping
  via `httpStatusForError` / `serializeError`; transient detection via the
  frozen `TRANSIENT_MONGO_ERROR_CODES` set.
- The `@ignex/core/debug` integration must stay **lazy, try/catch,
  ambient-typed** (`vendor-ignex-core.d.ts`) — it is not a dependency.

## Verify
- `bun test` — hot-cache, hot-cache-mongo, hot-cache-resync (needs replica
  set), hooks, health, drift, utils suites.
- Replica-only suites auto-skip without a reachable Mongo; the local `.env`
  points at a percona `rs0` replica set for full coverage.
