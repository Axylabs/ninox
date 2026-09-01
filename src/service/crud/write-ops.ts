/**
 * Write op group: every mutating CRUD operation. All writes invalidate the
 * collection's cache and fire lifecycle hooks (`beforeUpdate`/`afterUpdate`
 * on update-shaped ops including `updateMany`/`findOneAndUpdate`/`upsert`,
 * `beforeDelete`/`afterDelete` on delete-shaped ops including `deleteMany`
 * and `softDeleteOne`). The two RAW escape hatches (`bulkWrite`, and the
 * per-operation nature of `bulkUpsert`) are hook-translucent by design —
 * there is no single filter/doc to hand a hook. Transient driver errors are
 * retried only when the caller opts in via `QueryOptions.retryWrites`
 * (at-least-once semantics).
 *
 * Composed into `makeCrudOps` (see `./index.ts`). Takes the read ops object as
 * an explicit dependency so `updateWithVersion` can reuse `getOne` for its
 * cache-bypassing version read — dependency injection rather than a shared
 * closure.
 */
import type {
  AnyBulkWriteOperation,
  BulkWriteOptions,
  DeleteOptions,
  DeleteResult,
  Document,
  Filter,
  FindOneAndDeleteOptions,
  FindOneAndReplaceOptions,
  FindOneAndUpdateOptions,
  FindOptions,
  InsertManyResult,
  InsertOneOptions,
  InsertOneResult,
  OptionalUnlessRequiredId,
  ReplaceOptions,
  UpdateFilter,
  UpdateOptions,
  UpdateResult,
} from 'mongodb';
import { BadRequest } from '../../errors/index.ts';
import { type HookContext, runHooks } from '../../hooks/hooks.ts';
import { MAX_BATCH_OPS } from '../../shared/constants.ts';
import type { FilterInput } from '../../shared/filter-types.ts';
import { mergeMongoActiveFilter } from '../../shared/soft-delete.ts';
import type { QueryOptions } from '../query-options.ts';
import type { UpdateInput } from '../update-types.ts';
import type {
  ColNames,
  CrudContext,
  DocOf,
  InsertInput,
  VersionedUpdateResult,
} from './context.ts';
import type { ReadOps } from './read-ops.ts';

/** Write ops produced for one database by `makeWriteOps`. */
export type WriteOps<
  TClients extends import('../../types.ts').DbClientsDefinition,
  TDb extends import('../../types.ts').ExtractDbNames<TClients>,
> = ReturnType<typeof makeWriteOps<TClients, TDb>>;

/**
 * Build the write op set from the shared CRUD context. `readOps.getOne` is
 * injected so versioned updates read committed state without the cache.
 */
export const makeWriteOps = <
  TClients extends import('../../types.ts').DbClientsDefinition,
  TDb extends import('../../types.ts').ExtractDbNames<TClients>,
>(
  ctx: CrudContext<TClients, TDb>,
  readOps: ReadOps<TClients, TDb>,
) => {
  type C = ColNames<TClients, TDb>;
  type DocOf2<X extends C> = DocOf<TClients, TDb, X>;

  const { opts } = ctx;
  const { coll, toDriverFilter, writeRun, invalidate, stampCreate, stampUpdate, stampReplace } =
    ctx;
  const { getOne } = readOps;

  /**
   * Post-commit hook runner. `after*` hooks fire AFTER the DB write and cache
   * invalidation have succeeded — a throwing hook must NOT fail the operation:
   * the caller would see "failed" for already-committed state, and a retrying
   * caller would duplicate the write. Log loudly and keep the committed result.
   */
  const safeAfterHooks = async (
    collection: string,
    name: 'afterCreate' | 'afterUpdate' | 'afterDelete',
    hookCtx: HookContext<Document>,
  ): Promise<void> => {
    try {
      await runHooks(opts.hooks, collection, name, hookCtx);
    } catch (err) {
      ctx.logger.error?.(
        {
          collection,
          hook: name,
          error: err instanceof Error ? err.message : String(err),
        },
        `post-commit ${name} hook failed; DB write is already committed`,
      );
    }
  };

  /** Insert one document (runs before/after-create hooks; stamps timestamps; invalidates cache). */
  const insertOne = async <X extends C>(
    collection: X,
    doc: InsertInput<DocOf2<X>>,
    options?: InsertOneOptions & QueryOptions,
  ): Promise<InsertOneResult<DocOf2<X>>> => {
    await runHooks(opts.hooks, String(collection), 'beforeCreate', {
      collection: String(collection),
      doc: doc as Document,
    });
    stampCreate(collection, doc as Document);
    const result = await writeRun(
      collection,
      'mongo.insertOne',
      async (r) => {
        const insertOpts: InsertOneOptions = {
          ...(r.driverOpts as InsertOneOptions),
          ...(r.sdk.session !== undefined ? { session: r.sdk.session } : {}),
        };
        return await coll(collection).insertOne(doc as OptionalUnlessRequiredId<DocOf2<X>>, insertOpts);
      },
      options,
    );
    invalidate(collection);
    await safeAfterHooks(String(collection), 'afterCreate', {
      collection: String(collection),
      doc: doc as Document,
    });
    return result as InsertOneResult<DocOf2<X>>;
  };

  /** Insert many documents in one call (guards against batches over `MAX_BATCH_OPS`). */
  const insertMany = async <X extends C>(
    collection: X,
    docs: ReadonlyArray<InsertInput<DocOf2<X>>>,
    options?: BulkWriteOptions & QueryOptions,
  ): Promise<InsertManyResult<DocOf2<X>>> => {
    // Guard BEFORE stamping/hooking — don't pay O(n) work for an inevitable throw.
    if (docs.length > MAX_BATCH_OPS) {
      throw new BadRequest(
        `insertMany: too many docs (${docs.length} > ${MAX_BATCH_OPS}); split the batch`,
      );
    }
    await runHooks(opts.hooks, String(collection), 'beforeCreate', {
      collection: String(collection),
      docs: docs as unknown as Document[],
    });
    for (const d of docs) stampCreate(collection, d as Document);
    const result = await writeRun(
      collection,
      'mongo.insertMany',
      async (r) => {
        const bulkOpts: BulkWriteOptions = {
          ...(r.driverOpts as BulkWriteOptions),
          ...(r.sdk.session !== undefined ? { session: r.sdk.session } : {}),
        };
        return coll(collection).insertMany(
          docs as ReadonlyArray<OptionalUnlessRequiredId<DocOf2<X>>>,
          bulkOpts,
        );
      },
      options,
    );
    invalidate(collection);
    await safeAfterHooks(String(collection), 'afterCreate', {
      collection: String(collection),
      docs: docs as unknown as Document[],
    });
    return result as InsertManyResult<DocOf2<X>>;
  };

  /** Update the first document matching a filter (runs before/after-update hooks). */
  const updateOne = async <X extends C>(
    collection: X,
    filter: FilterInput<DocOf2<X>>,
    update: UpdateInput<DocOf2<X>>,
    options?: UpdateOptions & QueryOptions,
  ): Promise<UpdateResult<DocOf2<X>>> => {
    await runHooks(opts.hooks, String(collection), 'beforeUpdate', {
      collection: String(collection),
      filter: filter as Filter<Document>,
    });
    const effective = stampUpdate(collection, update);
    const result = await writeRun(
      collection,
      'mongo.updateOne',
      async (r) => {
        const updateOpts: UpdateOptions = {
          ...(r.driverOpts as UpdateOptions),
          ...(r.sdk.session !== undefined ? { session: r.sdk.session } : {}),
        };
        return coll(collection).updateOne(
          toDriverFilter(filter),
          effective as unknown as UpdateFilter<DocOf2<X>>,
          updateOpts,
        );
      },
      options,
    );
    invalidate(collection);
    await safeAfterHooks(String(collection), 'afterUpdate', {
      collection: String(collection),
      filter: filter as Filter<Document>,
    });
    return result;
  };

  /** Update every document matching a filter (runs before/after-update hooks). */
  const updateMany = async <X extends C>(
    collection: X,
    filter: FilterInput<DocOf2<X>>,
    update: UpdateInput<DocOf2<X>>,
    options?: UpdateOptions & QueryOptions,
  ): Promise<UpdateResult<DocOf2<X>>> => {
    await runHooks(opts.hooks, String(collection), 'beforeUpdate', {
      collection: String(collection),
      filter: filter as Filter<Document>,
    });
    const effective = stampUpdate(collection, update);
    const result = await writeRun(
      collection,
      'mongo.updateMany',
      async (r) => {
        const updateOpts: UpdateOptions = {
          ...(r.driverOpts as UpdateOptions),
          ...(r.sdk.session !== undefined ? { session: r.sdk.session } : {}),
        };
        return coll(collection).updateMany(
          toDriverFilter(filter),
          effective as unknown as UpdateFilter<DocOf2<X>>,
          updateOpts,
        );
      },
      options,
    );
    invalidate(collection);
    await safeAfterHooks(String(collection), 'afterUpdate', {
      collection: String(collection),
      filter: filter as Filter<Document>,
    });
    return result;
  };

  /** Find one + update atomically (runs before/after-update hooks). */
  const findOneAndUpdate = async <X extends C>(
    collection: X,
    filter: FilterInput<DocOf2<X>>,
    update: UpdateInput<DocOf2<X>>,
    options?: FindOneAndUpdateOptions & QueryOptions,
  ): Promise<DocOf2<X> | null> => {
    await runHooks(opts.hooks, String(collection), 'beforeUpdate', {
      collection: String(collection),
      filter: filter as Filter<Document>,
    });
    const effective = stampUpdate(collection, update);
    const result = await writeRun(
      collection,
      'mongo.findOneAndUpdate',
      async (r) => {
        const fOpts = {
          ...(r.driverOpts as FindOneAndUpdateOptions),
          ...(r.sdk.session !== undefined ? { session: r.sdk.session } : {}),
          ...(r.sdk.maxTimeMS !== undefined ? { maxTimeMS: r.sdk.maxTimeMS } : {}),
          ...(r.sdk.hint !== undefined
            ? { hint: r.sdk.hint as FindOneAndUpdateOptions['hint'] }
            : {}),
          // `after` is the ORM's default, but honor an explicit caller override.
          returnDocument: (r.driverOpts as FindOneAndUpdateOptions).returnDocument ?? 'after',
        } as FindOneAndUpdateOptions;
        return coll(collection).findOneAndUpdate(
          toDriverFilter(filter),
          effective as unknown as UpdateFilter<DocOf2<X>>,
          fOpts,
        ) as unknown as DocOf2<X> | null;
      },
      options,
    );
    invalidate(collection);
    await safeAfterHooks(String(collection), 'afterUpdate', {
      collection: String(collection),
      filter: filter as Filter<Document>,
    });
    return result;
  };

  /** Find one + replace atomically with a full replacement doc (runs update hooks). */
  const findOneAndReplace = async <X extends C>(
    collection: X,
    filter: FilterInput<DocOf2<X>>,
    replacement: DocOf2<X>,
    options?: FindOneAndReplaceOptions & QueryOptions,
  ): Promise<DocOf2<X> | null> => {
    await runHooks(opts.hooks, String(collection), 'beforeUpdate', {
      collection: String(collection),
      filter: filter as Filter<Document>,
    });
    const effective = stampReplace(collection, replacement as Document) as DocOf2<X>;
    const result = await writeRun(
      collection,
      'mongo.findOneAndReplace',
      async (r) => {
        const fOpts = {
          ...(r.driverOpts as FindOneAndReplaceOptions),
          ...(r.sdk.session !== undefined ? { session: r.sdk.session } : {}),
          ...(r.sdk.maxTimeMS !== undefined ? { maxTimeMS: r.sdk.maxTimeMS } : {}),
          ...(r.sdk.hint !== undefined
            ? { hint: r.sdk.hint as FindOneAndReplaceOptions['hint'] }
            : {}),
          // `after` is the ORM's default, but honor an explicit caller override.
          returnDocument: (r.driverOpts as FindOneAndReplaceOptions).returnDocument ?? 'after',
        } as FindOneAndReplaceOptions;
        return coll(collection).findOneAndReplace(
          toDriverFilter(filter),
          effective,
          fOpts,
        ) as unknown as DocOf2<X> | null;
      },
      options,
    );
    invalidate(collection);
    await safeAfterHooks(String(collection), 'afterUpdate', {
      collection: String(collection),
      filter: filter as Filter<Document>,
    });
    return result;
  };

  /** Replace one document by filter (full replacement; runs before/after-update hooks). */
  const replaceOne = async <X extends C>(
    collection: X,
    filter: FilterInput<DocOf2<X>>,
    replacement: InsertInput<DocOf2<X>>,
    options?: ReplaceOptions & QueryOptions,
  ): Promise<UpdateResult<DocOf2<X>>> => {
    await runHooks(opts.hooks, String(collection), 'beforeUpdate', {
      collection: String(collection),
      filter: filter as Filter<Document>,
    });
    const result = await writeRun(
      collection,
      'mongo.replaceOne',
      async (r) => {
        const repOpts: ReplaceOptions = {
          ...(r.driverOpts as ReplaceOptions),
          ...(r.sdk.session !== undefined ? { session: r.sdk.session } : {}),
        };
        return coll(collection).replaceOne(
          toDriverFilter(filter),
          stampReplace(collection, replacement as Document) as unknown as OptionalUnlessRequiredId<
            DocOf2<X>
          >,
          repOpts,
        );
      },
      options,
    );
    invalidate(collection);
    await safeAfterHooks(String(collection), 'afterUpdate', {
      collection: String(collection),
      filter: filter as Filter<Document>,
    });
    return result;
  };

  /** Delete the first document matching a filter (runs before/after-delete hooks). */
  const deleteOne = async <X extends C>(
    collection: X,
    filter: FilterInput<DocOf2<X>>,
    options?: DeleteOptions & QueryOptions,
  ): Promise<DeleteResult> => {
    await runHooks(opts.hooks, String(collection), 'beforeDelete', {
      collection: String(collection),
      filter: filter as Filter<Document>,
    });
    const result = await writeRun(
      collection,
      'mongo.deleteOne',
      async (r) => {
        const delOpts: DeleteOptions = {
          ...(r.driverOpts as DeleteOptions),
          ...(r.sdk.session !== undefined ? { session: r.sdk.session } : {}),
        };
        return await coll(collection).deleteOne(toDriverFilter(filter), delOpts);
      },
      options,
    );
    invalidate(collection);
    await safeAfterHooks(String(collection), 'afterDelete', {
      collection: String(collection),
      filter: filter as Filter<Document>,
    });
    return result;
  };

  /** Delete every document matching a filter (runs before/after-delete hooks). */
  const deleteMany = async <X extends C>(
    collection: X,
    filter: FilterInput<DocOf2<X>>,
    options?: DeleteOptions & QueryOptions,
  ): Promise<DeleteResult> => {
    await runHooks(opts.hooks, String(collection), 'beforeDelete', {
      collection: String(collection),
      filter: filter as Filter<Document>,
    });
    const result = await writeRun(
      collection,
      'mongo.deleteMany',
      async (r) => {
        const delOpts: DeleteOptions = {
          ...(r.driverOpts as DeleteOptions),
          ...(r.sdk.session !== undefined ? { session: r.sdk.session } : {}),
        };
        return await coll(collection).deleteMany(toDriverFilter(filter), delOpts);
      },
      options,
    );
    invalidate(collection);
    await safeAfterHooks(String(collection), 'afterDelete', {
      collection: String(collection),
      filter: filter as Filter<Document>,
    });
    return result;
  };

  /** Find one + delete atomically (runs before/after-delete hooks). */
  const findOneAndDelete = async <X extends C>(
    collection: X,
    filter: FilterInput<DocOf2<X>>,
    options?: FindOneAndDeleteOptions & QueryOptions,
  ): Promise<DocOf2<X> | null> => {
    await runHooks(opts.hooks, String(collection), 'beforeDelete', {
      collection: String(collection),
      filter: filter as Filter<Document>,
    });
    const result = await writeRun(
      collection,
      'mongo.findOneAndDelete',
      async (r) => {
        const fOpts = {
          ...(r.driverOpts as FindOneAndDeleteOptions),
          ...(r.sdk.session !== undefined ? { session: r.sdk.session } : {}),
          ...(r.sdk.maxTimeMS !== undefined ? { maxTimeMS: r.sdk.maxTimeMS } : {}),
          ...(r.sdk.hint !== undefined
            ? { hint: r.sdk.hint as FindOneAndDeleteOptions['hint'] }
            : {}),
        } as FindOneAndDeleteOptions;
        return coll(collection).findOneAndDelete(
          toDriverFilter(filter),
          fOpts,
        ) as unknown as DocOf2<X> | null;
      },
      options,
    );
    invalidate(collection);
    await safeAfterHooks(String(collection), 'afterDelete', {
      collection: String(collection),
      filter: filter as Filter<Document>,
    });
    return result;
  };

  /**
   * Soft-delete one doc: sets `deletedAt` instead of removing it (active reads
   * exclude it). Stamps `updatedAt` per the collection's timestamps config and
   * runs before/after-delete hooks — a soft delete IS a delete from the
   * lifecycle's point of view.
   */
  const softDeleteOne = async <X extends C>(
    collection: X,
    filter: FilterInput<DocOf2<X>>,
    options?: UpdateOptions & QueryOptions,
  ): Promise<UpdateResult<DocOf2<X>>> => {
    await runHooks(opts.hooks, String(collection), 'beforeDelete', {
      collection: String(collection),
      filter: filter as Filter<Document>,
    });
    const active = mergeMongoActiveFilter(true, filter);
    const effective = stampUpdate(collection, {
      $set: { deletedAt: new Date() },
    } as unknown as UpdateInput<DocOf2<X>>);
    const result = await writeRun(
      collection,
      'mongo.softDeleteOne',
      async (r) => {
        const updateOpts: UpdateOptions = {
          ...(r.driverOpts as UpdateOptions),
          ...(r.sdk.session !== undefined ? { session: r.sdk.session } : {}),
        };
        return coll(collection).updateOne(
          active,
          effective as unknown as UpdateFilter<DocOf2<X>>,
          updateOpts,
        );
      },
      options,
    );
    invalidate(collection);
    await safeAfterHooks(String(collection), 'afterDelete', {
      collection: String(collection),
      filter: filter as Filter<Document>,
    });
    return result;
  };

  /** Upsert one document (insert when the filter matches nothing; runs update hooks). */
  const upsert = async <X extends C>(
    collection: X,
    filter: FilterInput<DocOf2<X>>,
    update: UpdateInput<DocOf2<X>>,
    options?: UpdateOptions & QueryOptions,
  ): Promise<UpdateResult<DocOf2<X>>> => {
    await runHooks(opts.hooks, String(collection), 'beforeUpdate', {
      collection: String(collection),
      filter: filter as Filter<Document>,
    });
    const formatted = stampUpdate(collection, update) as unknown as UpdateFilter<DocOf2<X>>;
    const result = await writeRun(
      collection,
      'mongo.upsert',
      async (r) => {
        const updateOpts: UpdateOptions = {
          ...(r.driverOpts as UpdateOptions),
          ...(r.sdk.session !== undefined ? { session: r.sdk.session } : {}),
          upsert: true,
        };
        return await coll(collection).updateOne(toDriverFilter(filter), formatted, updateOpts);
      },
      options,
    );
    invalidate(collection);
    await safeAfterHooks(String(collection), 'afterUpdate', {
      collection: String(collection),
      filter: filter as Filter<Document>,
    });
    return result;
  };

  /** Bulk upsert: many `updateOne`-style upserts in one write (guarded by `MAX_BATCH_OPS`). */
  const bulkUpsert = async <X extends C>(
    collection: X,
    operations: Array<{
      filter: FilterInput<DocOf2<X>>;
      update: UpdateInput<DocOf2<X>>;
      upsert?: boolean;
    }>,
    options?: BulkWriteOptions & QueryOptions,
  ): Promise<Document> => {
    // Guard BEFORE mapping/stamping — don't pay O(n) work for an inevitable throw.
    if (operations.length > MAX_BATCH_OPS) {
      throw new BadRequest(
        `bulkUpsert: too many operations (${operations.length} > ${MAX_BATCH_OPS}); split the batch`,
      );
    }
    const writes = operations.map((op) => ({
      updateOne: {
        filter: op.filter,
        update: stampUpdate(collection, op.update) as unknown as UpdateFilter<DocOf2<X>>,
        upsert: op.upsert ?? true,
      },
    })) as unknown as AnyBulkWriteOperation<DocOf2<X>>[];
    const result = await writeRun(
      collection,
      'mongo.bulkUpsert',
      async (r) => {
        const bulkOpts: BulkWriteOptions = {
          ...(r.driverOpts as BulkWriteOptions),
          ...(r.sdk.session !== undefined ? { session: r.sdk.session } : {}),
        };
        return await coll(collection).bulkWrite(writes, bulkOpts);
      },
      options,
    );
    invalidate(collection);
    return result;
  };

  /** Generic `bulkWrite` with arbitrary driver bulk operations (guarded by `MAX_BATCH_OPS`). */
  const bulkWrite = async <X extends C>(
    collection: X,
    operations: AnyBulkWriteOperation<DocOf2<X>>[],
    options?: BulkWriteOptions & QueryOptions,
  ): Promise<Document> => {
    if (operations.length > MAX_BATCH_OPS) {
      throw new BadRequest(
        `bulkWrite: too many operations (${operations.length} > ${MAX_BATCH_OPS}); split the batch`,
      );
    }
    const result = await writeRun(
      collection,
      'mongo.bulkWrite',
      async (r) => {
        const bulkOpts: BulkWriteOptions = {
          ...(r.driverOpts as BulkWriteOptions),
          ...(r.sdk.session !== undefined ? { session: r.sdk.session } : {}),
        };
        return await coll(collection).bulkWrite(operations, bulkOpts);
      },
      options,
    );
    invalidate(collection);
    return result;
  };

  /** Optimistic lock on a `__v` field: read → CAS update → version_conflict on miss. */
  const updateWithVersion = async <X extends C>(
    collection: X,
    filter: FilterInput<DocOf2<X>>,
    update: UpdateInput<DocOf2<X>>,
    options?: FindOneAndUpdateOptions & QueryOptions,
  ): Promise<VersionedUpdateResult<DocOf2<X>>> => {
    // The version read must reflect committed state — bypass the read cache
    // (a stale or cached-`null` entry would yield spurious not_found /
    // version_conflict even when the doc is present/current in the DB).
    const existing = await getOne(collection, filter, {
      ...(options as FindOptions & QueryOptions),
      cache: false,
    });
    if (!existing) return { ok: false, reason: 'not_found' };

    // A doc that has never been versioned has NO `__v` field — `{__v: 0}` would
    // never match, so match on the field's absence for the first write.
    const current = (existing as Document & { __v?: number }).__v;
    const versionFilter: Document =
      current === undefined ? { __v: { $exists: false } } : { __v: current };

    const formatted = stampUpdate(collection, update) as Document;
    const versionedUpdate = {
      ...formatted,
      $inc: { ...((formatted as Document).$inc as Document | undefined), __v: 1 },
    } as unknown as UpdateInput<DocOf2<X>>;

    const result = await findOneAndUpdate(
      collection,
      { ...filter, ...versionFilter } as unknown as FilterInput<DocOf2<X>>,
      versionedUpdate,
      { ...options, returnDocument: 'after' },
    );
    if (result === null) return { ok: false, reason: 'version_conflict' };
    return { ok: true, doc: result };
  };

  return {
    insertOne,
    insertMany,
    updateOne,
    updateMany,
    findOneAndUpdate,
    findOneAndReplace,
    deleteOne,
    deleteMany,
    softDeleteOne,
    upsert,
    bulkUpsert,
    bulkWrite,
    updateWithVersion,
    findOneAndDelete,
    replaceOne,
  };
};
