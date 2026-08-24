/**
 * In-flight request coalescing: identical concurrent operations share a single
 * Promise so the underlying (expensive) work runs once. This is the "query
 * dedup" optimization used by the CRUD read path.
 */
export class InFlight {
  private pending = new Map<string, Promise<unknown>>();

  get size(): number {
    return this.pending.size;
  }

  run<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const existing = this.pending.get(key);
    if (existing) return existing as Promise<T>;
    // Promise.resolve().then(fn) so a synchronous throw from `fn` still
    // becomes a rejected Promise (and reaches joiners) instead of escaping
    // `run()` as a sync exception and skipping the map registration.
    const promise = Promise.resolve()
      .then(fn)
      .finally(() => {
        this.pending.delete(key);
      });
    this.pending.set(key, promise);
    return promise;
  }

  clear(): void {
    this.pending.clear();
  }
}
