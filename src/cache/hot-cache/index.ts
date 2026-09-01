/**
 * HotCache — read-through hot cache for latency-sensitive, high-throughput
 * workloads that cannot afford a DB round-trip on every read.
 *
 * A user creates ONE global instance via `createHotCache()`, opts-in ("registers")
 * the queries that should be served from memory, and the parameters of each call
 * become the cache key. Reads hit a per-query LRU; misses run the user's loader
 * exactly once (concurrent identical calls are in-flight-deduped).
 *
 * Keeping the cache fresh is deployment-dependent, chosen by probing whether the
 * MongoDB deployment supports replica sets:
 *   - **Replica set / mongos** → change-stream watchers (`./watcher.ts`) are
 *     opened on the collections each query is bound to (`watch`). Any
 *     insert/update/delete invalidates the affected queries immediately
 *     (event-driven, works across processes, covers external writers). When a
 *     watch ref declares `idsOf`, the changed document's `_id` is matched
 *     against the dependencies each cached entry extracted from its arguments,
 *     so only entries that actually depend on the changed document are purged.
 *   - **Standalone** (no change streams) → a single global ticker (`./ticker.ts`)
 *     background-refreshes cached entries on a set interval. Stale values keep
 *     being served until the fresh value swaps in (bounded staleness, reads
 *     never block).
 *
 * Both modes (and any code path that knows better than the streams — e.g. ORM
 * after-write hooks) share one fine-tuned purge primitive: `invalidateIds(collection, ids)`
 * drops exactly the entries depending on those documents; `invalidateCollection`
 * stays the coarse "drop everything watching this collection" switch.
 *
 * `start()` resolves the mode once; `stop()` is **terminal** — it tears down
 * the ticker + streams and disposes the instance, so a later `get()` serves
 * cached values read-through without ever re-probing or re-opening background
 * resources. Errors from a loader are never cached, so a transient failure
 * retries on the next read.
 *
 * ## Failure semantics (the staleness window)
 *
 * Freshness is best-effort under failure; the cache keeps serving from memory
 * while the background freshness mechanism is down, so **low latency can hide
 * stale reads**. The guarantees:
 *
 * - **Replica (change streams)** — the watcher self-heals: any stream error or
 *   server-side kill (resume-token expiry, rollback, replica failover, dropped
 *   collection) closes the stream, retries with jittered backoff (1s → 5s),
 *   and **invalidates the bound collection once on reopen**, so entries that
 *   could have gone stale during the outage are re-fetched on the next read.
 *   Until that reopen happens, cached values are served as-is.
 * - **Standalone (ticker)** — entries are background-refreshed only for
 *   queries that set `refreshIntervalMs`; a stale value keeps being served
 *   until the fresh value swaps in. Queries with neither `refreshIntervalMs`
 *   nor `ttlMs` are served until manually invalidated (unbounded staleness;
 *   `start()` logs a warning naming them).
 * - **Bounding the window** — set per-query `ttlMs` and/or `refreshIntervalMs`
 *   (or `autoRefresh: false` + manual invalidation) and monitor `stats()` plus
 *   the "change stream reconnected"/"change stream error" warnings to bound how
 *   long a stale value can be served.
 *
 * This file is the coordinator: public API + the shared read/fetch pipeline.
 * The two freshness strategies and the size estimator live in sibling modules
 * (`./watcher.ts`, `./ticker.ts`, `./size.ts`) and are injected here, keeping
 * each concern small and independently testable.
 */
import { probeMongoCapabilities } from '../../capabilities.ts';
import { BadRequest } from '../../errors/index.ts';
import { cloneDeep } from '../../utils/clone.ts';
import { stableHash } from '../../utils/hash.ts';
import type { LoggerLike } from '../../utils/logger.ts';
import { LRU } from '../../utils/lru.ts';
import { InFlight } from '../in-flight.ts';
import { estimateSize } from './size.ts';
import { RefreshTicker } from './ticker.ts';
import {
  type Entry,
  type HotCacheMode,
  type HotCacheOptions,
  type HotCacheStats,
  type HotQueryAccessor,
  type HotQueryConfig,
  type HotQueryStats,
  normalizeWatchId,
  type RegisteredQuery,
  resolveWatchDb,
  WATCH_SEP,
} from './types.ts';
import { WatchCoordinator } from './watcher.ts';

export class HotCache {
  private options: HotCacheOptions;
  private logger: LoggerLike;
  private refreshEnabled: boolean;
  private queries = new Map<string, RegisteredQuery>();
  private inflight = new InFlight();
  private watcher: WatchCoordinator;
  private ticker: RefreshTicker;
  private _mode: HotCacheMode = 'unknown';
  private started = false;
  private startAttempted = false;
  private stopped = false;
  private disposed = false;
  private startPromise: Promise<HotCacheMode> | undefined;

  constructor(options: HotCacheOptions = {}) {
    this.options = options;
    this.refreshEnabled = options.autoRefresh !== false;
    this.logger = options.logger ?? { debug() {}, info() {}, warn() {}, error() {} };
    this.ticker = new RefreshTicker(
      {
        queries: () => this.queries,
        fetch: (q, key, args, gen) => this.fetch(q, key, args, gen),
        logger: this.logger,
      },
      options.tickIntervalMs ?? 1000,
    );
    this.watcher = new WatchCoordinator({
      queries: () => this.queries,
      invalidateCollection: (collection) => this.invalidateCollection(collection),
      invalidateDocument: (collection, id) => this.invalidateIds(collection, [id]),
      isReplica: () => this._mode === 'replica',
      fallbackToStandalone: () => {
        this._mode = 'standalone';
        if (this.refreshEnabled && !this.ticker.running) {
          this.ticker.start();
          // Late-registered queries never get the start()-time warning; the
          // fallback path must warn for currently-registered unbounded ones too.
          this.ticker.warnUnboundedStaleness();
        }
      },
      logger: this.logger,
    });
  }

  /** Number of cached entries across all registered queries. */
  get size(): number {
    let total = 0;
    for (const q of this.queries.values()) total += q.lru.size;
    return total;
  }

  /** Resolved mode: `unknown` until `start()` (or the first `get`) probes. */
  get mode(): HotCacheMode {
    return this._mode;
  }

  /** Whether the standalone background-refresh ticker is enabled (`autoRefresh`). */
  get autoRefresh(): boolean {
    return this.refreshEnabled;
  }

  /** Whether a query with this name has been registered. */
  has(name: string): boolean {
    return this.queries.has(name);
  }

  /**
   * Opt a query into the hot cache. Throws `BadRequest` on a duplicate name.
   * Returns a fully typed accessor — `.get(...args)` (intellisense on the loader
   * parameters) and `.invalidate()` / `.invalidate(...args)` for manual
   * invalidation (all entries or a single parameter set).
   */
  register<TArgs extends readonly unknown[], TResult>(
    name: string,
    config: HotQueryConfig<TArgs, TResult>,
  ): HotQueryAccessor<TArgs, TResult> {
    if (this.queries.has(name)) {
      throw new BadRequest(`hot cache: query '${name}' is already registered`);
    }
    const query: RegisteredQuery = {
      name,
      config: config as HotQueryConfig<readonly unknown[], unknown>,
      lru: new LRU<string, Entry>({
        max: config.maxSize ?? this.options.defaultMaxSize ?? 500,
      }),
      ttlMs: config.ttlMs ?? this.options.defaultTtlMs ?? 0,
      refreshIntervalMs: config.refreshIntervalMs ?? 0,
      clone: config.clone ?? false,
      ...(config.maxValueBytes !== undefined ? { maxValueBytes: config.maxValueBytes } : {}),
      hasIdWatch: (config.watch ?? []).some((ref) => typeof ref.idsOf === 'function'),
      gen: 0,
      hits: 0,
      misses: 0,
      refreshes: 0,
      loadErrors: 0,
      sizeSkips: 0,
      idDrops: 0,
      warnedSize: false,
    };
    this.queries.set(name, query);
    // If already running in replica mode, wire change streams for new watch refs.
    if (this._mode === 'replica' && !this.stopped) {
      this.watcher.start();
    }
    // Named consts (not inline arrows) so stack frames read `get`/`invalidate`
    // instead of `<anonymous>` when user code goes through the accessor.
    const get = (...args: TArgs): Promise<TResult> => this.get(name, ...args) as Promise<TResult>;
    const invalidate = (...args: TArgs): void => {
      if (args.length === 0) this.invalidate(name);
      else this.invalidateParams(name, ...args);
    };
    return { get, invalidate };
  }

  /**
   * Read-through read by dynamic name lookup. Call parameters are hashed into
   * the cache key (`keyOf` override wins). Throws `BadRequest` for an unknown
   * query name. For fully typed parameters/results prefer the accessor returned
   * by `register()` — this dynamic form returns `Promise<unknown>`.
   */
  async get(name: string, ...args: unknown[]): Promise<unknown> {
    this.ensureStarted();
    const q = this.queries.get(name);
    if (!q) throw new BadRequest(`hot cache: unknown query '${name}'`);
    const key = q.config.keyOf ? q.config.keyOf(...args) : stableHash(args);
    const entry = q.lru.get(key);
    if (entry && !(q.ttlMs > 0 && entry.expiresAt <= Date.now())) {
      q.hits++;
      // Each read gets its own copy so the stored entry can't be mutated.
      return q.clone ? cloneDeep(entry.value) : entry.value;
    }
    if (entry && q.ttlMs > 0 && entry.expiresAt <= Date.now()) {
      // Drop the dead entry eagerly so `size`/`stats()` stay accurate.
      q.lru.delete(key);
    }
    q.misses++;
    // `await` (not a bare `return`): a non-awaited return from an async
    // function unwinds the caller chain in Bun's stack capture, so the ignex
    // debugbar's span origin would truncate here and never reach the route
    // handler that issued this read.
    return await this.fetch(q, key, args, q.gen);
  }

  /** Drop every cached entry for a registered query. */
  invalidate(name: string): void {
    const q = this.queries.get(name);
    if (!q) return;
    q.lru.clear();
    q.gen++;
  }

  /**
   * Drop only the cached entry for a specific parameter set. The key is computed
   * exactly like `get` (`keyOf` override ?? `stableHash` of args), so the same
   * parameters invalidate the same entry.
   */
  invalidateParams(name: string, ...args: unknown[]): void {
    const q = this.queries.get(name);
    if (!q) return;
    const key = q.config.keyOf ? q.config.keyOf(...args) : stableHash(args);
    q.lru.delete(key);
    q.gen++;
  }

  /**
   * Invalidate every query bound to a physical collection (via `watch`). Can be
   * called manually to wire ORM write hooks in standalone mode.
   */
  invalidateCollection(collection: string): void {
    for (const q of this.queries.values()) {
      if (q.config.watch?.some((ref) => ref.collection === collection)) {
        q.lru.clear();
        q.gen++;
      }
    }
  }

  /**
   * Fine-tuned purge: drop only the entries that depend on specific document
   * ids of a watched collection. Two complementary mechanisms feed it:
   *
   *   - **Replica mode** — the change stream extracts `documentKey._id` from
   *     each event and calls this with just that id, so a write to one document
   *     no longer purges every query bound to the whole collection.
   *   - **Manual (any mode)** — call it from ORM after-write hooks or anywhere
   *     else you know exactly which ids changed.
   *
   * Per query bound to `collection`, semantics are:
   *   - watch ref declares `idsOf` → only LRU entries whose extracted ids
   *     include one of `ids` are dropped (`depsAll` entries — where extraction
   *     failed — are dropped too; conservative). Sibling entries stay warm and
   *     `stats().perQuery[name].idDrops` counts what was dropped.
   *   - no `idsOf` on any bound ref → full purge of that query (the
   *     `invalidateCollection` behavior — the safe default).
   */
  invalidateIds(collection: string, ids: readonly unknown[]): void {
    if (ids.length === 0) return;
    // Deps are stored namespaced (`${collection}${WATCH_SEP}${id}`) so
    // multi-collection watchers never cross-invalidate — match that exact shape.
    const changed = new Set<string>();
    for (const id of ids) changed.add(`${collection}${WATCH_SEP}${normalizeWatchId(id)}`);
    for (const q of this.queries.values()) {
      const bound = q.config.watch?.filter((ref) => ref.collection === collection);
      if (!bound || bound.length === 0) continue;
      if (!bound.some((ref) => typeof ref.idsOf === 'function')) {
        // No id-level extractor for this collection → keep the coarse contract.
        q.lru.clear();
        q.gen++;
        continue;
      }
      let dropped = 0;
      for (const [key, entry] of [...q.lru.entries()]) {
        const matches =
          entry.depsAll === true || entry.deps?.some((dep) => changed.has(dep)) === true;
        if (matches) {
          q.lru.delete(key);
          dropped++;
        }
      }
      q.idDrops += dropped;
      // Unconditional race guard (even when nothing was dropped): an in-flight
      // load for these args must never re-store a value fetched BEFORE the
      // change event — otherwise a change landing mid-load would pin the old
      // value in the cache with no TTL to rescue it.
      q.gen++;
    }
  }

  /** Drop every cached entry for every query. */
  clear(): void {
    for (const q of this.queries.values()) {
      q.lru.clear();
      q.gen++;
    }
  }

  /**
   * Runtime observability snapshot: total queries/entries plus per-query
   * counters (`hits`, `misses`, background `refreshes`, `loadErrors`,
   * `sizeSkips` for entries dropped by `maxValueBytes`, and `idDrops` for
   * entries dropped by id-targeted invalidation). Useful for dashboards and
   * cache-effectiveness checks.
   */
  stats(): HotCacheStats {
    const perQuery: Record<string, HotQueryStats> = {};
    for (const [name, q] of this.queries) {
      perQuery[name] = {
        size: q.lru.size,
        hits: q.hits,
        misses: q.misses,
        refreshes: q.refreshes,
        loadErrors: q.loadErrors,
        sizeSkips: q.sizeSkips,
        idDrops: q.idDrops,
        evictions: q.lru.evictions,
      };
    }
    return { mode: this._mode, queries: this.queries.size, entries: this.size, perQuery };
  }

  /**
   * Probe replica support once, then start change-stream watchers (replica) or
   * the global refresh ticker (standalone). Idempotent — resolves the mode.
   * A FAILED start does not stick: the memoized promise is cleared so the next
   * `get()`/`start()` retries probing (one transient blip during startup must
   * not disable background freshness for the life of the instance).
   */
  async start(): Promise<HotCacheMode> {
    if (this.disposed) return this._mode;
    if (this.started) return this._mode;
    if (!this.startPromise) {
      this.startPromise = this.runStart().catch(this.forgetFailedStart);
    }
    return this.startPromise;
  }

  /**
   * Stop the ticker, close every change stream, and **dispose** the instance.
   * Terminal: a later `get()` serves cached values read-through but never
   * re-probes or re-opens background resources.
   */
  async stop(): Promise<void> {
    this.disposed = true;
    this.stopped = true;
    this.ticker.stop();
    await this.watcher.stop();
    this.inflight.clear();
    // In-flight loads shouldn't re-populate the cache during/after teardown.
    for (const q of this.queries.values()) q.gen++;
    this.started = false;
    this.startAttempted = false;
    this.startPromise = undefined;
    this._mode = 'unknown';
  }

  /* ----------------------------- internals ----------------------------- */

  /**
   * A FAILED start does not stick: clear the memoized state so the next
   * `get()`/`start()` retries probing (one transient blip during startup must
   * not disable background freshness for the life of the instance).
   */
  private forgetFailedStart = (err: unknown): never => {
    this.startPromise = undefined;
    this.startAttempted = false;
    this.started = false;
    throw err;
  };

  private async runStart(): Promise<HotCacheMode> {
    this.stopped = false;
    const supported =
      this.options.mode === 'replica'
        ? true
        : this.options.mode === 'standalone'
          ? false
          : await (this.options.probe ?? this.defaultProbe)();
    // stop() may have run while the probe was in flight — don't re-open resources.
    if (this.disposed) {
      this.started = false;
      return this._mode;
    }
    if (supported) {
      this._mode = 'replica';
      this.watcher.start();
    } else {
      this._mode = 'standalone';
      if (this.refreshEnabled) {
        this.ticker.start();
        this.ticker.warnUnboundedStaleness();
      }
    }
    this.started = true;
    return this._mode;
  }

  private ensureStarted(): void {
    if (this.disposed || this.started || this.startAttempted) return;
    this.startAttempted = true;
    // Fire-and-forget: the rejection crosses a promise boundary, so the error's
    // own stack will NOT contain whoever triggered this read. Snapshot the
    // synchronous caller chain NOW and attach it as `cause` + log meta —
    // otherwise "start failed" warnings are unattributable.
    const origin = new Error('hot cache: background start() was triggered by this call');
    const reportStartFailure = (err: unknown): void => {
      const wrapped = err instanceof Error ? err : new Error(String(err));
      if (wrapped.cause === undefined) wrapped.cause = origin;
      this.logger.warn?.(
        { error: wrapped.message, stack: wrapped.stack, trigger: origin.stack },
        'hot cache start failed; reads continue without auto-refresh',
      );
    };
    this.start().catch(reportStartFailure);
  }

  private defaultProbe = async (): Promise<boolean> => {
    for (const q of this.queries.values()) {
      for (const ref of q.config.watch ?? []) {
        let db: { databaseName: string };
        try {
          db = resolveWatchDb(ref);
        } catch {
          // Lazy accessor not ready (module-scope registration before connect)
          // — treat as "unknown", not standalone.
          this.logger.warn?.(
            {},
            'hot cache: replica probe could not resolve the watch db (accessor threw) — falling back to the standalone ticker; pass `mode` or a custom `probe` to pin the behavior',
          );
          return false;
        }
        const caps = await probeMongoCapabilities(db as never);
        if (!caps.probed) {
          // A timed-out/failed probe is NOT "confirmed standalone" — falling back
          // to the ticker silently could surprise replica users. Warn loudly so
          // they can pin the behavior with `mode` or a custom `probe`.
          this.logger.warn?.(
            { db: db.databaseName },
            'hot cache: replica probe returned no result (timeout?) — falling back to the standalone ticker; pass `mode` or a custom `probe` to pin the behavior',
          );
          return false;
        }
        return caps.transactionsSupported;
      }
    }
    return false;
  };

  private fetch(
    q: RegisteredQuery,
    key: string,
    args: readonly unknown[],
    gen: number,
  ): Promise<unknown> {
    // The generation is part of the dedup identity: a reader arriving AFTER an
    // invalidation must start a FRESH load, never join the pre-invalidation
    // in-flight one (whose result is stale-by-arrival for it).
    const dedupeKey = `${q.name}${WATCH_SEP}g${gen}${WATCH_SEP}${key}`;
    // Named const (not an inline async arrow) so loader frames read `loadOnce`
    // instead of `<anonymous>` in error stacks.
    const loadOnce = async (): Promise<unknown> => {
      try {
        const value = await q.config.loader(...args);
        // Generation guard: if an invalidation/clear happened while the loader
        // was in flight, the result is stale-by-arrival — don't re-store it.
        // The caller still receives the value; the next read re-fetches.
        if (q.gen === gen) {
          const bytes = q.maxValueBytes !== undefined ? estimateSize(value) : undefined;
          if (bytes !== undefined && bytes > q.maxValueBytes!) {
            q.sizeSkips++;
            if (!q.warnedSize) {
              q.warnedSize = true;
              this.logger.warn?.(
                { query: q.name, bytes, max: q.maxValueBytes },
                'hot cache: value exceeds maxValueBytes — returned but not cached',
              );
            }
          } else {
            this.setEntry(q, key, args, value);
          }
        }
        return value;
      } catch (err) {
        q.loadErrors++;
        throw err;
      }
    };
    return this.inflight.run<unknown>(dedupeKey, loadOnce);
  }

  private setEntry(
    q: RegisteredQuery,
    key: string,
    args: readonly unknown[],
    value: unknown,
  ): void {
    const now = Date.now();
    // Id-level watch: record which watched documents this result depends on, so
    // `invalidateIds` (change stream or manual) can purge exactly these entries.
    const deps = q.hasIdWatch ? this.computeDeps(q, args) : {};
    q.lru.set(key, {
      value,
      args,
      expiresAt: q.ttlMs > 0 ? now + q.ttlMs : Infinity,
      nextRefreshAt: q.refreshIntervalMs > 0 ? now + q.refreshIntervalMs : Infinity,
      ...deps,
    });
  }

  /**
   * Extract the watched-document dependencies of one loader call. Namespaced by
   * collection so multi-collection watchers never cross-invalidate. An extractor
   * that throws or returns a non-array yields `{ depsAll: true }` — the entry is
   * then dropped by ANY targeted change on its watched collections instead of
   * being incorrectly kept.
   */
  private computeDeps(
    q: RegisteredQuery,
    args: readonly unknown[],
  ): Pick<Entry, 'deps' | 'depsAll'> {
    const deps: string[] = [];
    for (const ref of q.config.watch ?? []) {
      if (!ref.idsOf) continue;
      // The `never`-params declaration is contravariance-safe for writers; the
      // runtime contract is that it accepts the loader's argument tuple.
      const extract = ref.idsOf as (...args: readonly unknown[]) => readonly unknown[];
      try {
        const ids = extract(...args);
        if (!Array.isArray(ids)) return { depsAll: true };
        for (const id of ids) deps.push(`${ref.collection}${WATCH_SEP}${normalizeWatchId(id)}`);
      } catch {
        return { depsAll: true };
      }
    }
    return { deps };
  }
}

/** Create a new global hot-cache instance. */
export const createHotCache = (options?: HotCacheOptions): HotCache => new HotCache(options);

// Re-export the public HotCache types so the folder barrel matches the old
// single-module exports.
export type {
  Entry,
  HotCacheMode,
  HotCacheOptions,
  HotCacheStats,
  HotCollectionRef,
  HotQueryAccessor,
  HotQueryConfig,
  HotQueryStats,
  RegisteredQuery,
} from './types.ts';
