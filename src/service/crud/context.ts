/**
 * Shared CRUD context: the cross-cutting helpers every CRUD op group depends
 * on (collection resolution, tracing, retry plumbing, cache/dedup/drift read
 * pipeline, auto-timestamps, `select` normalization).
 *
 * `makeCrudOps` (see `./index.ts`) builds ONE context via `createCrudContext`
 * and hands it to the read / write / watch op-group factories, so the helpers
 * live in exactly one place instead of being duplicated per op. This module is
 * the dependency-injection seam of the CRUD layer.
 */
import type { Collection, Db, Document, Filter, FindOptions } from 'mongodb';
import type { InFlight } from '../../cache/in-flight.ts';
import type { QueryCache } from '../../cache/query-cache.ts';
import { cacheCollectionKey } from '../../cache/query-cache.ts';
import type { HooksRegistry } from '../../hooks/hooks.ts';
import { withRetry } from '../../mongo-helpers.ts';
import { applySchemaDefaults } from '../../schema/apply-defaults.ts';
import type { ObjectField } from '../../schema/types.ts';
import type { DriftMode } from '../../schema/validate-doc/index.ts';
import type { FilterInput } from '../../shared/filter-types.ts';
import type {
  CollectionTimestamps,
  DbClientsDefinition,
  ExtractCollectionNames,
  ExtractCollectionType,
  ExtractDbNames,
} from '../../types.ts';
import { stableHash } from '../../utils/hash.ts';
import type { LoggerLike } from '../../utils/logger.ts';
import { stripUndefinedFromUpdate, stripUndefinedKeys } from '../../utils/omit-undefined.ts';
import { defineCrudOp } from '../crud-op.ts';
import { checkDocsDrift } from '../drift.ts';
import { makeOpDeps } from '../op-deps.ts';
import {
  type QueryOptions,
  type ResolvedQueryOptions,
  resolveDriftMode,
  resolveQueryOptions,
} from '../query-options.ts';
import type { DbOpMeta } from '../trace-db-op.ts';
import { formatUpdateFilter } from '../update-format.ts';
import type { UpdateInput } from '../update-types.ts';

export type ColNames<
  TClients extends DbClientsDefinition,
  TDb extends ExtractDbNames<TClients>,
> = ExtractCollectionNames<TClients, TDb>;

export type DocOf<
  TClients extends DbClientsDefinition,
  TDb extends ExtractDbNames<TClients>,
  C extends ColNames<TClients, TDb>,
> = ExtractCollectionType<TClients, TDb, C>;

/** Input accepted by insert ops: the doc without `_id`, or with an explicit `_id`. */
export type InsertInput<T> = Omit<T, '_id'> & { _id?: T extends { _id: infer I } ? I : never };

export type VersionedUpdateResult<T> =
  | { ok: true; doc: T }
  | { ok: false; reason: 'not_found' | 'version_conflict' };

/**
 * Find-query options. Extends driver `FindOptions` + SDK `QueryOptions` with a
 * first-class `select` (field list) that is translated to a driver `projection`
 * so only the requested fields are transferred from the server.
 */
export type FindQueryOptions<T> = FindOptions &
  QueryOptions & {
    /** Project only the listed fields — pushed to the driver as `projection`. */
    select?: readonly (keyof T)[];
  };

/** Per-collection auto-timestamp config (keyed by logical collection name). */
export type TimestampsByCollection = Record<string, CollectionTimestamps | undefined>;

export interface CrudOpsOptions {
  resolveCollectionName: (logical: string) => string;
  wrapMongoErrors?: boolean;
  cache?: QueryCache;
  dedupeReads?: boolean;
  inFlight?: InFlight;
  hooks?: HooksRegistry;
  /** Auto-timestamp field names per collection (from the collection definition). */
  timestamps?: TimestampsByCollection;
  /** Service-level schema-drift policy for reads (default `'report'`). */
  drift?: DriftMode;
  /** Resolve the declared schema for a logical collection (drift detection). */
  getSchema?: (logical: string) => ObjectField | undefined;
}

/**
 * Everything a CRUD op-group factory needs, bundled into one immutable object.
 * See `createCrudContext` for the wiring.
 */
export interface CrudContext<
  TClients extends DbClientsDefinition,
  TDb extends ExtractDbNames<TClients>,
> {
  client: Db;
  dbLabel: string;
  logger: LoggerLike;
  opts: CrudOpsOptions;
  /** Logical → physical collection name. */
  resolve: (logical: string) => string;
  /** Trace + optional error mapping for a single DB call. */
  trace: <T>(meta: DbOpMeta, fn: () => T | Promise<T>) => Promise<T>;
  /** Structured log metadata for a (collection, op). */
  meta: (collection: ColNames<TClients, TDb>, op: string) => DbOpMeta;
  /** Raw driver collection handle for a logical collection. */
  coll: <X extends ColNames<TClients, TDb>>(name: X) => Collection<DocOf<TClients, TDb, X>>;
  /** Narrow the strict public filter to the driver's loose `Filter<T>`. */
  toDriverFilter: <X extends ColNames<TClients, TDb>>(
    filter: FilterInput<DocOf<TClients, TDb, X>>,
  ) => Filter<DocOf<TClients, TDb, X>>;
  /** Op pipeline (resolve → trace → retry) for reads. */
  run: <X extends ColNames<TClients, TDb>, T>(
    collection: X,
    opName: string,
    execute: (resolved: ResolvedQueryOptions) => Promise<T>,
    options?: QueryOptions,
  ) => Promise<T>;
  /** Op pipeline for writes — transient errors retried only with `retryWrites: true`. */
  writeRun: <X extends ColNames<TClients, TDb>, T>(
    collection: X,
    opName: string,
    execute: (resolved: ResolvedQueryOptions) => Promise<T>,
    options?: QueryOptions,
  ) => Promise<T>;
  /** Drop this collection's cached reads (DB-namespaced key). */
  invalidate: (collection: ColNames<TClients, TDb>) => void;
  /** Stamp `createdAt`/`updatedAt` onto a doc being created (in place, only when unset). */
  stampCreate: (collection: ColNames<TClients, TDb>, doc: Document) => void;
  /** Merge `updatedAt` into an update payload (plain patch or `$set` operator form). */
  stampUpdate: <X extends ColNames<TClients, TDb>>(
    collection: X,
    update: UpdateInput<DocOf<TClients, TDb, X>>,
  ) => UpdateInput<DocOf<TClients, TDb, X>>;
  /** Return a full replacement with `updatedAt` stamped. */
  stampReplace: (collection: ColNames<TClients, TDb>, doc: Document) => Document;
  /** Shared read pipeline: trace + retry, with opt-in cache and in-flight dedup. */
  read: <X extends ColNames<TClients, TDb>, T>(
    collection: X,
    opName: string,
    filter: FilterInput<DocOf<TClients, TDb, X>>,
    options: QueryOptions | undefined,
    execute: (resolved: ResolvedQueryOptions) => Promise<T>,
    shape?: 'one' | 'many' | 'none',
    /** Extra key discriminator (e.g. `distinct`'s field name). */
    keyExtra?: string,
  ) => Promise<T>;
  /** Translate `select` (field list) into a driver `projection`; strip `select`. */
  normalizeFindOptions: <T>(options: FindQueryOptions<T> | undefined) => FindOptions & QueryOptions;
}

/**
 * Build the CRUD shared context. All state is closure-local (no module-level
 * mutation) and handed to the op-group factories for composition.
 */
export const createCrudContext = <
  TClients extends DbClientsDefinition,
  TDb extends ExtractDbNames<TClients>,
>(
  client: Db,
  dbLabel: string,
  logger: LoggerLike,
  opts: CrudOpsOptions,
): CrudContext<TClients, TDb> => {
  const resolve = opts.resolveCollectionName;
  const deps = makeOpDeps<ColNames<TClients, TDb>>(
    logger,
    dbLabel,
    resolve,
    opts.wrapMongoErrors === true,
  );
  const coll = <X extends ColNames<TClients, TDb>>(name: X): Collection<DocOf<TClients, TDb, X>> =>
    client.collection<DocOf<TClients, TDb, X>>(resolve(String(name)));
  const toDriverFilter = <X extends ColNames<TClients, TDb>>(
    filter: FilterInput<DocOf<TClients, TDb, X>>,
  ): Filter<DocOf<TClients, TDb, X>> => filter as unknown as Filter<DocOf<TClients, TDb, X>>;
  const run = <X extends ColNames<TClients, TDb>, T>(
    collection: X,
    opName: string,
    execute: (resolved: ResolvedQueryOptions) => Promise<T>,
    options?: QueryOptions,
  ): Promise<T> => defineCrudOp(deps, collection, opName, execute, options);

  /** Same as `run` but for write ops — transient errors are NOT auto-retried
   * unless the caller opts in via `QueryOptions.retryWrites` (at-least-once). */
  const writeRun = <X extends ColNames<TClients, TDb>, T>(
    collection: X,
    opName: string,
    execute: (resolved: ResolvedQueryOptions) => Promise<T>,
    options?: QueryOptions,
  ): Promise<T> => defineCrudOp(deps, collection, opName, execute, options, true);

  const invalidate = (collection: ColNames<TClients, TDb>): void => {
    // Namespaced by DB so a write to one database never (in)validates another's
    // same-named collection in the shared cache.
    opts.cache?.invalidateByCollection(
      cacheCollectionKey(client.databaseName, resolve(String(collection))),
    );
  };

  const timestampsFor = (collection: ColNames<TClients, TDb>): CollectionTimestamps | undefined =>
    opts.timestamps?.[String(collection)];

  /**
   * Normalize + stamp a doc being created (in place): schema defaults are
   * materialized first (absent defaulted fields get their declared value),
   * `undefined` keys are stripped (TS "absent" must not serialize to `null`
   * under a strict validator) and `createdAt`/`updatedAt` are set when unset.
   */
  const stampCreate = (collection: ColNames<TClients, TDb>, doc: Document): void => {
    applySchemaDefaults(opts.getSchema?.(String(collection)), doc);
    stripUndefinedKeys(doc);
    const ts = timestampsFor(collection);
    if (!ts) return;
    const now = new Date();
    if (ts.createdAt && doc[ts.createdAt] === undefined) doc[ts.createdAt] = now;
    if (ts.updatedAt && doc[ts.updatedAt] === undefined) doc[ts.updatedAt] = now;
  };

  /** Normalize + merge `updatedAt` into an update payload (plain patch or `$set` operator form). */
  const stampUpdate = <X extends ColNames<TClients, TDb>>(
    collection: X,
    update: UpdateInput<DocOf<TClients, TDb, X>>,
  ): UpdateInput<DocOf<TClients, TDb, X>> => {
    // `undefined` = absent, never `null` on the wire (see omit-undefined).
    stripUndefinedFromUpdate(update);
    // Always normalize plain patches into `$set` form (matches `formatUpdateFilter`).
    const formatted = formatUpdateFilter(update) as Document & { $set?: Document };
    const ts = timestampsFor(collection);
    if (ts?.updatedAt) {
      const $set = { ...(formatted.$set as Document | undefined), [ts.updatedAt]: new Date() };
      return { ...formatted, $set } as unknown as UpdateInput<DocOf<TClients, TDb, X>>;
    }
    return formatted as unknown as UpdateInput<DocOf<TClients, TDb, X>>;
  };

  /** Return a full replacement with `updatedAt` stamped (findOneAndReplace/replaceOne). */
  const stampReplace = (collection: ColNames<TClients, TDb>, doc: Document): Document => {
    applySchemaDefaults(opts.getSchema?.(String(collection)), doc);
    stripUndefinedKeys(doc);
    const ts = timestampsFor(collection);
    if (!ts?.updatedAt) return doc;
    return { ...doc, [ts.updatedAt]: new Date() };
  };

  /** Shared read pipeline: trace + retry, with opt-in cache and in-flight dedup. */
  const read = async <X extends ColNames<TClients, TDb>, T>(
    collection: X,
    opName: string,
    filter: FilterInput<DocOf<TClients, TDb, X>>,
    options: QueryOptions | undefined,
    execute: (resolved: ResolvedQueryOptions) => Promise<T>,
    shape: 'one' | 'many' | 'none' = 'none',
    keyExtra?: string,
  ): Promise<T> => {
    const physical = resolve(String(collection));
    const resolved = resolveQueryOptions(options);
    const noSession = !resolved.sdk.session;
    const useCache = opts.cache !== undefined && noSession && resolved.cache !== false;
    const shouldDedupe =
      resolved.dedupe !== false &&
      (resolved.dedupe === true || (opts.dedupeReads === true && noSession)) &&
      opts.inFlight !== undefined;

    // Schema-drift detection on DB fetch only: check the freshly-fetched docs
    // BEFORE they are cached, so `'throw'` mode never caches/exposes a drifted
    // document and `'report'` mode logs once per fetch (cache hits are skipped).
    // Projected reads return partial documents — validation would false-positive
    // on the excluded required fields, so they are skipped.
    const checkDrift = (value: T): void => {
      const mode = resolveDriftMode(resolved.sdk.drift, opts.drift);
      if (mode === 'off') return;
      if ((resolved.driverOpts as { projection?: unknown }).projection !== undefined) return;
      const docs: Document[] =
        shape === 'many'
          ? (value as Document[])
          : shape === 'one' && value !== null
            ? [value as Document]
            : [];
      checkDocsDrift(
        {
          logger,
          db: dbLabel,
          drift: mode,
          ...(opts.getSchema !== undefined ? { getSchema: opts.getSchema } : {}),
        },
        String(collection),
        opName,
        docs,
      );
    };

    const executeWrapped = () =>
      deps.trace(deps.meta(collection, opName), () =>
        withRetry(() => execute(resolved), {
          maxAttempts: resolved.maxAttempts,
          delayMs: resolved.retryDelayMs,
        }),
      );

    // Hash ONCE and reuse for both the cache key and the dedup key.
    // The op name is part of the identity — `getOne`/`countDocuments`/`distinct`
    // on the same filter return different SHAPES, so they must never share a
    // cache entry (`distinct` also namespaces by its field). Pure retry/dedup
    // knobs are stripped so they can't fragment the cache; `drift` STAYS
    // because it changes read SEMANTICS (a 'throw' request must never be
    // served an entry that was cached under 'off'/'report' without
    // validation), and everything result-affecting (driver opts, session)
    // stays too. Computed LAZILY: session reads use neither cache nor dedup,
    // so their options (containing cyclic ClientSession objects) are never
    // serialized at all.
    const {
      maxAttempts: _ma,
      retryDelayMs: _rd,
      dedupe: _dd,
      cache: _ca,
      retryWrites: _rw,
      ...resultOptions
    } = (options ?? {}) as QueryOptions;
    void _ma;
    void _rd;
    void _dd;
    void _ca;
    void _rw;
    let payloadHash: string | undefined;
    const getPayloadHash = (): string => {
      if (payloadHash === undefined) {
        payloadHash = stableHash([opName, keyExtra ?? '', filter, resultOptions]);
      }
      return payloadHash;
    };

    const key = useCache
      ? opts.cache!.key(cacheCollectionKey(client.databaseName, physical), getPayloadHash())
      : undefined;

    // Execution is created lazily so in-flight dedup can share ONE underlying
    // driver call (creating it eagerly would start a call per request).
    const fetchAndCheck = (): Promise<T> =>
      executeWrapped().then((value) => {
        checkDrift(value);
        return value;
      });

    const runOnce = (): Promise<T> => {
      if (useCache && key) {
        // Capture the collection version BEFORE fetching so a write that lands
        // mid-flight can never be hidden by a late cache set (see `get` guard).
        const colKey = cacheCollectionKey(client.databaseName, physical);
        const versions = { [colKey]: opts.cache!.versionOf(colKey) };
        const hit = opts.cache!.get(key) as T | undefined;
        if (hit !== undefined) return Promise.resolve(hit);
        return fetchAndCheck().then((value) => {
          opts.cache!.set(key, value, undefined, undefined, versions);
          return value;
        });
      }
      return fetchAndCheck();
    };

    if (shouldDedupe) {
      // The collection VERSION is part of the dedup identity: a reader arriving
      // after a write invalidated the collection must start a FRESH load, never
      // join the pre-invalidation in-flight promise (mirrors HotCache's gen).
      const colKey = cacheCollectionKey(client.databaseName, physical);
      const gen = opts.cache !== undefined ? opts.cache.versionOf(colKey) : '';
      // `await` (not a bare `return`): a non-awaited return from this async
      // function unwinds the caller chain in Bun's stack capture, so the ignex
      // debugbar's span origin would truncate here and never reach the route
      // handler that issued this read.
      return await opts.inFlight!.run(`${colKey}|${gen}|${getPayloadHash()}`, runOnce);
    }
    return await runOnce();
  };

  /** Translate `select` (field list) into a driver `projection`; strip `select`. */
  const normalizeFindOptions = <T>(
    options: FindQueryOptions<T> | undefined,
  ): FindOptions & QueryOptions => {
    if (!options) return {};
    const { select, ...rest } = options;
    if (!select || select.length === 0) return rest;
    const projection: Record<string, 1> = {};
    for (const field of select) projection[String(field)] = 1;
    return { ...rest, projection };
  };

  return {
    client,
    dbLabel,
    logger,
    opts,
    resolve,
    trace: deps.trace,
    meta: deps.meta,
    coll,
    toDriverFilter,
    run,
    writeRun,
    invalidate,
    stampCreate,
    stampUpdate,
    stampReplace,
    read,
    normalizeFindOptions,
  };
};
