import { createHash } from 'node:crypto';
import { BSON } from 'mongodb';

const { EJSON } = BSON;

type Canonical = null | string | number | boolean | Canonical[] | { [key: string]: Canonical };

const bsonTypeOf = (value: object): string | undefined => {
  const type = (value as { _bsontype?: unknown })._bsontype;
  return typeof type === 'string' ? type : undefined;
};

const isPlainObject = (value: unknown): value is Record<string, unknown> => {
  if (value === null || typeof value !== 'object') return false;
  const prototype = Object.getPrototypeOf(value) as object | null;
  return (prototype === Object.prototype || prototype === null) && bsonTypeOf(value) === undefined;
};

/**
 * Canonical, type-preserving serialization. Every value carries a type tag so
 * user objects/strings cannot impersonate Date, ObjectId, RegExp, undefined, or
 * other special values. BSON wrappers are encoded through the driver's EJSON
 * implementation, including values from a second copy of the driver.
 */
export const stableStringify = (value: unknown): string => {
  const ancestors = new WeakSet<object>();
  const visit = (input: unknown): Canonical => {
    if (input === null) return { t: 'null' };
    if (input === undefined) return { t: 'undefined' };
    switch (typeof input) {
      case 'string':
      case 'boolean':
        return { t: typeof input, v: input };
      case 'number':
        if (Number.isNaN(input)) return { t: 'number', v: 'NaN' };
        if (input === Infinity) return { t: 'number', v: 'Infinity' };
        if (input === -Infinity) return { t: 'number', v: '-Infinity' };
        if (Object.is(input, -0)) return { t: 'number', v: '-0' };
        return { t: 'number', v: input };
      case 'bigint':
        return { t: 'bigint', v: input.toString() };
      case 'symbol':
      case 'function':
        throw new TypeError(`stableStringify: unsupported ${typeof input} value`);
      default:
        break;
    }

    const object = input as object;
    if (ancestors.has(object)) throw new TypeError('stableStringify: cyclic value');
    ancestors.add(object);
    try {
      if (input instanceof Date) {
        return { t: 'date', v: Number.isNaN(input.getTime()) ? 'Invalid' : input.toISOString() };
      }
      if (input instanceof RegExp) return { t: 'regexp', v: `re:${input.source}/${input.flags}` };
      const bsonType = bsonTypeOf(object);
      if (bsonType !== undefined) {
        return { t: 'bson', kind: bsonType, v: EJSON.stringify(input, { relaxed: false }) };
      }
      if (Array.isArray(input)) return { t: 'array', v: input.map(visit) };
      if (input instanceof Map) {
        return {
          t: 'map',
          v: [...input.entries()].map(([key, entry]) => [visit(key), visit(entry)]),
        };
      }
      if (input instanceof Set) return { t: 'set', v: [...input].map(visit) };
      if (Buffer.isBuffer(input)) return { t: 'buffer', v: input.toString('base64') };
      if (ArrayBuffer.isView(input)) {
        return {
          t: 'bytes',
          kind: input.constructor.name,
          v: Buffer.from(input.buffer, input.byteOffset, input.byteLength).toString('base64'),
        };
      }
      if (input instanceof ArrayBuffer) {
        return { t: 'arraybuffer', v: Buffer.from(input).toString('base64') };
      }
      if (isPlainObject(input)) {
        const out: Record<string, Canonical> = {};
        for (const key of Object.keys(input).sort()) out[key] = visit(input[key]);
        return { t: 'object', v: out };
      }
      throw new TypeError(`stableStringify: unsupported object ${input.constructor.name}`);
    } finally {
      ancestors.delete(object);
    }
  };
  return JSON.stringify(visit(value));
};

/** SHA-256 digest of the canonical input, safe to use as a complete cache key. */
export const hashString = (input: string): string =>
  createHash('sha256').update(input, 'utf8').digest('base64url');

export const stableHash = (value: unknown): string => hashString(stableStringify(value));
