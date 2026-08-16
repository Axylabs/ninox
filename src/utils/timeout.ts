/**
 * Race a promise against a timeout. A `timeoutMs` <= 0 disables the timer and
 * returns the original promise untouched (zero-overhead fast path).
 */
export const withTimeout = <T>(
  promise: Promise<T>,
  timeoutMs: number,
  label: string,
): Promise<T> => {
  if (timeoutMs <= 0) return promise;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      reject(new Error(`Operation timed out after ${timeoutMs}ms: ${label}`));
    }, timeoutMs);
  });
  return Promise.race([promise, timeout]).finally(() => {
    if (timer !== undefined) clearTimeout(timer);
  });
};

/** Sleep helper used by retry backoff. */
export const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/**
 * Sleep for `ms` plus random jitter (0..jitterMs, capped at `ms`) so retry
 * loops don't resynchronize into a thundering herd after a replica failover.
 */
export const sleepJittered = (ms: number, jitterMs = 1000): Promise<void> =>
  sleep(ms + Math.floor(Math.random() * Math.min(ms, jitterMs)));
