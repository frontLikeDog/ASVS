// @vitest-environment node
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import {
  formatSrtTimeFromMs,
  type StudioSnapshot,
  type VideoProject,
} from '@asvs/domain';
import type {
  CreateOrchestrationRunInput,
  RenderJobExecutionResult,
  RenderJobExecutorCallbacks,
  RenderJobExecutorPort,
  SpeechPort,
} from '@asvs/ports';
import { openDatabase } from '../db/database';
import { ExportBundleStore } from '../db/export-bundle-store';
import { SqliteOrchestrationStore } from '../db/orchestration-store';
import { QaReportStore } from '../db/qa-report-store';
import { DeterministicQaRunner } from '../qa/testing/deterministic-qa-runner';
import {
  DeterministicTestSpeechAdapter,
  SpeechCacheStore,
  SpeechService,
} from '../speech';
import { Orchestrator } from './orchestrator';

const WORKSPACE_ID = 'ws_narr_test';
const VIDEO_ID = 'vid_narr_test';
const ISO = '2026-11-27T10:00:00.000Z';

function scene(id: string, order: number, narration: string, durationSec: number) {
  return {
    id,
    order,
    revision: 1,
    title: id,
    intent: id,
    narration,
    caption: narration,
    durationSec,
    visualType: 'title' as const,
    templateId: 'tpl_signal',
    claimIds: [],
    status: 'approved' as const,
    look: 'cinematic' as const,
    brightness: 1,
    vignette: true,
  };
}

function buildSnapshot(videoOverrides: Partial<VideoProject> = {}): StudioSnapshot {
  return {
    projects: [
      {
        id: 'proj_narr',
        name: 'Narr',
        productName: 'Narr',
        description: '旁白导出测试',
        website: 'https://narr.demo.invalid',
        stage: 'active',
        brand: {
          logoText: 'NARR',
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
        projectId: 'proj_narr',
        title: 'Narration export',
        mode: 'release_video',
        stage: 'review',
        fps: 30,
        brief: {
          objective: '验证旁白导出',
          audience: '工程师',
          featureIds: [],
          durationSec: 12,
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
          scene('scene_intro', 0, '开场旁白。', 3),
          scene('scene_body', 1, '第二镜的旁白内容。', 4),
          scene('scene_cta', 2, '最后一镜。', 3),
        ],
        directorMessages: [],
        scriptVersion: 1,
        createdAt: ISO,
        updatedAt: ISO,
        demo: true,
        ...videoOverrides,
      },
    ],
    runs: [],
    exports: [],
    activity: [],
  };
}

/**
 * A fake worker that writes the MP4 / receipt / manifest / SRT exactly where
 * the real worker does, including an audio block and the narration provenance,
 * so `register_artifacts` and the export gate run against realistic shapes.
 */
function writeWorkerOutput(
  artifactDir: string,
  runId: string,
  jobId: string,
  options: { audio: boolean },
): void {
  const runDir = path.join(artifactDir, 'workspaces', WORKSPACE_ID, 'runs', runId);
  const outDir = path.join(runDir, 'artifacts');
  mkdirSync(outDir, { recursive: true });
  const mp4 = path.join(outDir, `${runId}.mp4`);
  writeFileSync(mp4, 'fake-mp4-bytes-with-audio');
  const sha = createHash('sha256').update('fake-mp4-bytes-with-audio').digest('hex');
  const bytes = Buffer.byteLength('fake-mp4-bytes-with-audio');
  const srtFile = path.join(runDir, 'subtitles.srt');
  const srtContent = options.audio ? readFileSync(srtFile, 'utf8') : '';
  const srtSha = createHash('sha256').update(srtContent).digest('hex');
  const receipt = {
    schemaVersion: '1',
    jobId,
    artifactId: jobId.replace(/^orchjob/, 'artifact'),
    sha256: sha,
    mimeType: 'video/mp4',
    byteSize: bytes,
    storageRef: `workspaces/${WORKSPACE_ID}/runs/${runId}/artifacts/${runId}.mp4`,
    durationMs: 12000,
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
      durationMs: 12000,
      width: 1920,
      height: 1080,
      fps: 30,
      frameCount: 360,
      ...(options.audio
        ? {
            audio: {
              codecName: 'aac',
              sampleRate: 48000,
              channels: 1,
              durationMs: 12000,
              meanVolumeDb: -20,
            },
          }
        : {}),
    },
    ...(options.audio
      ? {
          narration: {
            provider: 'deterministic_test',
            model: 'tone-v1',
            voiceId: 'test-voice-zh',
            language: 'zh-CN',
            license: 'internal-deterministic-test-only',
            synthetic: true,
            timingPolicy: 'extend_scene',
            adjustments: [],
            clips: [],
          },
          subtitles: {
            fileName: 'subtitles.srt',
            mimeType: 'application/x-subrip',
            byteSize: Buffer.byteLength(srtContent),
            sha256: srtSha,
            cueCount: 3,
            durationMs: 12000,
          },
        }
      : {}),
    createdAt: ISO,
  };
  writeFileSync(path.join(outDir, 'receipt.json'), JSON.stringify(receipt));
  writeFileSync(path.join(outDir, 'manifest.json'), JSON.stringify(manifest));
}

class FakeExecutor implements RenderJobExecutorPort {
  jobs: unknown[] = [];
  constructor(private readonly artifactDirRef: () => string) {}
  isRunning() {
    return false;
  }
  abort() {
    /* no-op */
  }
  async execute(
    job: unknown,
    _inputFile: string,
    _outDir: string,
    _checkpointFile: string,
    callbacks: RenderJobExecutorCallbacks,
  ): Promise<RenderJobExecutionResult> {
    this.jobs.push(job);
    const typed = job as { jobId: string; runId: string; audio: unknown[]; subtitlesPath?: string };
    callbacks.onHeartbeat?.(4242);
    writeWorkerOutput(this.artifactDirRef(), typed.runId, typed.jobId, {
      audio: typed.audio.length > 0,
    });
    return {
      ok: true,
      workerPid: 4242,
      exitCode: 0,
      checkpoints: [],
      completed: {
        type: 'completed',
        receiptPath: path.join(this.artifactDirRef(), 'receipt.json'),
        manifestPath: path.join(this.artifactDirRef(), 'manifest.json'),
        outputPath: path.join(this.artifactDirRef(), `${typed.runId}.mp4`),
        outputSha256: createHash('sha256').update('fake-mp4-bytes-with-audio').digest('hex'),
        byteSize: Buffer.byteLength('fake-mp4-bytes-with-audio'),
        ...(typed.audio.length > 0
          ? {
              audio: {
                codecName: 'aac',
                sampleRate: 48000,
                channels: 1,
                durationMs: 12000,
                meanVolumeDb: -20,
              },
            }
          : {}),
      },
    };
  }
}

interface Harness {
  db: DatabaseSync;
  orchestrator: Orchestrator;
  exportStore: ExportBundleStore;
  speech: SpeechService;
  executor: FakeExecutor;
  artifactDir: string;
  snapshot: { current: StudioSnapshot };
}

let harness: Harness | undefined;

function createHarness(
  options: {
    snapshot?: StudioSnapshot;
    speech?: SpeechService | null;
    start?: boolean;
  } = {},
): Harness {
  const artifactDir = mkdtempSync(path.join(os.tmpdir(), 'asvs-narr-'));
  const db = openDatabase(':memory:');
  const store = new SqliteOrchestrationStore(db);
  const exportStore = new ExportBundleStore(db);
  const snapshot = { current: options.snapshot ?? buildSnapshot() };
  const speech =
    options.speech === null
      ? null
      : (options.speech ??
        new SpeechService({
          port: new DeterministicTestSpeechAdapter({
            provider: 'deterministic_test',
            model: 'tone-v1',
            voiceZh: 'test-voice-zh',
            voiceEn: 'test-voice-en',
            license: 'internal-deterministic-test-only',
            timeoutMs: 10_000,
            maxRetries: 1,
          }),
          cache: new SpeechCacheStore(db),
          audioRoot: path.join(artifactDir, 'tts'),
        }));
  const executor = new FakeExecutor(() => artifactDir);
  const orchestrator = new Orchestrator({
    store,
    artifactDir,
    loadWorkspace: () => snapshot.current,
    executor,
    speech,
    exportStore,
    qaRunner: new DeterministicQaRunner(),
    qaReportStore: new QaReportStore(db),
    instanceId: 'api_narr_test',
    maxAttempts: 2,
    schedulerIntervalMs: 25,
  });
  harness = { db, orchestrator, exportStore, speech: speech as SpeechService, executor, artifactDir, snapshot };
  if (options.start !== false) void orchestrator.start();
  return harness;
}

/**
 * Wraps the deterministic adapter with a call counter, so a cache hit can be
 * proved by "no provider calls", not by inspecting cache rows.
 */
function countingPort(get: () => number, set: (value: number) => void): SpeechPort {
  const inner = new DeterministicTestSpeechAdapter({
    provider: 'deterministic_test',
    model: 'tone-v1',
    voiceZh: 'test-voice-zh',
    voiceEn: 'test-voice-en',
    license: 'internal-deterministic-test-only',
    timeoutMs: 10_000,
    maxRetries: 1,
  });
  return {
    providerName: inner.providerName,
    isConfigured: () => inner.isConfigured(),
    getDefaultVoice: (language) => inner.getDefaultVoice(language),
    // The deterministic adapter has no cancellation path; the port's
    // optional signal is intentionally dropped here.
    synthesize: async (request, _signal) => {
      set(get() + 1);
      return inner.synthesize(request);
    },
  };
}

function buildSpeechWithPort(port: SpeechPort): SpeechService {
  return new SpeechService({
    port,
    cache: new SpeechCacheStore(openDatabase(':memory:')),
    audioRoot: mkdtempSync(path.join(os.tmpdir(), 'asvs-narr-tts-')),
  });
}

async function waitForRun(
  orchestrator: Orchestrator,
  runId: string,
  predicate: (run: NonNullable<Awaited<ReturnType<Orchestrator['getRun']>>>['run']) => boolean,
  timeoutMs = 5000,
) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const detail = await orchestrator.getRun(WORKSPACE_ID, runId);
    if (detail && predicate(detail.run)) return detail;
    if (Date.now() > deadline) {
      throw new Error(`等待运行状态超时：${JSON.stringify(detail?.run ?? null)}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

const RUN_INPUT: CreateOrchestrationRunInput = {
  videoId: VIDEO_ID,
  idempotencyKey: 'idem-narr-0001',
};

afterEach(async () => {
  await harness?.orchestrator.stop();
  harness?.db.close();
  if (harness) rmSync(harness.artifactDir, { recursive: true, force: true });
  harness = undefined;
});

describe('编排器 · 5B 旁白与 SRT 步骤', () => {
  it('未配置 TTS 时创建运行直接 503（fail-closed），不生成任何运行', async () => {
    const { orchestrator, db } = createHarness({ speech: null, start: false });
    await expect(orchestrator.createRun(WORKSPACE_ID, RUN_INPUT)).rejects.toMatchObject({
      code: 'tts_not_configured',
      httpStatus: 503,
    });
    const count = db.prepare('SELECT COUNT(*) AS n FROM orchestration_runs').get() as { n: number };
    expect(count.n).toBe(0);
  });

  it('显式关闭旁白时两个步骤被跳过，运行成功且不产生音轨', async () => {
    const { orchestrator } = createHarness();
    const created = await orchestrator.createRun(WORKSPACE_ID, {
      ...RUN_INPUT,
      narration: { enabled: false },
    });
    const detail = await waitForRun(orchestrator, created.run.id, (run) => run.status === 'succeeded');
    const statuses = detail.run.steps.map((step) => `${step.stepKey}:${step.status}`);
    expect(statuses).toContain('synthesize_voice:skipped');
    expect(statuses).toContain('generate_subtitles:skipped');
    const kinds = detail.artifacts.map((artifact) => artifact.kind);
    expect(kinds).not.toContain('subtitles_srt');
  });

  it('开启旁白时：合成 → SRT 校验 → 渲染 → 生成 Mic/SRT/manifest 产物，且 SRT 单调无重叠', async () => {
    const { orchestrator } = createHarness();
    const created = await orchestrator.createRun(WORKSPACE_ID, RUN_INPUT);
    const detail = await waitForRun(orchestrator, created.run.id, (run) => run.status === 'succeeded');
    expect(detail.run.status).toBe('succeeded');

    const synthesis = detail.run.steps.find((step) => step.stepKey === 'synthesize_voice')!;
    expect(synthesis.status).toBe('succeeded');
    expect(synthesis.checkpointPhases).toContain('narration_ready');
    const subtitles = detail.run.steps.find((step) => step.stepKey === 'generate_subtitles')!;
    expect(subtitles.status).toBe('succeeded');
    expect(subtitles.checkpointPhases).toContain('subtitles_ready');

    const kinds = detail.artifacts.map((artifact) => artifact.kind);
    expect(kinds).toContain('subtitles_srt');
    expect(kinds).toContain('video_mp4');

    const srtArtifact = detail.artifacts.find((artifact) => artifact.kind === 'subtitles_srt')!;
    expect(srtArtifact.mimeType).toContain('application/x-subrip');
    const srtFile = path.join(
      harness!.artifactDir,
      ...srtArtifact.storageRef.split('/'),
    );
    const srtContent = readFileSync(srtFile, 'utf8');
    expect(srtContent).toContain('-->');
    expect(createHash('sha256').update(srtContent).digest('hex')).toBe(srtArtifact.sha256);

    const mp4Artifact = detail.artifacts.find((artifact) => artifact.kind === 'video_mp4')!;
    expect(mp4Artifact.metadata.hasAudio).toBe(true);
  });

  it('旁白超长触发 extend_scene：帧数被延展，manifest 记录时长调整', async () => {
    const longNarration =
      '这是一段非常非常长的旁白，用来验证镜头会为了容纳语音而延展时长，绝不截断语音也绝不跨镜头。'.repeat(4);
    const snapshot = buildSnapshot({
      scenes: [
        scene('scene_long', 0, longNarration, 3),
        scene('scene_short', 1, '短句。', 2),
      ],
    });
    const { orchestrator } = createHarness({ snapshot });
    const created = await orchestrator.createRun(WORKSPACE_ID, RUN_INPUT);
    const detail = await waitForRun(orchestrator, created.run.id, (run) => run.status === 'succeeded');
    const narrationStep = detail.run.steps.find((step) => step.stepKey === 'synthesize_voice')!;
    expect(narrationStep.status).toBe('succeeded');
    // The summary records how many scenes were extended.
    expect(detail.run.input.narration?.adjustments).toBeGreaterThan(0);

    const runDir = path.join(harness!.artifactDir, 'workspaces', WORKSPACE_ID, 'runs', created.run.id);
    const narration = JSON.parse(readFileSync(path.join(runDir, 'narration.json'), 'utf8')) as {
      adjustments: Array<{ sceneId: string; originalDurationFrames: number; effectiveDurationFrames: number }>;
    };
    expect(narration.adjustments.length).toBeGreaterThan(0);
    const adjustment = narration.adjustments[0]!;
    expect(adjustment.effectiveDurationFrames).toBeGreaterThan(adjustment.originalDurationFrames);

    const frozen = JSON.parse(readFileSync(path.join(runDir, 'input.json'), 'utf8')) as {
      input: { storyboard: { scenes: Array<{ id: string; durationFrames: number }> } };
    };
    const longScene = frozen.input.storyboard.scenes.find((item) => item.id === 'scene_long')!;
    expect(longScene.durationFrames).toBe(adjustment.effectiveDurationFrames);
  });

  it('fail_on_overflow 策略下，旁白超长使运行失败且错误码为 narration_overflow', async () => {
    const longNarration =
      '这是一段非常非常长的旁白，用于触发 fail_on_overflow 策略并让运行失败，绝不静默截断。'.repeat(4);
    const snapshot = buildSnapshot({
      scenes: [scene('scene_long', 0, longNarration, 2)],
    });
    const { orchestrator } = createHarness({ snapshot });
    const created = await orchestrator.createRun(WORKSPACE_ID, {
      ...RUN_INPUT,
      narration: { enabled: true, timingPolicy: 'fail_on_overflow' },
    });
    const detail = await waitForRun(orchestrator, created.run.id, (run) => run.status === 'failed');
    expect(detail.run.failure?.code).toBe('narration_overflow');
    expect(harness!.executor.jobs).toHaveLength(0);
  });

  it('同一输入重跑：语音缓存命中，第二次 0 次 provider 调用', async () => {
    let providerCalls = 0;
    const port = countingPort(() => providerCalls, (value) => (providerCalls = value));
    const { orchestrator } = createHarness({ speech: buildSpeechWithPort(port) });

    const first = await orchestrator.createRun(WORKSPACE_ID, RUN_INPUT);
    await waitForRun(orchestrator, first.run.id, (run) => run.status === 'succeeded');
    const callsAfterFirst = providerCalls;
    expect(callsAfterFirst).toBeGreaterThan(0);

    const second = await orchestrator.createRun(WORKSPACE_ID, {
      ...RUN_INPUT,
      idempotencyKey: 'idem-narr-0002',
    });
    const detail = await waitForRun(orchestrator, second.run.id, (run) => run.status === 'succeeded');
    expect(providerCalls).toBe(callsAfterFirst);
    expect(detail.run.input.narration?.cacheHits).toBeGreaterThan(0);
  });
});

describe('编排器 · Gate 3 导出（AC-10）', () => {
  async function succeedRun() {
    const created = await harness!.orchestrator.createRun(WORKSPACE_ID, RUN_INPUT);
    const detail = await waitForRun(harness!.orchestrator, created.run.id, (run) => run.status === 'succeeded');
    return detail;
  }

  function approveVideo() {
    harness!.snapshot.current = {
      ...harness!.snapshot.current,
      videos: harness!.snapshot.current.videos.map((video) => ({
        ...video,
        stage: 'approved' as const,
        review: { status: 'approved' as const, decidedAt: ISO },
      })),
    };
  }

  it('审核通过后可导出：bundle 绑定三个哈希、文件清单与 narration 溯源', async () => {
    createHarness();
    const detail = await succeedRun();
    approveVideo();

    const bundle = await harness!.orchestrator.createExportBundle(WORKSPACE_ID, {
      videoId: VIDEO_ID,
      runId: detail.run.id,
      approvalNote: '审核通过',
    });
    expect(bundle.bundle.mp4Sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(bundle.bundle.srtSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(bundle.bundle.manifestSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(bundle.files.map((file) => file.kind).sort()).toEqual(
      // 5D: the passing QA report ships inside the bundle and is bound into it.
      ['artifact_receipt', 'qa_report', 'render_manifest', 'subtitles_srt', 'video_mp4'].sort(),
    );
    expect(bundle.bundle.qaReportArtifactId).toBe(
      bundle.files.find((file) => file.kind === 'qa_report')!.artifactId,
    );
    expect(bundle.bundle.qaReportSha256).toBe(
      bundle.files.find((file) => file.kind === 'qa_report')!.sha256,
    );
    const srtFile = bundle.files.find((file) => file.kind === 'subtitles_srt')!;
    expect(srtFile.fileName.endsWith('.srt')).toBe(true);
    expect(srtFile.downloadUrl).toContain('/download');
    expect(bundle.narration?.synthetic).toBe(true);
    expect(bundle.narration?.license).toBe('internal-deterministic-test-only');

    const listed = await harness!.orchestrator.listExportBundles(WORKSPACE_ID, { videoId: VIDEO_ID });
    expect(listed).toHaveLength(1);
    expect(listed[0]!.bundle.id).toBe(bundle.bundle.id);
  });

  it('未通过 Gate 3 时导出返回 409 export_not_approved', async () => {
    createHarness();
    const detail = await succeedRun();
    await expect(
      harness!.orchestrator.createExportBundle(WORKSPACE_ID, {
        videoId: VIDEO_ID,
        runId: detail.run.id,
      }),
    ).rejects.toMatchObject({ httpStatus: 409, code: 'export_not_approved' });
  });

  it('审核后又修改脚本（scriptVersion 变化）时导出返回 409 export_stale', async () => {
    createHarness();
    const detail = await succeedRun();
    harness!.snapshot.current = {
      ...harness!.snapshot.current,
      videos: harness!.snapshot.current.videos.map((video) => ({
        ...video,
        stage: 'approved' as const,
        review: { status: 'approved' as const, decidedAt: ISO },
        scriptVersion: video.scriptVersion + 1,
        updatedAt: '2026-11-27T11:00:00.000Z',
      })),
    };
    await expect(
      harness!.orchestrator.createExportBundle(WORKSPACE_ID, {
        videoId: VIDEO_ID,
        runId: detail.run.id,
      }),
    ).rejects.toMatchObject({ httpStatus: 409, code: 'export_stale' });
  });

  it('产物文件被篡改后导出返回 409 export_hash_mismatch', async () => {
    createHarness();
    const detail = await succeedRun();
    approveVideo();
    const mp4 = detail.artifacts.find((artifact) => artifact.kind === 'video_mp4')!;
    const file = path.join(harness!.artifactDir, ...mp4.storageRef.split('/'));
    writeFileSync(file, 'tampered-bytes');
    await expect(
      harness!.orchestrator.createExportBundle(WORKSPACE_ID, { videoId: VIDEO_ID }),
    ).rejects.toMatchObject({ httpStatus: 409, code: 'export_hash_mismatch' });
  });

  it('失败的运行不能导出（没有成功运行）', async () => {
    createHarness();
    approveVideo();
    await expect(
      harness!.orchestrator.createExportBundle(WORKSPACE_ID, { videoId: VIDEO_ID }),
    ).rejects.toMatchObject({ httpStatus: 409, code: 'export_run_missing' });
  });
});

describe('SRT 时间格式（5B 坑位 #1）', () => {
  it('毫秒进位不再产生 1000ms 非法时间戳', () => {
    expect(formatSrtTimeFromMs(2999.6)).toBe('00:00:03,000');
    expect(formatSrtTimeFromMs(2100)).toBe('00:00:02,100');
    expect(formatSrtTimeFromMs(0)).toBe('00:00:00,000');
    expect(formatSrtTimeFromMs(3661500)).toBe('01:01:01,500');
  });
});

void mkdirSync;
