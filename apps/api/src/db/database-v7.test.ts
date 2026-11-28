import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import { MIGRATIONS, migrateDatabase } from './database';
import { OrchestrationApprovalStore } from './orchestration-approval-store';
import type { OrchestrationApprovalV1 } from '@asvs/domain';

const ISO = '2026-11-28T09:00:00.000Z';

function tableNames(db: DatabaseSync): string[] {
  const rows = db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
    .all() as Array<{ name: string }>;
  return rows.map((row) => row.name);
}

function columns(db: DatabaseSync, table: string): string[] {
  const rows = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
  return rows.map((row) => row.name);
}

function seedRun(db: DatabaseSync, runId = 'orchrun_v7'): string {
  db.prepare(
    `INSERT INTO orchestration_runs
      (id, workspace_id, project_id, video_id, idempotency_key, status, payload, created_at, updated_at)
     VALUES (?, 'ws_v7', 'proj', 'video', ?, 'awaiting_approval', '{}', ?, ?)`,
  ).run(runId, `idem-${runId}`, ISO, ISO);
  return runId;
}

function pendingApproval(approvalId: string): OrchestrationApprovalV1 {
  return {
    approvalId,
    stepKey: 'capture_demo',
    status: 'pending',
    gateType: 'gate2_demo_capture',
    subjectDigest: 'a'.repeat(64),
    planId: 'plan_v7',
    policyVersion: 'gate2-v1',
    requestedAt: ISO,
  };
}

describe('migration v7 · Gate 2 审批账本', () => {
  it('迁移版本递增到最新且保持幂等', () => {
    const db = new DatabaseSync(':memory:');
    expect(migrateDatabase(db)).toBe(MIGRATIONS.at(-1)!.version);
    expect(migrateDatabase(db)).toBe(MIGRATIONS.at(-1)!.version);
    const version = db.prepare('PRAGMA user_version').get() as { user_version: number };
    expect(version.user_version).toBe(MIGRATIONS.at(-1)!.version);
    db.close();
  });

  it('从 v6 升级只新增表，5B 的 speech_cache / export_bundles 数据原样保留', () => {
    const db = new DatabaseSync(':memory:');
    db.exec('PRAGMA foreign_keys = ON');
    for (const migration of MIGRATIONS.filter((item) => item.version <= 6)) {
      db.exec('BEGIN');
      migration.up(db);
      db.exec(`PRAGMA user_version = ${migration.version}`);
      db.exec('COMMIT');
    }
    db.prepare(
      `INSERT INTO speech_cache
        (cache_key, provider, model, voice_id, language, speed, text_sha256, text_length,
         file_path, sha256, byte_size, duration_ms, sample_rate, channels, license,
         synthetic, created_at, last_used_at, hit_count)
       VALUES ('k', 'p', 'm', 'v', 'zh-CN', 1, 't', 2, '/tmp/a.wav', 's', 1, 1, 48000, 1, 'l', 1, ?, ?, 0)`,
    ).run(ISO, ISO);

    expect(migrateDatabase(db)).toBe(MIGRATIONS.at(-1)!.version);
    expect(tableNames(db)).toContain('orchestration_approvals');
    const row = db.prepare("SELECT cache_key FROM speech_cache WHERE cache_key = 'k'").get() as {
      cache_key: string;
    };
    expect(row.cache_key).toBe('k');
    db.close();
  });

  it('orchestration_approvals 具备审计所需的全部列与索引', () => {
    const db = new DatabaseSync(':memory:');
    migrateDatabase(db);
    expect(columns(db, 'orchestration_approvals')).toEqual(
      expect.arrayContaining([
        'id',
        'run_id',
        'workspace_id',
        'step_key',
        'gate_type',
        'status',
        'plan_id',
        'plan_digest',
        'policy_version',
        'risk_level',
        'requested_at',
        'decided_at',
        'decided_by',
        'decision_note',
        'superseded_by',
        'payload',
      ]),
    );
    const indexes = (
      db
        .prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'orchestration_approvals'")
        .all() as Array<{ name: string }>
    ).map((row) => row.name);
    expect(indexes).toEqual(
      expect.arrayContaining(['idx_orch_approvals_run', 'idx_orch_approvals_workspace_status']),
    );
    db.close();
  });
});

describe('OrchestrationApprovalStore · 决策不可回退', () => {
  it('pending → approved，且重复 approve 返回 null（第二个标签页不能覆盖决定）', () => {
    const db = new DatabaseSync(':memory:');
    migrateDatabase(db);
    const runId = seedRun(db);
    const store = new OrchestrationApprovalStore(db);
    store.createPending(runId, {
      workspaceId: 'ws_v7',
      approval: pendingApproval('appr_v7_1'),
      planDigest: 'a'.repeat(64),
      riskLevel: 'medium',
    });

    const first = store.markApproved(runId, 'appr_v7_1', {
      at: ISO,
      decidedBy: 'local',
      note: 'ok',
    });
    expect(first?.status).toBe('approved');
    expect(first?.decidedBy).toBe('local');

    const second = store.markApproved(runId, 'appr_v7_1', {
      at: '2026-11-28T09:05:00.000Z',
      decidedBy: 'other',
    });
    expect(second).toBeNull();
    expect(store.getLatestByRun(runId)?.status).toBe('approved');
    db.close();
  });

  it('计划编辑后旧审批变为 superseded，只剩一条 pending', () => {
    const db = new DatabaseSync(':memory:');
    migrateDatabase(db);
    const runId = seedRun(db);
    const store = new OrchestrationApprovalStore(db);
    store.createPending(runId, {
      workspaceId: 'ws_v7',
      approval: pendingApproval('appr_old'),
    });
    store.createPending(runId, {
      workspaceId: 'ws_v7',
      approval: pendingApproval('appr_new'),
      // Two plans requested in the same millisecond are legal; ordering falls
      // back to rowid, and the previous row is superseded either way.
      supersedes: 'appr_old',
    });
    const all = store.listByRun(runId);
    expect(all.map((row) => [row.approvalId, row.status])).toEqual([
      ['appr_old', 'superseded'],
      ['appr_new', 'pending'],
    ]);
    expect(store.getLatestByRun(runId)?.approvalId).toBe('appr_new');
    expect(store.countPending('ws_v7')).toBe(1);

    // The superseded approval can no longer be approved.
    expect(
      store.markApproved(runId, 'appr_old', { at: ISO, decidedBy: 'local' }),
    ).toBeNull();
    db.close();
  });

  it('reject 记录原因与时间，之后不能再次 approve', () => {
    const db = new DatabaseSync(':memory:');
    migrateDatabase(db);
    const runId = seedRun(db);
    const store = new OrchestrationApprovalStore(db);
    store.createPending(runId, { workspaceId: 'ws_v7', approval: pendingApproval('appr_r') });
    const rejected = store.markRejected(runId, 'appr_r', {
      at: ISO,
      decidedBy: 'local',
      note: '计划里的按钮会删除演示数据',
    });
    expect(rejected?.status).toBe('rejected');
    expect(rejected?.rejectedAt).toBe(ISO);
    expect(rejected?.decisionNote).toContain('删除');
    expect(store.markApproved(runId, 'appr_r', { at: ISO, decidedBy: 'local' })).toBeNull();
    db.close();
  });

  it('审批行随 run 级联删除，不产生孤儿审计记录', () => {
    const db = new DatabaseSync(':memory:');
    db.exec('PRAGMA foreign_keys = ON');
    migrateDatabase(db);
    const runId = seedRun(db);
    const store = new OrchestrationApprovalStore(db);
    store.createPending(runId, { workspaceId: 'ws_v7', approval: pendingApproval('appr_c') });
    db.prepare('DELETE FROM orchestration_runs WHERE id = ?').run(runId);
    expect(store.listByRun(runId)).toHaveLength(0);
    db.close();
  });
});
