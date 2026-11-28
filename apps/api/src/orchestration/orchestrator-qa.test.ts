// @vitest-environment node
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import type {
  CreateOrchestrationRunInput,
  QaCaptureInput,
  QaFinalInput,
  RenderJobExecutionResult,
  RenderJobExecutorCallbacks,
  RenderJobExecutorPort,
} from '@asvs/ports';
import type { StudioSnapshot, VideoProject } from '@asvs/domain';
import { openDatabase } from '../db/database';
import { ExportBundleStore } from '../db/export-bundle-store';
import { SqliteOrchestrationStore } from '../db/orchestration-store';
import { QaReportStore } from '../db/qa-report-store';
import { DeterministicQaRunner, type DeterministicQaScript } from '../qa/testing/deterministic-qa-runner';
import {
  DeterministicTestSpeechAdapter,
  SpeechCacheStore,
  SpeechService,
} from '../speech';
import { OrchestrationHttpError } from './errors';
import { Orchestrator } from './orchestrator';

/**
 * Step 5D · orchestrator wiring for the independent QA steps and the Gate 3
 * export hard gate.
 *
 * The media pipeline itself (real ffmpeg/OCR scanning) is proven by
 * `pnpm qa:verify`; here the `QaRunnerPort` double proves the *orchestration*
 * contract: step order, report persistence, failure codes, export gating.
 */

const WORKSPACE_ID = 'ws_qa_orch';
const VIDEO_ID = 'vid_qa_orch';
const ISO = '2026-11-28T10:00:00.000Z';

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
        id: 'proj_qa',
        name: 'QA',
        productName: 'QA',
        description: '独立 QA 编排测试',
        website: 'https://qa.demo.invalid',
        stage: 'active',
        brand: {
          logoText: 'QA',
          logoMark: 'orbit',
          primary: '#38BDF8',
          secondary: '#0F172A',
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
        projectId: 'proj_qa',
        title: 'QA orchestration',
        mode: 'release_video',
        stage: 'review',
        fps: 30,
        brief: {
          objective: '验证独立 QA 编排',
          audience: '工程师',
          featureIds: [],
          durationSec: 8,
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
        scenes: [scene('scene_one', 0, '第一镜旁白。', 4), scene('scene_two', 1, '第二镜旁白。', 4)],
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

const MP4_BYTES = 'fake-mp4-bytes-for-qa';

class FakeExecutor implements RenderJobExecutorPort {
  calls = 0;
  isRunning() {
    return false;
  }
  abort() {
    /* no-op */
  }
  async execute(
    job: unknown,
    _inputFile: string,
    outDir: string,
    _checkpointFile: string,
    callbacks: RenderJobExecutorCallbacks,
  ): Promise<RenderJobExecutionResult> {
    this.calls += 1;
    const typed = job as { jobId: string; runId: string; subtitlesPath?: string };
    callbacks.onHeartbeat?.(4242);
    callbacks.onCheckpoint?.('verified_receipt', {});
    mkdirSync(outDir, { recursive: true });
    const mp4 = path.join(outDir, `${typed.runId}.mp4`);
    writeFileSync(mp4, MP4_BYTES);
    const sha = createHash('sha256').update(MP4_BYTES).digest('hex');
    const bytes = Buffer.byteLength(MP4_BYTES);
    // Mirror the real worker: when subtitles were passed in, the manifest
    // records them, which is what lets `register_artifacts` register the SRT.
    const srtContent = typed.subtitlesPath ? readFileSync(typed.subtitlesPath, 'utf8') : '';
    const subtitleBlock = typed.subtitlesPath
      ? {
          subtitles: {
            fileName: 'subtitles.srt',
            mimeType: 'application/x-subrip',
            byteSize: Buffer.byteLength(srtContent),
            sha256: createHash('sha256').update(srtContent).digest('hex'),
            cueCount: (srtContent.match(/-->/g) ?? []).length,
            durationMs: 8000,
          },
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
        }
      : {};
    writeFileSync(
      path.join(outDir, 'receipt.json'),
      JSON.stringify({
        schemaVersion: '1',
        jobId: typed.jobId,
        artifactId: typed.jobId.replace(/^orchjob/, 'artifact'),
        sha256: sha,
        mimeType: 'video/mp4',
        byteSize: bytes,
        storageRef: `workspaces/${WORKSPACE_ID}/runs/${typed.runId}/artifacts/${typed.runId}.mp4`,
        durationMs: 8000,
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
        output: { fileName: `${typed.runId}.mp4`, mimeType: 'video/mp4', byteSize: bytes, sha256: sha },
        ffprobe: {
          codecName: 'h264',
          durationMs: 8000,
          width: 1920,
          height: 1080,
          fps: 30,
          frameCount: 240,
          audio: {
            codecName: 'aac',
            sampleRate: 48000,
            channels: 1,
            durationMs: 8000,
            meanVolumeDb: -20,
          },
        },
        ...subtitleBlock,
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
        outputPath: `${typed.runId}.mp4`,
        outputSha256: sha,
        byteSize: bytes,
      },
    };
  }
}

interface Harness {
  db: DatabaseSync;
  orchestrator: Orchestrator;
  qaRunner: DeterministicQaRunner;
  qaReports: QaReportStore;
  exportStore: ExportBundleStore;
  artifactDir: string;
  snapshot: { current: StudioSnapshot };
}

let harness: Harness | undefined;

function createHarness(script: DeterministicQaScript = {}): Harness {
  const artifactDir = mkdtempSync(path.join(os.tmpdir(), 'asvs-qa-orch-'));
  const db = openDatabase(':memory:');
  const store = new SqliteOrchestrationStore(db);
  const qaReports = new QaReportStore(db);
  const exportStore = new ExportBundleStore(db);
  const qaRunner = new DeterministicQaRunner(script);
  const snapshot = { current: buildSnapshot() };
  // The export gate requires an SRT, and the SRT only exists when narration is
  // on — the deterministic speech adapter keeps that path offline.
  const speech = new SpeechService({
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
  });
  const orchestrator = new Orchestrator({
    store,
    artifactDir,
    loadWorkspace: () => snapshot.current,
    executor: new FakeExecutor(),
    speech,
    exportStore,
    qaRunner,
    qaReportStore: qaReports,
    instanceId: 'api_qa_test',
    maxAttempts: 2,
    schedulerIntervalMs: 60_000,
  });
  harness = { db, orchestrator, qaRunner, qaReports, exportStore, artifactDir, snapshot };
  return harness;
}

const RUN_INPUT: CreateOrchestrationRunInput = {
  videoId: VIDEO_ID,
  idempotencyKey: 'idem-qa-orch-0001',
  narration: { enabled: true },
};

async function waitForRun(
  orchestrator: Orchestrator,
  runId: string,
  predicate: (run: { status: string; currentStepKey: string | null }) => boolean,
): Promise<Awaited<ReturnType<Orchestrator['getRun']>> & object> {
  const deadline = Date.now() + 10_000;
  for (;;) {
    const detail = await orchestrator.getRun(WORKSPACE_ID, runId);
    if (detail && predicate(detail.run)) return detail;
    if (Date.now() > deadline) {
      throw new Error(`等待运行状态超时；最后状态：${JSON.stringify(detail?.run ?? null)}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

function approveVideo(): void {
  harness!.snapshot.current = {
    ...harness!.snapshot.current,
    videos: harness!.snapshot.current.videos.map((video) => ({
      ...video,
      stage: 'approved' as const,
      review: { status: 'approved' as const, decidedAt: ISO },
    })),
  };
}

afterEach(async () => {
  await harness?.orchestrator.stop();
  harness?.db.close();
  if (harness) rmSync(harness.artifactDir, { recursive: true, force: true });
  harness = undefined;
});

describe('编排器 · 独立 QA 步骤（Step 5D）', () => {
  it('通过时：qa_final 在 render_video 之后、register_artifacts 之前执行并落盘报告', async () => {
    const { orchestrator, qaRunner, qaReports } = createHarness();
    await orchestrator.start();
    const created = await orchestrator.createRun(WORKSPACE_ID, RUN_INPUT);
    const detail = await waitForRun(orchestrator, created.run.id, (run) => run.status === 'succeeded');

    const keys = detail.run.steps.map((step) => `${step.stepKey}:${step.status}`);
    expect(keys.indexOf('qa_final:succeeded')).toBeGreaterThan(keys.indexOf('render_video:succeeded'));
    expect(keys.indexOf('qa_final:succeeded')).toBeLessThan(keys.indexOf('register_artifacts:succeeded'));
    expect(keys).toContain('qa_capture:skipped');

    // The runner was asked exactly once, for the final stage.
    expect(qaRunner.calls.map((call) => call.stage)).toEqual(['final']);
    const finalInput = qaRunner.calls[0]!.input as QaFinalInput;
    expect(finalInput.videoFile).toBe(
      path.join(harness!.artifactDir, 'workspaces', WORKSPACE_ID, 'runs', created.run.id, 'artifacts', `${created.run.id}.mp4`),
    );

    // Report artifact + row + run pointer all agree.
    const reportArtifact = detail.artifacts.find((artifact) => artifact.kind === 'qa_report')!;
    expect(reportArtifact).toBeDefined();
    const stored = qaReports.getByRun(WORKSPACE_ID, created.run.id, 'final')!;
    expect(stored.report.verdict).toBe('pass');
    expect(stored.reportArtifactId).toBe(reportArtifact.id);
    expect(detail.run.qaSummary?.verdict).toBe('pass');
    expect(detail.run.qaSummary?.reportArtifactId).toBe(reportArtifact.id);

    // The report on disk is the canonical artifact, not a copy in the DB.
    const onDisk = JSON.parse(
      readFileSync(path.join(harness!.artifactDir, reportArtifact.storageRef), 'utf8'),
    ) as { reportId: string; subject: { mp4Sha256?: string } };
    expect(onDisk.reportId).toBe(stored.report.reportId);
    expect(onDisk.subject.mp4Sha256).toBe(
      createHash('sha256').update(MP4_BYTES).digest('hex'),
    );

    // Checkpoints the UI renders.
    expect(
      detail.checkpoints.filter((checkpoint) => checkpoint.stepKey === 'qa_final').map((c) => c.phase),
    ).toEqual(expect.arrayContaining(['qa_media_checked', 'qa_privacy_scanned', 'qa_report_written']));
  });

  it('qa_final 阻断时：运行终态失败、错误码为 qa_privacy_blocked、不登记 video_mp4', async () => {
    const { orchestrator, qaReports } = createHarness({
      findings: {
        final: [
          {
            category: 'privacy',
            severity: 'blocker',
            ruleId: 'privacy.email',
            title: '成片字幕命中邮箱',
            sourceKind: 'subtitle_srt',
            sceneId: 'scene_one',
            sceneOrder: 0,
            matchRedacted: 'a***@corp.internal',
          },
        ],
      },
    });
    await orchestrator.start();
    const created = await orchestrator.createRun(WORKSPACE_ID, RUN_INPUT);
    const detail = await waitForRun(orchestrator, created.run.id, (run) => run.status === 'failed');

    expect(detail.run.failure?.code).toBe('qa_privacy_blocked');
    expect(detail.run.failure?.stepKey).toBe('qa_final');
    const byKey = new Map(detail.run.steps.map((step) => [step.stepKey, step]));
    expect(byKey.get('qa_final')?.status).toBe('failed');
    expect(byKey.get('register_artifacts')?.status).toBe('pending');
    // The deliverable MP4 must never be registered for a blocked run.
    expect(detail.artifacts.some((artifact) => artifact.kind === 'video_mp4')).toBe(false);
    // But the blocked report is persisted and readable: that is what Gate 3 shows.
    const stored = qaReports.getByRun(WORKSPACE_ID, created.run.id, 'final')!;
    expect(stored.report.verdict).toBe('fail');
    expect(stored.report.summary.privacyBlockerCount).toBe(1);
    expect(detail.run.qaSummary?.privacyBlockerCount).toBe(1);
  });

  it('OCR 不可用意味着阻断：错误码为 qa_ocr_unavailable', async () => {
    const { orchestrator } = createHarness({
      findings: {
        final: [
          {
            category: 'privacy',
            severity: 'blocker',
            ruleId: 'privacy.ocr_unavailable',
            title: 'OCR 不可用，图像隐私未验证',
            sourceKind: 'render_frame',
          },
        ],
      },
    });
    await orchestrator.start();
    const created = await orchestrator.createRun(WORKSPACE_ID, RUN_INPUT);
    const detail = await waitForRun(orchestrator, created.run.id, (run) => run.status === 'failed');
    expect(detail.run.failure?.code).toBe('qa_ocr_unavailable');
  });

  it('runner 内部抛出异常时映射为 qa_execution_failed（终态，不重试）', async () => {
    const { orchestrator, qaRunner } = createHarness({ throwOn: { final: 'ffmpeg 不可用' } });
    await orchestrator.start();
    const created = await orchestrator.createRun(WORKSPACE_ID, RUN_INPUT);
    const detail = await waitForRun(orchestrator, created.run.id, (run) => run.status === 'failed');
    expect(detail.run.failure?.code).toBe('qa_execution_failed');
    expect(detail.run.failure?.message).toContain('ffmpeg 不可用');
    expect(qaRunner.calls).toHaveLength(1);
    const byKey = new Map(detail.run.steps.map((step) => [step.stepKey, step]));
    expect(byKey.get('qa_final')?.attempt).toBe(1);
  });

  it('cancel 活跃 QA 步骤时调用 runner.abort()', async () => {
    const { orchestrator, qaRunner } = createHarness({ delayMs: 1_500 });
    await orchestrator.start();
    const created = await orchestrator.createRun(WORKSPACE_ID, RUN_INPUT);
    // Wait until the run is parked inside `qa_final`, then cancel it.
    await waitForRun(
      orchestrator,
      created.run.id,
      (run) => run.status === 'running' && run.currentStepKey === 'qa_final',
    );
    expect(qaRunner.isRunning()).toBe(true);
    await orchestrator.cancelRun(WORKSPACE_ID, created.run.id);
    expect(qaRunner.aborted).toBe(true);
  });
});

describe('编排器 · Gate 3 导出硬门禁（Step 5D）', () => {
  it('无 qa_final 报告时 409 export_qa_missing（即使视频已批准）', async () => {
    const { orchestrator, qaReports } = createHarness();
    await orchestrator.start();
    const created = await orchestrator.createRun(WORKSPACE_ID, RUN_INPUT);
    // A run whose qa_final never happened: simulate a legacy 5A/5B run by
    // deleting the report row and artifact registration expectations.
    const detail = await waitForRun(orchestrator, created.run.id, (run) => run.status === 'succeeded');
    qaReports.deleteByRun(WORKSPACE_ID, created.run.id);
    approveVideo();
    await expect(
      orchestrator.createExportBundle(WORKSPACE_ID, { videoId: VIDEO_ID, runId: detail.run.id }),
    ).rejects.toMatchObject({ httpStatus: 409, code: 'export_qa_missing' });
  });

  it('QA 判定 fail 时 409 export_qa_blocked（服务端兜底，与 UI 无关）', async () => {
    // A run that reaches qa_final pass — then the reviewer-approved state and a
    // later tampered report must still block. Here the fail report is written
    // directly into the store, exactly as a blocked run would leave it.
    const { orchestrator, qaReports } = createHarness();
    await orchestrator.start();
    const created = await orchestrator.createRun(WORKSPACE_ID, RUN_INPUT);
    const detail = await waitForRun(orchestrator, created.run.id, (run) => run.status === 'succeeded');
    approveVideo();
    const stored = qaReports.getByRun(WORKSPACE_ID, created.run.id, 'final')!;
    qaReports.upsert({
      report: {
        ...stored.report,
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
        checks: stored.report.checks.map((check) =>
          check.category === 'privacy'
            ? { ...check, status: 'fail' as const, blockerCount: 1, summary: '阻断 1 项' }
            : check,
        ),
        findings: [
          {
            id: 'qaf_export_01',
            ruleId: 'privacy.github_token',
            category: 'privacy' as const,
            severity: 'blocker' as const,
            sourceKind: 'render_frame' as const,
            title: '成片帧命中 Token',
            message: '成片画面中出现疑似 GitHub Token。',
            remediation: '替换为脱敏账号后重录。',
            remediationAction: 'production' as const,
            location: { scope: 'global' as const },
            matchRedacted: 'ghp_****9a2f',
          },
        ],
      },
      reportArtifactId: stored.reportArtifactId ?? undefined,
      reportSha256: stored.reportSha256,
    });
    // The disk report still says `pass`, so the DB/disk hash-mismatch check
    // fires first — which is also a refusal, but for the wrong reason. Rewrite
    // the disk file to the same blocked content so the scenario is honest.
    const artifact = detail.artifacts.find((item) => item.kind === 'qa_report')!;
    const diskPath = path.join(harness!.artifactDir, artifact.storageRef);
    const blocked = qaReports.getByRun(WORKSPACE_ID, created.run.id, 'final')!.report;
    writeFileSync(diskPath, JSON.stringify(blocked, null, 2));
    const newSha = createHash('sha256').update(readFileSync(diskPath)).digest('hex');
    qaReports.upsert({ report: blocked, reportArtifactId: artifact.id, reportSha256: newSha });
    harness!.db
      .prepare('UPDATE orchestration_artifacts SET sha256 = ?, byte_size = ? WHERE id = ?')
      .run(newSha, readFileSync(diskPath).byteLength, artifact.id);

    const rejection = await orchestrator
      .createExportBundle(WORKSPACE_ID, { videoId: VIDEO_ID, runId: detail.run.id })
      .catch((error: unknown) => error);
    expect(rejection).toBeInstanceOf(OrchestrationHttpError);
    expect(rejection).toMatchObject({ httpStatus: 409, code: 'export_qa_blocked' });
    // The error body carries only redacted matches.
    expect(JSON.stringify((rejection as OrchestrationHttpError).details)).not.toMatch(
      /ghp_[A-Za-z0-9]{20,}/,
    );
  });

  it('报告哈希漂移时 409 export_hash_mismatch', async () => {
    const { orchestrator, artifactDir } = createHarness();
    await orchestrator.start();
    const created = await orchestrator.createRun(WORKSPACE_ID, RUN_INPUT);
    const detail = await waitForRun(orchestrator, created.run.id, (run) => run.status === 'succeeded');
    approveVideo();
    const artifact = detail.artifacts.find((item) => item.kind === 'qa_report')!;
    const diskPath = path.join(artifactDir, artifact.storageRef);
    writeFileSync(diskPath, `${readFileSync(diskPath, 'utf8')} `);
    await expect(
      orchestrator.createExportBundle(WORKSPACE_ID, { videoId: VIDEO_ID, runId: detail.run.id }),
    ).rejects.toMatchObject({ httpStatus: 409, code: 'export_hash_mismatch' });
  });

  it('报告针对的 MP4 与当前交付文件不一致时 409 export_qa_stale', async () => {
    const { orchestrator, artifactDir } = createHarness();
    await orchestrator.start();
    const created = await orchestrator.createRun(WORKSPACE_ID, RUN_INPUT);
    const detail = await waitForRun(orchestrator, created.run.id, (run) => run.status === 'succeeded');
    approveVideo();
    // Rewrite the MP4 *and* its artifact row so rehash passes, leaving the QA
    // report describing the previous bytes.
    const mp4Artifact = detail.artifacts.find((item) => item.kind === 'video_mp4')!;
    const mp4Path = path.join(artifactDir, mp4Artifact.storageRef);
    writeFileSync(mp4Path, 'fake-mp4-bytes-for-qa-v2');
    const newSha = createHash('sha256').update('fake-mp4-bytes-for-qa-v2').digest('hex');
    harness!.db
      .prepare('UPDATE orchestration_artifacts SET sha256 = ?, byte_size = ? WHERE id = ?')
      .run(newSha, Buffer.byteLength('fake-mp4-bytes-for-qa-v2'), mp4Artifact.id);
    // The manifest also binds the MP4 hash; keep the export path consistent by
    // updating the receipt/manifest rows' hashes as well.
    for (const kind of ['artifact_receipt', 'render_manifest'] as const) {
      const artifact = detail.artifacts.find((item) => item.kind === kind);
      if (!artifact) continue;
      const file = path.join(artifactDir, artifact.storageRef);
      const sha = createHash('sha256').update(readFileSync(file)).digest('hex');
      harness!.db
        .prepare('UPDATE orchestration_artifacts SET sha256 = ?, byte_size = ? WHERE id = ?')
        .run(sha, readFileSync(file).byteLength, artifact.id);
    }
    const rejection = await orchestrator
      .createExportBundle(WORKSPACE_ID, { videoId: VIDEO_ID, runId: detail.run.id })
      .catch((error: unknown) => error);
    expect(rejection).toMatchObject({ httpStatus: 409, code: 'export_qa_stale' });
  });

  it('通过时：交付包包含 qa-report.json 并绑定报告哈希', async () => {
    const { orchestrator } = createHarness();
    await orchestrator.start();
    const created = await orchestrator.createRun(WORKSPACE_ID, RUN_INPUT);
    const detail = await waitForRun(orchestrator, created.run.id, (run) => run.status === 'succeeded');
    approveVideo();
    const bundle = await orchestrator.createExportBundle(WORKSPACE_ID, {
      videoId: VIDEO_ID,
      runId: detail.run.id,
    });
    const qaFile = bundle.files.find((file) => file.kind === 'qa_report')!;
    expect(qaFile.fileName).toBe(`${VIDEO_ID}.qa-report.json`);
    expect(bundle.bundle.qaReportArtifactId).toBe(qaFile.artifactId);
    expect(bundle.bundle.qaReportSha256).toBe(qaFile.sha256);
    // Delivered file bytes hash to the bound digest.
    const onDisk = path.join(
      harness!.artifactDir,
      'workspaces',
      WORKSPACE_ID,
      'runs',
      created.run.id,
      'qa',
      'qa-final-report.json',
    );
    expect(createHash('sha256').update(readFileSync(onDisk)).digest('hex')).toBe(qaFile.sha256);
  });

  it('QA 通过但有非阻断提醒时仍可导出（至少 1 条 warning 也不例外）', async () => {
    const { orchestrator } = createHarness({
      findings: {
        final: [
          {
            category: 'content',
            severity: 'warning',
            ruleId: 'content.banned_phrase',
            title: '文案接近禁用词',
          },
        ],
      },
    });
    await orchestrator.start();
    const created = await orchestrator.createRun(WORKSPACE_ID, RUN_INPUT);
    const detail = await waitForRun(orchestrator, created.run.id, (run) => run.status === 'succeeded');
    expect(detail.run.qaSummary?.verdict).toBe('pass_with_warnings');
    approveVideo();
    const bundle = await orchestrator.createExportBundle(WORKSPACE_ID, {
      videoId: VIDEO_ID,
      runId: detail.run.id,
    });
    expect(bundle.files.some((file) => file.kind === 'qa_report')).toBe(true);
  });
});
