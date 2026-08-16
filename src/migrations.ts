import { mkdir, readdir, writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { Document } from 'mongodb';
import type { LoggerLike } from './utils/logger.ts';

export interface MigrationContext {
  service: unknown;
  logger: LoggerLike;
  name: string;
}

export interface MigrationModule {
  up: (ctx: MigrationContext) => void | Promise<void>;
  down: (ctx: MigrationContext) => void | Promise<void>;
}

/** Minimal manager surface the journaling uses (satisfied by `service.db.*Client`). */
interface JournalManager {
  insertOne(collection: string, doc: Document): Promise<unknown>;
  findMany(collection: string, filter?: Document): Promise<Document[]>;
  deleteOne(collection: string, filter: Document): Promise<unknown>;
  deleteMany(collection: string, filter: Document): Promise<unknown>;
  updateOne(collection: string, filter: Document, update: Document): Promise<unknown>;
  findOneAndUpdate(
    collection: string,
    filter: Document,
    update: Document,
    options?: Record<string, unknown>,
  ): Promise<Document | null>;
}

export interface MongoMigrationRunner {
  /** Apply every not-yet-applied migration in numeric order. */
  up(): Promise<void>;
  /** Roll back applied migrations in reverse order (down to `targetName` when given). */
  down(targetName?: string): Promise<void>;
  status(): Promise<{ applied: string[]; pending: string[] }>;
  /** Scaffold a new `NNN_name.ts` migration file; returns its path. */
  create(name: string): Promise<string>;
}

export interface MongoMigrationRunnerOptions {
  migrationDir?: string;
  logger?: LoggerLike;
}

const MIGRATION_FILE = /^(\d+)_.+\.(ts|js|mjs)$/;
const JOURNAL_COLLECTION = '_migrations';

export const createMongoMigrationRunner = (
  service: {
    db: Record<string, unknown>;
    logger: LoggerLike;
    config?: { migrationDir?: string };
  },
  options: MongoMigrationRunnerOptions = {},
): MongoMigrationRunner => {
  const migrationDir = options.migrationDir ?? service.config?.migrationDir ?? './migrations';
  const logger = options.logger ?? service.logger;

  const manager = (): JournalManager => {
    const key = Object.keys(service.db)[0];
    const db = key ? (service.db[key] as JournalManager) : undefined;
    if (!db) throw new Error('No database client connected — call service.makeConnections() first');
    return db;
  };

  const listFiles = async (): Promise<string[]> => {
    const files = await readdir(migrationDir);
    return files.filter((file) => MIGRATION_FILE.test(file)).sort();
  };

  const load = async (file: string): Promise<MigrationModule & { name: string }> => {
    const mod = (await import(pathToFileURL(join(migrationDir, file)).href)) as MigrationModule;
    return { name: basename(file).replace(/\.(ts|js|mjs)$/, ''), ...mod };
  };

  const appliedNames = async (): Promise<Set<string>> => {
    const rows = await manager().findMany(JOURNAL_COLLECTION);
    return new Set(
      rows
        // `status` is absent on legacy (pre-status) rows — treat those as applied.
        .filter((row) => row.status === undefined || row.status === 'applied')
        .map((row) => row.name as string),
    );
  };

  const unrecord = async (name: string): Promise<void> => {
    await manager().deleteOne(JOURNAL_COLLECTION, { name });
  };

  const up = async (): Promise<void> => {
    await mkdir(migrationDir, { recursive: true });
    // Recover a claim left `running` by a hard crash: if it's older than a
    // minute it was never marked `applied`, so it can be re-run safely.
    await manager()
      .deleteMany(JOURNAL_COLLECTION, {
        status: 'running',
        appliedAt: { $lt: new Date(Date.now() - 60_000) },
      })
      .catch(() => {});

    const files = await listFiles();
    const applied = await appliedNames();
    const pending = files.filter(
      (file) => !applied.has(basename(file).replace(/\.(ts|js|mjs)$/, '')),
    );

    for (const file of pending) {
      const migration = await load(file);
      logger.info({ name: migration.name }, 'running migration up');
      // Atomic claim: an upsert `$setOnInsert` is exclusive at the document
      // level — the winner upserts a fresh `running` row (findOneAndUpdate
      // returns null); any concurrent runner matches the existing row and
      // skips. `status` flips to `applied` only AFTER `up()` succeeds, so a
      // mid-flight crash leaves a `running` row that `appliedNames()` does NOT
      // count as applied (the stale-row cleanup above re-runs it).
      const claimed = await manager().findOneAndUpdate(
        JOURNAL_COLLECTION,
        { name: migration.name },
        {
          $setOnInsert: {
            name: migration.name,
            appliedAt: new Date(),
            status: 'running',
            file: basename(file),
          },
        },
        { upsert: true, returnDocument: 'before' },
      );
      if (claimed) {
        logger.info({ name: migration.name }, 'migration already applied, skipping');
        continue;
      }
      try {
        await migration.up({ service, logger, name: migration.name });
        await manager()
          .updateOne(
            JOURNAL_COLLECTION,
            { name: migration.name, status: 'running' },
            { $set: { status: 'applied' } },
          )
          .catch(async () => {
            // Marker was removed concurrently — restore an `applied` row.
            await manager()
              .insertOne(JOURNAL_COLLECTION, {
                name: migration.name,
                appliedAt: new Date(),
                status: 'applied',
              })
              .catch(() => {});
          });
      } catch (err) {
        await manager()
          .deleteOne(JOURNAL_COLLECTION, { name: migration.name, status: 'running' })
          .catch(() => {});
        throw err;
      }
      logger.info({ name: migration.name }, 'migration applied');
    }
  };

  const down = async (targetName?: string): Promise<void> => {
    const files = await listFiles();
    const applied = await appliedNames();
    const appliedFiles = files
      .filter((file) => applied.has(basename(file).replace(/\.(ts|js|mjs)$/, '')))
      .reverse();

    for (const file of appliedFiles) {
      const migration = await load(file);
      logger.info({ name: migration.name }, 'running migration down');
      await migration.down({ service, logger, name: migration.name });
      await unrecord(migration.name);
      logger.info({ name: migration.name }, 'migration rolled back');
      if (targetName && migration.name === targetName) break;
    }
  };

  const status = async (): Promise<{ applied: string[]; pending: string[] }> => {
    const files = await listFiles();
    const applied = await appliedNames();
    const all = files.map((file) => basename(file).replace(/\.(ts|js|mjs)$/, ''));
    return {
      applied: all.filter((name) => applied.has(name)),
      pending: all.filter((name) => !applied.has(name)),
    };
  };

  const create = async (name: string): Promise<string> => {
    await mkdir(migrationDir, { recursive: true });
    const files = await listFiles();
    const next =
      files.reduce((max, file) => {
        const match = MIGRATION_FILE.exec(file);
        return match ? Math.max(max, Number(match[1])) : max;
      }, 0) + 1;
    const padded = String(next).padStart(3, '0');
    const fileName = `${padded}_${name}.ts`;
    const filePath = join(migrationDir, fileName);
    const template = `import type { MigrationContext } from 'ninox';

export const up = async (ctx: MigrationContext): Promise<void> => {
  // const users = ctx.service.db.primaryClient;
  // await users.createSchema('users');
};

export const down = async (ctx: MigrationContext): Promise<void> => {
  // const users = ctx.service.db.primaryClient;
  // await users.client.dropCollection('users');
};
`;
    await writeFile(filePath, template, 'utf8');
    logger.info({ name, file: fileName }, 'migration scaffolded');
    return filePath;
  };

  return { up, down, status, create };
};
