// @vitest-environment node
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import type {
  OrchestrationApprovalV1,
  OrchestrationArtifactV1,
  StudioSnapshot,
} from '@asvs/domain';
import type {
  CreateOrchestrationRunInput,
  RenderJobExecutionResult,
  RenderJobExecutorCallbacks,
  RenderJobExecutorPort,
} from '@asvs/ports';
import { openDatabase } from '../db/database';
import { SqliteOrchestrationStore } from '../db/orchestration-store';
import { Orchestrator } from './orchestrator';
import { OrchestrationHttpError } from './errors';

const WORKSPACE_ID = 'ws_orch_test';
const VIDEO_ID = 'vid_orch_test';
const ISO = '2026-11-27T10:00:00.000Z';

const SNAPSHOT: StudioSnapshot = {
  projects: [
    {
      id: 'proj_orch',
      name: 'Orch',
      productName: 'Orch',
      description: '编排器测试项目',
      website: 'https://orch.demo.invalid',
      stage: 'active',
      brand: {
        logoText: 'ORCH',
        logoMark: 'orbit',
        primary: '#FF7A59',
        secondary: '#FFD5B8',
        fontPair: 'grotesk',
        style: 'editorial',
        intro: '',
        outro: '',
      },
      sources: [],
      defaultAspect: '16:9',
      defaultLanguage: 'zh-CN',
      templateId: 'tpl_signal',
      analysisCount: 0,
      createdAt: ISO,
      updatedAt: ISO,
      demo: true,
    },
  ],
  features: [],
  claims: [],
  evidence: [],
  pullRequests: [],
  releases: [],
  suggestions: [],
  assets: [],
  templates: [],
  videos: [
    {
      id: VIDEO_ID,
      projectId: 'proj_orch',
      title: 'Orchestration test',
      mode: 'release_video',
      stage: 'review',
      fps: 30,
      brief: {
        objective: '验证编排器',
        audience: '工程师',
        featureIds: [],
        durationSec: 30,
        aspect: '16:9',
        language: 'zh-CN',
        tone: 'confident',
        style: 'editorial',
        templateId: 'tpl_signal',
        useRealCapture: false,
        useGeneratedVisuals: true,
        cta: '',
        bannedPhrases: [],
      },
      scenes: [
        {
          id: 'scene_one',
          order: 0,
          revision: 1,
          title: '开场',
          intent: '开场',
          narration: '开场',
          caption: '开场',
          durationSec: 6,
          visualType: 'title',
          templateId: 'tpl_signal',
          claimIds: [],
          status: 'approved',
          look: 'cinematic',
          brightness: 1,
          vignette: true,
        },
      ],
      directorMessages: [],
      scriptVersion: 1,
      createdAt: ISO,
      updatedAt: ISO,
      demo: true,
    },
  ],
  runs: [],
  exports: [],
  activity: [],
};

class FakeExecutor implements RenderJobExecutorPort {
  calls = 0;
  aborted = false;
  running = false;
  behaviour: (call: number, callbacks: RenderJobExecutorCallbacks) => Promise<RenderJobExecutionResult>;

  constructor(behaviour?: FakeExecutor['behaviour']) {
    this.behaviour =
      behaviour ??
      (async (call, callbacks) => {
        callbacks.onHeartbeat?.(4242);
        callbacks.onCheckpoint?.('bundle_ready', { call });
        callbacks.onCheckpoint?.('verified_receipt', { call });
        return {
          ok: true,
          workerPid: 4242,
          exitCode: 0,
          checkpoints: [],
          completed: {
            type: 'completed',
            receiptPath: 'receipt.json',
            manifestPath: 'manifest.json',
            outputPath: 'output.mp4',
            outputSha256: 'a'.repeat(64),
            byteSize: 1024,
          },
        };
      });
  }

  isRunning(): boolean {
    return this.running;
  }

  abort(): void {
    this.aborted = true;
  }

  async execute(
    _job: unknown,
    _inputFile: string,
    _outDir: string,
    _checkpointFile: string,
    callbacks: RenderJobExecutorCallbacks,
  ): Promise<RenderJobExecutionResult> {
    this.calls += 1;
    this.running = true;
    try {
      return await this.behaviour(this.calls, callbacks);
    } finally {
      this.running = false;
    }
  }
}

interface Harness {
  db: DatabaseSync;
  store: SqliteOrchestrationStore;
  orchestrator: Orchestrator;
  executor: FakeExecutor;
  artifactDir: string;
}

let harness: Harness | undefined;

function createHarness(
  options: {
    executor?: FakeExecutor;
    snapshot?: StudioSnapshot | null;
    maxAttempts?: number;
    instanceId?: string;
  } = {},
): Harness {
  const artifactDir = mkdtempSync(path.join(os.tmpdir(), 'asvs-orch-'));
  const db = openDatabase(':memory:');
  const store = new SqliteOrchestrationStore(db);
  const executor = options.executor ?? new FakeExecutor();
  const snapshot = options.snapshot === undefined ? SNAPSHOT : options.snapshot;
  const orchestrator = new Orchestrator({
    store,
    artifactDir,
    loadWorkspace: () => snapshot,
    executor,
    instanceId: options.instanceId ?? 'api_test',
    maxAttempts: options.maxAttempts ?? 3,
    schedulerIntervalMs: 60_000,
  });
  harness = { db, store, orchestrator, executor, artifactDir };
  return harness;
}

// These tests exercise the 5A silent render path: no speech service is wired,
// so narration must be explicitly disabled (the server fails closed otherwise).
const RUN_INPUT: CreateOrchestrationRunInput = {
  videoId: VIDEO_ID,
  idempotencyKey: 'idem-orch-test-0001',
  narration: { enabled: false },
};

async function waitForRun(
  orchestrator: Orchestrator,
  runId: string,
  predicate: (run: NonNullable<Awaited<ReturnType<Orchestrator['getRun']>>>['run']) => boolean,
  timeoutMs = 3000,
): Promise<NonNullable<Awaited<ReturnType<Orchestrator['getRun']>>>> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const detail = await orchestrator.getRun(WORKSPACE_ID, runId);
    if (detail && predicate(detail.run)) return detail;
    if (Date.now() > deadline) {
      throw new Error(`等待运行状态超时；最后状态：${JSON.stringify(detail?.run ?? null)}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

/** Writes a JSON file where the fake worker claims its artifacts live. */
function writeArtifacts(artifactDir: string, runId: string, jobId: string): void {
  const outDir = path.join(artifactDir, 'workspaces', WORKSPACE_ID, 'runs', runId, 'artifacts');
  mkdirSync(outDir, { recursive: true });
  const mp4 = path.join(outDir, `${runId}.mp4`);
  writeFileSync(mp4, 'fake-mp4-bytes');
  const sha = createHash('sha256').update('fake-mp4-bytes').digest('hex');
  const bytes = Buffer.byteLength('fake-mp4-bytes');
  const receipt = {
    schemaVersion: '1',
    jobId,
    artifactId: jobId.replace(/^orchjob/, 'artifact'),
    sha256: sha,
    mimeType: 'video/mp4',
    byteSize: bytes,
    storageRef: `workspaces/${WORKSPACE_ID}/runs/${runId}/artifacts/${runId}.mp4`,
    durationMs: 6000,
    width: 1920,
    height: 1080,
    fps: 30,
    rendererVersion: '4.0.545',
    compositionId: 'AsvsVideo',
    createdAt: ISO,
  };
  const manifest = {
    schemaVersion: '1',
    jobId,
    artifactId: receipt.artifactId,
    compositionId: 'AsvsVideo',
    rendererVersion: '4.0.545',
    renderInputDigest: 'b'.repeat(64),
    storyboardDigest: 'c'.repeat(64),
    sceneDigests: [],
    assetHashes: [],
    renderProfile: { width: 1920, height: 1080, codec: 'h264', crf: 18 },
    output: { fileName: `${runId}.mp4`, mimeType: 'video/mp4', byteSize: bytes, sha256: sha },
    ffprobe: {
      codecName: 'h264',
      durationMs: 6000,
      width: 1920,
      height: 1080,
      fps: 30,
      frameCount: 180,
    },
    createdAt: ISO,
  };
  writeFileSync(path.join(outDir, 'receipt.json'), JSON.stringify(receipt));
  writeFileSync(path.join(outDir, 'manifest.json'), JSON.stringify(manifest));
}

afterEach(async () => {
  await harness?.orchestrator.stop();
  harness?.db.close();
  if (harness) rmSync(harness.artifactDir, { recursive: true, force: true });
  harness = undefined;
});

describe('编排器 · 创建与幂等', () => {
  it('相同 idempotencyKey 重复创建只生成一个运行并返回 created=false', async () => {
    const { orchestrator, store } = createHarness();
    await orchestrator.start();
    const first = await orchestrator.createRun(WORKSPACE_ID, RUN_INPUT);
    const second = await orchestrator.createRun(WORKSPACE_ID, RUN_INPUT);
    expect(first.created).toBe(true);
    expect(second.created).toBe(false);
    expect(second.run.id).toBe(first.run.id);
    expect(store.listRuns(WORKSPACE_ID)).toHaveLength(1);
  });

  it('非 16:9 视频在创建阶段即被拒绝，且不生成任何运行或任务', async () => {
    const snapshot: StudioSnapshot = {
      ...SNAPSHOT,
      videos: [
        {
          ...SNAPSHOT.videos[0]!,
          brief: { ...SNAPSHOT.videos[0]!.brief, aspect: '9:16' },
        },
      ],
    };
    const { orchestrator, store } = createHarness({ snapshot });
    await expect(orchestrator.createRun(WORKSPACE_ID, RUN_INPUT)).rejects.toMatchObject({
      code: 'aspect_not_supported',
      httpStatus: 400,
    });
    expect(store.listRuns(WORKSPACE_ID)).toHaveLength(0);
  });

  it('工作区未同步时拒绝创建（404）', async () => {
    const { orchestrator } = createHarness({ snapshot: null });
    await expect(orchestrator.createRun(WORKSPACE_ID, RUN_INPUT)).rejects.toMatchObject({
      httpStatus: 404,
    });
  });

  it('非 16:9 的渲染分辨率也被拒绝', async () => {
    const { orchestrator } = createHarness();
    await expect(
      orchestrator.createRun(WORKSPACE_ID, {
        ...RUN_INPUT,
        renderProfile: { width: 1080, height: 1920 },
      }),
    ).rejects.toMatchObject({ code: 'aspect_not_supported' });
  });
});

describe('编排器 · DAG 推进', () => {
  it('五步顺序推进；render_video 崩溃后按 checkpoint 续跑并最终成功', async () => {
    const executor = new FakeExecutor(async (call, callbacks) => {
      callbacks.onHeartbeat?.(9000);
      callbacks.onCheckpoint?.('bundle_ready', { call });
      if (call === 1) {
        // Simulate the worker dying BY SIGNAL mid-render: it never emits a
        // final event, so the executor reports `crashed: true`.
        const crashed: RenderJobExecutionResult = {
          ok: false,
          workerPid: 9000,
          exitCode: null,
          signal: 'SIGKILL',
          crashed: true,
          code: 'signal_SIGKILL',
          message: '渲染进程被信号 SIGKILL 终止',
          checkpoints: [{ phase: 'bundle_ready', payload: {} }],
        };
        return crashed;
      }
      return {
        ok: true,
        workerPid: 9000,
        exitCode: 0,
        checkpoints: [],
        completed: {
          type: 'completed',
          receiptPath: 'receipt.json',
          manifestPath: 'manifest.json',
          outputPath: 'output.mp4',
          outputSha256: 'a'.repeat(64),
          byteSize: 1024,
        },
      };
    });
    const { orchestrator, store, artifactDir } = createHarness({ executor });
    await orchestrator.start();
    const created = await orchestrator.createRun(WORKSPACE_ID, RUN_INPUT);

    // The fake worker succeeds on the 2nd call; only then do we materialize the
    // artifact files it "produced" so `register_artifacts` can verify them.
    const originalExecute = executor.execute.bind(executor);
    executor.execute = async (job, inputFile, outDir, checkpointFile, callbacks) => {
      const result = await originalExecute(job, inputFile, outDir, checkpointFile, callbacks);
      if (result.ok) {
        writeArtifacts(artifactDir, created.run.id, (job as { jobId: string }).jobId);
      }
      return result;
    };

    const detail = await waitForRun(orchestrator, created.run.id, (run) => run.status === 'succeeded');
    // 5B inserts synthesize_voice + generate_subtitles (skipped here because
    // narration is off); render_video is index 5 and crashed once.
    expect(detail.run.steps.map((step) => step.status)).toEqual([
      'succeeded',
      'succeeded',
      'succeeded',
      'skipped',
      'skipped',
      'succeeded',
      'succeeded',
    ]);
    expect(detail.run.steps[5]!.attempt).toBe(2);
    const eventTypes = detail.events.map((event) => event.eventType);
    expect(eventTypes).toContain('worker_crash');
    expect(eventTypes).toContain('retry');
    // render_video checkpoint survived the crash and was persisted.
    expect(
      detail.checkpoints
        .filter((checkpoint) => checkpoint.stepKey === 'render_video')
        .map((checkpoint) => checkpoint.phase),
    ).toEqual(expect.arrayContaining(['bundle_ready', 'verified_receipt']));
    expect(detail.artifacts.map((artifact) => artifact.kind).sort()).toEqual([
      'artifact_receipt',
      'render_manifest',
      'video_mp4',
    ]);
    expect(store.getJobForStep(created.run.id, 'render_video')?.status).toBe('succeeded');
  });

  it('连续崩溃达到 maxAttempts 后运行进入 failed 且 failure.code=worker_crash_exhausted', async () => {
    const executor = new FakeExecutor(async () => ({
      ok: false,
      workerPid: 777,
      exitCode: null,
      signal: 'SIGKILL',
      crashed: true,
      code: 'signal_SIGKILL',
      message: '渲染进程被信号 SIGKILL 终止',
      checkpoints: [],
    }));
    const { orchestrator, store } = createHarness({ executor, maxAttempts: 2 });
    await orchestrator.start();
    const created = await orchestrator.createRun(WORKSPACE_ID, RUN_INPUT);
    const detail = await waitForRun(orchestrator, created.run.id, (run) => run.status === 'failed');
    expect(detail.run.failure?.code).toBe('worker_crash_exhausted');
    expect(detail.run.failure?.stepKey).toBe('render_video');
    expect(executor.calls).toBe(2);
    expect(store.getJobForStep(created.run.id, 'render_video')?.attempt).toBe(2);
  });

  it('声明被阻断时 verify_claims 直接失败（确定性错误不重试），worker 从未启动', async () => {
    const snapshot: StudioSnapshot = {
      ...SNAPSHOT,
      claims: [
        {
          id: 'claim_stale',
          projectId: 'proj_orch',
          featureId: 'feat_orch',
          statement: '过期的声明',
          audience: '',
          status: 'stale',
          evidenceIds: [],
          demo: true,
        },
      ],
      videos: [
        {
          ...SNAPSHOT.videos[0]!,
          scenes: [{ ...SNAPSHOT.videos[0]!.scenes[0]!, claimIds: ['claim_stale'] }],
        },
      ],
    };
    const executor = new FakeExecutor();
    const { orchestrator } = createHarness({ executor, snapshot });
    await orchestrator.start();
    const created = await orchestrator.createRun(WORKSPACE_ID, RUN_INPUT);
    const detail = await waitForRun(orchestrator, created.run.id, (run) => run.status === 'failed');
    expect(detail.run.failure?.code).toBe('claims_blocked');
    expect(detail.run.failure?.retryable).toBe(false);
    expect(executor.calls).toBe(0);
  });

  it('cancel 在渲染中终止 make 运行进入 cancelled，不重试', async () => {
    let release: (() => void) | undefined;
    const executor = new FakeExecutor(
      async (_call, callbacks) =>
        new Promise<RenderJobExecutionResult>((resolve) => {
          callbacks.onHeartbeat?.(555);
          release = () =>
            resolve({
              ok: false,
              workerPid: 555,
              exitCode: null,
              signal: 'SIGKILL',
              crashed: true,
              code: 'cancelled',
              message: '渲染进程已被取消',
              checkpoints: [],
            });
        }),
    );
    const { orchestrator } = createHarness({ executor });
    await orchestrator.start();
    const created = await orchestrator.createRun(WORKSPACE_ID, RUN_INPUT);
    await waitForRun(orchestrator, created.run.id, (run) => run.status === 'running' && run.currentStepKey === 'render_video');
    // `currentStepKey` is written before the async job digest, so wait for the
    // executor to actually start: this test is "cancel while rendering", not
    // "cancel in the window before the renderer spawned" (which returns early).
    const deadline = Date.now() + 3000;
    while (executor.calls === 0) {
      if (Date.now() > deadline) throw new Error('执行器未在 3 秒内启动');
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    const cancelled = await orchestrator.cancelRun(WORKSPACE_ID, created.run.id);
    expect(cancelled.status).toBe('cancelled');
    expect(executor.aborted).toBe(true);
    release?.();
    await new Promise((resolve) => setTimeout(resolve, 100));
    const detail = await orchestrator.getRun(WORKSPACE_ID, created.run.id);
    expect(detail?.run.status).toBe('cancelled');
    expect(executor.calls).toBe(1);
  });

  it('取消落在渲染启动前的窗口时，绝不留下无人终止的渲染进程', async () => {
    let release: (() => void) | undefined;
    const executor = new FakeExecutor(
      async (_call, callbacks) =>
        new Promise<RenderJobExecutionResult>((resolve) => {
          callbacks.onHeartbeat?.(777);
          // Never settles on its own, so the run stays in render_video and the
          // test controls exactly when the renderer finishes.
          release = () =>
            resolve({
              ok: false,
              workerPid: 777,
              exitCode: null,
              signal: 'SIGKILL',
              crashed: true,
              code: 'cancelled',
              message: '渲染进程已被取消',
              checkpoints: [],
            });
        }),
    );
    const { orchestrator } = createHarness({ executor });
    await orchestrator.start();
    const created = await orchestrator.createRun(WORKSPACE_ID, RUN_INPUT);
    // `currentStepKey` is persisted before `executeRenderStep` awaits the job
    // digest, so cancelling here exercises the pre-spawn window. The invariant:
    // the renderer is either never started or aborted — `cancelRun` must never
    // walk away letting a renderer run for a run whose output is discarded.
    await waitForRun(
      orchestrator,
      created.run.id,
      (run) => run.status === 'running' && run.currentStepKey === 'render_video',
    );
    const cancelled = await orchestrator.cancelRun(WORKSPACE_ID, created.run.id);
    expect(cancelled.status).toBe('cancelled');
    await new Promise((resolve) => setTimeout(resolve, 150));
    release?.();
    await new Promise((resolve) => setTimeout(resolve, 50));
    const detail = await orchestrator.getRun(WORKSPACE_ID, created.run.id);
    expect(detail?.run.status).toBe('cancelled');
    if (executor.calls > 0) {
      // Started in time: the cancel must have aborted it.
      expect(executor.aborted).toBe(true);
    }
  });

  it('非法状态迁移返回 409：成功运行不能取消/重试，未审批运行不能重试', async () => {
    const { orchestrator } = createHarness();
    await orchestrator.start();
    const created = await orchestrator.createRun(WORKSPACE_ID, RUN_INPUT);
    await waitForRun(orchestrator, created.run.id, (run) => run.status === 'failed');
    // Failed runs cannot be cancelled (terminal), but can be retried.
    await expect(orchestrator.cancelRun(WORKSPACE_ID, created.run.id)).rejects.toBeInstanceOf(
      OrchestrationHttpError,
    );
    const retried = await orchestrator.retryRun(WORKSPACE_ID, created.run.id);
    expect(retried.status).toBe('queued');
    await expect(orchestrator.retryRun(WORKSPACE_ID, created.run.id)).rejects.toMatchObject({
      httpStatus: 409,
    });
  });
});

describe('编排器 · 重启与租约回收', () => {
  it('API 重启后回收上一实例的活跃租约并继续推进', async () => {
    // First API process reaches render_video and is then killed while its
    // worker is mid-render. The lease stays behind, owned by a dead instance.
    let releaseRender: (() => void) | undefined;
    const blockingExecutor = new FakeExecutor(
      async () =>
        new Promise<RenderJobExecutionResult>((resolve) => {
          releaseRender = () =>
            resolve({
              ok: false,
              workerPid: 321,
              exitCode: null,
              signal: 'SIGTERM',
              crashed: false,
              code: 'cancelled',
              message: '渲染进程已被取消',
              checkpoints: [],
            });
        }),
    );
    const first = createHarness({ executor: blockingExecutor, instanceId: 'api_first' });
    await first.orchestrator.start();
    const created = await first.orchestrator.createRun(WORKSPACE_ID, RUN_INPUT);
    await waitForRun(
      first.orchestrator,
      created.run.id,
      (run) => run.status === 'running' && run.currentStepKey === 'render_video',
    );
    releaseRender?.();
    await new Promise((resolve) => setTimeout(resolve, 50));
    await first.orchestrator.stop();

    // Second API process over the same DB: `api_second` must notice the foreign
    // lease, emit heartbeat_lost and resume from the checkpoint.
    const secondExecutor = new FakeExecutor();
    const second = new Orchestrator({
      store: first.store,
      artifactDir: first.artifactDir,
      loadWorkspace: () => SNAPSHOT,
      executor: {
        execute: async (job, inputFile, outDir, checkpointFile, callbacks) => {
          const result = await secondExecutor.execute(job, inputFile, outDir, checkpointFile, callbacks);
          if (result.ok) {
            writeArtifacts(first.artifactDir, created.run.id, (job as { jobId: string }).jobId);
          }
          return result;
        },
        abort: () => secondExecutor.abort(),
        isRunning: () => secondExecutor.isRunning(),
      },
      instanceId: 'api_second',
      schedulerIntervalMs: 60_000,
    });
    await second.start();
    const detail = await waitForRun(second, created.run.id, (run) => run.status === 'succeeded');
    expect(detail.events.some((event) => event.eventType === 'heartbeat_lost')).toBe(true);
    // The dead lease's attempt survived; the reclaim increments it again.
    expect(detail.run.steps.find((step) => step.stepKey === 'render_video')?.attempt).toBe(2);
    expect(detail.artifacts).toHaveLength(3);
    await second.stop();
  });

  it('手动 retry 把 failed 运行重新入队并重置任务尝试次数', async () => {
    const executor = new FakeExecutor(async () => ({
      ok: false,
      workerPid: 1,
      exitCode: 1,
      signal: null,
      crashed: false,
      code: 'invalid_input',
      message: '确定性输入错误',
      checkpoints: [],
    }));
    const { orchestrator, store } = createHarness({ executor });
    await orchestrator.start();
    const created = await orchestrator.createRun(WORKSPACE_ID, RUN_INPUT);
    await waitForRun(orchestrator, created.run.id, (run) => run.status === 'failed');
    expect(executor.calls).toBe(1);

    executor.behaviour = async (call, callbacks) => {
      callbacks.onCheckpoint?.('verified_receipt', { call });
      if (!harness) throw new Error('harness missing');
      writeArtifacts(harness.artifactDir, created.run.id, store.getJobForStep(created.run.id, 'render_video')!.jobId);
      return {
        ok: true,
        workerPid: 2,
        exitCode: 0,
        checkpoints: [],
        completed: {
          type: 'completed',
          receiptPath: 'receipt.json',
          manifestPath: 'manifest.json',
          outputPath: 'output.mp4',
          outputSha256: 'a'.repeat(64),
          byteSize: 1024,
        },
      };
    };
    const retried = await orchestrator.retryRun(WORKSPACE_ID, created.run.id);
    expect(retried.status).toBe('queued');
    // resetJobsForRetry zeroes the counter; the next lease increments it to 1.
    expect(store.getJobForStep(created.run.id, 'render_video')?.attempt).toBeLessThanOrEqual(1);
    const detail = await waitForRun(orchestrator, created.run.id, (run) => run.status === 'succeeded');
    expect(detail.artifacts).toHaveLength(3);
  });

  it('findLatestSucceededVideo 返回最新成功运行的 MP4 产物', async () => {
    const { orchestrator, artifactDir } = createHarness();
    await orchestrator.start();
    const created = await orchestrator.createRun(WORKSPACE_ID, RUN_INPUT);
    const originalExecute = (orchestrator as unknown as { executor: FakeExecutor }).executor.execute.bind(
      (orchestrator as unknown as { executor: FakeExecutor }).executor,
    );
    (orchestrator as unknown as { executor: FakeExecutor }).executor.execute = async (
      job,
      inputFile,
      outDir,
      checkpointFile,
      callbacks,
    ) => {
      writeArtifacts(artifactDir, created.run.id, (job as { jobId: string }).jobId);
      return originalExecute(job, inputFile, outDir, checkpointFile, callbacks);
    };
    await waitForRun(orchestrator, created.run.id, (run) => run.status === 'succeeded');
    const found = orchestrator.findLatestSucceededVideo(WORKSPACE_ID, VIDEO_ID);
    expect(found?.run.id).toBe(created.run.id);
    expect(found?.artifact.kind).toBe('video_mp4');
    const resolved = await orchestrator.resolveArtifactFile(WORKSPACE_ID, found!.artifact.id);
    expect(resolved?.file).toContain(`${created.run.id}.mp4`);
  });
});

describe('编排器 · approve 守门', () => {
  it('没有待审批 Gate 时 approve 返回 409', async () => {
    const { orchestrator } = createHarness();
    const created = await orchestrator.createRun(WORKSPACE_ID, RUN_INPUT);
    await expect(
      orchestrator.approveRun(WORKSPACE_ID, created.run.id, { approvalId: 'ap_1' }),
    ).rejects.toMatchObject({ httpStatus: 409, code: 'invalid_transition' });
  });

  it('approvalId 或 subjectDigest 不匹配时拒绝', async () => {
    const { orchestrator, store } = createHarness();
    const created = await orchestrator.createRun(WORKSPACE_ID, RUN_INPUT);
    const run = store.getRun(created.run.id)!;
    store.updateRun({
      ...run,
      status: 'awaiting_approval',
      approval: {
        approvalId: 'ap_expected',
        stepKey: 'render_video',
        status: 'pending',
        subjectDigest: 'd'.repeat(64),
        requestedAt: ISO,
      } as OrchestrationApprovalV1,
    });
    await expect(
      orchestrator.approveRun(WORKSPACE_ID, created.run.id, {
        approvalId: 'ap_wrong',
        subjectDigest: 'd'.repeat(64),
      }),
    ).rejects.toMatchObject({ code: 'approval_mismatch' });
    await expect(
      orchestrator.approveRun(WORKSPACE_ID, created.run.id, {
        approvalId: 'ap_expected',
        subjectDigest: 'e'.repeat(64),
      }),
    ).rejects.toMatchObject({ code: 'approval_subject_mismatch' });
    const approved = await orchestrator.approveRun(WORKSPACE_ID, created.run.id, {
      approvalId: 'ap_expected',
      subjectDigest: 'd'.repeat(64),
    });
    expect(approved.status).toBe('approved');
  });
});

describe('编排器 · 产物路径防护', () => {
  it('storageRef 越界或文件缺失时 resolveArtifactFile 返回 null', async () => {
    const { orchestrator, store } = createHarness();
    await orchestrator.createRun(WORKSPACE_ID, RUN_INPUT);
    const runId = store.listRuns(WORKSPACE_ID)[0]!.id;
    store.insertArtifact({
      schemaVersion: '1',
      id: 'artifact_evil',
      runId,
      workspaceId: WORKSPACE_ID,
      jobId: 'orchjob_evil',
      kind: 'video_mp4',
      fileName: 'evil.mp4',
      mimeType: 'video/mp4',
      byteSize: 1,
      sha256: 'f'.repeat(64),
      storageRef: '../../../../etc/passwd',
      metadata: {},
      createdAt: ISO,
    } as OrchestrationArtifactV1);
    expect(await orchestrator.resolveArtifactFile(WORKSPACE_ID, 'artifact_evil')).toBeNull();
    expect(await orchestrator.resolveArtifactFile('ws_other', 'artifact_evil')).toBeNull();
  });
});
