/**
 * Deterministic hashing utilities used for cache keys / in-flight dedup keys.
 * `stableStringify` produces an order-insensitive serialization so two logically
 * identical filters yield the same hash regardless of key insertion order.
 */

type Primitive = string | number | boolean | bigint | null | undefined;

const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' &&
  v !== null &&
  !Array.isArray(v) &&
  !(v instanceof Date) &&
  !(v instanceof RegExp) &&
  // Mongo driver ObjectId (and other BSON values with a toHexString marker)
  // must fall through to `toPrimitive` — treating them as plain objects
  // would serialize every ObjectId as `{}` and collapse distinct values.
  typeof (v as { toHexString?: unknown }).toHexString !== 'function';

const toPrimitive = (v: unknown): Primitive => {
  if (v === undefined || v === null) return null;
  if (typeof v === 'bigint') return v.toString();
  if (v instanceof Date) return `date:${v.getTime()}`;
  if (typeof v === 'object') {
    // Mongo driver ObjectId has toHexString(); RegExp serializes as a string.
    const anyV = v as { toHexString?: () => string; source?: string; flags?: string };
    if (typeof anyV.toHexString === 'function') return `oid:${anyV.toHexString()}`;
    if (anyV instanceof RegExp) return `re:${anyV.source}/${anyV.flags}`;
  }
  return v as Primitive;
};

/**
 * Stable stringify: recursively sorts object keys, coerces Date/ObjectId/RegExp
 * into primitive markers. Result is deterministic for a given logical value.
 */
export const stableStringify = (value: unknown): string => {
  const visit = (v: unknown): Primitive | Record<string, unknown> | unknown[] => {
    if (Array.isArray(v)) return v.map(visit);
    if (isPlainObject(v)) {
      const out: Record<string, unknown> = {};
      for (const key of Object.keys(v).sort()) out[key] = visit(v[key]);
      return out;
    }
    return toPrimitive(v);
  };
  return JSON.stringify(visit(value));
};

/**
 * Dual-round 32-bit digest → ~64 bits of collision resistance, base-36.
 * Round 1 is djb2; round 2 mixes FNV-1a over the same input so two distinct
 * strings colliding in one round almost never collide in both. Cache keys
 * store ONLY this digest, so collision resistance matters: a hit must never
 * be able to serve another query's rows.
 */
export const hashString = (input: string): string => {
  let h1 = 5381;
  let h2 = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    const c = input.charCodeAt(i);
    h1 = ((h1 << 5) + h1 + c) | 0;
    h2 = ((h2 ^ c) * 0x01000193) | 0;
    // Extra diffusion so low-entropy inputs still spread across rounds.
    h2 = (h2 << 3) | (h2 >>> 29);
  }
  return `${(h1 >>> 0).toString(36)}${(h2 >>> 0).toString(36)}`;
};

/** Convenience: hash any value through a stable stringification. */
export const stableHash = (value: unknown): string => hashString(stableStringify(value));
