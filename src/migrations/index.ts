/**
 * File-based migration runner — `createMongoMigrationRunner`. Orchestrates the
 * two sub-systems:
 *
 *   - `./files.ts`   — discover / load / scaffold `NNN_name.ts` files
 *   - `./journal.ts` — lease-based `_migrations` journal (atomic, crash-safe)
 *
 * `up()` applies pending migrations in numeric order under an exclusive claim
 * with an auto-renewed lease (long migrations can't be stolen by another
 * runner, but a crashed runner's claim expires); `down()` rolls back applied
 * migrations in reverse order and validates its target BEFORE destroying
 * anything; `status()` reports applied/pending; `create()` scaffolds a new file
 * atomically (`wx` — concurrent scaffolds never clobber each other).
 */

import { writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import type { LoggerLike } from '../utils/logger.ts';
import {
  ensureMigrationDir,
  listMigrationFiles,
  loadMigration,
  migrationNameOf,
  nextMigrationNumber,
} from './files.ts';
import { createMigrationJournal } from './journal.ts';
import type { JournalManager, MongoMigrationRunner, MongoMigrationRunnerOptions } from './types.ts';

/** The `service` shape the runner needs (one connected manager + config/logger). */
interface MigrationService {
  db: Record<string, unknown>;
  logger: LoggerLike;
  config?: { migrationDir?: string };
}

const DEFAULT_LEASE_MS = 120_000;

export const createMongoMigrationRunner = (
  service: MigrationService,
  options: MongoMigrationRunnerOptions = {},
): MongoMigrationRunner => {
  const migrationDir = options.migrationDir ?? service.config?.migrationDir ?? './migrations';
  const logger = options.logger ?? service.logger;
  const leaseMs = options.leaseMs ?? DEFAULT_LEASE_MS;

  const manager = (): JournalManager => {
    const keys = Object.keys(service.db);
    // Explicit option first; otherwise the first connected key. In multi-DB
    // services insertion order is arbitrary — pass `db:` explicitly.
    const key = options.db !== undefined ? options.db : keys[0];
    const db = key ? (service.db[key] as JournalManager | undefined) : undefined;
    if (!db) {
      throw new Error(
        options.db !== undefined && !keys.includes(options.db)
          ? `Unknown database "${options.db}" — connected: ${keys.join(', ')}`
          : 'No database client connected — call service.makeConnections() first',
      );
    }
    return db;
  };

  /** Heartbeat that keeps a running claim's lease alive during a long `up()`. */
  const startHeartbeat = (journal: ReturnType<typeof createMigrationJournal>, name: string) => {
    const timer = setInterval(
      () => {
        void journal.renew(name, leaseMs).catch(() => {});
      },
      Math.max(leaseMs / 2, 1_000),
    );
    // Never hold the event loop open just for the heartbeat.
    timer.unref?.();
    return () => clearInterval(timer);
  };

  const up = async (): Promise<void> => {
    await ensureMigrationDir(migrationDir);
    const journal = createMigrationJournal(manager());

    const files = await listMigrationFiles(migrationDir);
    const applied = await journal.appliedNames();
    const pending = files.filter((file) => !applied.has(migrationNameOf(file)));

    for (const file of pending) {
      const migration = await loadMigration(migrationDir, file);
      logger.info({ name: migration.name }, 'running migration up');
      // Exclusive lease-based claim: fresh rows insert, expired claims steal,
      // applied/live rows reject. `status` flips to `applied` only AFTER
      // `up()` succeeds.
      if (!(await journal.claim(migration.name, basename(file), leaseMs))) {
        logger.info(
          { name: migration.name },
          'migration claimed by another runner or already applied, skipping',
        );
        continue;
      }
      const stopHeartbeat = startHeartbeat(journal, migration.name);
      try {
        await migration.up({ service, logger, name: migration.name });
        await journal.markApplied(migration.name);
      } catch (err) {
        await journal.removeRunning(migration.name);
        throw err;
      } finally {
        stopHeartbeat();
      }
      logger.info({ name: migration.name }, 'migration applied');
    }
  };

  const down = async (targetName?: string): Promise<void> => {
    const files = await listMigrationFiles(migrationDir);
    // Validate the target BEFORE touching the DB: a typo'd name must fail
    // loudly instead of silently rolling back EVERYTHING.
    if (targetName !== undefined) {
      const known = files.some((file) => migrationNameOf(file) === targetName);
      if (!known) {
        throw new Error(
          `down(): unknown migration "${targetName}" — known: ${files.map(migrationNameOf).join(', ') || '(none)'}`,
        );
      }
    }
    const journal = createMigrationJournal(manager());
    const applied = await journal.appliedNames();
    const appliedFiles = files.filter((file) => applied.has(migrationNameOf(file))).reverse();

    for (const file of appliedFiles) {
      const migration = await loadMigration(migrationDir, file);
      logger.info({ name: migration.name }, 'running migration down');
      await migration.down({ service, logger, name: migration.name });
      await journal.unrecord(migration.name);
      logger.info({ name: migration.name }, 'migration rolled back');
      if (targetName !== undefined && migration.name === targetName) break;
    }
  };

  const status = async (): Promise<{ applied: string[]; pending: string[] }> => {
    const files = await listMigrationFiles(migrationDir);
    const applied = await createMigrationJournal(manager()).appliedNames();
    const all = files.map(migrationNameOf);
    return {
      applied: all.filter((name) => applied.has(name)),
      pending: all.filter((name) => !applied.has(name)),
    };
  };

  const create = async (name: string): Promise<string> => {
    await ensureMigrationDir(migrationDir);
    const template = `import type { MigrationContext } from '@ignex/ninox';

export const up = async (ctx: MigrationContext): Promise<void> => {
  // const users = ctx.service.db.primaryClient;
  // await users.createSchema('users');
};

export const down = async (ctx: MigrationContext): Promise<void> => {
  // const users = ctx.service.db.primaryClient;
  // await users.client.dropCollection('users');
};
`;
    // Atomic scaffold: `wx` fails if the file appeared between our number
    // scan and the write (concurrent `create()` calls), so we bump + retry
    // instead of silently overwriting someone else's migration.
    for (;;) {
      const next = await nextMigrationNumber(migrationDir);
      const padded = String(next).padStart(3, '0');
      const fileName = `${padded}_${name}.ts`;
      const filePath = join(migrationDir, fileName);
      try {
        await writeFile(filePath, template, { encoding: 'utf8', flag: 'wx' });
        logger.info({ name, file: fileName }, 'migration scaffolded');
        return filePath;
      } catch (err) {
        if ((err as NodeJS.ErrnoException)?.code === 'EEXIST') continue;
        throw err;
      }
    }
  };

  return { up, down, status, create };
};

// Re-export the public migration types so the folder barrel matches the old
// single-module exports.
export type {
  MigrationContext,
  MigrationModule,
  MongoMigrationRunner,
  MongoMigrationRunnerOptions,
} from './types.ts';
