// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { MIGRATIONS, migrateDatabase, openDatabase } from './database';
import { SqliteWorkspaceStore } from './workspace-store';

const ISO = '2026-11-27T10:00:00.000Z';

const WORKSPACE_PAYLOAD = JSON.stringify({
  projects: [],
  features: [],
  claims: [],
  evidence: [],
  pullRequests: [],
  releases: [],
  suggestions: [],
  assets: [],
  templates: [],
  videos: [],
  runs: [
    {
      id: 'run_legacy',
      projectId: 'proj_1',
      videoId: 'vid_1',
      scenario: 'happy_path',
      status: 'succeeded',
      steps: [],
      logs: [],
      elapsedMs: 1000,
      startedAt: ISO,
      speed: 1,
      input: { sceneCount: 1, durationSec: 30, aspect: '16:9', claimCount: 0 },
      demo: true,
    },
  ],
  exports: [],
  activity: [],
});

function buildV2Database(): DatabaseSync {
  const db = new DatabaseSync(':memory:');
  MIGRATIONS[0]!.up(db);
  MIGRATIONS[1]!.up(db);
  db.exec('PRAGMA user_version = 2');

  db.prepare(
    'INSERT INTO workspaces (id, revision, schema_version, payload, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)',
  ).run('ws_legacy', 3, 2, WORKSPACE_PAYLOAD, ISO, ISO);
  db.prepare(
    `INSERT INTO production_runs
      (id, workspace_id, video_id, status, elapsed_ms, started_at, finished_at, payload, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    'run_legacy',
    'ws_legacy',
    'vid_1',
    'succeeded',
    1000,
    ISO,
    ISO,
    JSON.stringify(JSON.parse(WORKSPACE_PAYLOAD).runs[0]),
    ISO,
  );
  return db;
}

describe('SQLite v2 → v3 迁移（知识快照表）', () => {
  it('升级后既有工作区、修订号与运行记录完全保留', () => {
    const db = buildV2Database();
    expect(migrateDatabase(db)).toBe(4);

    const workspaceRow = db
      .prepare('SELECT id, revision, schema_version, payload FROM workspaces WHERE id = ?')
      .get('ws_legacy') as { id: string; revision: number; schema_version: number; payload: string };
    expect(workspaceRow).toMatchObject({ id: 'ws_legacy', revision: 3, schema_version: 2 });
    expect(JSON.parse(workspaceRow.payload)).toEqual(JSON.parse(WORKSPACE_PAYLOAD));

    const runs = db
      .prepare('SELECT id, workspace_id, status, payload FROM production_runs')
      .all() as Array<{ id: string; workspace_id: string; status: string; payload: string }>;
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({ id: 'run_legacy', workspace_id: 'ws_legacy', status: 'succeeded' });
    expect(JSON.parse(runs[0]!.payload).id).toBe('run_legacy');

    // The store still reads the migrated workspace through the normal path.
    const store = new SqliteWorkspaceStore(db);
    const record = store.get('ws_legacy');
    expect(record?.revision).toBe(3);
    expect(record?.workspace.runs).toHaveLength(1);

    expect(db.prepare('PRAGMA user_version').get()).toEqual({ user_version: 4 });

    // The new table exists and starts empty.
    expect(db.prepare('SELECT COUNT(*) AS count FROM knowledge_snapshots').get()).toEqual({
      count: 0,
    });
    db.close();
  });

  it('迁移可重复执行且幂等', () => {
    const db = buildV2Database();
    expect(migrateDatabase(db)).toBe(4);
    expect(migrateDatabase(db)).toBe(4);
    expect(db.prepare('SELECT COUNT(*) AS count FROM workspaces').get()).toEqual({ count: 1 });
    db.close();
  });

  it('全新数据库直接到最新版本，并保留 v1→v2 的复合主键约束', () => {
    const db = openDatabase(':memory:');
    expect(db.prepare('PRAGMA user_version').get()).toEqual({ user_version: 4 });

    db.prepare(
      'INSERT INTO workspaces (id, revision, schema_version, payload, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)',
    ).run('ws_a', 1, 2, WORKSPACE_PAYLOAD, ISO, ISO);
    db.prepare(
      'INSERT INTO workspaces (id, revision, schema_version, payload, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)',
    ).run('ws_b', 1, 2, WORKSPACE_PAYLOAD, ISO, ISO);

    const insertRun = db.prepare(
      `INSERT INTO production_runs
        (id, workspace_id, video_id, status, elapsed_ms, started_at, finished_at, payload, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    insertRun.run('run_1', 'ws_a', 'vid_1', 'succeeded', 1, ISO, ISO, '{}', ISO);
    // Same run id in another workspace is legal (v2 composite primary key).
    expect(() =>
      insertRun.run('run_1', 'ws_b', 'vid_2', 'running', 0, ISO, null, '{}', ISO),
    ).not.toThrow();

    // Knowledge snapshots are keyed by id alone and indexed for listing.
    const indexes = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'knowledge_snapshots'")
      .all() as Array<{ name: string }>;
    expect(indexes.map((row) => row.name)).toEqual(
      expect.arrayContaining([
        'idx_knowledge_snapshots_repo_branch',
        'idx_knowledge_snapshots_repo_commit',
      ]),
    );
    db.close();
  });

  it('迁移失败会回滚并保留原 user_version', () => {
    const db = new DatabaseSync(':memory:');
    MIGRATIONS[0]!.up(db);
    db.exec('PRAGMA user_version = 1');
    // Pre-create the v3 table with an incompatible shape so the migration's
    // CREATE TABLE IF NOT EXISTS is a no-op and the index creation fails.
    db.exec('CREATE TABLE knowledge_snapshots (id TEXT PRIMARY KEY)');
    expect(() => migrateDatabase(db)).toThrow();
    // v2 itself committed; only the failing v3 step is rolled back, so the
    // recorded version is the last fully applied migration, never a partial one.
    expect(db.prepare('PRAGMA user_version').get()).toEqual({ user_version: 2 });
    db.close();
  });
});
