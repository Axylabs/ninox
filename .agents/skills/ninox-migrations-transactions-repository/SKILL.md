---
name: ninox-migrations-transactions-repository
description: State-changing infrastructure of @ignex/ninox — file-based migrations with a claim journal, graceful transactions with capability fallback, and the optional repository layer. Use when touching migrations, transactions, or the repository wrapper.
---

# ninox: Migrations, Transactions & Repository

State-changing infrastructure: file-based migrations with a crash-safe claim
journal, graceful transactions that degrade when the server lacks replica-set
support, and the optional domain-typed repository layer.

## When to use
- Adding migration runner features, changing journal semantics, or migration
  file discovery/scaffolding.
- Changing transaction fallback behavior or the toolkit wiring.
- Working on `createRepository` or optimistic-locking/soft-delete helpers.

## Key files
| File | Role |
| --- | --- |
| `src/migrations/types.ts` | `MigrationContext` / `MigrationModule` / `MongoMigrationRunner` + constants |
| `src/migrations/files.ts` | Discovery / load / next-number — pure fs helpers |
| `src/migrations/journal.ts` | `_migrations` claim-based journal (atomic, crash-safe) |
| `src/migrations/index.ts` | `createMongoMigrationRunner` (orchestrates files + journal) |
| `src/service/transaction.ts` | Manager ops: `transaction(fn(session|null))` + `migrate(name, fn, filePath?)` |
| `src/graceful-transaction.ts` | `withGracefulMongoTransaction` — transaction-or-null fallback wrapper |
| `src/capabilities.ts` | `probeMongoCapabilities` — transaction capability probe + env override |
| `src/toolkit.ts` | `createMongoToolkit` = service + migrations sharing one config |
| `src/repository/repository.ts` | `createRepository(manager, collection)` — getById/create/page/populate/watch… |
| `src/mongo-helpers.ts` | `withRetry` (transient-only) + `withTransaction` (manual session) |
| `src/service/crud/write-ops.ts` | `updateWithVersion` (`__v` optimistic locking), `softDeleteOne` (`deletedAt`) |

## Facts (verified against code — don't guess)
- Runner API is **`create(name)`** (NOT `scaffold`): `create('add_tags')` creates
  a `NNN_add_tags.ts` template. API.md documents `create`; older README snippets
  said `scaffold` — that is wrong.
- Migration files are `NNN_name.ts` exporting `up` / `down`; the runner applies
  them in numeric order, rolls back to a target with `down(targetName)`,
  `status()` lists applied/pending. The journal makes concurrent runners safe
  (claim-based idempotency).
- Transactions degrade gracefully: `withGracefulMongoTransaction` returns
  `null`/runs without a session when the server isn't a replica set /
  mongos — reads/writes still work, session-scoped features don't.
- Repository is a **thin typed wrapper over a manager** (closures, no change
  tracking): `getById(id) => manager.getOne(collection, { _id: id }, …)`.
- Optimistic locking: `updateWithVersion` bumps `__v`; soft delete sets
  `deletedAt` and reads filter via the active filter (`buildMongoActiveFilter`).

## Conventions
- Migrations and journal code stays pure where possible (fs helpers in
  `files.ts`); driver interaction lives in the runner/manager.
- Keep the `_migrations` journal claim protocol atomic — never weaken it.

## Verify
- `bun test` — migrations, repository, crud (optimistic locking/soft delete),
  integration, graceful-transaction suites.
- `bun run typecheck` — `tests/types.ts` type assertions.
