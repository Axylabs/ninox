/**
 * Replica-mode change-stream watchers: one long-lived `$changeStream` consumer
 * per (database, collection); every data change invalidates the queries bound
 * to that collection (event-driven, works across processes and external
 * writers). Document events are routed through `invalidateDocument` so queries
 * with an `idsOf` extractor purge only the entries depending on that document;
 * stream-wide events (drop/rename/invalidate) and reconnects invalidate the
 * whole collection.
 *
 * A strategy object owned by `HotCache` (see `./index.ts`). The host supplies
 * the registered queries, per-collection invalidation, and the mode-fallback
 * callback. On permanent "not supported" errors the watcher drops the stream
 * and, when every planned stream has failed, tells the host to flip to the
 * standalone ticker. Transient errors retry with jittered backoff.
 *
 * ## Failure semantics (the staleness window)
 *
 * `watchLoop` is the self-healing consumer. Any stream error or server-side
 * kill (network drop, replica failover, cursor invalidation) is logged, the
 * abandoned stream is closed, and the loop reconnects after a jittered backoff
 * (1s → 5s). On every REOPEN (`backoff > 0`) the bound collection is
 * invalidated **once**, dropping cached entries so anything written during the
 * outage is re-fetched on the next read — this "invalidate-on-reopen" is what
 * restores correctness after:
 *
 *   - **Resume-token expiry** — a `ChangeStreamHistoryLost`/invalid-token error.
 *     It is a recoverable error, NOT "not supported", so it stays in the retry
 *     path. The re-opened stream has no resume token and starts from "now"; the
 *     invalidate-on-reopen drops entries that could be stale.
 *   - **Rollback / `invalidate` events** — a dropped or renamed collection emits
 *     an `invalidate` event that ends the stream; the loop reconnects and
 *     invalidates on reopen.
 *   - **Consumer downtime** — while the consumer is down, writes are NOT
 *     observed, so the in-process LRU keeps serving stale values (the inherent
 *     tradeoff: low latency can hide stale reads). Staleness is bounded only by
 *     reconnect latency + the invalidate-on-reopen, plus any per-query
 *     `ttlMs`/`refreshIntervalMs`. A consumer that never reconnects leaves
 *     entries stale forever unless TTL/refresh are set.
 */
import type { ChangeStream, Db } from 'mongodb';
import type { LoggerLike } from '../../utils/logger.ts';
import { sleepJittered } from '../../utils/timeout.ts';
import { isPermanentWatchError } from '../../utils/watch-errors.ts';
import { type HotCollectionRef, type RegisteredQuery, resolveWatchDb, WATCH_SEP } from './types.ts';

export interface WatchHost {
  /** All registered queries (their `watch` refs drive which streams to open). */
  queries: () => Map<string, RegisteredQuery>;
  /** Invalidate every query bound to a physical collection. */
  invalidateCollection: (collection: string) => void;
  /**
   * Invalidate only the entries that depend on one changed document (the
   * change event's `documentKey._id`). The host decides per query whether it
   * can target by id (`idsOf`) or must fall back to a coarse purge.
   */
  invalidateDocument: (collection: string, id: unknown) => void;
  /** Whether the cache is currently in replica mode (used before a fallback). */
  isReplica: () => boolean;
  /** Flip the cache to standalone mode + start the ticker (called after a total fallback). */
  fallbackToStandalone: () => void;
  logger: LoggerLike;
}

/**
 * Resolve a lazy `db` accessor defensively: module-scope registrations commonly
 * access connections that don't exist yet, so a THROW means "not available
 * yet" — never let it escape into an unhandled rejection.
 */
const resolveDbSafe = (ref: HotCollectionRef, logger: LoggerLike): Db | null => {
  try {
    return resolveWatchDb(ref);
  } catch (err) {
    logger.debug?.(
      { error: err instanceof Error ? err.message : String(err), collection: ref.collection },
      'hot cache: watch db accessor not ready yet',
    );
    return null;
  }
};

/**
 * The `_id` of the document a change event touched, or `undefined` for
 * stream-wide events (drop / dropDatabase / rename / invalidate) that carry no
 * `documentKey` and must invalidate the whole collection. Real `_id` values are
 * never undefined — but they CAN be falsy (`0`, `''`), hence the explicit
 * null-check on the wrapper object instead of the id itself.
 */
const documentKeyOf = (change: unknown): unknown => {
  const key = (change as { documentKey?: { _id?: unknown } | null } | null | undefined)
    ?.documentKey;
  return key ? key._id : undefined;
};

/** Long-lived change-stream coordinator for replica mode. */
export class WatchCoordinator {
  private streams = new Map<string, ChangeStream>();
  private failedStreams = new Set<string>();
  private stopped = true;
  /** Guards against stacking reconnect timers when several accessors lag. */
  private reopenTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(private host: WatchHost) {}

  /** Number of currently open change streams. */
  get size(): number {
    return this.streams.size;
  }

  /** Mark the coordinator as running and open watchers for all watch refs (idempotent). */
  start(): void {
    this.stopped = false;
    this.openWatchStreams();
  }

  /** Close every watcher and clear failure bookkeeping (idempotent). */
  async stop(): Promise<void> {
    this.stopped = true;
    if (this.reopenTimer) clearTimeout(this.reopenTimer);
    const closes = [...this.streams.values()].map((stream) => {
      try {
        return Promise.resolve(stream.close()).catch(() => {});
      } catch {
        return Promise.resolve();
      }
    });
    this.streams.clear();
    this.failedStreams.clear();
    await Promise.allSettled(closes);
  }

  private openWatchStreams(): void {
    const seen = new Set<string>();
    let deferred = false;
    for (const q of this.host.queries().values()) {
      for (const ref of q.config.watch ?? []) {
        const db = resolveDbSafe(ref, this.host.logger);
        // Accessor not ready yet (module-scope registration before connect):
        // retry the whole sweep shortly instead of losing the stream forever.
        if (!db) {
          deferred = true;
          continue;
        }
        const key = `${db.databaseName}${WATCH_SEP}${ref.collection}`;
        if (seen.has(key) || this.streams.has(key)) continue;
        seen.add(key);
        // The loop must NEVER float as an unhandled rejection — any escape
        // from its catch handler would crash the process (Node ≥ 15).
        void this.watchLoop(key, ref).catch((err) => {
          this.host.logger.error?.(
            { error: err instanceof Error ? err.message : String(err), collection: ref.collection },
            'hot cache: watcher crashed',
          );
        });
      }
    }
    if (deferred && !this.stopped && !this.reopenTimer) {
      this.reopenTimer = setTimeout(() => {
        this.reopenTimer = undefined;
        if (!this.stopped) this.openWatchStreams();
      }, 5_000);
      this.reopenTimer.unref?.();
    }
  }

  /**
   * Long-lived change-stream consumer for one collection. Each data change
   * invalidates the queries bound to it. On permanent "not supported" errors the
   * watcher is dropped and, if every planned stream failed, the cache falls back
   * to the standalone ticker. Transient errors (including resume-token expiry,
   * rollbacks, and `invalidate` events) retry with backoff and invalidate the
   * collection on reopen so entries missed during the outage are re-fetched —
   * see the module doc for the full failure-semantics contract.
   */
  private async watchLoop(key: string, ref: HotCollectionRef): Promise<void> {
    let backoff = 0;
    while (!this.stopped) {
      // A stream that stayed healthy for a long time before failing is an
      // isolated blip — reset the escalation instead of converging to 5s
      // forever (backoff is for repeated failures, not for uptime history).
      let connectedAt = Date.now();
      try {
        const db = resolveDbSafe(ref, this.host.logger);
        if (!db) throw new Error('watch db accessor not available');
        const stream = db.collection(ref.collection).watch([]);
        stream.on('error', (err: unknown) => {
          // Prevent EventEmitter crashes between events; keep diagnostics.
          this.host.logger.debug?.(
            { error: err instanceof Error ? err.message : String(err) },
            'hot cache change stream error event',
          );
        });
        this.streams.set(key, stream);
        connectedAt = Date.now();
        if (backoff > 0) {
          // This stream is a RECONNECT after an error — changes made during the
          // outage were missed, so drop any entries they may have affected.
          this.host.logger.warn?.(
            { collection: ref.collection },
            'hot cache: change stream reconnected — invalidating collection to drop entries missed during the outage',
          );
          this.host.invalidateCollection(ref.collection);
        }
        const iterator = stream[Symbol.asyncIterator]();
        for await (const change of iterator) {
          // Document events carry `documentKey._id` → targeted purge of just
          // the entries depending on that document (queries without an
          // `idsOf` extractor still get the coarse collection-wide drop, see
          // HotCache.invalidateIds). Anything else (drop/rename/invalidate)
          // purges the whole collection.
          const docId = documentKeyOf(change);
          if (docId === undefined) this.host.invalidateCollection(ref.collection);
          else this.host.invalidateDocument(ref.collection, docId);
        }
      } catch (err) {
        if (Date.now() - connectedAt > 60_000) backoff = 0;
        const message = err instanceof Error ? err.message : String(err);
        this.host.logger.warn?.(
          { error: message, collection: ref.collection },
          'hot cache change stream error',
        );
        // Close the abandoned stream before the retry loop re-opens one, so a
        // transient error never leaks a ChangeStream cursor.
        const abandoned = this.streams.get(key);
        this.streams.delete(key);
        if (abandoned) {
          try {
            await abandoned.close();
          } catch {
            // Best-effort: the server drops the cursor on disconnect anyway.
          }
        }
        // Classify permanent errors ONLY by the definitive standalone + auth
        // verdicts (see isPermanentWatchError). A broad pattern (e.g. `not
        // supported` or `ChangeStream`) can misfire on replica errors like
        // "change stream history lost" (resume-token expiry) and wrongly flip
        // the cache to the standalone ticker — those must stay in the retry
        // path, where the invalidate-on-reopen restores correctness.
        if (isPermanentWatchError(message)) {
          this.markStreamFailed(key);
          return;
        }
      }
      if (this.stopped) return;
      backoff = Math.min(backoff + 1000, 5000);
      await sleepJittered(backoff, 1000, true);
    }
  }

  private markStreamFailed(key: string): void {
    this.failedStreams.add(key);
    if (!this.host.isReplica()) return;
    const planned = this.plannedStreamKeys();
    if (planned.size > 0 && [...planned].every((k) => this.failedStreams.has(k))) {
      this.host.logger.warn?.({}, 'hot cache: change streams unsupported, falling back to ticker');
      this.host.fallbackToStandalone();
    }
  }

  private plannedStreamKeys(): Set<string> {
    const set = new Set<string>();
    for (const q of this.host.queries().values()) {
      for (const ref of q.config.watch ?? []) {
        const db = resolveDbSafe(ref, this.host.logger);
        if (!db) continue; // accessor not ready — not a "failed" stream
        set.add(`${db.databaseName}${WATCH_SEP}${ref.collection}`);
      }
    }
    return set;
  }
}
