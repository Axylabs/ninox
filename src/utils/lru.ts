/**
 * Minimal dependency-free LRU cache backed by a Map (recency = insertion order).
 * get() re-inserts the entry so the most-recently-used item is always last.
 */
export interface LRUOptions {
  /** Maximum number of entries before the least-recently-used item is evicted. Must be > 0. */
  max: number;
  /**
   * Called when an entry is evicted by capacity pressure (NOT on explicit
   * delete/clear). Lets owners release side structures keyed by the entry.
   */
  onEvict?: (key: never, value: never) => void;
}

export class LRU<K, V> {
  readonly max: number;
  private map = new Map<K, V>();
  private onEvict: ((key: K, value: V) => void) | undefined;
  /** Number of entries evicted to make room for new ones (capacity evictions only). */
  evictions = 0;

  constructor(options: LRUOptions) {
    if (options.max <= 0) throw new Error('LRU max must be > 0');
    this.max = options.max;
    // Contravariance-safe: `(key: never) => void` accepts any handler shape.
    this.onEvict = options.onEvict as ((key: K, value: V) => void) | undefined;
  }

  get size(): number {
    return this.map.size;
  }

  get(key: K): V | undefined {
    const value = this.map.get(key);
    if (value === undefined) return undefined;
    // Refresh recency.
    this.map.delete(key);
    this.map.set(key, value);
    return value;
  }

  peek(key: K): V | undefined {
    return this.map.get(key);
  }

  has(key: K): boolean {
    return this.map.has(key);
  }

  set(key: K, value: V): this {
    if (this.map.has(key)) this.map.delete(key);
    this.map.set(key, value);
    if (this.map.size > this.max) {
      const next = this.map.keys().next();
      if (next.done !== true) {
        const evictedKey = next.value;
        const evictedValue = this.map.get(evictedKey) as V;
        this.map.delete(evictedKey);
        this.evictions++;
        try {
          // Eviction hooks must never break the cache write path.
          this.onEvict?.(evictedKey, evictedValue);
        } catch {
          /* ignore */
        }
      }
    }
    return this;
  }

  delete(key: K): boolean {
    return this.map.delete(key);
  }

  clear(): void {
    this.map.clear();
  }

  keys(): IterableIterator<K> {
    return this.map.keys();
  }

  entries(): IterableIterator<[K, V]> {
    return this.map.entries();
  }

  [Symbol.iterator](): IterableIterator<[K, V]> {
    return this.map.entries();
  }
}
