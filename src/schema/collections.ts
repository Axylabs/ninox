/**
 * Schema-driven collection registry.
 *
 * Collection names are carried by the schema itself (`s.object({...}, { name })`
 * or `defineCollection(name, schema, extras)`), so the ORM's `collections` map
 * is *derived* from the schemas instead of hand-typed. The keys of the derived
 * map ARE the schema names — a typo'd collection name becomes a type error
 * everywhere (CRUD, query builder, relations, populate).
 *
 *   const users = s.object(
 *     { _id: s.objectId(), email: s.string() },
 *     { name: 'users' },
 *   );
 *   const orders = defineCollection('orders', s.object({ ... }), {
 *     indexes: [{ key: { userId: 1 } }],
 *   });
 *
 *   const dbClients = {
 *     primary: {
 *       name: 'app',
 *       collections: defineCollections(users, orders),
 *     },
 *   };
 */

import type { HookMap } from '../hooks/hooks.ts';
import type {
  CollectionDefinition,
  CollectionLike,
  CollectionTimestamps,
  IndexSpec,
} from '../types.ts';
import type { InferDoc } from './infer.ts';
import type { ObjectField, SchemaType } from './types.ts';

/** An object schema that carries its collection name. */
export type NamedObjectField<N extends string = string> = ObjectField<
  Record<string, SchemaType>,
  N
> & {
  name: N;
};

/** A collection definition (schema + optional indexes/hooks) that carries its name. */
export type NamedCollectionDefinition<
  N extends string = string,
  S extends ObjectField = ObjectField,
> = CollectionDefinition<S & { name: N }> & { name: N };

/** Either form accepted by `defineCollections`. */
export type NamedCollection =
  | (ObjectField & { name: string })
  | ({
      schema: ObjectField;
      indexes?: IndexSpec[];
      hooks?: HookMap<any>;
      timestamps?: CollectionTimestamps | boolean;
    } & { name: string });

/** Extract the carried collection name from a named collection item. */
type StringName<T> = T extends { name: infer N } ? Extract<N, string> : never;

export type CollectionName<T> = T extends { schema: infer S } ? StringName<S> : StringName<T>;

/** The value placed in the derived `collections` map for a given item. */
export type CollectionValue<T> = T extends {
  schema: infer S;
  indexes?: infer _Ix;
  hooks?: infer _Hk;
}
  ? CollectionDefinition<Extract<S, ObjectField>>
  : T;

/** The derived `collections` map type: keyed by each item's carried name. */
export type CollectionMap<T extends readonly NamedCollection[]> = {
  [K in T[number] as CollectionName<K>]: CollectionValue<K>;
};

const resolveItemName = (item: NamedCollection): string =>
  'schema' in item
    ? ((item as NamedCollectionDefinition).schema as NamedObjectField).name
    : (item as NamedObjectField).name;

/**
 * Fail fast when `timestamps: true | {...}` names fields the schema does not
 * declare. Under strict validation (`additionalProperties: false`, the
 * default) an undeclared timestamp field gets EVERY insert/update rejected
 * server-side with an opaque `DocumentValidationFailure` — far from this
 * misconfiguration site. Throwing here turns that into a one-line fix.
 */
const assertTimestampsDeclared = (
  name: string,
  schema: ObjectField,
  timestamps: CollectionTimestamps | boolean,
): void => {
  const ts = typeof timestamps === 'boolean' ? {} : timestamps;
  const createdAt = ts.createdAt ?? 'createdAt';
  const updatedAt = ts.updatedAt ?? 'updatedAt';
  const properties = schema.properties ?? {};
  for (const field of [createdAt, updatedAt]) {
    if (!(field in properties)) {
      throw new Error(
        `defineCollections: "${name}" enables timestamps but its schema does not declare the ` +
          `field "${field}". Add \`${field}: s.date().optional()\` to the schema (or adjust ` +
          `\`timestamps\`) — otherwise strict validation rejects every stamped write.`,
      );
    }
  }
};

const resolveItemValue = (item: NamedCollection): CollectionLike => {
  if ('schema' in item) {
    const def = item as NamedCollectionDefinition;
    if (def.timestamps !== undefined) {
      assertTimestampsDeclared(def.name, def.schema, def.timestamps);
    }
    return {
      schema: def.schema,
      ...(def.indexes ? { indexes: def.indexes } : {}),
      ...(def.hooks ? { hooks: def.hooks } : {}),
      ...(def.timestamps !== undefined ? { timestamps: def.timestamps } : {}),
    };
  }
  return item as NamedObjectField;
};

/**
 * Attach a collection name to a schema (plus optional indexes/hooks) and return
 * a `CollectionDefinition`-shaped item. When no extras are needed this is
 * equivalent to `s.object({...}, { name })`.
 */
export const defineCollection = <N extends string, S extends ObjectField>(
  name: N,
  schema: S,
  extras: {
    indexes?: IndexSpec[];
    hooks?: HookMap<InferDoc<S>>;
    timestamps?: CollectionTimestamps | boolean;
  } = {},
): NamedCollectionDefinition<N, S> => {
  const namedSchema = { ...(schema as object), name } as S & { name: N };
  if (extras.timestamps !== undefined) {
    assertTimestampsDeclared(name, schema, extras.timestamps);
  }
  return {
    name,
    schema: namedSchema,
    ...(extras.indexes ? { indexes: extras.indexes } : {}),
    ...(extras.hooks ? { hooks: extras.hooks } : {}),
    ...(extras.timestamps !== undefined ? { timestamps: extras.timestamps } : {}),
  } as NamedCollectionDefinition<N, S>;
};

/**
 * Derive a `collections` map from schemas that carry their own names. Throws on
 * duplicate names. The returned map's keys are the schema names and its values
 * are valid `CollectionLike` entries, so it plugs directly into
 * `DBClientDefinition.collections` with full type inference.
 */
export const defineCollections = <const T extends readonly NamedCollection[]>(
  ...items: T
): CollectionMap<T> => {
  const out: Record<string, unknown> = {};
  for (const item of items) {
    const name = resolveItemName(item);
    if (name in out) {
      throw new Error(`defineCollections: duplicate collection name "${name}"`);
    }
    out[name] = resolveItemValue(item);
  }
  return out as CollectionMap<T>;
};
