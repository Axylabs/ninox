# RULES.md — @ignex/ninox

Non-negotiable rules for writing code in this repo. Read before editing.
Enforced by convention and CI (`bun run typecheck`, `bun run lint`,
`bun test --coverage` ≥ 85% lines, `bun run check:api`). `AGENTS.md` is the
how-to guide; `.agents/skills/` holds task-specific runbooks;
`docs/ai/LOCAL_DEV.md` covers cross-repo local development.

## 1. Bun first

- ninox is a **Bun-first** library: tests run on `bun test`, scripts on
  `bun run`, builds via `tsup` under Bun. Node ≥ 18.17 works (published
  `dist/` is plain ESM), but Bun is the primary developer/runtime experience
  and must never be slowed or complicated by Node-first patterns.
- Engine floors: `node >=18.17.0`, `bun >=1.0.0` (see `package.json`). The
  reference runtime is the Rust-based Bun 1.4+
  ([bun.com/blog/bun-v1.4](https://bun.com/blog/bun-v1.4)); prefer Bun's
  native APIs (`Bun.test`, `Bun.file`, `node:` imports only where the driver
  requires them) whenever they are strictly better or simpler.
- **Performance comes from query shape and the MongoDB driver.** Before
  adding a cache/helper, check the existing perf machinery
  (`src/cache/`, `src/loader/dataloader.ts`, `src/service/crud/read-ops.ts`,
  `$facet` pagination) — do not reinvent it.

## 2. No Rust here — correctness & typing are the product

- ninox is pure TypeScript (no addon). The "core" is the typed schema DSL
  (`src/schema/`), the manager/service op graph (`src/service/`), and the
  caching layer (`src/cache/`). Preserve their contracts exactly:
  `src/index.ts` (public barrel) and `docs/API.md` must agree
  (`bun run check:api` enforces it).
- Hot paths (read pipeline, query cache, in-flight dedup) must stay lean:
  no per-call allocation churn, no eager work at import time
  (see `test/perf-no-side-effects.test.ts`).

## 3. Functional composition — pure functions, no classes

- The public API is **factories over explicit state**:
  `createMongoToolkit()`, `createMongoService()`, `createRepository()`,
  `createHotCache()`, `createMongoMigrationRunner()`. No classes, no `this`,
  for public surfaces; internal mutable state lives inside factory closures
  or explicit context objects (`service/crud/context.ts`, `op-deps.ts`).
- Prefer **pure functions** (same input → same output, no hidden state):
  `toMongoSchema()`, `validateDoc()`, `buildPaginationResult()`,
  `normalizePageLimit()`, `mergeMongoFilters()` are directly unit-testable
  without a database. Isolate driver I/O in the service layer; keep
  `schema/`, `shared/`, `utils/` side-effect free.
- **Small functions in small files**: one responsibility per file, small pure
  functions grouped into folders by concern (`schema/validate-doc/`,
  `service/crud/`, `service/pagination/`, `cache/hot-cache/`, `errors/`,
  `migrations/`). Follow the existing decomposition — never build god-files
  or one giant `helpers.ts`.

## 4. Structure & maintainability

- New code ships in small, focused files under the right folder — consult
  `STRUCTURE.md` before adding a file.
- Don't reinvent: check `src/` (and the IgnEX core repos one directory back
  in `/home/adeel/poc/` — `@ignex/core` in `ignus/packages/core` etc.)
  before writing a new implementation. Reuse `src/shared/` + `src/utils/`
  (lru, memoize, hash, clone, logger) instead of adding duplicate helpers.
- Types drive everything: schema definitions must infer through
  `InferDoc`/`InferField`; keep `exactOptionalPropertyTypes` green.

## 5. Tests ship with code

- `bun test` — unit tests live under `tests/` mirroring `src/`; integration
  tests skip gracefully when no MongoDB is reachable.
- Pure functions get direct unit tests (no mocks); driver-facing wiring gets
  integration tests (`tests/*mongo*.test.ts`, replica-set for change streams /
  `cacheWatch`).
- Coverage floor: ≥ 85% lines (CI). Run `bun test --coverage` after changes.

## 6. Docs discipline (anti-hallucination)

- Docs must match code. Never document behavior you did not verify in the
  source; if a doc and the code disagree, fix the doc.
- When you add/rename/move files or exports, update `AGENTS.md`, `RULES.md`,
  the relevant `.agents/skills/`, `STRUCTURE.md`, `API.md`, and regenerate
  the scaffolding map (`bun run gen:ai-map`).
- Keep `CHANGELOG.md` current; keep the `check:api` surface green.

## 7. Local development with core projects (maintainers & AI only)

- Core IgnEX packages live one directory back in `/home/adeel/poc/`. When a
  change spans repos (e.g. `@ignex/ninox` ↔ `ignex-app` ↔ `@ignex/core`),
  use `bun link` against the local source instead of the registry — see
  `docs/ai/LOCAL_DEV.md`. Never publish from a linked tree; CI/releases
  resolve from the registry (`scripts/deploy.ts`).
