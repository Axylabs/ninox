import type { Document, Filter } from 'mongodb';

const isOperatorDoc = (value: unknown): value is Document =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

/**
 * Merge multiple Mongo filters into one. Empty/undefined parts are skipped.
 *
 * Conflicting keys deep-merge when BOTH sides are plain objects (operator
 * documents like `{ $gte: 18 }` / `{ $in: [...] }`), so
 * `merge({ role: 'admin', age: { $gte: 18 } }, { age: { $lte: 65 } })`
 * keeps both range clauses instead of the old shallow-assign silently
 * dropping `$gte`. Scalars replace (last write wins). Top-level `$and`/`$or`
 * arrays CONCATENATE — dropping a sibling branch would change semantics.
 */
export const mergeMongoFilters = <T extends Document>(
  ...parts: Array<Filter<T> | undefined>
): Filter<T> => {
  const out: Document = {};
  for (const part of parts) {
    if (!part) continue;
    for (const [key, value] of Object.entries(part as Document)) {
      if (!(key in out)) {
        out[key] = value;
        continue;
      }
      if (key === '$and' || key === '$or') {
        const prev = out[key];
        out[key] = [
          ...(Array.isArray(prev) ? prev : [prev]),
          ...(Array.isArray(value) ? value : [value]),
        ];
        continue;
      }
      const prev = out[key];
      out[key] = isOperatorDoc(prev) && isOperatorDoc(value) ? { ...prev, ...value } : value;
    }
  }
  return out as Filter<T>;
};
