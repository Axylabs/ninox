/**
 * Cheap, BSON-aware byte estimator used by the HotCache `maxValueBytes` guard.
 * It is deliberately approximate (strings 2 bytes/char, fixed sizes for
 * primitives/BSON kinds) — enough to reject pathologically large values without
 * the cost of a real BSON encoder.
 *
 * Coverage notes: `Map`/`Set`/typed arrays are measured (a loader returning a
 * big Map used to measure 0 bytes and bypass the guard entirely), and a
 * `seen` WeakSet makes cyclic structures safe (they report their traversed
 * size instead of crashing with a stack overflow inside `fetch`).
 */
import { ObjectId } from 'mongodb';

const OVERHEAD_PER_KEY = 8;

/** Approximate in-memory byte size of a cached value (used to bound single entries). */
export const estimateSize = (value: unknown, seen?: WeakSet<object>): number => {
  if (value === null || value === undefined) return 0;
  if (typeof value === 'string') return value.length * 2;
  if (typeof value === 'number' || typeof value === 'boolean') return 8;
  if (typeof value === 'bigint') return 16;
  if (typeof value !== 'object') return 0;
  if (value instanceof ObjectId) return 16;
  if (value instanceof Date) return 8;

  const visit = (v: unknown): number => {
    // Cycle guard: revisit only counts the reference overhead once.
    if (v !== null && typeof v === 'object') {
      if (!seen) seen = new WeakSet();
      else if (seen.has(v as object)) return OVERHEAD_PER_KEY;
      seen.add(v as object);
    }
    return estimateSize(v, seen);
  };

  if (Array.isArray(value)) {
    let sum = OVERHEAD_PER_KEY * Math.max(value.length, 1);
    for (const v of value) sum += visit(v);
    return sum;
  }
  if (value instanceof Map) {
    let sum = OVERHEAD_PER_KEY * value.size;
    for (const [k, v] of value) sum += estimateSize(k, seen) + visit(v);
    return sum;
  }
  if (value instanceof Set) {
    let sum = OVERHEAD_PER_KEY * value.size;
    for (const v of value) sum += visit(v);
    return sum;
  }
  if (ArrayBuffer.isView(value)) {
    // Buffers/typed arrays: measure REAL bytes — iterating them as index-keyed
    // objects inflated the estimate ~10× and caused spurious sizeSkips.
    return (value as ArrayBufferView).byteLength + OVERHEAD_PER_KEY;
  }
  let sum = 0;
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    sum += k.length * 2 + OVERHEAD_PER_KEY + visit(v);
  }
  return sum;
};
