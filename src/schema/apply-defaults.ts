/**
 * Schema-default materialization for writes.
 *
 * The schema DSL lets fields carry a `.default(v)` (`flags.hasDefault` +
 * `flags.defaultValue`). Until this module existed those defaults were only
 * *declared* — validation allowed the field to be absent, but nothing ever
 * wrote the value, so stored documents silently lacked defaulted fields. The
 * ORM's own timestamp stamping had the same shape (absent → stamped at
 * insert), and defaults should behave the same: materialized at write time so
 * every stored document carries them.
 *
 * `applySchemaDefaults` fills missing keys (in place, recursively into nested
 * object fields) with a per-document deep clone of the declared default, so
 * no two documents ever share a mutable default reference.
 */

import type { Document } from 'mongodb';
import type { ObjectField } from './types.ts';

/** Deep-clone a default value; falls back to a shallow copy when
 * `structuredClone` is unavailable (very old runtimes). */
const cloneDefault = (value: unknown): unknown => {
  if (value === null || typeof value !== 'object') return value;
  if (typeof structuredClone === 'function') return structuredClone(value);
  return Array.isArray(value) ? [...value] : { ...(value as Record<string, unknown>) };
};

/**
 * Fill schema defaults into `doc` (in place). Only *absent* keys are written;
 * explicitly-provided values (including `undefined`, which the write pipeline
 * strips afterwards) are never overwritten. Nested object fields are recursed
 * into so their inner defaults materialize too.
 *
 * @param schema - The collection's declared schema (`ObjectField`), if any.
 * @param doc - Document being created or fully replaced.
 */
export const applySchemaDefaults = (
  schema: ObjectField | undefined,
  doc: Document,
): void => {
  if (!schema || doc === null || typeof doc !== 'object' || Array.isArray(doc)) return;

  for (const [key, prop] of Object.entries(schema.properties)) {
    if (key in doc && doc[key] !== undefined) {
      // Present value: recurse so nested defaults materialize around it.
      if (prop.kind === 'object' && doc[key] !== null && typeof doc[key] === 'object' && !Array.isArray(doc[key])) {
        applySchemaDefaults(prop, doc[key] as Document);
      }
      continue;
    }
    if (prop.flags.hasDefault) {
      doc[key] = cloneDefault(prop.flags.defaultValue);
    }
  }
};
