/**
 * Permanent change-stream error classification, shared by every `$changeStream`
 * watcher (service `CacheInvalidator` + hot-cache `WatchCoordinator`).
 *
 * These errors can NEVER be fixed by retrying — retrying only logs the same
 * warning every 1–5s forever and (with an un-unref'd timer) keeps the process
 * alive, which is wrong for a background watcher whose host server or build
 * should own the process lifetime. Watchers must classify them once, log once,
 * and stop (disable the watcher / fall back to the standalone ticker).
 *
 * Detection alone is not enough for the operator reading the log, though: "change
 * streams unavailable permanently" says nothing about *why* or *what to change*.
 * {@link explainPermanentWatchError} returns the cause-specific headline and the
 * one-line fix, so the warning that disables a watcher tells you it was the
 * credentials (fix the URL and restart) or a standalone server (use a replica
 * set or turn `cacheWatch` off).
 *
 * Deliberately NARROW on purpose: replica errors that ARE transient — e.g.
 * "change stream history lost" (resume-token expiry, collection dropped),
 * network drops, failovers — must stay in the retry path, where
 * invalidate-on-reopen restores correctness. Broad patterns (like `not
 * supported` or `ChangeStream`) are rejected here because they can misfire on
 * those recoverable errors.
 */

/** Why a change stream can never succeed. */
export type PermanentWatchReason = 'standalone' | 'credentials';

/** A cause-specific explanation of a permanent change-stream failure. */
export interface PermanentWatchExplanation {
  /** The classified reason. */
  readonly reason: PermanentWatchReason;
  /** Short headline for a log line (`change streams need a replica set`). */
  readonly headline: string;
  /** The fix, in one line. */
  readonly hint: string;
}

/** Standalone server: `$changeStream` is not supported at all. */
const STANDALONE = /only supported on replica sets|not supported on (?:a )?standalone/i;

/**
 * Credentials/authorization problems: the user cannot run `aggregate` on this
 * collection/server. Wrong creds, missing roles, or a user created without the
 * `read`/`changeStream` privilege will never start working by retrying.
 */
const CREDENTIALS =
  /requires authentication|not authorized|unauthorized|authentication failed|Command .* requires authentication/i;

/**
 * Explain a permanent change-stream failure, or return `undefined` when the
 * error is retryable (the caller must keep retrying with backoff in that case).
 *
 * @param message - The driver's error message.
 * @returns The reason + headline + fix, or `undefined` when retrying may work.
 */
export const explainPermanentWatchError = (
  message: string,
): PermanentWatchExplanation | undefined => {
  if (STANDALONE.test(message)) {
    return {
      reason: 'standalone',
      headline: 'change streams need a replica set',
      hint:
        'Point the connection at a replica set (a single-node replica set is fine for local dev), ' +
        'or set cacheWatch: false / cache: { ttlMs } to run write-through only.',
    };
  }
  if (CREDENTIALS.test(message)) {
    return {
      reason: 'credentials',
      headline: 'the connection is not authorized for change streams',
      hint:
        'Change streams need an authenticated user with the read + changeStream privilege ' +
        '(usually granted on the authSource database) — fix the credentials in .env, then restart.',
    };
  }
  return undefined;
};

/**
 * True when retrying this change-stream error can never succeed.
 *
 * @param message - The driver's error message.
 * @returns `true` for a definitive standalone/authorization verdict.
 */
export const isPermanentWatchError = (message: string): boolean =>
  explainPermanentWatchError(message) !== undefined;
