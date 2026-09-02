/**
 * Ambient declaration for the OPTIONAL ignex-debugbar integration hook.
 *
 * `@ignex/core` is intentionally NOT a dependency of this package — the ORM
 * stays standalone. `traceDbOp` probes the module lazily at runtime (one
 * cached dynamic import, wrapped in try/catch) and degrades to a plain
 * pass-through when ignex is not installed. This declaration only makes that
 * optional probe type-check; it contributes nothing at runtime.
 */
declare module '@ignex/core/debug' {
  /**
   * Record a `db` span in the current request trace (kind: "db"). Zero-cost
   * pass-through when no request trace is active. Shape matches
   * `@ignex/core`'s debugbar `debugQuery` helper.
   */
  export function debugQuery<T = unknown>(
    sql: string,
    params: unknown,
    fn: () => T | Promise<T>,
  ): Promise<T>;
}
