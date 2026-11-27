// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { MIGRATIONS, migrateDatabase, openDatabase } from './database';

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
  runs: [],
  exports: [],
  activity: [],
});

function buildV3Database(): DatabaseSync {
  const db = new DatabaseSync(':memory:');
  MIGRATIONS[0]!.up(db);
  MIGRATIONS[1]!.up(db);
  MIGRATIONS[2]!.up(db);
  db.exec('PRAGMA user_version = 3');

  db.prepare(
    'INSERT INTO workspaces (id, revision, schema_version, payload, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)',
  ).run('ws_legacy', 7, 2, WORKSPACE_PAYLOAD, ISO, ISO);
  db.prepare(
    `INSERT INTO production_runs
      (id, workspace_id, video_id, status, elapsed_ms, started_at, finished_at, payload, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run('run_legacy', 'ws_legacy', 'vid_1', 'succeeded', 1000, ISO, ISO, '{}', ISO);
  db.prepare(
    `INSERT INTO knowledge_snapshots
      (id, repo, branch, git_commit_sha, parent_snapshot_id, indexed_at, index_mode,
       total_files, indexed_files, reused_files, removed_files, skipped_files,
       fetched_files, duration_ms, payload)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    `snap_${'a'.repeat(32)}`,
    'frontLikeDog/livenotes',
    'main',
    '1'.repeat(40),
    null,
    ISO,
    'cold',
    1,
    1,
    0,
    0,
    0,
    1,
    5,
    '{}',
  );
  return db;
}

describe('SQLite v3 → v4 迁移（PR 候选与核验审计表）', () => {
  it('升级后既有工作区、运行记录与知识快照完全保留', () => {
    const db = buildV3Database();
    expect(migrateDatabase(db)).toBe(4);

    const workspaceRow = db
      .prepare('SELECT id, revision, schema_version FROM workspaces WHERE id = ?')
      .get('ws_legacy') as { id: string; revision: number; schema_version: number };
    expect(workspaceRow).toMatchObject({ id: 'ws_legacy', revision: 7, schema_version: 2 });

    const runs = db
      .prepare('SELECT id, workspace_id, status FROM production_runs')
      .all() as Array<{ id: string; workspace_id: string; status: string }>;
    expect(runs).toEqual([{ id: 'run_legacy', workspace_id: 'ws_legacy', status: 'succeeded' }]);

    const snapshots = db
      .prepare('SELECT id, repo, branch, git_commit_sha FROM knowledge_snapshots')
      .all() as Array<{ id: string; repo: string; branch: string; git_commit_sha: string }>;
    expect(snapshots).toHaveLength(1);
    expect(snapshots[0]).toMatchObject({
      repo: 'frontLikeDog/livenotes',
      branch: 'main',
      git_commit_sha: '1'.repeat(40),
    });

    expect(db.prepare('PRAGMA user_version').get()).toEqual({ user_version: 4 });
    expect(db.prepare('SELECT COUNT(*) AS count FROM pr_change_candidates').get()).toEqual({
      count: 0,
    });
    expect(db.prepare('SELECT COUNT(*) AS count FROM claim_verifications').get()).toEqual({
      count: 0,
    });
    db.close();
  });

  it('迁移可重复执行且幂等', () => {
    const db = buildV3Database();
    expect(migrateDatabase(db)).toBe(4);
    expect(migrateDatabase(db)).toBe(4);
    expect(db.prepare('SELECT COUNT(*) AS count FROM workspaces').get()).toEqual({ count: 1 });
    db.close();
  });

  it('全新数据库直接到 v4，并具备候选唯一索引与审计索引', () => {
    const db = openDatabase(':memory:');
    expect(db.prepare('PRAGMA user_version').get()).toEqual({ user_version: 4 });

    const indexes = db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name IN ('pr_change_candidates', 'claim_verifications')",
      )
      .all() as Array<{ name: string }>;
    expect(indexes.map((row) => row.name)).toEqual(
      expect.arrayContaining([
        'idx_pr_candidates_repo_pull',
        'idx_pr_candidates_repo_analyzed',
        'idx_claim_verifications_claim',
      ]),
    );

    // (repo, pull_number) is unique: a second row for the same PR must fail,
    // which is what makes re-analysis an explicit upsert instead of a fork.
    const insert = db.prepare(
      `INSERT INTO pr_change_candidates
        (id, repo, pull_number, classification, promotable, merged, merge_commit_sha,
         snapshot_id, analyzed_at, updated_at, payload)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    insert.run('prc_1', 'frontLikeDog/livenotes', 12, 'user_facing_feature', 1, 1, null, null, ISO, ISO, '{}');
    expect(() =>
      insert.run('prc_2', 'frontLikeDog/livenotes', 12, 'internal_non_promotable', 0, 1, null, null, ISO, ISO, '{}'),
    ).toThrow();
    // The same pull number in another repository is fine.
    expect(() =>
      insert.run('prc_3', 'other/repo', 12, 'internal_non_promotable', 0, 1, null, null, ISO, ISO, '{}'),
    ).not.toThrow();
    db.close();
  });

  it('迁移失败会回滚并保留原 user_version', () => {
    const db = new DatabaseSync(':memory:');
    MIGRATIONS[0]!.up(db);
    MIGRATIONS[1]!.up(db);
    db.exec('PRAGMA user_version = 2');
    // Pre-create the v4 table with an incompatible shape so the migration's
    // CREATE TABLE IF NOT EXISTS is a no-op and the unique index fails.
    db.exec('CREATE TABLE pr_change_candidates (id TEXT PRIMARY KEY)');
    expect(() => migrateDatabase(db)).toThrow();
    // v3 committed; only the failing v4 step is rolled back.
    expect(db.prepare('PRAGMA user_version').get()).toEqual({ user_version: 3 });
    db.close();
  });
});
