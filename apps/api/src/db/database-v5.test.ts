// @vitest-environment node
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MIGRATIONS, migrateDatabase, openDatabase } from './database';
import { SqliteOrchestrationStore } from './orchestration-store';
import { renderJobDigest } from '@asvs/domain';
import type { RenderJobInputV1 } from '@asvs/domain';

const ISO = '2026-11-27T10:00:00.000Z';
const WORKSPACE_ID = 'ws_orch';
const RUN_ID = 'orchrun_v5test';

function buildV4Database(): DatabaseSync {
  const db = new DatabaseSync(':memory:');
  for (const migration of MIGRATIONS.filter((entry) => entry.version <= 4)) {
    migration.up(db);
  }
  db.exec('PRAGMA user_version = 4');
  db.prepare(
    'INSERT INTO workspaces (id, revision, schema_version, payload, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)',
  ).run(
    WORKSPACE_ID,
    3,
    2,
    JSON.stringify({
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
    }),
    ISO,
    ISO,
  );
  return db;
}

function makeRun(overrides: Record<string, unknown> = {}) {
  return {
    schemaVersion: '1' as const,
    id: RUN_ID,
    workspaceId: WORKSPACE_ID,
    projectId: 'proj_lumen',
    videoId: 'vid_lumen_release',
    idempotencyKey: 'idem-v5-001',
    status: 'queued' as const,
    renderProfile: { width: 1920, height: 1080, codec: 'h264' as const, crf: 18 },
    inputDigest: null,
    currentStepKey: null,
    steps: [
      { stepKey: 'freeze_input' as const, status: 'pending' as const, attempt: 0, checkpointPhases: [] },
      { stepKey: 'verify_claims' as const, status: 'pending' as const, attempt: 0, checkpointPhases: [] },
      { stepKey: 'prepare_media' as const, status: 'pending' as const, attempt: 0, checkpointPhases: [] },
      { stepKey: 'render_video' as const, status: 'pending' as const, attempt: 0, checkpointPhases: [] },
      { stepKey: 'register_artifacts' as const, status: 'pending' as const, attempt: 0, checkpointPhases: [] },
    ],
    input: { sceneCount: 6, durationSec: 30, aspect: '16:9' as const, claimCount: 3 },
    createdAt: ISO,
    updatedAt: ISO,
    ...overrides,
  };
}

let db: DatabaseSync | undefined;
let store: SqliteOrchestrationStore | undefined;
let artifactDir: string | undefined;

beforeEach(() => {
  artifactDir = mkdtempSync(path.join(os.tmpdir(), 'asvs-orch-v5-'));
});

afterEach(() => {
  db?.close();
  db = undefined;
  store = undefined;
  if (artifactDir) rmSync(artifactDir, { recursive: true, force: true });
  artifactDir = undefined;
});

describe('SQLite migration v5 · 编排表', () => {
  it('从 v4 迁移到 v5 后新增五张编排表且保留既有数据', () => {
    const legacy = buildV4Database();
    expect(migrateDatabase(legacy)).toBe(MIGRATIONS[MIGRATIONS.length - 1]!.version);
    const tables = (
      legacy
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'orchestration_%'")
        .all() as Array<{ name: string }>
    )
      .map((row) => row.name)
      .sort();
    expect(tables).toEqual([
      'orchestration_artifacts',
      'orchestration_checkpoints',
      'orchestration_events',
      'orchestration_jobs',
      'orchestration_runs',
    ]);
    const workspace = legacy
      .prepare('SELECT revision FROM workspaces WHERE id = ?')
      .get(WORKSPACE_ID) as { revision: number };
    expect(workspace.revision).toBe(3);
    legacy.close();
  });

  it('同一 (workspace, idempotencyKey) 的重复写入只保留第一条运行与五个任务', () => {
    db = openDatabase(':memory:');
    store = new SqliteOrchestrationStore(db);
    const jobs = (
      ['freeze_input', 'verify_claims', 'prepare_media', 'render_video', 'register_artifacts'] as const
    ).map((stepKey, index) => ({
      id: `orchjob_${String(index).padStart(2, '0')}`,
      stepKey,
      type: stepKey === 'render_video' ? ('render' as const) : ('inline' as const),
      inputDigest: '0'.repeat(64),
      maxAttempts: 3,
      createdAt: ISO,
    }));
    const first = store.insertRun({ run: makeRun(), jobs });
    expect(first.created).toBe(true);
    const second = store.insertRun({
      run: makeRun({ id: 'orchrun_other' }),
      jobs: jobs.map((job) => ({ ...job, id: `${job.id}_x` })),
    });
    expect(second.created).toBe(false);
    expect(second.run.id).toBe(RUN_ID);
    expect(store.listRuns(WORKSPACE_ID)).toHaveLength(1);
    expect(store.listJobs(RUN_ID)).toHaveLength(5);
  });

  it('checkpoint 按 (run, step, phase) 幂等 upsert，事件按插入顺序读取', () => {
    db = openDatabase(':memory:');
    store = new SqliteOrchestrationStore(db);
    store.insertRun({
      run: makeRun(),
      jobs: [
        {
          id: 'orchjob_1',
          stepKey: 'render_video',
          type: 'render',
          inputDigest: '0'.repeat(64),
          maxAttempts: 3,
          createdAt: ISO,
        },
      ],
    });
    const checkpoint = {
      schemaVersion: '1' as const,
      id: `${RUN_ID}_render_video_bundle_ready`,
      runId: RUN_ID,
      stepKey: 'render_video' as const,
      phase: 'bundle_ready',
      inputDigest: 'a'.repeat(64),
      payload: { attempt: 1 },
      createdAt: ISO,
    };
    store.upsertCheckpoint(checkpoint);
    store.upsertCheckpoint({ ...checkpoint, payload: { attempt: 2 }, createdAt: '2026-11-27T10:01:00.000Z' });
    const checkpoints = store.listCheckpoints(RUN_ID);
    expect(checkpoints).toHaveLength(1);
    expect(checkpoints[0]!.payload).toEqual({ attempt: 2 });

    store.appendEvent({
      schemaVersion: '1',
      runId: RUN_ID,
      stepKey: null,
      level: 'info',
      eventType: 'state_change',
      message: '第一次',
      createdAt: ISO,
    });
    store.appendEvent({
      schemaVersion: '1',
      runId: RUN_ID,
      stepKey: 'render_video',
      level: 'warn',
      eventType: 'worker_crash',
      message: '第二次',
      createdAt: ISO,
    });
    expect(store.listEvents(RUN_ID).map((event) => event.message)).toEqual(['第一次', '第二次']);
  });

  it('lease 会递增 attempt，活跃租约拒绝再次抢占，过期后可被回收', () => {
    db = openDatabase(':memory:');
    store = new SqliteOrchestrationStore(db);
    store.insertRun({
      run: makeRun(),
      jobs: [
        {
          id: 'orchjob_lease',
          stepKey: 'render_video',
          type: 'render',
          inputDigest: '0'.repeat(64),
          maxAttempts: 2,
          createdAt: ISO,
        },
      ],
    });
    const first = store.leaseJob('orchjob_lease', {
      owner: 'api_a',
      leaseTtlMs: 15_000,
      now: new Date(ISO),
    });
    expect(first?.attempt).toBe(1);
    const blocked = store.leaseJob('orchjob_lease', {
      owner: 'api_a',
      leaseTtlMs: 15_000,
      now: new Date('2026-11-27T10:00:05.000Z'),
    });
    expect(blocked).toBeNull();
    const stolen = store.leaseJob('orchjob_lease', {
      owner: 'api_a',
      leaseTtlMs: 15_000,
      now: new Date('2026-11-27T10:00:20.000Z'),
    });
    expect(stolen?.attempt).toBe(2);
    expect(
      store.listExpiredLeases('api_b', new Date('2026-11-27T10:00:21.000Z')),
    ).toHaveLength(1);
  });

  it('产物按 storageRef 登记且能按工作区读取', async () => {
    db = openDatabase(':memory:');
    store = new SqliteOrchestrationStore(db);
    store.insertRun({
      run: makeRun(),
      jobs: [
        {
          id: 'orchjob_1',
          stepKey: 'render_video',
          type: 'render',
          inputDigest: '0'.repeat(64),
          maxAttempts: 3,
          createdAt: ISO,
        },
      ],
    });
    const storageRef = `workspaces/${WORKSPACE_ID}/runs/${RUN_ID}/artifacts/${RUN_ID}.mp4`;
    const file = path.join(artifactDir!, ...storageRef.split('/'));
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, 'fake-mp4');
    const job: Omit<RenderJobInputV1, 'jobDigest'> = {
      schemaVersion: '1',
      kind: 'asvs.render-job',
      jobId: 'orchjob_1',
      artifactId: 'artifact_1',
      runId: RUN_ID,
      input: {
        schemaVersion: '1',
        storyboard: {
          schemaVersion: '1',
          videoProjectId: 'vid_lumen_release',
          briefRevisionId: 'brief_v1',
          knowledgeSnapshotId: 'ksnap_local_seed',
          fps: 30,
          scenes: [],
        },
        project: {
          id: 'proj_lumen',
          name: 'Lumen',
          summary: '',
          status: 'active',
          defaultAspect: '16:9',
          templateId: 'tpl_signal',
          sources: [],
          createdAt: ISO,
          updatedAt: ISO,
        },
        features: [],
        assets: [],
        renderProfile: { width: 1920, height: 1080, codec: 'h264', crf: 18 },
      } as unknown as RenderJobInputV1['input'],
      media: [],
      outputFileName: `${RUN_ID}.mp4`,
      createdAt: ISO,
    };
    const digest = await renderJobDigest({
      jobId: job.jobId,
      artifactId: job.artifactId,
      renderInput: job.input,
      media: job.media,
    });
    expect(digest).toMatch(/^[a-f0-9]{64}$/);
    store.insertArtifact({
      schemaVersion: '1',
      id: 'artifact_1_video_mp4',
      runId: RUN_ID,
      workspaceId: WORKSPACE_ID,
      jobId: 'orchjob_1',
      kind: 'video_mp4',
      fileName: `${RUN_ID}.mp4`,
      mimeType: 'video/mp4',
      byteSize: 8,
      sha256: digest,
      storageRef,
      metadata: { width: 1920, height: 1080 },
      createdAt: ISO,
    });
    expect(store.getArtifact(WORKSPACE_ID, 'artifact_1_video_mp4')?.storageRef).toBe(storageRef);
    expect(store.getArtifact('ws_other', 'artifact_1_video_mp4')).toBeNull();
    const detail = store.getDetail(RUN_ID);
    expect(detail?.artifacts).toHaveLength(1);
    expect(detail?.jobs).toHaveLength(1);
  });
});
