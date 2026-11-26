// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { MIGRATIONS, migrateDatabase } from './database';

const ISO = '2026-11-27T10:00:00.000Z';

describe('SQLite 迁移链', () => {
  it('从 v1 升级到最新版本时保留运行记录并改为复合主键', () => {
    const db = new DatabaseSync(':memory:');
    MIGRATIONS[0]!.up(db);
    db.exec('PRAGMA user_version = 1');

    db.prepare(
      'INSERT INTO workspaces (id, revision, schema_version, payload, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)',
    ).run('ws_a', 1, 2, '{}', ISO, ISO);
    db.prepare(
      'INSERT INTO workspaces (id, revision, schema_version, payload, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)',
    ).run('ws_b', 1, 2, '{}', ISO, ISO);
    db.prepare(
      `INSERT INTO production_runs
        (id, workspace_id, video_id, status, elapsed_ms, started_at, finished_at, payload, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run('run_1', 'ws_a', 'vid_1', 'succeeded', 1000, ISO, ISO, '{}', ISO);

    expect(migrateDatabase(db)).toBe(2);

    const kept = db.prepare('SELECT id, workspace_id FROM production_runs').all();
    expect(kept).toEqual([{ id: 'run_1', workspace_id: 'ws_a' }]);

    // The same run id is now legal in a second workspace.
    expect(() =>
      db
        .prepare(
          `INSERT INTO production_runs
            (id, workspace_id, video_id, status, elapsed_ms, started_at, finished_at, payload, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run('run_1', 'ws_b', 'vid_2', 'running', 0, ISO, null, '{}', ISO),
    ).not.toThrow();

    expect(db.prepare('PRAGMA user_version').get()).toEqual({ user_version: 2 });
    db.close();
  });
});
