import type { CreateCollectionOptions, Db, Document } from 'mongodb';
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
 * Schema-first collection management.
 *
 * `createSchema` is IDEMPOTENT and SELF-RECONCILING: on a NEW collection it
 * provisions the `$jsonSchema` validator derived from the ORM schema plus the
 * declared indexes; when the collection ALREADY exists it upgrades the DB
 * schema to match the current ORM schema — hot-swapping the validator via
 * `collMod` only when it has actually drifted, and creating any newly-declared
 * indexes. It never drops indexes or data (destructive reconciliation stays
 * explicit via `syncIndexes`), so it is safe to call on every boot: the Mongo
 * schema follows the app schema automatically as models change.
 *
 * `updateSchema` hot-swaps a validator explicitly (via `collMod`);
 * `syncIndexes` reconciles index drift (create missing, drop undeclared).
 */
export const makeSchemaOps = (client: Db, _logger: LoggerLike, opts: SchemaOpsOptions) => {
  /** Read the `$jsonSchema` validator currently installed on a physical collection. */
  const readCollectionValidator = async (physical: string): Promise<Document | undefined> => {
    const info = (await client.listCollections({ name: physical }).next()) as
      | { options?: { validator?: Document } }
      | undefined;
    return info?.options?.validator;
  };

  /**
   * Create any declared index that is missing from the live collection.
   * ADDITIVE ONLY — never drops an existing (possibly undeclared) index; that
   * stays the explicit job of `syncIndexes`.
   */
  const ensureDeclaredIndexes = async (
    collection: string,
    physical: string,
    def?: CollectionRegistryEntry,
  ): Promise<void> => {
    const declared = def?.indexes ?? [];
    if (declared.length === 0) return;
    const handle = client.collection(physical);
    const existing = new Set(
      (await handle.listIndexes().toArray())
        .filter((i) => i.name !== '_id_')
        .map((i) => indexKeyOf(i.key as Document, i as IndexOptionLike)),
    );
    for (const index of declared) {
      if (existing.has(indexKeyOf(index.key as Document, index.options))) continue;
      try {
        await handle.createIndex(index.key as Document, index.options);
      } catch (err) {
        if ((err as { code?: number })?.code === 85 /* IndexOptionsConflict */) {
          // An index with the same name/key exists but with different options
          // (e.g. `unique` added). Can't be applied additively — tell the user
          // how to reconcile instead of failing the whole boot.
          throw new Error(
            `Cannot apply declared index on "${collection}": an index with the same ` +
              `name/key already exists with different options. Run ` +
              `db.syncIndexes("${collection}") to reconcile index drift.`,
            { cause: err },
          );
        }
        throw err;
      }
    }
  };

  /**
   * Provision a collection with its `$jsonSchema` validator + declared indexes,
   * or — when the collection already exists — reconcile it to the current
   * schema (validator hot-swap + missing declared indexes). Idempotent: safe to
   * call on every boot.
   */
  const createSchema = async (
    collection: string,
    createCollectionOptions?: CreateCollectionOptions,
  ): Promise<void> => {
    const physical = opts.resolveCollectionName(collection);
    const def = opts.getDefinition(collection);
    // Caller options FIRST, derived validator LAST — a stale `validator`
    // key in the options must not clobber the schema-derived one.
    const createOptions = {
      ...(createCollectionOptions ?? {}),
      ...(def?.schema ? { validator: toMongoValidator(def.schema) } : {}),
    } as CreateCollectionOptions;

    // Try the fast path first: create the collection (implicitly creating its
    // database). We intentionally skip a pre-flight `listCollections` — on a
    // not-yet-created database that errors with `NamespaceNotFound` (code 26).
    // Code 48 means a previous boot already provisioned the collection, in
    // which case we fall through to the reconcile path below.
    let created = true;
    try {
      await client.createCollection(physical, createOptions);
    } catch (err) {
      if ((err as { code?: number })?.code !== 48) throw err;
      created = false;
    }

    if (created) {
      try {
        await ensureDeclaredIndexes(collection, physical, def);
      } catch (err) {
        // Roll back so a half-provisioned collection (validator, no indexes)
        // isn't left behind on partial failure.
        await client.dropCollection(physical).catch(() => {});
        throw err;
      }
      return;
    }

    // Collection already exists → self-heal to the current app schema: swap the
    // validator only when it actually drifted, and create any missing declared
    // indexes (never dropping anything — that is `syncIndexes`'s job).
    if (createOptions.validator) {
      const current = await readCollectionValidator(physical);
      if (JSON.stringify(current) !== JSON.stringify(createOptions.validator)) {
        await client.command({ collMod: physical, validator: createOptions.validator });
      }
    }
    await ensureDeclaredIndexes(collection, physical, def);
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
