import {
  Binary,
  Code,
  DBRef,
  Decimal128,
  Double,
  Int32,
  Long,
  MaxKey,
  MinKey,
  ObjectId,
  Timestamp,
} from 'mongodb';

/**
 * Deep-clone a value while preserving the types `JSON.parse(JSON.stringify())`
 * would corrupt or flatten: `Date`, `ObjectId`, `RegExp`, the numeric/binary
 * BSON wrappers (`Decimal128`, `Long`, `Int32`, `Double`, `Timestamp`,
 * `Binary`, `MinKey`, `MaxKey`, `Code`, `DBRef`), and the JS containers
 * `Map` / `Set` / `Buffer` / typed arrays — without this, cached money fields
 * (`Decimal128`) or int64 values (`Long`) would clone into `{}`, and a
 * `Map` (no enumerable own properties) or `Buffer` would silently lose both
 * type and data in the generic-object fallback. Arrays and plain objects are
 * copied recursively; primitives pass through.
 * Used by the optional `clone` mode on `QueryCache` / `HotCache` so a caller
 * can't mutate a cached result and poison the shared cache.
 */
export const cloneDeep = <T>(value: T): T => {
  if (value instanceof Date) return new Date(value.getTime()) as T;
  if (value instanceof ObjectId) return new ObjectId(value.toHexString()) as T;
  if (value instanceof Decimal128) return Decimal128.fromString(value.toString()) as T;
  if (value instanceof Long) return Long.fromString(value.toString()) as T;
  if (value instanceof Int32) return new Int32(value.valueOf()) as T;
  if (value instanceof Double) return new Double(value.valueOf()) as T;
  // fromBits round-trips exactly; fromNumber loses low bits above 2^53.
  if (value instanceof Timestamp)
    return Timestamp.fromBits(value.getLowBits(), value.getHighBits()) as T;
  if (value instanceof Binary) {
    const bytes = Buffer.from(value.buffer);
    return new Binary(bytes, value.sub_type) as T;
  }
  if (value instanceof MinKey) return new MinKey() as T;
  if (value instanceof MaxKey) return new MaxKey() as T;
  if (value instanceof DBRef) {
    return new DBRef(value.collection, cloneDeep(value.oid), value.db) as T;
  }
  if (value instanceof Code) {
    return new Code(
      value.code,
      value.scope !== undefined ? cloneDeep(value.scope) : undefined,
    ) as T;
  }
  if (value instanceof RegExp) return new RegExp(value.source, value.flags) as T;
  if (value instanceof Map) {
    const out = new Map<unknown, unknown>();
    for (const [k, v] of value) out.set(cloneDeep(k), cloneDeep(v));
    return out as T;
  }
  if (value instanceof Set) {
    const out = new Set<unknown>();
    for (const v of value) out.add(cloneDeep(v));
    return out as T;
  }
  // Buffer first (a Uint8Array subclass); then any other typed array view.
  if (Buffer.isBuffer(value)) return Buffer.from(value) as T;
  if (ArrayBuffer.isView(value)) {
    const view = value as unknown as ArrayBufferView & { slice?: () => unknown };
    if (view instanceof DataView) {
      const bytes = view.buffer.slice(view.byteOffset, view.byteOffset + view.byteLength);
      return new DataView(bytes) as T;
    }
    return typeof view.slice === 'function' ? (view.slice() as T) : value;
  }
  if (Array.isArray(value)) return value.map((item) => cloneDeep(item)) as T;
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = cloneDeep(v);
    }
    return out as T;
  }
  return value;
};
