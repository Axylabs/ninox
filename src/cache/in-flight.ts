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
    let promise: Promise<T>;
    try {
      // Call fn() SYNCHRONOUSLY (instead of Promise.resolve().then(fn)) so
      // the caller chain — route handler → ORM → hot-cache get/fetch — stays
      // on the stack for the ignex debugbar's span-origin capture. A detached
      // .then() microtask unwinds that chain, so origins truncate at this
      // wrapper and never reach the application code that issued the query.
      // Promise.resolve() still normalizes sync returns; the try/catch keeps
      // the old contract of turning a synchronous throw into a rejection.
      promise = Promise.resolve(fn());
    } catch (err) {
      promise = Promise.reject(err) as Promise<T>;
    }
    // Cleanup as a DETACHED side-chain: wrapping the returned promise in
    // .finally() would make Bun truncate the async chain at this wrapper and
    // hide the route handler from span origins again. Both handlers consume
    // the settlement so a rejected loader never surfaces as an unhandled
    // rejection.
    promise.then(
      () => {
        this.pending.delete(key);
      },
      () => {
        this.pending.delete(key);
      },
    );
    this.pending.set(key, promise);
    return promise;
  }

  clear(): void {
    this.pending.clear();
  }
}
