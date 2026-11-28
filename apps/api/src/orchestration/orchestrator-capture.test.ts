// @vitest-environment node
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import {
  captureReceiptV1Schema,
  computeDemoPlanDigest,
  type CaptureJobInputV1,
  type CaptureJobResultV1,
  type StudioSnapshot,
} from '@asvs/domain';
import type {
  CaptureJobExecutionResult,
  CaptureJobExecutorCallbacks,
  CaptureJobExecutorPort,
  CreateOrchestrationRunInput,
  RenderJobExecutionResult,
  RenderJobExecutorPort,
} from '@asvs/ports';
import { openDatabase } from '../db/database';
import { OrchestrationApprovalStore } from '../db/orchestration-approval-store';
import { SqliteOrchestrationStore } from '../db/orchestration-store';
import { QaReportStore } from '../db/qa-report-store';
import { DeterministicQaRunner } from '../qa/testing/deterministic-qa-runner';
import {
  DeterministicTestSpeechAdapter,
  DETERMINISTIC_TEST_LICENSE,
  SpeechCacheStore,
  SpeechService,
} from '../speech';
import { Orchestrator } from './orchestrator';

const WORKSPACE_ID = 'ws_capture_test';
const VIDEO_ID = 'vid_capture_test';
const ISO = '2026-11-28T10:00:00.000Z';

function sha(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

/** A workspace with one 4D-verified feature/claim and a real_demo scene. */
const SNAPSHOT: StudioSnapshot = {
  projects: [
    {
      id: 'proj_cap',
      name: 'Capture',
      productName: 'Capture',
      description: 'capture 测试项目',
      website: 'https://capture.demo.invalid',
      stage: 'active',
      brand: {
        logoText: 'CAP',
        logoMark: 'orbit',
        primary: '#E8A44C',
        secondary: '#23262D',
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
  features: [
    {
      id: 'feat_cap',
      projectId: 'proj_cap',
      name: '知识中心',
      summary: '功能、声明与证据',
      category: '知识',
      status: 'verified',
      confidence: 92,
      userConfirmed: true,
      sourceRefs: [],
      claimIds: ['claim_cap'],
      prIds: [],
      demoRoute: '/videos',
      updatedAt: ISO,
      tags: [],
      demo: true,
    },
  ],
  claims: [
    {
      id: 'claim_cap',
      projectId: 'proj_cap',
      featureId: 'feat_cap',
      statement: '每个卖点都能回到已核验的证据。',
      audience: '产品经理',
      status: 'verified',
      eligibility: 'publishable',
      evidenceIds: [],
      demo: true,
    },
  ],
  evidence: [],
  pullRequests: [],
  releases: [],
  suggestions: [],
  assets: [],
  templates: [],
  videos: [
    {
      id: VIDEO_ID,
      projectId: 'proj_cap',
      title: 'Capture test',
      mode: 'release_video',
      stage: 'review',
      fps: 30,
      brief: {
        objective: '验证 Gate 2 与真实录屏回填',
        audience: '工程师',
        featureIds: ['feat_cap'],
        durationSec: 20,
        aspect: '16:9',
        language: 'zh-CN',
        tone: 'confident',
        style: 'editorial',
        templateId: 'tpl_signal',
        useRealCapture: true,
        useGeneratedVisuals: false,
        cta: '',
        bannedPhrases: [],
      },
      scenes: [
        {
          id: 'scene_intro',
          order: 0,
          revision: 1,
          title: '开场',
          intent: '开场',
          narration: '开场。',
          caption: '开场',
          durationSec: 3,
          visualType: 'title',
          templateId: 'tpl_signal',
          claimIds: [],
          status: 'approved',
          look: 'cinematic',
          brightness: 1,
          vignette: true,
        },
        {
          id: 'scene_demo',
          order: 1,
          revision: 1,
          title: '知识中心',
          intent: '展示真实界面',
          narration: '真实界面。',
          caption: '知识中心',
          durationSec: 14,
          visualType: 'real_demo',
          templateId: 'tpl_signal',
          claimIds: ['claim_cap'],
          featureId: 'feat_cap',
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

/** Render executor: succeeds and writes the three files the DAG verifies. */
class FakeRenderExecutor implements RenderJobExecutorPort {
  calls = 0;
  aborted = false;
  running = false;
  constructor(private readonly artifactDir: () => string) {}
  isRunning(): boolean {
    return this.running;
  }
  abort(): void {
    this.aborted = true;
  }
  async execute(
    job: unknown,
    _inputFile: string,
    outDir: string,
    _checkpointFile: string,
    callbacks: CaptureJobExecutorCallbacks,
  ): Promise<RenderJobExecutionResult> {
    this.calls += 1;
    this.running = true;
    try {
      callbacks.onCheckpoint?.('verified_receipt', {});
      const typed = job as { jobId: string; runId: string; subtitlesPath?: string };
      // Mirror the real worker: a narration run gets its SRT bound into the
      // manifest. Without that binding `register_artifacts` correctly refuses
      // the stray `subtitles.srt` next to the MP4.
      const srtBinding = typed.subtitlesPath
        ? (() => {
            const content = readFileSync(typed.subtitlesPath, 'utf8');
            return {
              fileName: 'subtitles.srt',
              mimeType: 'application/x-subrip',
              byteSize: Buffer.byteLength(content),
              sha256: sha(content),
              cueCount: content.split('\n\n').filter((block) => block.trim().length > 0).length,
              durationMs: 6000,
            };
          })()
        : undefined;
      mkdirSync(outDir, { recursive: true });
      const mp4 = path.join(outDir, `${typed.runId}.mp4`);
      writeFileSync(mp4, 'fake-mp4-bytes');
      const digest = sha('fake-mp4-bytes');
      const bytes = Buffer.byteLength('fake-mp4-bytes');
      writeFileSync(
        path.join(outDir, 'receipt.json'),
        JSON.stringify({
          schemaVersion: '1',
          jobId: typed.jobId,
          artifactId: typed.jobId.replace(/^orchjob/, 'artifact'),
          sha256: digest,
          mimeType: 'video/mp4',
          byteSize: bytes,
          storageRef: `workspaces/${WORKSPACE_ID}/runs/${typed.runId}/artifacts/${typed.runId}.mp4`,
          durationMs: 6000,
          width: 1920,
          height: 1080,
          fps: 30,
          rendererVersion: '4.0.545',
          compositionId: 'AsvsVideo',
          createdAt: ISO,
        }),
      );
      writeFileSync(
        path.join(outDir, 'manifest.json'),
        JSON.stringify({
          schemaVersion: '1',
          jobId: typed.jobId,
          artifactId: typed.jobId.replace(/^orchjob/, 'artifact'),
          compositionId: 'AsvsVideo',
          rendererVersion: '4.0.545',
          renderInputDigest: 'b'.repeat(64),
          storyboardDigest: 'c'.repeat(64),
          sceneDigests: [],
          assetHashes: [],
          renderProfile: { width: 1920, height: 1080, codec: 'h264', crf: 18 },
          output: {
            fileName: `${typed.runId}.mp4`,
            mimeType: 'video/mp4',
            byteSize: bytes,
            sha256: digest,
          },
          ffprobe: {
            codecName: 'h264',
            durationMs: 6000,
            width: 1920,
            height: 1080,
            fps: 30,
            frameCount: 180,
          },
          ...(srtBinding ? { subtitles: srtBinding } : {}),
          createdAt: ISO,
        }),
      );
      return {
        ok: true,
        workerPid: 4242,
        exitCode: 0,
        checkpoints: [],
        completed: {
          type: 'completed',
          receiptPath: 'receipt.json',
          manifestPath: 'manifest.json',
          outputPath: mp4,
          outputSha256: digest,
          byteSize: bytes,
        },
      };
    } finally {
      this.running = false;
    }
  }
}

type CaptureBehaviour = (
  call: number,
  job: CaptureJobInputV1,
) => Promise<CaptureJobExecutionResult>;

const CLIP_BYTES = 'fake-real-clip-bytes';

/** Writes the files a real browser-worker would leave in `<runDir>/capture`. */
function writeCaptureArtifacts(
  artifactDir: string,
  runId: string,
  job: CaptureJobInputV1,
  options: { planDigest?: string; assertions?: { total: number; passed: number } } = {},
): { clipFile: string; receiptFile: string; clipSha: string } {
  const outDir = path.join(artifactDir, 'workspaces', WORKSPACE_ID, 'runs', runId, 'capture');
  mkdirSync(path.join(outDir, 'screenshots'), { recursive: true });
  const slug = job.plan.id.replace(/^plan_/, '');
  const clipFile = path.join(outDir, `${slug}.mp4`);
  writeFileSync(clipFile, CLIP_BYTES);
  const clipSha = sha(CLIP_BYTES);
  writeFileSync(path.join(outDir, 'screenshots', '01-dashboard.png'), 'png-bytes-1');
  writeFileSync(path.join(outDir, 'screenshots', '02-knowledge.png'), 'png-bytes-2');
  const assertions = options.assertions ?? { total: 4, passed: 4 };
  const receiptFile = path.join(outDir, 'capture-receipt.json');
  const receipt = captureReceiptV1Schema.parse({
    schemaVersion: '1',
    kind: 'asvs.capture-receipt',
    jobId: `job_capture_${slug}`,
    planId: job.plan.id,
    planFile: 'capture-job-input.json',
    planDigest: options.planDigest ?? job.planDigest,
    approvalId: job.plan.approval.approvalId,
    createdAt: ISO,
    environment: {
      baseUrl: job.plan.baseUrl,
      browser: 'Chromium',
      viewport: {
        width: job.plan.viewport.width,
        height: job.plan.viewport.height,
        deviceScaleFactor: 1,
      },
      locale: job.plan.locale,
      timezoneId: job.plan.timezoneId,
      colorScheme: job.plan.colorScheme,
      reducedMotion: job.plan.reducedMotion,
    },
    assertions: { ...assertions, failed: assertions.total - assertions.passed },
    steps: [
      {
        id: job.plan.steps[0]!.id,
        action: job.plan.steps[0]!.action,
        status: 'passed',
        startedAtMs: 0,
        durationMs: 10,
      },
    ],
    rawVideo: {
      ...artifact(clipFile, 'video/webm', outDir),
      width: 1920,
      height: 1080,
      fps: 30,
      durationMs: 20_000,
      codecName: 'vp8',
    },
    clip: {
      ...artifact(clipFile, 'video/mp4', outDir),
      width: 1920,
      height: 1080,
      fps: 30,
      durationMs: 14_000,
      codecName: 'h264',
    },
    trace: artifact(path.join(outDir, 'trace.zip'), 'application/zip', outDir, 'trace'),
    screenshots: [artifact(path.join(outDir, 'screenshots', '01-dashboard.png'), 'image/png', outDir)],
    asset: job.plan.asset
      ? {
          id: job.plan.asset.id,
          projectId: job.plan.projectId,
          name: job.plan.asset.name,
          kind: 'capture',
          durationSec: 14,
          description: job.plan.asset.description,
          palette: job.plan.asset.palette,
          mock: false,
          media: {
            src: `captures/${job.plan.asset.id}.mp4`,
            mimeType: 'video/mp4',
            width: 1920,
            height: 1080,
            durationMs: 14_000,
            sha256: clipSha,
            capturePlanId: job.plan.id,
            captureReceiptRef: path
              .relative(artifactDir, receiptFile)
              .split(path.sep)
              .join('/'),
          },
        }
      : undefined,
    media: {
      assetId: job.plan.asset.id,
      sourceFile: path.relative(artifactDir, clipFile).split(path.sep).join('/'),
      sha256: clipSha,
      mimeType: 'video/mp4',
      width: 1920,
      height: 1080,
      durationMs: 14_000,
    },
    renderFixture: { file: 'captured-30s.json', sha256: 'd'.repeat(64) },
  });
  writeFileSync(receiptFile, `${JSON.stringify(receipt, null, 2)}\n`);
  return { clipFile, receiptFile, clipSha };
}

function artifact(file: string, mimeType: string, outDir: string, name?: string) {
  writeFileSync(file, name === 'trace' ? 'zip-bytes' : CLIP_BYTES);
  return {
    file: path.relative(outDir, file).split(path.sep).join('/'),
    sha256: sha(readFileSync(file, 'utf8')),
    byteSize: Buffer.byteLength(readFileSync(file)),
    mimeType,
  };
}

function completedResult(job: CaptureJobInputV1, clipSha: string): CaptureJobResultV1 {
  return {
    schemaVersion: '1',
    kind: 'asvs.capture-job-result',
    jobId: job.jobId,
    planId: job.plan.id,
    planDigest: job.planDigest,
    policyVersion: job.policyVersion,
    passed: true,
    completed: {
      kind: 'asvs.capture-job-completed',
      jobId: job.jobId,
      planId: job.plan.id,
      planDigest: job.planDigest,
      receiptFile: 'capture-receipt.json',
      receiptSha256: 'e'.repeat(64),
      clipFile: 'clip.mp4',
      clipSha256: clipSha,
      clipDurationMs: 14_000,
      clipWidth: 1920,
      clipHeight: 1080,
      assertions: { total: 4, passed: 4, failed: 0 },
      screenshotCount: 2,
      completedAt: ISO,
    },
    durationMs: 1200,
    writtenAt: ISO,
  };
}

class FakeCaptureExecutor implements CaptureJobExecutorPort {
  calls: 0 | number = 0;
  aborted = false;
  running = false;
  jobs: CaptureJobInputV1[] = [];
  behaviour: CaptureBehaviour;
  constructor(behaviour: CaptureBehaviour) {
    this.behaviour = behaviour;
  }
  isRunning(): boolean {
    return this.running;
  }
  abort(): void {
    this.aborted = true;
  }
  async execute(
    job: CaptureJobInputV1,
    _inputFile: string,
    _outDir: string,
    _checkpointFile: string,
    callbacks: CaptureJobExecutorCallbacks,
  ): Promise<CaptureJobExecutionResult> {
    this.calls += 1;
    this.jobs.push(job);
    this.running = true;
    callbacks.onSpawn?.(5151);
    callbacks.onHeartbeat?.(5151);
    // Same phases the real `capture-job.ts` emits.
    callbacks.onCheckpoint?.('plan_verified', { planId: job.plan.id });
    callbacks.onCheckpoint?.('capture_started', { baseUrl: job.plan.baseUrl });
    callbacks.onCheckpoint?.('capture_recorded', {});
    callbacks.onCheckpoint?.('clip_transcoded', {});
    try {
      return await this.behaviour(this.calls, job);
    } finally {
      this.running = false;
    }
  }
}

interface Harness {
  db: DatabaseSync;
  store: SqliteOrchestrationStore;
  orchestrator: Orchestrator;
  capture: FakeCaptureExecutor;
  render: FakeRenderExecutor;
  qaRunner: DeterministicQaRunner;
  artifactDir: string;
}

let harness: Harness | undefined;

function createHarness(
  behaviour: CaptureBehaviour,
  snapshot: StudioSnapshot = SNAPSHOT,
  options: { narration?: boolean; qaScript?: ConstructorParameters<typeof DeterministicQaRunner>[0] } = {},
): Harness {
  const artifactDir = mkdtempSync(path.join(os.tmpdir(), 'asvs-cap-'));
  const db = openDatabase(':memory:');
  const store = new SqliteOrchestrationStore(db);
  const render = new FakeRenderExecutor(() => artifactDir);
  const capture = new FakeCaptureExecutor(behaviour);
  const qaRunner = new DeterministicQaRunner(options.qaScript);
  // Narration off by default so the 5A/5C paths stay free of TTS; the rewrite
  // of `input.json` that `synthesize_voice` performs is under test in one case.
  const speech = options.narration
    ? new SpeechService({
        port: new DeterministicTestSpeechAdapter({
          provider: 'deterministic_test',
          model: 'tone-v1',
          voiceZh: 'test-voice-zh',
          voiceEn: 'test-voice-en',
          license: DETERMINISTIC_TEST_LICENSE,
          timeoutMs: 10_000,
          maxRetries: 1,
        }),
        cache: new SpeechCacheStore(db),
        audioRoot: path.join(artifactDir, 'tts'),
      })
    : null;
  const orchestrator = new Orchestrator({
    store,
    artifactDir,
    loadWorkspace: () => snapshot,
    executor: render,
    speech,
    captureExecutor: capture,
    qaRunner,
    qaReportStore: new QaReportStore(db),
    captureConfig: {
      enabled: true,
      allowedOrigins: ['http://localhost:4200'],
      defaultBaseUrl: 'http://localhost:4200',
      allowAutoServe: false,
    },
    instanceId: 'api_capture_test',
    maxAttempts: 2,
    schedulerIntervalMs: 60_000,
  });
  harness = { db, store, orchestrator, capture, render, qaRunner, artifactDir };
  return harness;
}

const RUN_INPUT: CreateOrchestrationRunInput = {
  videoId: VIDEO_ID,
  idempotencyKey: 'idem-capture-test-0001',
  narration: { enabled: false },
  capture: { enabled: true, template: 'web_studio_knowledge_claim', baseUrl: 'http://localhost:4200' },
};

async function waitForRun(
  orchestrator: Orchestrator,
  runId: string,
  predicate: (run: NonNullable<Awaited<ReturnType<Orchestrator['getRun']>>>['run']) => boolean,
  timeoutMs = 4000,
): Promise<NonNullable<Awaited<ReturnType<Orchestrator['getRun']>>>> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const detail = await orchestrator.getRun(WORKSPACE_ID, runId);
    if (detail && predicate(detail.run)) return detail;
    if (Date.now() > deadline) {
      throw new Error(`等待运行状态超时；最后状态：${JSON.stringify(detail?.run ?? null)}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

afterEach(async () => {
  await harness?.orchestrator.stop();
  harness?.db.close();
  if (harness) rmSync(harness.artifactDir, { recursive: true, force: true });
  harness = undefined;
});

describe('编排器 · Gate 2 创建守门', () => {
  it('未请求 capture 时 plan_demo / capture_demo 在创建时即标记 skipped', async () => {
    const { orchestrator, capture } = createHarness(async () => {
      throw new Error('不应启动录屏');
    });
    await orchestrator.start();
    const created = await orchestrator.createRun(WORKSPACE_ID, {
      ...RUN_INPUT,
      capture: undefined,
    });
    const statuses = created.run.steps.map((step) => `${step.stepKey}:${step.status}`);
    expect(statuses).toContain('plan_demo:skipped');
    expect(statuses).toContain('capture_demo:skipped');
    expect(created.run.input.capture).toMatchObject({ enabled: false, realDemoSceneCount: 1 });
    const detail = await waitForRun(orchestrator, created.run.id, (run) => run.status === 'succeeded');
    expect(capture.calls).toBe(0);
    expect(detail.artifacts.map((item) => item.kind)).not.toContain('capture_clip');
  });

  it('enabled=true 但没有 real_demo 镜头时 400 no_real_demo_scenes，且不落任何运行', async () => {
    const noDemo: StudioSnapshot = {
      ...SNAPSHOT,
      videos: [
        {
          ...SNAPSHOT.videos[0]!,
          scenes: SNAPSHOT.videos[0]!.scenes.map((scene) => ({
            ...scene,
            visualType: 'title' as const,
          })),
        },
      ],
    };
    const { orchestrator, store } = createHarness(async () => {
      throw new Error('不应启动录屏');
    }, noDemo);
    await expect(orchestrator.createRun(WORKSPACE_ID, RUN_INPUT)).rejects.toMatchObject({
      code: 'no_real_demo_scenes',
      httpStatus: 400,
    });
    expect(store.listRuns(WORKSPACE_ID)).toHaveLength(0);
  });

  it('baseUrl 不在服务端 allowlist 时 400 capture_origin_not_allowed（SSRF 防护）', async () => {
    const { orchestrator } = createHarness(async () => {
      throw new Error('不应启动录屏');
    });
    await expect(
      orchestrator.createRun(WORKSPACE_ID, {
        ...RUN_INPUT,
        capture: { ...RUN_INPUT.capture!, baseUrl: 'http://169.254.169.254' },
      }),
    ).rejects.toMatchObject({ code: 'capture_origin_not_allowed', httpStatus: 400 });
  });
});

describe('编排器 · Gate 2 审批与执行', () => {
  it('plan_demo 生成确定性计划并挂起审批；批准后录屏、回填真实片段并完成整条 DAG', async () => {
    const { orchestrator, capture, artifactDir } = createHarness(async (_call, job) => {
      const written = writeCaptureArtifacts(artifactDir, job.runId, job);
      return { ok: true, workerPid: 5151, exitCode: 0, checkpoints: [], result: completedResult(job, written.clipSha) };
    });
    await orchestrator.start();
    const created = await orchestrator.createRun(WORKSPACE_ID, RUN_INPUT);

    const waiting = await waitForRun(orchestrator, created.run.id, (run) => run.status === 'awaiting_approval');
    expect(waiting.run.demoPlan).toBeDefined();
    expect(waiting.run.approval?.gateType).toBe('gate2_demo_capture');
    expect(waiting.run.approval?.status).toBe('pending');
    expect(waiting.run.demoPlan?.policyVersion).toBe('gate2-v1');
    // The published digest is the digest of the published draft.
    expect(await computeDemoPlanDigest(waiting.run.demoPlan!.draft)).toBe(
      waiting.run.demoPlan!.planDigest,
    );
    expect(waiting.run.demoPlan!.draft.steps.some((step) => step.action === 'assert')).toBe(true);
    expect(capture.calls).toBe(0);

    // A stale digest is refused before any state changes.
    await expect(
      orchestrator.approveRun(WORKSPACE_ID, created.run.id, {
        approvalId: waiting.run.approval!.approvalId,
        subjectDigest: 'f'.repeat(64),
      }),
    ).rejects.toMatchObject({ code: 'approval_subject_mismatch' });
    // Omitting the digest is a refusal, not an approval.
    await expect(
      orchestrator.approveRun(WORKSPACE_ID, created.run.id, {
        approvalId: waiting.run.approval!.approvalId,
      }),
    ).rejects.toMatchObject({ code: 'approval_subject_missing' });

    await orchestrator.approveRun(WORKSPACE_ID, created.run.id, {
      approvalId: waiting.run.approval!.approvalId,
      subjectDigest: waiting.run.demoPlan!.planDigest,
    });

    const detail = await waitForRun(orchestrator, created.run.id, (run) => run.status === 'succeeded');
    expect(capture.calls).toBe(1);
    const captureStep = detail.run.steps.find((step) => step.stepKey === 'capture_demo')!;
    expect(captureStep.status).toBe('succeeded');
    expect(captureStep.checkpointPhases).toEqual(
      expect.arrayContaining(['capture_started', 'capture_recorded', 'step_done']),
    );
    // The job handed to the worker is exactly the approved plan.
    const job = capture.jobs[0]!;
    expect(job.planDigest).toBe(waiting.run.demoPlan!.planDigest);
    expect(job.plan.approval.approvedPlanDigest).toBe(waiting.run.demoPlan!.planDigest);
    // The ref base must be the base the worker itself writes refs against
    // (the media/repo root), not the artifact dir: the worker re-resolves
    // `receipt.media.sourceFile` against it before emitting `completed`.
    expect(job.storageRefBase).not.toBe(artifactDir);
    expect(path.resolve(job.storageRefBase)).toBe(
      path.resolve(fileURLToPath(new URL('.', import.meta.url)), '../../../..'),
    );
    // Real clip registered and backfilled into the render input.
    const kinds = detail.artifacts.map((item) => item.kind);
    expect(kinds).toEqual(expect.arrayContaining(['capture_clip', 'capture_receipt', 'capture_screenshot', 'video_mp4']));
    const backfilled = JSON.parse(
      readFileSync(
        path.join(artifactDir, 'workspaces', WORKSPACE_ID, 'runs', created.run.id, 'input.json'),
        'utf8',
      ),
    ) as { input: { assets: Array<{ mock: boolean; media?: { sha256?: string } }> }; capture: { planDigest: string } };
    expect(backfilled.input.assets.some((asset) => asset.mock === false)).toBe(true);
    expect(backfilled.capture.planDigest).toBe(waiting.run.demoPlan!.planDigest);
    expect(detail.run.input.capture?.capturedAssetId).toBeDefined();
    expect(detail.run.input.capture?.assertions).toEqual({ total: 4, passed: 4 });
    expect(detail.run.captureFailure).toBeUndefined();
    expect(detail.run.currentStepKey).toBeNull();
    expect(detail.run.steps).toHaveLength(11);
  });

  it('旁白启用时 synthesize_voice 重写 input.json 仍保留录屏溯源块', async () => {
    const { orchestrator, capture, artifactDir } = createHarness(
      async (_call, job) => {
        const written = writeCaptureArtifacts(artifactDir, job.runId, job);
        return { ok: true, workerPid: 5151, exitCode: 0, checkpoints: [], result: completedResult(job, written.clipSha) };
      },
      SNAPSHOT,
      { narration: true },
    );
    await orchestrator.start();
    const created = await orchestrator.createRun(WORKSPACE_ID, {
      ...RUN_INPUT,
      narration: { enabled: true, timingPolicy: 'extend_scene' },
    });

    const waiting = await waitForRun(orchestrator, created.run.id, (run) => run.status === 'awaiting_approval');
    await orchestrator.approveRun(WORKSPACE_ID, created.run.id, {
      approvalId: waiting.run.approval!.approvalId,
      subjectDigest: waiting.run.demoPlan!.planDigest,
    });

    const detail = await waitForRun(orchestrator, created.run.id, (run) => run.status === 'succeeded');
    expect(capture.calls).toBe(1);
    const frozen = JSON.parse(
      readFileSync(
        path.join(artifactDir, 'workspaces', WORKSPACE_ID, 'runs', created.run.id, 'input.json'),
        'utf8',
      ),
    ) as {
      capture?: { planDigest: string; clipSha256: string; assetId: string };
      narrationAppliedAt?: string;
    };
    // The narration rewrite really did happen...
    expect(frozen.narrationAppliedAt).toBeDefined();
    // ...and it carried the capture provenance forward instead of dropping it.
    // Without this the finished film has no on-disk proof of which approved
    // plan and which clip hash the render used.
    expect(frozen.capture?.planDigest).toBe(waiting.run.demoPlan!.planDigest);
    expect(frozen.capture?.clipSha256).toBe(sha(CLIP_BYTES));
    expect(frozen.capture?.assetId).toBe(detail.run.input.capture?.capturedAssetId);
    expect(frozen.capture?.clipSha256).toBe(detail.run.input.capture?.clipSha256);
  });

  it('断言失败时：不写回执、登记证据产物、运行失败且不回填', async () => {
    const { orchestrator, capture, artifactDir } = createHarness(async (_call, job) => {
      const outDir = path.join(artifactDir, 'workspaces', WORKSPACE_ID, 'runs', job.runId, 'capture');
      mkdirSync(path.join(outDir, 'screenshots'), { recursive: true });
      writeFileSync(path.join(outDir, 'failure-report.json'), JSON.stringify({
        schemaVersion: '1',
        kind: 'asvs.capture-failure',
        jobId: job.jobId,
        planId: job.plan.id,
        planFile: 'capture-job-input.json',
        planDigest: job.planDigest,
        approvalId: job.plan.approval.approvalId,
        createdAt: ISO,
        error: '断言失败 [visible]',
        failedStepId: 'claim-visible',
        assertions: { total: 4, passed: 3, failed: 1 },
        steps: [],
        artifacts: { screenshots: [] },
        blockedRequests: [],
      }));
      writeFileSync(path.join(outDir, 'screenshots', 'fail-01.png'), 'fail-png');
      writeFileSync(path.join(outDir, 'trace.zip'), 'trace-zip');
      const result: CaptureJobResultV1 = {
        schemaVersion: '1',
        kind: 'asvs.capture-job-result',
        jobId: job.jobId,
        planId: job.plan.id,
        planDigest: job.planDigest,
        policyVersion: job.policyVersion,
        passed: false,
        failed: {
          kind: 'asvs.capture-job-failed',
          jobId: job.jobId,
          code: 'capture_assertion_failed',
          message: '断言失败 [visible]',
          failedStepId: 'claim-visible',
          screenshotRefs: [],
          assertionFailures: 1,
          retryable: true,
          failedAt: ISO,
        },
        durationMs: 900,
        writtenAt: ISO,
      };
      return { ok: false, workerPid: 5151, exitCode: 1, signal: null, crashed: false, code: 'capture_assertion_failed', message: '断言失败 [visible]', checkpoints: [], result };
    });
    await orchestrator.start();
    const created = await orchestrator.createRun(WORKSPACE_ID, RUN_INPUT);
    const waiting = await waitForRun(orchestrator, created.run.id, (run) => run.status === 'awaiting_approval');
    await orchestrator.approveRun(WORKSPACE_ID, created.run.id, {
      approvalId: waiting.run.approval!.approvalId,
      subjectDigest: waiting.run.demoPlan!.planDigest,
    });
    const detail = await waitForRun(orchestrator, created.run.id, (run) => run.status === 'failed');
    expect(capture.calls).toBe(2); // maxAttempts = 2, assertion failures retry
    expect(detail.run.failure?.code).toBe('capture_assertion_failed');
    expect(detail.run.captureFailure?.failedStepId).toBe('claim-visible');
    const kinds = detail.artifacts.map((item) => item.kind);
    expect(kinds).toEqual(expect.arrayContaining(['capture_failure_report', 'capture_trace', 'capture_screenshot']));
    expect(kinds).not.toContain('capture_clip');
    expect(kinds).not.toContain('capture_receipt');
    expect(detail.run.input.capture?.capturedAssetId).toBeUndefined();
  });

  it('审批被拒绝后运行进入 failed(approval_rejected)，浏览器从未启动', async () => {
    const { orchestrator, capture } = createHarness(async () => {
      throw new Error('不应启动录屏');
    });
    await orchestrator.start();
    const created = await orchestrator.createRun(WORKSPACE_ID, RUN_INPUT);
    const waiting = await waitForRun(orchestrator, created.run.id, (run) => run.status === 'awaiting_approval');
    await orchestrator.rejectRun(WORKSPACE_ID, created.run.id, {
      approvalId: waiting.run.approval!.approvalId,
      reason: '计划包含一次未审计的写操作',
    });
    const detail = await waitForRun(orchestrator, created.run.id, (run) => run.status === 'failed');
    expect(detail.run.failure?.code).toBe('approval_rejected');
    expect(detail.run.approval?.status).toBe('rejected');
    expect(capture.calls).toBe(0);
  });

  it('编辑计划会让旧审批失效：摘要变化、approvalId 更新，旧 id 不能再批', async () => {
    const { orchestrator } = createHarness(async () => {
      throw new Error('不应启动录屏');
    });
    await orchestrator.start();
    const created = await orchestrator.createRun(WORKSPACE_ID, RUN_INPUT);
    const waiting = await waitForRun(orchestrator, created.run.id, (run) => run.status === 'awaiting_approval');
    const oldApprovalId = waiting.run.approval!.approvalId;
    const oldDigest = waiting.run.demoPlan!.planDigest;

    // A stale expectedPlanDigest is refused before anything is superseded.
    await expect(
      orchestrator.updateDemoPlan(WORKSPACE_ID, created.run.id, {
        patch: { template: 'web_studio_tour' },
        expectedPlanDigest: 'a'.repeat(64),
      }),
    ).rejects.toMatchObject({ code: 'plan_digest_stale' });

    const updated = await orchestrator.updateDemoPlan(WORKSPACE_ID, created.run.id, {
      patch: { template: 'web_studio_tour' },
      expectedPlanDigest: oldDigest,
    });
    expect(updated.approvalId).not.toBe(oldApprovalId);
    expect(updated.subjectDigest).not.toBe(oldDigest);
    const detail = await orchestrator.getRun(WORKSPACE_ID, created.run.id);
    expect(detail!.run.demoPlan!.planDigest).toBe(updated.subjectDigest);
    const ledger = new OrchestrationApprovalStore(harness!.store.database).listByRun(created.run.id);
    expect(ledger.map((item) => item.status)).toEqual(['superseded', 'pending']);

    await expect(
      orchestrator.approveRun(WORKSPACE_ID, created.run.id, {
        approvalId: oldApprovalId,
        subjectDigest: oldDigest,
      }),
    ).rejects.toMatchObject({ code: 'approval_mismatch' });
  });

  it('第三层防篡改：任何改写过的计划都拿不到审批，也启动不了 Chromium', async () => {
    const { orchestrator, capture } = createHarness(async () => {
      throw new Error('不应启动录屏');
    });
    // Drive the scheduler by hand: `start()` would let its own pump race the
    // tamper write below.
    const internal = orchestrator as unknown as { stopped: boolean; pump: () => Promise<void> };
    internal.stopped = false;
    const pumpOnce = async () => {
      await internal.pump();
    };
    const created = await orchestrator.createRun(WORKSPACE_ID, RUN_INPUT);
    await pumpOnce();
    const waiting = await waitForRun(orchestrator, created.run.id, (run) => run.status === 'awaiting_approval');
    // The approval is bound to the run's published draft. Editing that draft
    // (e.g. a buggy writer, a replayed old row) must make approval impossible,
    // even with the exact digest the approver saw: the server re-canonicalizes
    // the draft it is about to bind and compares. The edit stays schema-valid
    // (a dropped step), so it can only be caught by the digest check.
    const current = harness!.store.getRun(created.run.id)!;
    harness!.store.updateRun({
      ...current,
      demoPlan: {
        ...current.demoPlan!,
        draft: { ...current.demoPlan!.draft, steps: current.demoPlan!.draft.steps.slice(1) },
      },
    });
    await expect(
      orchestrator.approveRun(WORKSPACE_ID, created.run.id, {
        approvalId: waiting.run.approval!.approvalId,
        subjectDigest: waiting.run.demoPlan!.planDigest,
      }),
    ).rejects.toMatchObject({ code: 'approval_subject_mismatch' });
    expect(capture.calls).toBe(0);

    // Now the layer-2 case: the ledger says "approved" (a decision really was
    // recorded), the run is running, but the plan bytes changed *after* the
    // decision. Approving through the API would refuse (layer 1); simulate the
    // state a compromised writer could leave and pump by hand.
    const restored = harness!.store.getRun(created.run.id)!;
    const approvals = new OrchestrationApprovalStore(harness!.store.database);
    approvals.markApproved(created.run.id, restored.approval!.approvalId, {
      at: ISO,
      decidedBy: 'local',
    });
    harness!.store.updateRun({
      ...restored,
      status: 'running',
      approval: { ...restored.approval!, status: 'approved', approvedAt: ISO },
      demoPlan: {
        ...restored.demoPlan!,
        draft: { ...restored.demoPlan!.draft, steps: restored.demoPlan!.draft.steps.slice(1) },
      },
    });
    await pumpOnce();
    const after = harness!.store.getRun(created.run.id)!;
    expect(after.steps.find((step) => step.stepKey === 'capture_demo')?.status).toBe('failed');
    expect(after.failure?.code).toBe('capture_plan_tampered');
    expect(capture.calls).toBe(0);
  });

  it('cancel 在录屏中终止 browser-worker，运行保持 cancelled 且不回填', async () => {
    let release: (() => void) | undefined;
    const { orchestrator } = createHarness(
      async (_call, job) =>
        new Promise<CaptureJobExecutionResult>((resolve) => {
          release = () => {
            const outDir = path.join(
              harness!.artifactDir,
              'workspaces',
              WORKSPACE_ID,
              'runs',
              job.runId,
              'capture',
            );
            mkdirSync(outDir, { recursive: true });
            const result = completedResult(job, sha(CLIP_BYTES));
            resolve({
              ok: false,
              workerPid: 5151,
              exitCode: null,
              signal: 'SIGKILL',
              crashed: false,
              code: 'cancelled',
              message: '录屏进程已被取消',
              checkpoints: [],
              result,
            });
          };
        }),
    );
    await orchestrator.start();
    const created = await orchestrator.createRun(WORKSPACE_ID, RUN_INPUT);
    const waiting = await waitForRun(orchestrator, created.run.id, (run) => run.status === 'awaiting_approval');
    await orchestrator.approveRun(WORKSPACE_ID, created.run.id, {
      approvalId: waiting.run.approval!.approvalId,
      subjectDigest: waiting.run.demoPlan!.planDigest,
    });
    const deadline = Date.now() + 3000;
    while (harness!.capture.calls === 0) {
      if (Date.now() > deadline) throw new Error('录屏执行器未启动');
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    const cancelled = await orchestrator.cancelRun(WORKSPACE_ID, created.run.id);
    expect(cancelled.status).toBe('cancelled');
    expect(harness!.capture.aborted).toBe(true);
    release?.();
    await new Promise((resolve) => setTimeout(resolve, 120));
    const detail = await orchestrator.getRun(WORKSPACE_ID, created.run.id);
    expect(detail?.run.status).toBe('cancelled');
    expect(detail?.run.input.capture?.capturedAssetId).toBeUndefined();
  });
});

describe('编排器 · capture 健康信息', () => {
  it('captureHealth 暴露 allowlist 与策略版本，不泄露任何路径或凭证', () => {
    const { orchestrator } = createHarness(async () => {
      throw new Error('n/a');
    });
    const health = orchestrator.captureHealth();
    expect(health.allowedOrigins).toEqual(['http://localhost:4200']);
    expect(health.policyVersion).toBe('gate2-v1');
    expect(JSON.stringify(health)).not.toMatch(/secret|token|password/i);
  });
});

describe('编排器 · qa_capture 早阻断（Step 5D）', () => {
  it('qa_capture 在 capture_demo 之后、prepare_media 之前执行；阻断时运行失败且不进入下采样', async () => {
    const { orchestrator, capture, render, qaRunner } = createHarness(
      async (_call, job) => {
        const written = writeCaptureArtifacts(harness!.artifactDir, job.runId, job);
        return {
          ok: true,
          workerPid: 5151,
          exitCode: 0,
          checkpoints: [],
          result: completedResult(job, written.clipSha),
        };
      },
      SNAPSHOT,
      {
        qaScript: {
          findings: {
            capture: [
              {
                category: 'privacy',
                severity: 'blocker',
                ruleId: 'privacy.email',
                title: '截图命中邮箱',
                sourceKind: 'capture_screenshot',
                matchRedacted: 'c***@corp.internal',
              },
            ],
          },
          evidenceFor: [
            {
              category: 'privacy',
              severity: 'blocker',
              ruleId: 'privacy.email',
            },
          ],
        },
      },
    );
    await orchestrator.start();
    const created = await orchestrator.createRun(WORKSPACE_ID, RUN_INPUT);
    const waiting = await waitForRun(orchestrator, created.run.id, (run) => run.status === 'awaiting_approval');
    await orchestrator.approveRun(WORKSPACE_ID, created.run.id, {
      approvalId: waiting.run.approval!.approvalId,
      subjectDigest: waiting.run.demoPlan!.planDigest,
    });
    const detail = await waitForRun(orchestrator, created.run.id, (run) => run.status === 'failed');

    expect(detail.run.failure?.code).toBe('qa_privacy_blocked');
    const byKey = new Map(detail.run.steps.map((step) => [step.stepKey, step.status]));
    expect(byKey.get('capture_demo')).toBe('succeeded');
    expect(byKey.get('qa_capture')).toBe('failed');
    expect(byKey.get('prepare_media')).toBe('pending');
    // Early block: the renderer never runs.
    expect(render.calls).toBe(0);
    // The runner saw the real capture evidence, including the trace.
    const call = qaRunner.calls.find((entry) => entry.stage === 'capture')!;
    expect(call).toBeDefined();
    expect(detail.artifacts.some((artifact) => artifact.kind === 'capture_trace')).toBe(true);
    const captureInput = call.input as {
      clips: Array<{ sha256: string }>;
      screenshots: Array<{ file: string }>;
      captureTraceFile?: string;
      captureReceiptFile?: string;
    };
    expect(captureInput.clips).toHaveLength(1);
    expect(captureInput.clips[0]!.sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(captureInput.screenshots).toHaveLength(1);
    expect(captureInput.captureTraceFile).toBeDefined();
    expect(captureInput.captureReceiptFile).toBeDefined();
    // Evidence frame registered with the privacy redaction flag.
    const evidence = detail.artifacts.filter((artifact) => artifact.kind === 'qa_evidence_frame');
    expect(evidence).toHaveLength(1);
    expect(evidence[0]!.metadata.redacted).toBe(true);
  });
});
