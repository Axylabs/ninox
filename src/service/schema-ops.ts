import type { CreateCollectionOptions, Db, Document } from 'mongodb';
import { DomainError } from '../errors/index.ts';
import { type ObjectField, toMongoValidator } from '../schema/index.ts';
import type { IndexSpec } from '../types.ts';
import type { LoggerLike } from '../utils/logger.ts';

export interface CollectionRegistryEntry {
  schema?: ObjectField;
  indexes?: IndexSpec[];
}

/** What `syncIndexes` changed on a collection. */
export interface SyncIndexesResult {
  /** Names of indexes that were created (missing declared indexes). */
  created: string[];
  /** Names of indexes that were dropped (undeclared, excluding `_id_`). */
  dropped: string[];
}

/**
 * Canonical key signature for comparing index definitions. Key ORDER is
 * significant server-side (a compound index's prefix determines which sorts
 * it supports), so `{ userId: 1, createdAt: -1 }` and
 * `{ createdAt: -1, userId: 1 }` are DIFFERENT indexes. Relevant options are
 * folded into the signature so a declared-unique index never silently matches
 * an existing non-unique one. Both sides pass through the same projection:
 * server-reported index documents carry extra fields (`v`, `ns`, …) that must
 * not leak into the comparison.
 */
interface IndexOptionLike {
  unique?: unknown;
  sparse?: unknown;
  expireAfterSeconds?: unknown;
}

const optionSignature = (o?: IndexOptionLike): string =>
  JSON.stringify([
    Boolean(o?.unique),
    Boolean(o?.sparse),
    typeof o?.expireAfterSeconds === 'number' ? o.expireAfterSeconds : null,
  ]);

const indexKeyOf = (key: Document, options?: IndexOptionLike): string =>
  `${JSON.stringify(Object.keys(key).map((k) => [k, key[k]]))}|${optionSignature(options)}`;

export interface SchemaOpsOptions {
  resolveCollectionName: (logical: string) => string;
  getDefinition: (logical: string) => CollectionRegistryEntry | undefined;
}

/**
 * Schema-first collection management. `createSchema` provisions a collection
 * with a `$jsonSchema` validator derived from the ORM schema (and creates any
 * declared indexes); `updateSchema` hot-swaps the validator via `collMod`.
 */
export const makeSchemaOps = (client: Db, _logger: LoggerLike, opts: SchemaOpsOptions) => {
  /** Provision a collection with its `$jsonSchema` validator + declared indexes. */
  const createSchema = async (
    collection: string,
    createCollectionOptions?: CreateCollectionOptions,
  ): Promise<void> => {
    const physical = opts.resolveCollectionName(collection);
    const def = opts.getDefinition(collection);
    const validator = def?.schema ? toMongoValidator(def.schema) : undefined;
    try {
      await client.createCollection(physical, {
        // Caller options FIRST, derived validator LAST — a stale `validator`
        // key in the options must not clobber the schema-derived one.
        ...(createCollectionOptions ?? {}),
        ...(validator ? { validator } : {}),
      });
    } catch (err) {
      if ((err as { code?: number })?.code === 48) {
        throw new DomainError('COLLECTION_EXISTS', `Collection "${collection}" already exists`, {
          physicalCollection: physical,
        });
      }
      throw err;
    }
    const indexes = def?.indexes ?? [];
    if (indexes.length > 0) {
      try {
        await client.collection(physical).createIndexes(
          indexes.map((index) => ({
            key: index.key as Document,
            ...(index.options ?? {}),
          })),
        );
      } catch (err) {
        // Roll back so a half-provisioned collection (validator, no indexes)
        // isn't left behind on partial failure.
        await client.dropCollection(physical).catch(() => {});
        throw err;
      }
    }
  };

  /** Hot-swap a collection's validator via `collMod` (no downtime). */
  const updateSchema = async (collection: string, schema?: ObjectField): Promise<void> => {
    const physical = opts.resolveCollectionName(collection);
    const def = opts.getDefinition(collection);
    const resolved = schema ?? def?.schema;
    if (!resolved) {
      throw new Error(`No schema available for collection "${collection}"`);
    }
    await client.command({
      collMod: physical,
      validator: toMongoValidator(resolved),
    });
  };

  /**
   * Reconcile a collection's real indexes with the declared ones: create any
   * missing declared index and drop any undeclared one (`_id_` is always kept).
   * Matching compares key ORDER and the `unique`/`sparse`/`expireAfterSeconds`
   * options — an option-divergent same-key index is treated as missing (the
   * declared version is created; the divergent one is dropped as undeclared).
   * CAUTION: indexes on shared collections created by OTHER services are
   * treated as undeclared here — list them in the definition or don't share.
   * Expects the collection to already exist (`createSchema` first). Returns
   * the created/dropped index names.
   */
  const syncIndexes = async (collection: string): Promise<SyncIndexesResult> => {
    const physical = opts.resolveCollectionName(collection);
    const def = opts.getDefinition(collection);
    const declared = def?.indexes ?? [];
    const handle = client.collection(physical);
    const existing = (await handle.listIndexes().toArray()).filter((i) => i.name !== '_id_');
    const existingByKey = new Map(
      existing.map((i) => [indexKeyOf(i.key as Document, i as IndexOptionLike), i.name as string]),
    );
    const declaredByKey = new Map(
      declared.map((d) => [indexKeyOf(d.key as Document, d.options), d]),
    );
    const created: string[] = [];
    const dropped: string[] = [];
    for (const [key] of declaredByKey) {
      if (!existingByKey.has(key)) {
        await handle.createIndex(
          (declaredByKey.get(key) as IndexSpec).key as Document,
          (declaredByKey.get(key) as IndexSpec).options,
        );
      }
    }
    // Resolve the real names of the indexes we just created (auto-named when no
    // explicit `name` was given, e.g. `sku_1`) so the report is meaningful.
    const after = (await handle.listIndexes().toArray()).filter((i) => i.name !== '_id_');
    const afterByKey = new Map(
      after.map((i) => [indexKeyOf(i.key as Document, i as IndexOptionLike), i.name as string]),
    );
    for (const [key, spec] of declaredByKey) {
      if (!existingByKey.has(key)) {
        created.push(spec.options?.name ?? afterByKey.get(key) ?? JSON.stringify(spec.key));
      }
    }
    for (const [key, name] of existingByKey) {
      if (!declaredByKey.has(key)) {
        await handle.dropIndex(name);
        dropped.push(name);
      }
    }
    return { created, dropped };
  };

  return { createSchema, updateSchema, syncIndexes };
};
