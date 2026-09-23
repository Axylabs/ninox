/**
 * Log-safe text helpers — credential masking for anything quoted out of a
 * driver error.
 *
 * The ORM quotes driver messages in errors, and those routinely embed the
 * connection URL they failed on (`mongodb://user:pass@host`) or a secret pair
 * (`token=…`). Every string that can reach a log line or a client payload goes
 * through {@link redactText} so a password is never captured by a log scraper or
 * pasted into a bug report.
 */

/** `scheme://user:secret@host` — the password is the masked part. */
const CONNECTION_CREDENTIALS = /([a-z][a-z0-9+.-]*:\/\/[^/\s:@]*):[^/\s@]*@/gi;

/** `password=…` / `token=…` / `api-key=…` pairs (query strings, log fields). */
const SECRET_PAIR =
  /\b(password|passwd|pwd|secret|token|api[-_]?key|access[-_]?key)=([^&\s;,"')]+)/gi;

/** Mask the password of `scheme://user:secret@host` connection strings. */
export const maskCredentials = (value: string): string =>
  value.replace(CONNECTION_CREDENTIALS, '$1:***@');

/** Mask `password=…` / `token=…` style secret pairs. */
export const maskSecretPairs = (value: string): string => value.replace(SECRET_PAIR, '$1=***');

/**
 * Make a quoted string safe to log or serialize: mask credentials and secret
 * pairs, collapse to the first line and clip it.
 *
 * @param value - The raw text (a driver message, a connection string, …).
 * @param max - Maximum length (default 300).
 * @returns The redacted, single-line text.
 */
export const redactText = (value: string, max = 300): string => {
  const single = maskSecretPairs(maskCredentials(value))
    .split('\n')
    .find((line) => line.trim().length > 0);
  const text = (single ?? '').trim();
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
};
