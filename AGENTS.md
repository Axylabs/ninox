# AGENTS.md — @ignex/ninox

Guidance for AI coding agents working in this repository. Read this before
editing code. Human-facing docs: `README.md` (usage), `API.md` (exhaustive
export reference), `STRUCTURE.md` (code map). Agent skills:
`.agents/skills/*/SKILL.md`. Cross-repo local development:
`docs/ai/LOCAL_DEV.md`.

## What this project is

`@ignex/ninox` — a schema-first MongoDB ORM built directly on the `mongodb`
driver. One `s.*` schema drives TS types (`InferDoc`), the MongoDB
`$jsonSchema` validator, and read-time drift checks. Ships DataLoader-batched
relations, a read-through `QueryCache` + in-flight dedup (perf by default),
`$facet`/keyset pagination, a global `createHotCache`, lifecycle hooks, an
error taxonomy, file-based migrations, and graceful transactions. Bun-first:
`bun test` / `bun run` / tsup build; Node ≥ 18.17 works via plain ESM `dist/`.

## Commands

| Task | Command |
|------|---------|
| Install | `bun install` |
| Tests | `bun test` (Mongo-gated suites auto-skip without a server) |
| Coverage | `bun test --coverage` (CI floor: ≥ 85% lines) |
| Typecheck | `bun run typecheck` (== `tsc --noEmit`; includes `tests/types.ts` compile-only assertions) |
| Lint / format | `bun run lint` / `bun run lint:fix` / `bun run format` (Biome) |
| Build | `bun run build` (tsup → `dist/` ESM + d.ts) |
| API-surface gate | `bun run check:api` (barrel ↔ API.md consistency; must stay green) |
| Bench | `bun run bench` (→ `bench/results/summary.json`) |
| Examples | `bun run examples/<file>.ts` (need live Mongo) |
| Smoke demo | `bun run index.ts` |
| Publish (manual) | `bun run deploy[:dry]` (verify → bump → publish → commit+tag) |

## Where things live (short map — full detail in STRUCTURE.md)

```
src/
  index.ts                  public barrel — 216 named exports (values + types)
  toolkit.ts                createMongoToolkit = service + migrations
  types.ts                  DBClientDefinition / CollectionDefinition / Extract*
  schema/                   ★ typed DSL → $jsonSchema + InferDoc + validateDoc
  service/                  op factories: manager.ts (buildManager spreads
                            makeCrudOps/makePaginationOps/makeAggregationOps/
                            makeSchemaOps/makeTransactionOps + populate)
  cache/                    query-cache.ts + in-flight.ts + hot-cache/
  loader/                   DataLoader (microtask batch, per-key cache)
  relation/                 belongsTo/hasMany/manyToMany + populate
  repository/               createRepository (thin typed manager wrapper)
  query-builder/            QueryBuilder chain
  migrations/               NNN_name.ts runner + _migrations journal
  errors/                   AppError taxonomy + driver mapping + HTTP status
  hooks/                    HOOK_NAMES + runHooks
  shared/ + utils/          pure helpers (pagination, keyset, lru, memoize, …)
tests/                      bun:test suites (29) + helpers.ts + types.ts + fixtures/
scripts/                    check-api.ts, deploy.ts (maintainer tooling)
docs/ai/LOCAL_DEV.md        bun link workflow with the core projects
```

## Rules (full text in RULES.md)

1. **Bun first** — `bun test`/`bun run`/tsup; Node is secondary (ESM `dist/`).
2. **Functional composition** — public API is factories over explicit state
   (`createMongoToolkit`, `createMongoService`, `buildManager`,
   `createRepository`, `defineCollections`, `buildPaginationResult`). No
   classes as API entry points — classes only as stateful primitives
   (`QueryCache`, `DataLoader`, `HotCache`, `QueryBuilder`, `LRU`…).
3. **Pure functions, small files** — keep `schema/`, `shared/`, `utils/`
   side-effect free; use lookup-table registries instead of giant switches
   (`FIELD_VALIDATORS` in `schema/validate-doc/field-validators.ts` is the
   model); one responsibility per file, barrels per folder.
4. **Schema-driven types** — collection doc types, filters, updates, pipelines,
   and DB validators all derive from one `s.*` schema. A typo'd collection name
   must be a compile error (`defineCollections`), never a runtime surprise.
5. **Tests with code** — `bun:test`; gate Mongo suites with
   `maybeDescribe(await probe())` from `tests/helpers.ts`; type assertions live
   in `tests/types.ts` (`@ts-expect-error` MUST stay an error); keep ≥ 85% lines.
6. **Docs discipline** — every new export lands in `src/index.ts` AND `API.md`
   (`bun run check:api` gates); README = usage guide, API.md = reference,
   STRUCTURE.md = map; keep CHANGELOG entries in sync with `package.json`
   (currently 0.1.3).
7. **No cross-package deps** — `mongodb` is the only runtime dependency. The
   `@ignex/core/debug` probe must stay lazy/try-catch/ambient-typed
   (`vendor-ignex-core.d.ts`); never import castrum/ignex core eagerly.

## Do NOT

- Export a class as the primary public API surface.
- Add a runtime dependency beyond `mongodb`.
- Break the cache-invalidation contract (writes must invalidate affected
  collections; multi-DB keys stay namespaced).
- Forget the anchor/API checks: `bun run check:api` must pass after export
  changes; `tests/types.ts` assertions must still hold.
- Document `runner.scaffold` — the API is `runner.create(name)`.
