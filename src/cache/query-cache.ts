import { cloneDeep } from '../utils/clone.ts';
import { LRU } from '../utils/lru.ts';

export interface QueryCacheOptions {
  /** Max cached entries (default 500). */
  maxSize?: number;
  /** Per-entry TTL in ms (default 0 = no expiry). */
  ttlMs?: number;
  /**
   * Clone results on every read so callers can't mutate the shared cache entry
   * (default false — cloning has a per-read cost; treat cached results as
   * read-only when disabled).
   */
  clone?: boolean;
}

interface Entry<V> {
  value: V;
  expiresAt: number;
}

/** Snapshot of cache health (see `QueryCache.stats()`). */
export interface QueryCacheStats {
  size: number;
  maxSize: number;
  /** Reads served from the cache without touching the DB. */
  hits: number;
  /** Reads that missed (absent or expired). */
  misses: number;
  /** `set()` calls (writes to the cache). */
  sets: number;
  /** `delete()` calls. */
  deletes: number;
  /** `invalidateByCollection` calls that actually dropped entries. */
  invalidateEvents: number;
  /** `clear()` calls. */
  clearEvents: number;
  /** Capacity evictions (LRU). */
  evictions: number;
}

const SEP = '\u0000';
/** Namespace separator between the database name and physical collection. */
const NS_SEP = '\u0001';

/**
 * Compose the "collection" part of a cache key, namespaced by the DATABASE name.
 * One service shares a single QueryCache + InFlight across every DB client; without
 * the namespace, same-named physical collections in different databases would
 * collide — a read on DB A could be served DB B's cached rows, and identical
 * concurrent reads across DBs could coalesce into one driver call. Reads,
 * write-through invalidations, and change-stream invalidations MUST all use the
 * same namespace so they agree.
 */
export const cacheCollectionKey = (dbName: string, physical: string): string =>
  `${dbName}${NS_SEP}${physical}`;

/**
 * Read-through query cache with per-collection invalidation.
 *
 * Keys are `collection<sep>hash` so a single write can invalidate every cached
 * read for that collection. Invalidation is WRITE-THROUGH only: the ORM drops a
 * collection's entries on every write it performs. Reads are NOT invalidated by
 * external writers (other processes, the raw `client` escape hatch, or direct
 * DB writes) — with `ttlMs: 0` (default) those reads stay stale indefinitely,
 * so multi-writer deployments should set `ttlMs` or use the change-stream aware
 * `createHotCache()`. Perf wins: cache hits perform zero driver round-trips.
 */
export class QueryCache {
  private lru: LRU<string, Entry<unknown>>;
  private index = new Map<string, Set<string>>();
  private ttlMs: number;
  private clone: boolean;
  private hits = 0;
  private misses = 0;
  private sets = 0;
  private deletes = 0;
  private invalidateEvents = 0;
  private clearEvents = 0;

  constructor(options: QueryCacheOptions = {}) {
    this.lru = new LRU<string, Entry<unknown>>({ max: options.maxSize ?? 500 });
    this.ttlMs = options.ttlMs ?? 0;
    this.clone = options.clone ?? false;
  }

  get size(): number {
    return this.lru.size;
  }

  /** Cache-health snapshot: sizes plus lifetime hit/miss/eviction counters. */
  stats(): QueryCacheStats {
    return {
      size: this.lru.size,
      maxSize: this.lru.max,
      hits: this.hits,
      misses: this.misses,
      sets: this.sets,
      deletes: this.deletes,
      invalidateEvents: this.invalidateEvents,
      clearEvents: this.clearEvents,
      evictions: this.lru.evictions,
    };
  }

  /** Compose a cache key for a collection + filter/options hash. */
  key(collection: string, filterHash: string): string {
    return `${collection}${SEP}${filterHash}`;
  }

  get(key: string): unknown | undefined {
    const entry = this.lru.get(key);
    if (!entry) {
      this.misses++;
      return undefined;
    }
    if (this.ttlMs > 0 && Date.now() > entry.expiresAt) {
      this.lru.delete(key);
      this.misses++;
      return undefined;
    }
    this.hits++;
    // Each read gets its own copy so the stored entry can't be mutated.
    return this.clone ? cloneDeep(entry.value) : entry.value;
  }

  set(key: string, value: unknown, ttlMs?: number): void {
    this.sets++;
    const ttl = ttlMs ?? this.ttlMs;
    const expiresAt = ttl > 0 ? Date.now() + ttl : Infinity;
    this.lru.set(key, { value, expiresAt });
    const sep = key.indexOf(SEP);
    const collection = sep === -1 ? key : key.slice(0, sep);
    let keys = this.index.get(collection);
    if (!keys) {
      keys = new Set<string>();
      this.index.set(collection, keys);
    }
    keys.add(key);
  }

  delete(key: string): void {
    this.deletes++;
    this.lru.delete(key);
  }

  /** Drop every cached entry belonging to a physical collection. */
  invalidateByCollection(collection: string): void {
    const keys = this.index.get(collection);
    if (!keys) return;
    this.invalidateEvents++;
    for (const key of keys) this.lru.delete(key);
    this.index.delete(collection);
  }

  clear(): void {
    this.clearEvents++;
    this.lru.clear();
    this.index.clear();
  }
}
