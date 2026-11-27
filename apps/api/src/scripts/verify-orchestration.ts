import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type { DatabaseSync } from 'node:sqlite';
import {
  artifactReceiptV1Schema,
  renderJobInputV1Schema,
  renderManifestV1Schema,
  type RenderJobInputV1,
  type StudioSnapshot,
} from '@asvs/domain';
import type {
  RenderJobExecutionResult,
  RenderJobExecutorCallbacks,
  RenderJobExecutorPort,
} from '@asvs/ports';
import { openDatabase } from '../db/database';
import { SqliteOrchestrationStore } from '../db/orchestration-store';
import { Orchestrator } from '../orchestration/orchestrator';
import { RenderProcessExecutor } from '../orchestration/render-process-executor';
import { OrchestrationHttpError } from '../orchestration/errors';

/**
 * `pnpm orchestration:verify` — the AC-06 acceptance check.
 *
 * Unlike the unit tests this script never fakes the renderer: it builds a
 * throwaway SQLite database and workspace, spawns the real
 * `workers/render-worker` child process, `SIGKILL`s it mid-render, kills the
 * "API" while it is retrying and lets a fresh Orchestrator over the same
 * database reclaim the orphaned lease, resume from the persisted
 * `bundle_ready` checkpoint and finish. The MP4 is then verified with ffprobe
 * and SHA256 against the receipt, the manifest and the registered artifact row.
 *
 * Exit 0 only when every recorded assertion holds.
 */

const here = path.dirname(fileURLToPath(import.meta.url));
const requireFromHere = createRequire(import.meta.url);
/** apps/api/src/scripts → repository root */
const workspaceRoot = path.resolve(here, '../../../..');
const workerTsconfig = path.join(workspaceRoot, 'workers/render-worker/tsconfig.json');
const WORKSPACE_ID = 'ws_orchestration_verify';
const VIDEO_ID = 'vid_lumen_release';
const BLOCKED_VIDEO_ID = 'vid_lumen_blocked';
const PORTRAIT_VIDEO_ID = 'vid_lumen_portrait';
const ISO = '2026-11-27T10:00:00.000Z';

interface StepReport {
  name: string;
  ok: boolean;
  detail: string;
}

const reports: StepReport[] = [];

function record(name: string, ok: boolean, detail: string): void {
  reports.push({ name, ok, detail });
  process.stdout.write(`  ${ok ? '✓' : '✗'} ${name} — ${detail}\n`);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function sha256File(file: string): string {
  // The MP4 is a few MB; one read keeps this script dependency-free.
  return createHash('sha256').update(readFileSync(file)).digest('hex');
}

interface ProbeResult {
  codecName: string;
  width: number;
  height: number;
  fps: number;
  durationMs: number;
  hasAudio: boolean;
}

function runFfprobe(file: string): ProbeResult {
  const result = spawnSync(
    'ffprobe',
    ['-v', 'error', '-print_format', 'json', '-show_streams', '-show_format', file],
    { encoding: 'utf8', windowsHide: true, maxBuffer: 16 * 1024 * 1024 },
  );
  if (result.status !== 0) throw new Error(`ffprobe 失败：${result.stderr}`);
  const parsed = JSON.parse(result.stdout) as {
    streams?: Array<{
      codec_type?: string;
      codec_name?: string;
      width?: number;
      height?: number;
      avg_frame_rate?: string;
      r_frame_rate?: string;
    }>;
    format?: { duration?: string };
  };
  const video = parsed.streams?.find((stream) => stream.codec_type === 'video');
  if (!video) throw new Error('ffprobe 没有找到视频流');
  const rate = video.avg_frame_rate ?? video.r_frame_rate ?? '0/1';
  const [numerator, denominator] = rate.split('/').map(Number);
  return {
    codecName: video.codec_name ?? 'unknown',
    width: video.width ?? 0,
    height: video.height ?? 0,
    fps: denominator ? numerator / denominator : 0,
    durationMs: Math.round(Number(parsed.format?.duration ?? 0) * 1000),
    hasAudio: parsed.streams?.some((stream) => stream.codec_type === 'audio') ?? false,
  };
}

// ── Workspace fixture ───────────────────────────────────────────────────────

function buildVideo(options: {
  id: string;
  title: string;
  aspect: '16:9' | '9:16';
  claimIds?: string[];
  narration: string;
}): StudioSnapshot['videos'][number] {
  return {
    id: options.id,
    projectId: 'proj_lumen',
    title: options.title,
    mode: 'release_video',
    stage: 'review',
    fps: 30,
    brief: {
      objective: '验证服务端渲染链路',
      audience: '工程团队',
      featureIds: [],
      durationSec: 6,
      aspect: options.aspect,
      language: 'zh-CN',
      tone: 'confident',
      style: 'editorial',
      templateId: 'tpl_signal',
      useRealCapture: false,
      useGeneratedVisuals: true,
      cta: '无',
      bannedPhrases: [],
    },
    scenes: [
      {
        id: `${options.id}_scene`,
        order: 0,
        revision: 1,
        title: '验证镜头',
        intent: '验证编排器产出真实 MP4',
        narration: options.narration,
        caption: '真实渲染',
        durationSec: 6,
        durationFrames: 180,
        visualType: 'title',
        visual: { type: 'title' },
        templateId: 'tpl_signal',
        claimIds: options.claimIds ?? [],
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
  };
}

function buildWorkspaceSnapshot(): StudioSnapshot {
  return {
    projects: [
      {
        id: 'proj_lumen',
        name: 'Lumen',
        productName: 'Lumen',
        description: '编排器验收项目',
        website: 'https://lumen.demo.invalid',
        stage: 'active',
        brand: {
          logoText: 'LUMEN',
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
    claims: [
      {
        id: 'claim_blocked',
        projectId: 'proj_lumen',
        featureId: 'feat_lumen',
        statement: '未经核验的声明',
        audience: '工程团队',
        status: 'proposed',
        eligibility: 'blocked_unverified',
        blockers: ['缺少可复核的证据'],
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
      buildVideo({
        id: VIDEO_ID,
        title: '编排器验收视频',
        aspect: '16:9',
        narration: '这是一次真实的 16:9 渲染。',
      }),
      buildVideo({
        id: BLOCKED_VIDEO_ID,
        title: '声明阻断验收视频',
        aspect: '16:9',
        claimIds: ['claim_blocked'],
        narration: '此视频引用了未核验的声明。',
      }),
      buildVideo({
        id: PORTRAIT_VIDEO_ID,
        title: '竖屏验收视频',
        aspect: '9:16',
        narration: '竖屏不支持。',
      }),
    ],
    runs: [],
    exports: [],
    activity: [],
  };
}

function insertWorkspace(db: DatabaseSync, snapshot: StudioSnapshot): void {
  db.prepare(
    'INSERT INTO workspaces (id, revision, schema_version, payload, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)',
  ).run(WORKSPACE_ID, 1, 2, JSON.stringify(snapshot), ISO, ISO);
}

// ── Fault-injecting executors (all wrap the real subprocess) ────────────────

/**
 * SIGKILLs the real worker 150 ms after it reports `bundle_ready` — the exact
 * point AC-06 cares about: the bundle is durable, the MP4 is not.
 */
class KillOnBundleExecutor implements RenderJobExecutorPort {
  killed = false;
  workerPid: number | null = null;
  readonly spawns: number[] = [];

  constructor(private readonly inner = new RenderProcessExecutor({})) {}

  isRunning(): boolean {
    return this.inner.isRunning();
  }

  abort(): void {
    this.inner.abort();
  }

  execute(
    job: RenderJobInputV1,
    inputFile: string,
    outDir: string,
    checkpointFile: string,
    callbacks: RenderJobExecutorCallbacks,
  ): Promise<RenderJobExecutionResult> {
    return this.inner.execute(job, inputFile, outDir, checkpointFile, {
      ...callbacks,
      onSpawn: (pid) => {
        this.workerPid = pid;
        this.spawns.push(pid);
        callbacks.onSpawn?.(pid);
      },
      onCheckpoint: (phase, payload) => {
        callbacks.onCheckpoint?.(phase, payload);
        if (phase === 'bundle_ready' && !this.killed) {
          this.killed = true;
          setTimeout(() => this.inner.kill('SIGKILL'), 150);
        }
      },
    });
  }
}

/** Kills every spawned worker almost immediately — drives retry exhaustion. */
class CrashOnSpawnExecutor implements RenderJobExecutorPort {
  calls = 0;

  constructor(private readonly inner = new RenderProcessExecutor({})) {}

  isRunning(): boolean {
    return this.inner.isRunning();
  }

  abort(): void {
    this.inner.abort();
  }

  execute(
    job: RenderJobInputV1,
    inputFile: string,
    outDir: string,
    checkpointFile: string,
    callbacks: RenderJobExecutorCallbacks,
  ): Promise<RenderJobExecutionResult> {
    this.calls += 1;
    return this.inner.execute(job, inputFile, outDir, checkpointFile, {
      ...callbacks,
      onSpawn: (pid) => {
        callbacks.onSpawn?.(pid);
        setTimeout(() => this.inner.kill('SIGKILL'), 50);
      },
    });
  }
}

/** Records any spawn so the gate checks can prove none happened. */
class NeverCallExecutor implements RenderJobExecutorPort {
  calls = 0;

  isRunning(): boolean {
    return false;
  }

  abort(): void {
    // nothing to abort
  }

  async execute(): Promise<RenderJobExecutionResult> {
    this.calls += 1;
    return {
      ok: false,
      workerPid: null,
      exitCode: null,
      signal: null,
      crashed: false,
      code: 'unexpected_worker_spawn',
      message: '该场景本不应启动渲染子进程',
      checkpoints: [],
    };
  }
}

// ── Polling helpers ─────────────────────────────────────────────────────────

async function waitFor<T>(
  read: () => Promise<T> | T,
  predicate: (value: T) => boolean,
  timeoutMs: number,
  label: string,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await read();
    if (predicate(value)) return value;
    if (Date.now() > deadline) throw new Error(`等待「${label}」超时`);
    await sleep(100);
  }
}

function isTerminal(status: string): boolean {
  return status === 'succeeded' || status === 'failed' || status === 'cancelled';
}

async function runWorkerCli(
  job: RenderJobInputV1,
  outDir: string,
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  mkdirSync(outDir, { recursive: true });
  const inputFile = path.join(outDir, 'job.json');
  writeFileSync(inputFile, JSON.stringify(job, null, 2));
  return new Promise((resolve) => {
    const child = spawn(
      process.execPath,
      [
        '--import',
        // Node parses `--import` as a specifier; a bare Windows path would be
        // read as a `d:` URL. Same fix as RenderProcessExecutor.
        pathToFileURL(requireFromHere.resolve('tsx')).href,
        path.join(workspaceRoot, 'workers/render-worker/src/render-job.ts'),
        '--input',
        inputFile,
        '--out',
        outDir,
      ],
      {
        cwd: workspaceRoot,
        shell: false,
        stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...process.env, TSX_TSCONFIG_PATH: workerTsconfig },
      },
    );
    let stdout = '';
    let stderr = '';
    child.stdout?.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf8');
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8');
    });
    child.once('close', (code) => resolve({ code, stdout, stderr }));
    child.once('error', (error) =>
      resolve({ code: null, stdout, stderr: `${stderr}${error.message}` }),
    );
  });
}

// ── Main ────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const startedAt = Date.now();
  const tempRoot = mkdtempSync(path.join(os.tmpdir(), 'asvs-orch-verify-'));
  const dbPath = path.join(tempRoot, 'orchestration.sqlite');
  const artifactDir = path.join(tempRoot, 'artifacts');
  process.stdout.write(`\n编排器真实验收（AC-06）\n${'─'.repeat(78)}\n`);
  process.stdout.write(`  数据库    ${dbPath}\n  产物目录  ${artifactDir}\n\n`);

  const snapshot = buildWorkspaceSnapshot();
  const db = openDatabase(dbPath);
  insertWorkspace(db, snapshot);
  const store = new SqliteOrchestrationStore(db);
  const loadWorkspace = () => snapshot;

  try {
    // ── 1. Duplicate delivery ──────────────────────────────────────────────
    const firstKiller = new KillOnBundleExecutor();
    const apiFirst = new Orchestrator({
      store,
      artifactDir,
      loadWorkspace,
      executor: firstKiller,
      instanceId: 'api_first',
      maxAttempts: 4,
      schedulerIntervalMs: 200,
    });
    await apiFirst.start();
    const idempotencyKey = `verify-${Date.now()}`;
    const created = await apiFirst.createRun(WORKSPACE_ID, {
      videoId: VIDEO_ID,
      idempotencyKey,
    });
    const duplicate = await apiFirst.createRun(WORKSPACE_ID, {
      videoId: VIDEO_ID,
      idempotencyKey,
    });
    record(
      '重复投递只创建一个运行',
      created.created && duplicate.created === false && duplicate.run.id === created.run.id,
      `run=${created.run.id} duplicate.created=${duplicate.created}`,
    );

    // ── 2. Real SIGKILL mid-render ─────────────────────────────────────────
    const crashedRun = await waitFor(
      () => apiFirst.getRun(WORKSPACE_ID, created.run.id),
      (detail) =>
        detail !== null &&
        detail.checkpoints.some(
          (checkpoint) =>
            checkpoint.stepKey === 'render_video' && checkpoint.phase === 'bundle_ready',
        ) &&
        firstKiller.killed,
      600_000,
      '真实 worker 命中 bundle_ready 并被 SIGKILL',
    );
    record(
      '真实子进程被杀（SIGKILL / taskkill）',
      crashedRun !== null && firstKiller.killed && firstKiller.workerPid !== null,
      `worker pid=${firstKiller.workerPid ?? 'n/a'} spawns=${firstKiller.spawns.length}`,
    );
    const bundleCheckpoint = crashedRun?.checkpoints.find(
      (checkpoint) => checkpoint.stepKey === 'render_video' && checkpoint.phase === 'bundle_ready',
    );
    record(
      '崩溃前 bundle_ready checkpoint 已落库',
      Boolean(bundleCheckpoint),
      bundleCheckpoint
        ? `inputDigest=${String(bundleCheckpoint.payload.inputDigest).slice(0, 12)}…`
        : '缺失',
    );

    // The crash triggered an automatic retry. Wait until that retry has spawned
    // its real worker again, then hard-stop this "API process" — its lease then
    // survives exactly like a crashed API's would.
    await waitFor(
      () => firstKiller.spawns.length,
      (count) => count >= 2,
      300_000,
      '崩溃后自动重试启动第二次真实 worker',
    );
    const retryLease = await apiFirst.getRun(WORKSPACE_ID, created.run.id);
    const retryJob = retryLease?.jobs.find((job) => job.stepKey === 'render_video');
    record(
      '崩溃触发自动重试（新尝试已租约并启动 worker）',
      Boolean(
        retryJob &&
          retryJob.attempt >= 2 &&
          (retryJob.status === 'leased' || retryJob.status === 'running') &&
          retryJob.leaseOwner === 'api_first',
      ),
      `attempt=${retryJob?.attempt ?? 0} status=${retryJob?.status ?? 'n/a'} spawns=${firstKiller.spawns.length}`,
    );
    await apiFirst.stop();
    const afterHardStop = await apiFirst.getRun(WORKSPACE_ID, created.run.id);
    const orphanJob = afterHardStop?.jobs.find((job) => job.stepKey === 'render_video');
    record(
      'API 进程硬停后运行仍非终态（留下孤儿租约）',
      afterHardStop?.run.status === 'running' && orphanJob?.leaseOwner === 'api_first',
      `run status=${afterHardStop?.run.status ?? 'n/a'} leaseOwner=${orphanJob?.leaseOwner ?? 'null'}`,
    );

    // ── 3. Restart: a new Orchestrator reclaims and resumes ────────────────
    const apiSecond = new Orchestrator({
      store,
      artifactDir,
      loadWorkspace,
      executor: new RenderProcessExecutor({}),
      instanceId: 'api_second',
      maxAttempts: 4,
      schedulerIntervalMs: 200,
    });
    await apiSecond.start();
    const resumed = await waitFor(
      () => apiSecond.getRun(WORKSPACE_ID, created.run.id),
      (detail) => detail !== null && isTerminal(detail.run.status),
      600_000,
      '重启后的实例完成运行',
    );
    record(
      'API 重启后新实例自动接管并完成',
      resumed?.run.status === 'succeeded',
      resumed?.run.failure
        ? `failed: ${resumed.run.failure.code} ${resumed.run.failure.message}`
        : `status=${resumed?.run.status ?? 'n/a'}`,
    );
    if (!resumed || resumed.run.status !== 'succeeded') {
      throw new Error('运行没有成功完成；后续产物校验跳过');
    }
    record(
      '孤儿租约被回收（heartbeat_lost）',
      resumed.events.some((event) => event.eventType === 'heartbeat_lost'),
      `${resumed.events.filter((event) => event.eventType === 'heartbeat_lost').length} 条 heartbeat_lost 事件`,
    );
    const renderStep = resumed.run.steps.find((step) => step.stepKey === 'render_video');
    record(
      '断点续跑：render_video 尝试次数 ≥ 3',
      (renderStep?.attempt ?? 0) >= 3,
      `attempt=${renderStep?.attempt ?? 0} checkpoints=${renderStep?.checkpointPhases.join(',') ?? ''}`,
    );
    const resumeLog = resumed.events.find((event) =>
      event.message.includes('命中 bundle_ready checkpoint'),
    );
    record(
      '续跑跳过 Remotion 打包（命中 checkpoint）',
      Boolean(resumeLog),
      resumeLog ? resumeLog.message.slice(0, 72) : '未在事件日志中找到续跑记录',
    );
    await apiSecond.stop();

    // ── 4. Artifacts + ffprobe + SHA256 ────────────────────────────────────
    const videoArtifact = resumed.artifacts.find((artifact) => artifact.kind === 'video_mp4');
    const manifestArtifact = resumed.artifacts.find(
      (artifact) => artifact.kind === 'render_manifest',
    );
    const receiptArtifact = resumed.artifacts.find(
      (artifact) => artifact.kind === 'artifact_receipt',
    );
    record(
      '三种产物均已登记',
      Boolean(videoArtifact && manifestArtifact && receiptArtifact),
      `${resumed.artifacts.length} 个产物`,
    );
    if (!videoArtifact || !manifestArtifact || !receiptArtifact) {
      throw new Error('产物登记不完整');
    }

    // Read-only service view over the same store; no scheduler needed.
    const apiReader = new Orchestrator({
      store,
      artifactDir,
      loadWorkspace,
      instanceId: 'api_reader',
    });
    const resolved = await apiReader.resolveArtifactFile(WORKSPACE_ID, videoArtifact.id);
    if (!resolved) throw new Error('缺少 MP4 产物文件');
    const mp4Path = resolved.file;
    const outDir = path.dirname(mp4Path);
    const runDir = path.dirname(outDir);
    const receiptFile = path.join(outDir, 'receipt.json');
    const manifestFile = path.join(outDir, 'manifest.json');
    record(
      '产物文件全部存在',
      existsSync(mp4Path) && existsSync(receiptFile) && existsSync(manifestFile),
      mp4Path,
    );

    const actualSha = sha256File(mp4Path);
    const receipt = artifactReceiptV1Schema.parse(JSON.parse(readFileSync(receiptFile, 'utf8')));
    const manifest = renderManifestV1Schema.parse(JSON.parse(readFileSync(manifestFile, 'utf8')));
    record(
      'MP4 SHA256 与回执 / 清单 / 登记行一致',
      actualSha === receipt.sha256 &&
        actualSha === manifest.output.sha256 &&
        actualSha === videoArtifact.sha256,
      `sha256=${actualSha}`,
    );

    const probe = runFfprobe(mp4Path);
    record(
      'ffprobe：16:9 / H.264 / 无音轨',
      probe.width * 9 === probe.height * 16 && probe.codecName === 'h264' && !probe.hasAudio,
      `${probe.width}×${probe.height} · ${probe.codecName} · ${probe.fps}fps · ${probe.durationMs}ms · 音轨=${probe.hasAudio}`,
    );
    record(
      'ffprobe 时长与清单一致（±250ms）',
      Math.abs(probe.durationMs - manifest.ffprobe.durationMs) <= 250,
      `probe=${probe.durationMs}ms manifest=${manifest.ffprobe.durationMs}ms`,
    );

    // ── 5. Rejections must never spawn a worker ────────────────────────────
    const neverCall = new NeverCallExecutor();
    const apiGate = new Orchestrator({
      store,
      artifactDir,
      loadWorkspace,
      executor: neverCall,
      instanceId: 'api_gate',
      schedulerIntervalMs: 200,
    });
    await apiGate.start();
    let portraitError: unknown = null;
    try {
      await apiGate.createRun(WORKSPACE_ID, {
        videoId: PORTRAIT_VIDEO_ID,
        idempotencyKey: `verify-portrait-${Date.now()}`,
      });
    } catch (error) {
      portraitError = error;
    }
    record(
      '非 16:9 在创建阶段被拒绝，未启动 worker',
      portraitError instanceof OrchestrationHttpError &&
        portraitError.httpStatus === 400 &&
        portraitError.code === 'aspect_not_supported' &&
        neverCall.calls === 0,
      portraitError instanceof OrchestrationHttpError
        ? `${portraitError.httpStatus} ${portraitError.code} · executor calls=${neverCall.calls}`
        : `非预期错误：${String(portraitError)}`,
    );

    const blockedRun = await apiGate.createRun(WORKSPACE_ID, {
      videoId: BLOCKED_VIDEO_ID,
      idempotencyKey: `verify-blocked-${Date.now()}`,
    });
    const blockedDetail = await waitFor(
      () => apiGate.getRun(WORKSPACE_ID, blockedRun.run.id),
      (detail) => detail !== null && isTerminal(detail.run.status),
      60_000,
      '声明阻断运行进入终态',
    );
    record(
      '未核验声明在 verify_claims 阻断，未启动 worker',
      blockedDetail?.run.status === 'failed' &&
        blockedDetail.run.failure?.code === 'claims_blocked' &&
        neverCall.calls === 0,
      `${blockedDetail?.run.status ?? 'n/a'} · ${blockedDetail?.run.failure?.code ?? '-'} · executor calls=${neverCall.calls}`,
    );
    await apiGate.stop();

    // ── 6. Retry exhaustion → worker_crash_exhausted ───────────────────────
    const crasher = new CrashOnSpawnExecutor();
    const apiCrash = new Orchestrator({
      store,
      artifactDir,
      loadWorkspace,
      executor: crasher,
      instanceId: 'api_crash',
      maxAttempts: 2,
      schedulerIntervalMs: 200,
    });
    await apiCrash.start();
    const exhaustedRun = await apiCrash.createRun(WORKSPACE_ID, {
      videoId: VIDEO_ID,
      idempotencyKey: `verify-exhaust-${Date.now()}`,
    });
    const exhausted = await waitFor(
      () => apiCrash.getRun(WORKSPACE_ID, exhaustedRun.run.id),
      (detail) => detail !== null && isTerminal(detail.run.status),
      180_000,
      '重试耗尽运行进入终态',
    );
    const exhaustedJob = exhausted?.jobs.find((job) => job.stepKey === 'render_video');
    record(
      '重试耗尽 → failed / worker_crash_exhausted',
      exhausted?.run.status === 'failed' &&
        exhausted.run.failure?.code === 'worker_crash_exhausted' &&
        crasher.calls >= 2,
      `${exhausted?.run.status ?? 'n/a'} · ${exhausted?.run.failure?.code ?? '-'} · crashed attempts=${crasher.calls} · job attempt=${exhaustedJob?.attempt ?? 0}`,
    );
    // Stop the scheduler first so the transition checks below observe exactly
    // the state the service calls produce, with no pump racing them.
    await apiCrash.stop();

    const apiTransitions = new Orchestrator({
      store,
      artifactDir,
      loadWorkspace,
      instanceId: 'api_transitions',
    });
    const retried = await apiTransitions.retryRun(WORKSPACE_ID, exhaustedRun.run.id);
    record('手动重试把 failed 运行重新入队', retried.status === 'queued', `status=${retried.status}`);
    const cancelledExhausted = await apiTransitions.cancelRun(
      WORKSPACE_ID,
      exhaustedRun.run.id,
    );
    record(
      '取消 queued/running 运行 → cancelled',
      cancelledExhausted.status === 'cancelled',
      `status=${cancelledExhausted.status}`,
    );
    let illegalRetry: unknown = null;
    try {
      await apiTransitions.retryRun(WORKSPACE_ID, exhaustedRun.run.id);
    } catch (error) {
      illegalRetry = error;
    }
    record(
      '非法迁移（retry 已取消运行）→ 409',
      illegalRetry instanceof OrchestrationHttpError &&
        illegalRetry.httpStatus === 409 &&
        illegalRetry.code === 'invalid_transition',
      illegalRetry instanceof OrchestrationHttpError
        ? `${illegalRetry.httpStatus} ${illegalRetry.code}`
        : `非预期错误：${String(illegalRetry)}`,
    );
    let illegalCancel: unknown = null;
    try {
      await apiTransitions.cancelRun(WORKSPACE_ID, created.run.id);
    } catch (error) {
      illegalCancel = error;
    }
    record(
      '非法迁移（cancel 已成功运行）→ 409',
      illegalCancel instanceof OrchestrationHttpError &&
        illegalCancel.httpStatus === 409 &&
        illegalCancel.code === 'invalid_transition',
      illegalCancel instanceof OrchestrationHttpError
        ? `${illegalCancel.httpStatus} ${illegalCancel.code}`
        : `非预期错误：${String(illegalCancel)}`,
    );

    // ── 7. Tampered jobDigest is refused by the real worker CLI ────────────
    const frozen = JSON.parse(readFileSync(path.join(runDir, 'input.json'), 'utf8')) as {
      input: RenderJobInputV1['input'];
    };
    const tamperedJob = renderJobInputV1Schema.parse({
      schemaVersion: '1',
      kind: 'asvs.render-job',
      jobId: 'orchjob_tampered',
      artifactId: 'artifact_tampered',
      runId: created.run.id,
      input: frozen.input,
      media: [],
      outputFileName: 'tampered.mp4',
      jobDigest: 'f'.repeat(64),
      createdAt: ISO,
    });
    const tampered = await runWorkerCli(tamperedJob, path.join(tempRoot, 'tamper-out'));
    record(
      '篡改 jobDigest 的输入被 worker 拒绝',
      tampered.code !== 0 && /jobDigest/i.test(`${tampered.stdout}${tampered.stderr}`),
      `exit=${tampered.code ?? 'null'}`,
    );

    // ── 8. Cancel mid-render ───────────────────────────────────────────────
    const apiCancel = new Orchestrator({
      store,
      artifactDir,
      loadWorkspace,
      executor: new RenderProcessExecutor({}),
      instanceId: 'api_cancel',
      schedulerIntervalMs: 200,
    });
    await apiCancel.start();
    const cancelRun = await apiCancel.createRun(WORKSPACE_ID, {
      videoId: VIDEO_ID,
      idempotencyKey: `verify-cancel-${Date.now()}`,
    });
    await waitFor(
      () => apiCancel.getRun(WORKSPACE_ID, cancelRun.run.id),
      (detail) =>
        detail !== null &&
        // Cancel early, while the real worker is bundling: the run must land in
        // `cancelled` without ever registering artifacts.
        detail.jobs.some((job) => job.stepKey === 'render_video' && job.workerPid !== null),
      120_000,
      '渲染中任务已启动真实 worker',
    );
    const cancelled = await apiCancel.cancelRun(WORKSPACE_ID, cancelRun.run.id);
    await sleep(1_500);
    const afterCancel = await apiCancel.getRun(WORKSPACE_ID, cancelRun.run.id);
    record(
      '取消渲染中运行 → cancelled 且未被自动重试',
      cancelled.status === 'cancelled' &&
        afterCancel?.run.status === 'cancelled' &&
        afterCancel.artifacts.length === 0,
      `status=${afterCancel?.run.status ?? 'n/a'} · artifacts=${afterCancel?.artifacts.length ?? 0}`,
    );
    await apiCancel.stop();

    const durationMs = Date.now() - startedAt;
    process.stdout.write(`\nMP4：${mp4Path}\nSHA256：${actualSha}\n`);
    process.stdout.write(
      `ffprobe：${probe.width}×${probe.height} · ${probe.codecName} · ${probe.durationMs}ms · 无音轨\n`,
    );
    process.stdout.write(`用时：${(durationMs / 1000).toFixed(1)}s\n\n`);

    const failedChecks = reports.filter((report) => !report.ok);
    if (failedChecks.length > 0) {
      process.stderr.write(`验收失败：${failedChecks.length} 项未通过\n`);
      for (const check of failedChecks) process.stderr.write(`  ✗ ${check.name} — ${check.detail}\n`);
      process.exitCode = 1;
      return;
    }
    process.stdout.write(`全部 ${reports.length} 项验收通过。\n`);
  } finally {
    db.close();
    if (!process.env.ASVS_KEEP_VERIFY_DIR) {
      rmSync(tempRoot, { recursive: true, force: true });
    } else {
      process.stdout.write(`临时目录保留：${tempRoot}\n`);
    }
  }
}

void main().catch((error) => {
  process.stderr.write(
    `\n验收脚本异常：${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`,
  );
  process.exitCode = 1;
});
