import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import type { QaReportV1 } from '@asvs/domain';
import { MIGRATIONS, migrateDatabase } from './database';
import { QaReportStore } from './qa-report-store';

const ISO = '2026-11-28T12:00:00.000Z';
const WS = 'ws_qa_v8';

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

function seedRun(db: DatabaseSync, runId: string, status = 'failed', videoId = 'video_qa'): string {
  db.prepare(
    `INSERT INTO orchestration_runs
      (id, workspace_id, project_id, video_id, idempotency_key, status, payload, created_at, updated_at)
     VALUES (?, ?, 'proj_qa', ?, ?, ?, '{}', ?, ?)`,
  ).run(runId, WS, videoId, `idem-${runId}`, status, ISO, ISO);
  return runId;
}

function report(overrides: Partial<QaReportV1> & Pick<QaReportV1, 'reportId' | 'runId' | 'stage'>): QaReportV1 {
  const base: QaReportV1 = {
    schemaVersion: '1',
    kind: 'asvs.qa-report',
    workspaceId: WS,
    projectId: 'proj_qa',
    videoId: 'video_qa',
    policyVersion: 'qa-v1',
    verdict: 'pass',
    summary: {
      totalFindings: 0,
      blockerCount: 0,
      warningCount: 0,
      infoCount: 0,
      privacyBlockerCount: 0,
      technicalBlockerCount: 0,
      factBlockerCount: 0,
      contentBlockerCount: 0,
    },
    checks: (['privacy', 'technical', 'fact', 'content'] as const).map((category) => ({
      category,
      status: 'pass' as const,
      blockerCount: 0,
      warningCount: 0,
      infoCount: 0,
      summary: '无问题',
    })),
    findings: [],
    coverage: {
      scannedCaptureFrames: 3,
      scannedRenderFrames: 0,
      scannedScreenshots: 2,
      scannedTraceEntries: 10,
      skippedTraceStaticEntries: 4,
      scannedScenes: 2,
      scannedSrtCues: 0,
      ocrProvider: 'deterministic_test',
      ocrExecuted: true,
      ocrSynthetic: true,
      allowlistedDomains: [],
    },
    subject: { inputDigest: 'a'.repeat(64), scriptVersion: 1 },
    durationMs: 12,
    createdAt: ISO,
    ...overrides,
  };
  return base;
}

describe('migration v8 · 独立 QA 报告', () => {
  it('迁移版本递增到 8 且保持幂等', () => {
    const db = new DatabaseSync(':memory:');
    expect(MIGRATIONS.at(-1)!.version).toBe(8);
    expect(migrateDatabase(db)).toBe(8);
    expect(migrateDatabase(db)).toBe(8);
    const version = db.prepare('PRAGMA user_version').get() as { user_version: number };
    expect(version.user_version).toBe(8);
    db.close();
  });

  it('从 v7 升级只新增 qa_reports，5C 审批账本数据原样保留', () => {
    const db = new DatabaseSync(':memory:');
    db.exec('PRAGMA foreign_keys = ON');
    for (const migration of MIGRATIONS.filter((item) => item.version <= 7)) {
      db.exec('BEGIN');
      migration.up(db);
      db.exec(`PRAGMA user_version = ${migration.version}`);
      db.exec('COMMIT');
    }
    const runId = seedRun(db, 'orchrun_v7_keep', 'awaiting_approval');
    db.prepare(
      `INSERT INTO orchestration_approvals
        (id, run_id, workspace_id, step_key, gate_type, status, requested_at, payload, created_at, updated_at)
       VALUES ('appr_keep', ?, ?, 'capture_demo', 'gate2_demo_capture', 'pending', ?, '{}', ?, ?)`,
    ).run(runId, WS, ISO, ISO, ISO);

    expect(migrateDatabase(db)).toBe(8);
    expect(tableNames(db)).toContain('qa_reports');
    const kept = db
      .prepare("SELECT status FROM orchestration_approvals WHERE id = 'appr_keep'")
      .get() as { status: string };
    expect(kept.status).toBe('pending');
    db.close();
  });

  it('qa_reports 具备查询所需的全部列与索引', () => {
    const db = new DatabaseSync(':memory:');
    migrateDatabase(db);
    expect(columns(db, 'qa_reports')).toEqual(
      expect.arrayContaining([
        'id',
        'run_id',
        'workspace_id',
        'project_id',
        'video_id',
        'stage',
        'verdict',
        'policy_version',
        'blocker_count',
        'warning_count',
        'privacy_blocker_count',
        'report_artifact_id',
        'report_sha256',
        'input_digest',
        'script_version',
        'payload',
        'created_at',
      ]),
    );
    const indexes = (
      db
        .prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'qa_reports'")
        .all() as Array<{ name: string }>
    ).map((row) => row.name);
    expect(indexes).toEqual(
      expect.arrayContaining(['idx_qa_reports_workspace_video', 'idx_qa_reports_run_stage']),
    );
    db.close();
  });
});

describe('QaReportStore', () => {
  it('同一 (run, stage) 重试时原子覆盖，另一阶段报告保留', () => {
    const db = new DatabaseSync(':memory:');
    migrateDatabase(db);
    const store = new QaReportStore(db);
    const runId = seedRun(db, 'orchrun_upsert');

    store.upsert({
      report: report({ reportId: 'qarep_cap_1', runId, stage: 'capture' }),
      reportSha256: 'b'.repeat(64),
    });
    store.upsert({
      report: report({ reportId: 'qarep_final_1', runId, stage: 'final' }),
      reportSha256: 'c'.repeat(64),
      reportArtifactId: 'artifact_final',
    });
    // A retried qa_capture rewrites its own stage only.
    store.upsert({
      report: report({
        reportId: 'qarep_cap_2',
        runId,
        stage: 'capture',
        verdict: 'fail',
        summary: {
          totalFindings: 1,
          blockerCount: 1,
          warningCount: 0,
          infoCount: 0,
          privacyBlockerCount: 1,
          technicalBlockerCount: 0,
          factBlockerCount: 0,
          contentBlockerCount: 0,
        },
        checks: [
          {
            category: 'privacy',
            status: 'fail',
            blockerCount: 1,
            warningCount: 0,
            infoCount: 0,
            summary: '命中 1 项',
          },
          {
            category: 'technical',
            status: 'pass',
            blockerCount: 0,
            warningCount: 0,
            infoCount: 0,
            summary: '无问题',
          },
          {
            category: 'fact',
            status: 'pass',
            blockerCount: 0,
            warningCount: 0,
            infoCount: 0,
            summary: '无问题',
          },
          {
            category: 'content',
            status: 'pass',
            blockerCount: 0,
            warningCount: 0,
            infoCount: 0,
            summary: '无问题',
          },
        ],
        findings: [
          {
            id: 'qaf_01',
            ruleId: 'privacy.email',
            category: 'privacy',
            severity: 'blocker',
            sourceKind: 'capture_trace',
            title: '命中邮箱',
            message: 'Trace 中出现疑似邮箱',
            remediation: '替换为脱敏账号后重录',
            remediationAction: 'production',
            location: { scope: 'global' },
            matchRedacted: 'a***@corp.internal',
            matchSha256: 'd'.repeat(64),
          },
        ],
      }),
      reportSha256: 'e'.repeat(64),
    });

    expect(store.listByRun(WS, runId).map((row) => row.report.reportId)).toEqual([
      'qarep_cap_2',
      'qarep_final_1',
    ]);
    expect(store.getByRun(WS, runId, 'capture')?.report.verdict).toBe('fail');
    expect(store.getByRun(WS, runId, 'final')?.report.reportId).toBe('qarep_final_1');
    // No stage means the stronger (final) report wins.
    expect(store.getByRun(WS, runId)?.report.stage).toBe('final');
    db.close();
  });

  it('findLatestByVideo 返回被阻断失败运行的最新报告（不限于 succeeded）', () => {
    const db = new DatabaseSync(':memory:');
    migrateDatabase(db);
    const store = new QaReportStore(db);
    const failedRun = seedRun(db, 'orchrun_failed_qa', 'failed');
    store.upsert({
      report: report({
        reportId: 'qarep_blocked',
        runId: failedRun,
        stage: 'capture',
        verdict: 'fail',
        summary: {
          totalFindings: 1,
          blockerCount: 1,
          warningCount: 0,
          infoCount: 0,
          privacyBlockerCount: 1,
          technicalBlockerCount: 0,
          factBlockerCount: 0,
          contentBlockerCount: 0,
        },
        findings: [
          {
            id: 'qaf_01',
            ruleId: 'privacy.github_token',
            category: 'privacy',
            severity: 'blocker',
            sourceKind: 'capture_screenshot',
            title: '命中 Token',
            message: '截图中检测到疑似 GitHub Token',
            remediation: '使用脱敏测试账号重新录屏',
            remediationAction: 'production',
            location: { scope: 'scene', sceneId: 'scene_1' },
            matchRedacted: 'ghp_****9a2f',
          },
        ],
        checks: [
          {
            category: 'privacy',
            status: 'fail',
            blockerCount: 1,
            warningCount: 0,
            infoCount: 0,
            summary: '命中 1 项',
          },
          {
            category: 'technical',
            status: 'pass',
            blockerCount: 0,
            warningCount: 0,
            infoCount: 0,
            summary: '无问题',
          },
          {
            category: 'fact',
            status: 'pass',
            blockerCount: 0,
            warningCount: 0,
            infoCount: 0,
            summary: '无问题',
          },
          {
            category: 'content',
            status: 'pass',
            blockerCount: 0,
            warningCount: 0,
            infoCount: 0,
            summary: '无问题',
          },
        ],
        createdAt: '2026-11-28T12:05:00.000Z',
      }),
      reportSha256: 'a'.repeat(64),
    });

    const latest = store.findLatestByVideo(WS, 'video_qa');
    expect(latest?.report.runId).toBe(failedRun);
    expect(latest?.report.verdict).toBe('fail');
    expect(latest?.report.summary.privacyBlockerCount).toBe(1);
    db.close();
  });

  it('报告行随 run 级联删除', () => {
    const db = new DatabaseSync(':memory:');
    db.exec('PRAGMA foreign_keys = ON');
    migrateDatabase(db);
    const store = new QaReportStore(db);
    const runId = seedRun(db, 'orchrun_cascade');
    store.upsert({
      report: report({ reportId: 'qarep_cascade', runId, stage: 'final' }),
      reportSha256: 'f'.repeat(64),
    });
    db.prepare('DELETE FROM orchestration_runs WHERE id = ?').run(runId);
    expect(store.listByRun(WS, runId)).toHaveLength(0);
    db.close();
  });
});
