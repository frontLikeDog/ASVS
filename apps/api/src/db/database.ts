import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

interface Migration {
  version: number;
  up(db: DatabaseSync): void;
}

/**
 * Additive schema migrations. `PRAGMA user_version` records the last applied
 * step; never edit a shipped migration, append a new one instead.
 */
const MIGRATIONS: Migration[] = [
  {
    version: 1,
    up(db) {
      db.exec(`
        CREATE TABLE IF NOT EXISTS workspaces (
          id TEXT PRIMARY KEY,
          revision INTEGER NOT NULL,
          schema_version INTEGER NOT NULL,
          payload TEXT NOT NULL,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS production_runs (
          id TEXT PRIMARY KEY,
          workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
          video_id TEXT NOT NULL,
          status TEXT NOT NULL,
          elapsed_ms INTEGER NOT NULL,
          started_at TEXT NOT NULL,
          finished_at TEXT,
          payload TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );

        CREATE INDEX IF NOT EXISTS idx_production_runs_workspace
          ON production_runs(workspace_id, started_at DESC);
      `);
    },
  },
  {
    version: 2,
    up(db) {
      // Run ids are only unique inside a workspace (seed/export data uses
      // fixed ids such as `run_lumen_success`), so the primary key must be
      // composite. SQLite cannot alter a primary key in place; rebuild.
      db.exec(`
        CREATE TABLE production_runs_v2 (
          id TEXT NOT NULL,
          workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
          video_id TEXT NOT NULL,
          status TEXT NOT NULL,
          elapsed_ms INTEGER NOT NULL,
          started_at TEXT NOT NULL,
          finished_at TEXT,
          payload TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          PRIMARY KEY (workspace_id, id)
        );

        INSERT INTO production_runs_v2
          (id, workspace_id, video_id, status, elapsed_ms, started_at, finished_at, payload, updated_at)
        SELECT id, workspace_id, video_id, status, elapsed_ms, started_at, finished_at, payload, updated_at
        FROM production_runs;

        DROP TABLE production_runs;
        ALTER TABLE production_runs_v2 RENAME TO production_runs;

        CREATE INDEX idx_production_runs_workspace
          ON production_runs(workspace_id, started_at DESC);
      `);
    },
  },
];

function readUserVersion(db: DatabaseSync): number {
  const row = db.prepare('PRAGMA user_version').get() as { user_version?: number } | undefined;
  return Number(row?.user_version ?? 0);
}

export function migrateDatabase(db: DatabaseSync): number {
  let version = readUserVersion(db);
  for (const migration of MIGRATIONS) {
    if (migration.version <= version) continue;
    db.exec('BEGIN');
    try {
      migration.up(db);
      db.exec(`PRAGMA user_version = ${migration.version}`);
      db.exec('COMMIT');
      version = migration.version;
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
  }
  return version;
}

export function openDatabase(dbPath: string): DatabaseSync {
  if (dbPath !== ':memory:') {
    mkdirSync(path.dirname(dbPath), { recursive: true });
  }
  const db = new DatabaseSync(dbPath);
  if (dbPath !== ':memory:') {
    db.exec('PRAGMA journal_mode = WAL');
  }
  db.exec('PRAGMA foreign_keys = ON');
  db.exec('PRAGMA busy_timeout = 5000');
  migrateDatabase(db);
  return db;
}

export { MIGRATIONS };
