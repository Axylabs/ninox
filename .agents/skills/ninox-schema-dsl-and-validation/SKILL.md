---
name: ninox-schema-dsl-and-validation
description: Work with @ignex/ninox's schema-first DSL — how one s.* schema becomes TS types, the MongoDB $jsonSchema validator, and read-time drift checks. Use when adding a field kind, changing schema inference, or touching validation/drift.
---

# ninox: Schema DSL & Validation

The schema DSL (`s.*`) is the **single source of truth**: one schema drives the
TS document type (`InferDoc`), the MongoDB `$jsonSchema` validator, and the
read-side drift checker. Never maintain them separately.

## When to use
- Adding a new field kind (e.g. `s.bigint`) or a chainable modifier.
- Changing `InferDoc`/`InferField` inference, `toMongoSchema` output, or
  `validateDoc` drift behavior.
- Debugging why a document fails the DB validator or a drift check.

## Key files
| File | Role |
| --- | --- |
| `src/schema/types.ts` | Field builders (`s.*`) + `Chainable` modifiers + `s.jsonSchema` escape hatch |
| `src/schema/collections.ts` | `defineCollection` / `defineCollections` — schema-carried names, duplicate-name throw |
| `src/schema/infer.ts` | `InferField` / `InferDoc` (TS type from schema) |
| `src/schema/json-schema.ts` | `MongoJsonSchema` fragment type (shared by DSL + converter) |
| `src/schema/to-mongo-schema.ts` | `toMongoSchema` / `toMongoValidator` ($jsonSchema conversion) |
| `src/schema/validate-doc/` | Drift check: `types.ts` (DriftMode/Issue/Code), `helpers.ts`, **`field-validators.ts`** (per-kind registry), `validate.ts` (dispatch), `index.ts` |
| `src/service/schema-ops.ts` | `createSchema` / `updateSchema` / `syncIndexes` |
| `src/service/drift.ts` | Shared drift checker wired into read ops (`off` / `report` / `throw`) |

## How the pieces connect
`schema` → `toMongoSchema` → `$jsonSchema` validator (strict: `additionalProperties:
false`; reserved `_id` / `__v` / `deletedAt`) AND `InferDoc` (TS type) AND
`validateDoc` (read-time drift, `off`/`report`/`throw`, default `report`).

## Conventions
- **Lookup-table registries, not giant switches**: `FIELD_VALIDATORS` in
  `field-validators.ts` is a record of 15 pure per-kind validator functions,
  each receiving injected recursion deps (`validateValue` / `validateObjectProps`)
  to break the import cycle. New kinds add a row, not a `switch` branch.
- Keep the DSL pure: `schema/` has **no driver I/O** — everything is
  side-effect-free and directly unit-testable.
- `format` is a no-op (never emitted into `$jsonSchema`); BSON kinds are
  distinct (`double` / `long` / `decimal`).
- Types must infer: schema definitions must flow through `InferDoc` /
  `InferField`; keep `exactOptionalPropertyTypes` green.

## Verify
- `bun test` — schema / schema-complex / schema-sync / drift suites.
- `bun run typecheck` — `tests/types.ts` compile-only type assertions must stay
  errors if invalidated (they assert the inferred types).
- `bun run lint` (Biome).
