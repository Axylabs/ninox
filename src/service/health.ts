/**
 * Health check: pings every connected manager's raw `Db` handle in parallel
 * (with a configurable timeout per ping, default 2s) and reports per-DB latency,
 * failure reasons + overall status. Types and implementation live together here
 * so `service/index.ts` stays a thin composition root.
 */
import type { Db } from 'mongodb';
import { withTimeout } from '../utils/timeout.ts';

export interface DbHealthResult {
  /** Logical db client key (e.g. `primary`). */
  name: string;
  ok: boolean;
  /** Ping round-trip time in ms (present when `ok`). */
  latencyMs?: number;
  /** Why the ping failed — timeout vs auth vs network (present when `!ok`). */
  error?: string;
}

export interface HealthReport {
  /**
   * Overall status. `false` when ANY db fails — including the degenerate
   * "no dbs connected" case (an empty manager record is NOT healthy).
   */
  ok: boolean;
  /** Total elapsed time across all pings in ms. */
  latencyMs: number;
  dbs: DbHealthResult[];
}

/** Build a `health()` implementation over the service's manager record. */
export const createHealth =
  (db: Record<string, unknown>, options: { timeoutMs?: number } = {}) =>
  async (): Promise<HealthReport> => {
    const started = performance.now();
    const timeoutMs = options.timeoutMs ?? 2_000;
    const dbs = await Promise.all(
      Object.entries(db).map(async ([key, manager]): Promise<DbHealthResult> => {
        const name = key.replace(/Client$/, '');
        const handle = (manager as { client?: Db } | undefined)?.client;
        if (!handle) return { name, ok: false, error: 'no client handle on manager' };
        try {
          const t0 = performance.now();
          await withTimeout(handle.admin().command({ ping: 1 }), timeoutMs, `health:${name}`);
          return { name, ok: true, latencyMs: performance.now() - t0 };
        } catch (err) {
          // Keep the WHY (timeout/auth/DNS collapse into the same boolean
          // otherwise and operators can't triage). Message only — no stacks.
          return {
            name,
            ok: false,
            error: err instanceof Error ? err.message : String(err),
          };
        }
      }),
    );
    return {
      ok: dbs.length > 0 && dbs.every((r) => r.ok),
      latencyMs: performance.now() - started,
      dbs,
    };
  };
