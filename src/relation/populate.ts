import type { Document, Filter } from 'mongodb';
import { canonicalKey, DataLoader } from '../loader/dataloader.ts';
import type { RelationDef } from './relation.ts';

export interface PopulateDeps {
  /** Fetch docs from a (logical) collection by filter. */
  findMany: (
    collection: string,
    filter: Filter<Document>,
    options?: { projection?: Document; limit?: number },
  ) => Promise<Document[]>;
}

export interface PopulateOptions {
  maxBatchSize?: number;
  cache?: boolean;
  /**
   * Cap on docs fetched per foreign-key batch (default 10_000). A `hasMany` /
   * `manyToMany` relation with more children than this is silently truncated —
   * raise the cap when you expect larger joins.
   */
  maxDocs?: number;
}

/**
 * Batch + cache loader for one foreign key path. `$in`-queries one foreign
 * collection per relation (regardless of how many source docs reference it),
 * which is what turns N+1 population into 1+N.
 */
const createForeignKeyLoader = (
  deps: PopulateDeps,
  collection: string,
  foreignField: string,
  options: PopulateOptions = {},
): DataLoader<unknown, Document[]> =>
  new DataLoader<unknown, Document[]>({
    ...(options.maxBatchSize !== undefined ? { maxBatchSize: options.maxBatchSize } : {}),
    ...(options.cache !== undefined ? { cache: options.cache } : {}),
    keyOf: canonicalKey,
    batch: async (keys) => {
      const docs = await deps.findMany(
        collection,
        { [foreignField]: { $in: keys } },
        {
          ...(options.maxDocs !== undefined ? { limit: options.maxDocs } : {}),
        },
      );
      // Index foreign docs by canonical key value so distinct-but-equal keys
      // (e.g. two ObjectId instances with the same hex) resolve correctly.
      const index = new Map<string, Document[]>();
      for (const doc of docs) {
        const value = (doc as Document)[foreignField];
        const canonical = canonicalKey(value);
        const bucket = index.get(canonical) ?? [];
        bucket.push(doc);
        index.set(canonical, bucket);
      }
      const map = new Map<unknown, Document[]>();
      for (const key of keys) {
        map.set(key, index.get(canonicalKey(key)) ?? []);
      }
      return map;
    },
  });

const distinctKeys = (values: unknown[]): unknown[] => {
  const seen = new Set<string>();
  const out: unknown[] = [];
  for (const value of values) {
    if (value === undefined || value === null) continue;
    const canonical = canonicalKey(value);
    if (!seen.has(canonical)) {
      seen.add(canonical);
      out.push(value);
    }
  }
  return out;
};

/**
 * Resolve relations on an array of documents using DataLoader-batched queries.
 * Source documents are COPIED (shallow) before joining — populating a result
 * set that came from the shared query cache must never mutate the cached
 * entry (a cached order would otherwise carry join data into every later
 * reader of that cache entry). Returns the copies typed with joined fields.
 *
 * Independent relations resolve concurrently; relations sharing a target
 * collection + foreign field share ONE DataLoader batch.
 *
 *   const orders = await users.findMany('orders', { userId });
 *   const [withCustomer] = ... // orders[i].customer is now the joined Customer document
 *   const populated = await populate(orders, [
 *     belongsTo({ collection: 'customers', localField: 'customerId', as: 'customer' }),
 *   ]);
 */
export const makePopulator = (deps: PopulateDeps) => {
  const populate = async <T extends Document>(
    docs: T[],
    relations: RelationDef[],
    options: PopulateOptions = {},
  ): Promise<Array<T & Record<string, unknown>>> => {
    // Copy-on-write: attach joins onto fresh copies so shared/cached
    // documents are never polluted (see module doc).
    const out = docs.map((doc) => ({ ...doc })) as Array<T & Record<string, unknown>>;
    if (out.length === 0 || relations.length === 0) return out;

    // One loader per (collection, foreignField) per call: two relations
    // targeting the same collection share a single `$in` batch instead of
    // issuing duplicate queries.
    const loaderCache = new Map<string, DataLoader<unknown, Document[]>>();
    const loaderFor = (
      collection: string,
      foreignField: string,
    ): DataLoader<unknown, Document[]> => {
      const cacheKey = `${collection}\u0000${foreignField}`;
      let loader = loaderCache.get(cacheKey);
      if (!loader) {
        loader = createForeignKeyLoader(deps, collection, foreignField, options);
        loaderCache.set(cacheKey, loader);
      }
      return loader;
    };

    /** Load + index foreign docs for one hop: canonical key → matching docs. */
    const loadIndex = async (
      collection: string,
      foreignField: string,
      keys: unknown[],
    ): Promise<Map<string, Document[]>> => {
      const values = await loaderFor(collection, foreignField).loadMany(keys);
      const byKey = new Map<string, Document[]>();
      keys.forEach((key, i) => {
        byKey.set(canonicalKey(key), (values[i] as Document[] | undefined) ?? []);
      });
      return byKey;
    };

    await Promise.all(
      relations.map(async (relation) => {
        const target = relation.foreignField ?? '_id';
        const sourceKeys = distinctKeys(out.map((doc) => (doc as Document)[relation.localField]));

        if (relation.type === 'belongsTo') {
          const byKey = await loadIndex(relation.collection, target, sourceKeys);
          for (const doc of out) {
            const key = (doc as Document)[relation.localField];
            const matches =
              key === undefined || key === null ? undefined : byKey.get(canonicalKey(key));
            (doc as Record<string, unknown>)[relation.as] =
              matches?.[0] ?? (relation.optional ? undefined : null);
          }
        } else if (relation.type === 'hasMany') {
          const byKey = await loadIndex(relation.collection, target, sourceKeys);
          for (const doc of out) {
            const key = (doc as Document)[relation.localField];
            (doc as Record<string, unknown>)[relation.as] =
              key === undefined || key === null ? [] : (byKey.get(canonicalKey(key)) ?? []);
          }
        } else {
          // manyToMany: source → join docs → target docs (two batched hops).
          const throughByKey = await loadIndex(
            relation.through.collection,
            relation.through.localField,
            sourceKeys,
          );
          const joinDocs = [...throughByKey.values()].flat();
          const targetKeys = distinctKeys(
            joinDocs.map((join) => (join as Document)[relation.through.foreignField]),
          );
          const targetByKey = await loadIndex(relation.collection, target, targetKeys);

          for (const doc of out) {
            const key = (doc as Document)[relation.localField];
            const joins =
              key === undefined || key === null ? [] : (throughByKey.get(canonicalKey(key)) ?? []);
            // Dedupe targets: duplicate pivot rows pointing at the same
            // target must not repeat it in the populated array.
            const seenTargets = new Set<string>();
            const targets: Document[] = [];
            for (const join of joins) {
              const tk = canonicalKey((join as Document)[relation.through.foreignField]);
              if (seenTargets.has(tk)) continue;
              seenTargets.add(tk);
              const bucket = targetByKey.get(tk);
              if (bucket) targets.push(...bucket);
            }
            (doc as Record<string, unknown>)[relation.as] = targets;
          }
        }
      }),
    );
    return out;
  };

  return { populate };
};

export type Populator = ReturnType<typeof makePopulator>;
