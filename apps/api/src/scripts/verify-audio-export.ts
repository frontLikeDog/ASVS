import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import {
  exportBundleDetailV1Schema,
  type OrchestrationStepKey,
  type StoryboardV1,
  type StudioSnapshot,
} from '@asvs/domain';
import { openDatabase } from '../db/database';
import { SqliteOrchestrationStore } from '../db/orchestration-store';
import { ExportBundleStore } from '../db/export-bundle-store';
import { Orchestrator } from '../orchestration/orchestrator';
import { RenderProcessExecutor } from '../orchestration/render-process-executor';
import { OrchestrationHttpError } from '../orchestration/errors';
import { SpeechService } from '../speech/speech-service';
import { SpeechCacheStore } from '../speech/speech-cache-store';
import { createSpeechPort, speechAudioRoot, DETERMINISTIC_TEST_LICENSE } from '../speech';
import { QaReportStore } from '../db/qa-report-store';
import { IndependentQaRunner } from '../qa/independent-qa-runner';
import { DeterministicTestOcrAdapter } from '../qa/ocr-adapters';
import { loadQaConfig } from '../config';
import type { SpeechRuntimeConfig } from '@asvs/ports';

/**
 * `pnpm export:verify` — the AC-10 acceptance check.
 *
 * Runs the whole 5B pipeline against a throwaway SQLite database and a real
 * Remotion subprocess: synthesize narration (deterministic test voice, honestly
 * labelled), reconcile an intentionally over-long scene with `extend_scene`,
 * generate + server-validate the SRT, render H.264 + AAC, register MP4 / SRT /
 * manifest / receipt, then export a Gate-3 bundle and download every file over
 * the artifact route. Independently re-checks the bytes:
 *
 * - every SHA256 in the bundle agrees with the file on disk and with the
 *   manifest / receipt;
 * - ffprobe sees video AND audio, both within 500 ms of each other;
 * - `ffmpeg volumedetect` proves the track is not silent;
 * - the SRT re-parses under an independent validator (monotonic, no overlap,
 *   inside the video duration);
 * - a second identical run makes zero provider calls (100 % cache hits);
 * - exporting an unapproved video is refused with 409.
 *
 * Exit 0 only when every recorded assertion holds.
 */

const WORKSPACE_ID = 'ws_audio_export_verify';
const VIDEO_ID = 'vid_audio_export';
const UNAPPROVED_VIDEO_ID = 'vid_audio_unapproved';
const ISO = '2026-11-27T10:00:00.000Z';
/**
 * 5C/5D capture-dependent steps; `skipped` here means "capture was never
 * requested" — `qa_capture` has nothing to scan and is skipped with them. Typed
 * as `OrchestrationStepKey[]` (not a bare literal array) so it can index the
 * step-keyed Map without widening to `string`.
 */
const CAPTURE_STEP_KEYS: OrchestrationStepKey[] = ['plan_demo', 'capture_demo', 'qa_capture'];

/**
 * ~150 characters of Chinese. The deterministic adapter estimates 4.2 chars/s,
 * so this is ~36 s of speech inside a 12 s scene: a guaranteed overflow that
 * `extend_scene` must absorb without truncating.
 */
const OVERLONG_NARRATION =
  '这一句旁白故意写得远超十二秒的镜头时长，用来验证服务端在旁白溢出时的扩展策略：' +
  '它必须延长镜头以容纳完整语音，绝不截断、绝不跨镜头，也不会让字幕超出视频总时长。' +
  '同时它还要证明缓存键只由音色、语速与文本决定，重复运行不会再次调用语音合成服务。' +
  '这段文字会继续延长一点点，确保所需时长明显超过初始的十二秒整。';

const SPEECH_CONFIG: SpeechRuntimeConfig = {
  provider: 'deterministic_test',
  model: 'tone-v1',
  voiceZh: 'test-voice-zh',
  voiceEn: 'test-voice-en',
  license: DETERMINISTIC_TEST_LICENSE,
  timeoutMs: 10_000,
  maxRetries: 1,
};

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
  return createHash('sha256').update(readFileSync(file)).digest('hex');
}

function fileSizeLabel(file: string): string {
  const bytes = statSync(file).size;
  return bytes < 1024 ? `${bytes} B` : `${(bytes / 1024).toFixed(1)} KB`;
}

function readJson<T>(file: string): T {
  return JSON.parse(readFileSync(file, 'utf8')) as T;
}

// ── Media probing (the worker does its own; this is the independent check) ──

interface ProbeResult {
  codecName: string;
  width: number;
  height: number;
  fps: number;
  durationMs: number;
  audio: { codecName: string; sampleRate: number; channels: number; durationMs: number } | null;
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
      sample_rate?: string;
      channels?: number;
      duration?: string;
    }>;
    format?: { duration?: string };
  };
  const video = parsed.streams?.find((stream) => stream.codec_type === 'video');
  if (!video) throw new Error('ffprobe 没有找到视频流');
  const rate = video.avg_frame_rate ?? video.r_frame_rate ?? '0/1';
  const [numerator, denominator] = rate.split('/').map(Number);
  const durationMs = Math.round(Number(parsed.format?.duration ?? 0) * 1000);
  const audio = parsed.streams?.find((stream) => stream.codec_type === 'audio');
  return {
    codecName: video.codec_name ?? 'unknown',
    width: video.width ?? 0,
    height: video.height ?? 0,
    fps: denominator ? numerator / denominator : 0,
    durationMs,
    audio: audio
      ? {
          codecName: audio.codec_name ?? 'unknown',
          sampleRate: Number(audio.sample_rate ?? 0),
          channels: audio.channels ?? 0,
          durationMs: audio.duration ? Math.round(Number(audio.duration) * 1000) : durationMs,
        }
      : null,
  };
}

/**
 * `ffmpeg volumedetect` as an independent non-silence check. The worker also
 * runs this before registering; a file that is silent must never be exported
 * as narrated.
 */
function meanVolumeDb(file: string): number {
  const result = spawnSync(
    'ffmpeg',
    ['-v', 'info', '-nostats', '-i', file, '-map', '0:a:0', '-af', 'volumedetect', '-f', 'null', '-'],
    { encoding: 'utf8', windowsHide: true, maxBuffer: 16 * 1024 * 1024 },
  );
  if (result.status !== 0) throw new Error(`volumedetect 失败：${result.stderr}`);
  const match = result.stderr.match(/mean_volume:\s*(-?[\d.]+|-inf)\s*dB/i);
  if (!match) throw new Error('volumedetect 未返回 mean_volume');
  return match[1].toLowerCase() === '-inf' ? Number.NEGATIVE_INFINITY : Number(match[1]);
}

/** Independent SRT rules; a shared bug in the generator must not slip through. */
function validateSrt(content: string, totalDurationMs: number): string[] {
  const issues: string[] = [];
  const normalized = content.replace(/\r\n/g, '\n').trim();
  if (!normalized) return ['SRT 为空'];
  const timestamp = /^(\d{2}):(\d{2}):(\d{2}),(\d{3})$/;
  const parse = (value: string): number | null => {
    const match = timestamp.exec(value.trim());
    if (!match) return null;
    const [, hh, mm, ss, ms] = match.map(Number);
    if (mm > 59 || ss > 59 || ms > 999) return null;
    return ((hh * 60 + mm) * 60 + ss) * 1000 + ms;
  };
  let previousEnd = 0;
  normalized.split(/\n{2,}/).forEach((block, index) => {
    const lines = block.split('\n');
    const expected = index + 1;
    if (Number(lines[0]) !== expected) issues.push(`第 ${expected} 条序号错误：${lines[0]}`);
    const range = /^(.*?)\s*-->\s*(.*?)$/.exec(lines[1] ?? '');
    if (!range) {
      issues.push(`第 ${expected} 条缺少时间轴`);
      return;
    }
    const start = parse(range[1]);
    const end = parse(range[2]);
    if (start === null || end === null) {
      issues.push(`第 ${expected} 条时间码非法`);
      return;
    }
    if (start >= end) issues.push(`第 ${expected} 条起始时间不早于结束`);
    if (start < previousEnd) issues.push(`第 ${expected} 条与上一条重叠`);
    if (lines.slice(2).join('').trim() === '') issues.push(`第 ${expected} 条文本为空`);
    previousEnd = end;
  });
  if (previousEnd > totalDurationMs + 250) {
    issues.push(`末条字幕 ${previousEnd}ms 超出视频时长 ${totalDurationMs}ms（容差 250ms）`);
  }
  return issues;
}

// ── Workspace fixture ───────────────────────────────────────────────────────

function buildVideo(options: {
  id: string;
  title: string;
  stage: StudioSnapshot['videos'][number]['stage'];
  review?: StudioSnapshot['videos'][number]['review'];
}): StudioSnapshot['videos'][number] {
  return {
    id: options.id,
    projectId: 'proj_audio',
    title: options.title,
    mode: 'release_video',
    stage: options.stage,
    fps: 30,
    brief: {
      objective: '验证配音 + SRT + 导出交付包',
      audience: '工程团队',
      featureIds: [],
      durationSec: 12,
      aspect: '16:9',
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
        id: `${options.id}_scene_intro`,
        order: 0,
        revision: 1,
        title: '开场',
        intent: '验证旁白溢出时延长镜头而不是截断语音',
        narration: OVERLONG_NARRATION,
        caption: '旁白溢出验收',
        durationSec: 12,
        durationFrames: 360,
        visualType: 'title',
        visual: { type: 'title' },
        templateId: 'tpl_signal',
        claimIds: [],
        status: 'approved',
        look: 'cinematic',
        brightness: 1,
        vignette: true,
      },
      {
        id: `${options.id}_scene_outro`,
        order: 1,
        revision: 1,
        title: '收尾',
        intent: '一个短镜头，证明安静镜头不会被无故延长',
        narration: '收尾镜头保持原时长。',
        caption: '收尾',
        durationSec: 3,
        durationFrames: 90,
        visualType: 'title',
        visual: { type: 'title' },
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
    ...(options.review ? { review: options.review } : {}),
    createdAt: ISO,
    updatedAt: ISO,
    demo: true,
  };
}

function buildWorkspaceSnapshot(): StudioSnapshot {
  return {
    projects: [
      {
        id: 'proj_audio',
        name: 'Audio',
        productName: 'Audio',
        description: '配音与导出验收项目',
        website: 'https://audio.demo.invalid',
        stage: 'active',
        brand: {
          logoText: 'AUDIO',
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
      buildVideo({
        id: VIDEO_ID,
        title: '配音导出验收视频',
        stage: 'approved',
        review: { status: 'approved', note: 'AC-10 验收：批准导出', decidedAt: ISO },
      }),
      buildVideo({ id: UNAPPROVED_VIDEO_ID, title: '未审批视频', stage: 'review' }),
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
    await sleep(150);
  }
}

function isTerminal(status: string): boolean {
  return status === 'succeeded' || status === 'failed' || status === 'cancelled';
}

// ── Main ────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const startedAt = Date.now();
  const tempRoot = mkdtempSync(path.join(os.tmpdir(), 'asvs-audio-verify-'));
  const dbPath = path.join(tempRoot, 'audio.sqlite');
  const artifactDir = path.join(tempRoot, 'artifacts');
  process.stdout.write(`\n配音 / SRT / 导出真实验收（AC-10）\n${'─'.repeat(78)}\n`);
  process.stdout.write(`  数据库    ${dbPath}\n  产物目录  ${artifactDir}\n\n`);

  const snapshot = buildWorkspaceSnapshot();
  const db = openDatabase(dbPath);
  insertWorkspace(db, snapshot);
  const store = new SqliteOrchestrationStore(db);
  const exportStore = new ExportBundleStore(db);
  const speech = new SpeechService({
    port: createSpeechPort(SPEECH_CONFIG),
    cache: new SpeechCacheStore(db),
    audioRoot: speechAudioRoot(artifactDir),
  });
  const loadWorkspace = () => snapshot;

  try {
    const orchestrator = new Orchestrator({
      store,
      artifactDir,
      loadWorkspace,
      executor: new RenderProcessExecutor({}),
      speech,
      exportStore,
      // Step 5D made QA mandatory: without a runner every run would stop at
      // `qa_execution_failed`. The real runner over real ffmpeg media, with the
      // labelled deterministic OCR (this script proves AC-10, not OCR; the
      // AC-07 proof with real OCR is `pnpm qa:verify`).
      qaRunner: new IndependentQaRunner({
        config: loadQaConfig({ ...process.env, ASVS_QA_OCR_PROVIDER: 'deterministic_test' }),
        ocr: new DeterministicTestOcrAdapter(),
        logger: { warn: () => undefined },
      }),
      qaReportStore: new QaReportStore(db),
      instanceId: 'api_audio_verify',
      maxAttempts: 2,
      schedulerIntervalMs: 200,
    });
    await orchestrator.start();

    // ── 1. A full narrated run ─────────────────────────────────────────────
    const created = await orchestrator.createRun(WORKSPACE_ID, {
      videoId: VIDEO_ID,
      idempotencyKey: `audio-verify-${Date.now()}`,
      narration: { enabled: true, speed: 1, timingPolicy: 'extend_scene' },
    });
    record(
      '创建带旁白的运行（默认启用 TTS）',
      created.run.input.narration?.enabled === true,
      `run=${created.run.id} narration=${JSON.stringify(created.run.input.narration)}`,
    );

    const runId = created.run.id;
    const runDir = path.join(artifactDir, 'workspaces', WORKSPACE_ID, 'runs', runId);
    const finished = await waitFor(
      () => orchestrator.getRun(WORKSPACE_ID, runId),
      (detail) => detail !== null && isTerminal(detail.run.status),
      900_000,
      '带旁白的运行进入终态',
    );
    if (!finished || finished.run.status !== 'succeeded') {
      throw new Error(
        `运行未成功：${finished?.run.status ?? 'n/a'} ${finished?.run.failure?.code ?? ''} ${finished?.run.failure?.message ?? ''}`,
      );
    }
    // 5D widened the DAG to eleven steps. This script never requests capture, so
    // `plan_demo` / `capture_demo` / `qa_capture` must be `skipped` — not
    // failed, not silently absent — and every other step must have succeeded
    // (including `qa_final`, which always runs).
    const stepStatus = new Map(finished.run.steps.map((step) => [step.stepKey, step.status]));
    record(
      '十一个步骤全部到达终态（未请求录屏时三步 skipped，qa_final 仍执行）',
      finished.run.steps.length === 11 &&
        finished.run.steps.every(
          (step) =>
            step.status === 'succeeded' ||
            (CAPTURE_STEP_KEYS.includes(step.stepKey) && step.status === 'skipped'),
        ) &&
        CAPTURE_STEP_KEYS.every((key) => stepStatus.get(key) === 'skipped'),
      finished.run.steps.map((step) => `${step.stepKey}:${step.status}`).join(' · '),
    );

    // ── 2. Narration reconciliation ────────────────────────────────────────
    const narrationFile = path.join(runDir, 'narration.json');
    const narration = readJson<{
      clips: Array<{ sceneId: string; durationMs: number; synthetic: boolean; license: string }>;
      synthetic: boolean;
      cacheHits: number;
      providerCalls: number;
    }>(narrationFile);
    record(
      '旁白音频已持久化，且诚实标注 synthetic',
      existsSync(narrationFile) && narration.clips.length === 2 && narration.synthetic === true,
      `${narration.clips.length} 段 · synthetic=${narration.synthetic} · license=${narration.clips[0]?.license ?? '-'}`,
    );
    const introClip = narration.clips.find((clip) => clip.sceneId.endsWith('_scene_intro'));
    record(
      '长旁白超过初始 12s 镜头，触发 extend_scene 而非截断',
      Boolean(introClip && introClip.durationMs > 12_000),
      `intro clip=${introClip?.durationMs ?? 0}ms（镜头初始 12000ms）`,
    );

    const frozen = readJson<{ input: { storyboard: StoryboardV1; narration?: unknown } }>(
      path.join(runDir, 'input.json'),
    );
    const frozenIntro = frozen.input.storyboard.scenes.find((scene) => scene.id.endsWith('_scene_intro'));
    const frozenOutro = frozen.input.storyboard.scenes.find((scene) => scene.id.endsWith('_scene_outro'));
    record(
      '冻结 storyboard 只延长溢出镜头（intro > 360 帧，outro 保持 90 帧）',
      Boolean(frozenIntro && frozenIntro.durationFrames > 360) && frozenOutro?.durationFrames === 90,
      `intro=${frozenIntro?.durationFrames ?? 0} frames · outro=${frozenOutro?.durationFrames ?? 0} frames`,
    );

    // ── 3. SRT on disk ─────────────────────────────────────────────────────
    const srtFile = path.join(runDir, 'subtitles.srt');
    if (!existsSync(srtFile)) throw new Error('缺少 subtitles.srt');
    const srtContent = readFileSync(srtFile, 'utf8');
    const srtArtifact = finished.artifacts.find((artifact) => artifact.kind === 'subtitles_srt');
    record(
      'SRT 产物已登记，且 SHA256 与磁盘字节一致',
      Boolean(srtArtifact) && srtArtifact!.sha256 === sha256File(srtFile),
      `${srtArtifact?.metadata.cueCount ?? '?'} 条 · ${srtArtifact?.sha256.slice(0, 12) ?? '-'}…`,
    );

    // ── 4. MP4 + audio ─────────────────────────────────────────────────────
    const videoArtifact = finished.artifacts.find((artifact) => artifact.kind === 'video_mp4');
    const manifestArtifact = finished.artifacts.find((artifact) => artifact.kind === 'render_manifest');
    const receiptArtifact = finished.artifacts.find((artifact) => artifact.kind === 'artifact_receipt');
    if (!videoArtifact || !manifestArtifact || !receiptArtifact) throw new Error('产物登记不完整');
    const resolved = await orchestrator.resolveArtifactFile(WORKSPACE_ID, videoArtifact.id);
    if (!resolved) throw new Error('缺少 MP4 产物文件');
    const mp4Path = resolved.file;
    const outDir = path.dirname(mp4Path);
    const manifest = readJson<{
      output: { sha256: string; byteSize: number };
      ffprobe: {
        durationMs: number;
        audio?: { codecName: string; sampleRate: number; channels: number; durationMs: number; meanVolumeDb?: number };
      };
      narration?: { provider: string; voiceId: string; license: string; synthetic: boolean; timingPolicy: string };
      subtitles?: { fileName: string; sha256: string; cueCount: number };
    }>(path.join(outDir, 'manifest.json'));
    const receipt = readJson<{ sha256: string; byteSize: number }>(path.join(outDir, 'receipt.json'));

    const probe = runFfprobe(mp4Path);
    const volume = meanVolumeDb(mp4Path);
    record(
      'ffprobe：H.264 + AAC，视频与音频流都在',
      probe.codecName === 'h264' && probe.audio?.codecName === 'aac',
      `${probe.width}×${probe.height} · ${probe.codecName} + ${probe.audio?.codecName ?? 'none'} · ${probe.durationMs}ms`,
    );
    record(
      '音画时长一致（≤500ms）',
      Boolean(probe.audio) && Math.abs(probe.audio!.durationMs - probe.durationMs) <= 500,
      `audio=${probe.audio?.durationMs ?? '-'}ms video=${probe.durationMs}ms`,
    );
    record(
      '音轨非静音（volumedetect mean_volume > -90dB）',
      volume > -90,
      `mean_volume=${volume}dB · ${probe.audio?.sampleRate ?? 0}Hz · ${probe.audio?.channels ?? 0}ch`,
    );
    record(
      'MP4 SHA256 与 receipt / manifest / 登记行一致',
      sha256File(mp4Path) === receipt.sha256 &&
        sha256File(mp4Path) === manifest.output.sha256 &&
        sha256File(mp4Path) === videoArtifact.sha256,
      videoArtifact.sha256,
    );
    record(
      'manifest 记录 narration 溯源（许可、合成标注、timingPolicy）',
      manifest.narration?.license === DETERMINISTIC_TEST_LICENSE &&
        manifest.narration?.synthetic === true &&
        manifest.narration?.timingPolicy === 'extend_scene',
      `${manifest.narration?.provider ?? '-'}/${manifest.narration?.voiceId ?? '-'} · ${manifest.narration?.license ?? '-'}`,
    );

    const srtIssues = validateSrt(srtContent, probe.durationMs);
    record(
      'SRT 独立校验通过（序号连续、单调、无重叠、未超时长）',
      srtIssues.length === 0,
      srtIssues.length === 0 ? `${manifest.subtitles?.cueCount ?? 0} 条` : srtIssues.join('；'),
    );

    // ── 5. Cache: an identical second run makes zero provider calls ────────
    const second = await orchestrator.createRun(WORKSPACE_ID, {
      videoId: VIDEO_ID,
      idempotencyKey: `audio-verify-second-${Date.now()}`,
      narration: { enabled: true, speed: 1, timingPolicy: 'extend_scene' },
    });
    const secondFinished = await waitFor(
      () => orchestrator.getRun(WORKSPACE_ID, second.run.id),
      (detail) => detail !== null && isTerminal(detail.run.status),
      900_000,
      '第二次相同运行进入终态',
    );
    const secondNarration = readJson<{ cacheHits: number; providerCalls: number }>(
      path.join(artifactDir, 'workspaces', WORKSPACE_ID, 'runs', second.run.id, 'narration.json'),
    );
    record(
      '重复运行 100% 命中缓存：0 次外部合成调用',
      secondFinished?.run.status === 'succeeded' &&
        secondNarration.providerCalls === 0 &&
        secondNarration.cacheHits === 2,
      `providerCalls=${secondNarration.providerCalls} cacheHits=${secondNarration.cacheHits}`,
    );

    // ── 6. Gate 3 export ──────────────────────────────────────────────────
    let blocked: unknown = null;
    try {
      await orchestrator.createExportBundle(WORKSPACE_ID, { videoId: UNAPPROVED_VIDEO_ID });
    } catch (error) {
      blocked = error;
    }
    record(
      '未通过 Gate 3 的视频导出被拒绝（409 export_not_approved）',
      blocked instanceof OrchestrationHttpError &&
        blocked.httpStatus === 409 &&
        blocked.code === 'export_not_approved',
      blocked instanceof OrchestrationHttpError
        ? `${blocked.httpStatus} ${blocked.code}`
        : `非预期结果：${String(blocked)}`,
    );

    const bundle = exportBundleDetailV1Schema.parse(
      await orchestrator.createExportBundle(WORKSPACE_ID, {
        videoId: VIDEO_ID,
        runId,
        approvalNote: 'AC-10 验收导出',
      }),
    );
    // Step 5D added Gate 5: every bundle now carries the `qa_final` report, so
    // the honest expectation is five files, not four.
    record(
      'Gate 3 导出包已生成（MP4 + SRT + manifest + receipt + QA 报告）',
      bundle.files.length === 5 &&
        bundle.files.some((file) => file.kind === 'video_mp4') &&
        bundle.files.some((file) => file.kind === 'subtitles_srt') &&
        bundle.files.some((file) => file.kind === 'qa_report'),
      `${bundle.bundle.id} · ${bundle.files.length} 个文件 · ${bundle.files.map((file) => file.kind).join('/')}`,
    );
    record(
      '导出包绑定脚本版本与运行',
      bundle.bundle.runId === runId && bundle.bundle.scriptVersion === 1,
      `scriptVersion=${bundle.bundle.scriptVersion}`,
    );
    record(
      '导出包记录 audio/video 时长与旁白溯源',
      typeof bundle.videoDurationMs === 'number' &&
        typeof bundle.audioDurationMs === 'number' &&
        bundle.narration?.synthetic === true,
      `video=${bundle.videoDurationMs ?? '-'}ms audio=${bundle.audioDurationMs ?? '-'}ms · synthetic=${bundle.narration?.synthetic ?? '-'}`,
    );

    // ── 7. Download every file and verify the bytes ───────────────────────
    const downloadDir = path.join(tempRoot, 'downloads');
    mkdirSync(downloadDir, { recursive: true });
    const downloadReport: string[] = [];
    let downloadsOk = true;
    for (const file of bundle.files) {
      const resolvedFile = await orchestrator.resolveArtifactFile(WORKSPACE_ID, file.artifactId);
      if (!resolvedFile || !existsSync(resolvedFile.file)) {
        downloadsOk = false;
        downloadReport.push(`${file.kind}: 文件缺失`);
        continue;
      }
      const target = path.join(downloadDir, file.fileName);
      const bytes = readFileSync(resolvedFile.file);
      writeFileSync(target, bytes);
      const actual = createHash('sha256').update(bytes).digest('hex');
      const bytesOk = bytes.byteLength === file.byteSize && statSync(target).size === file.byteSize;
      const shaOk = actual === file.sha256;
      if (!bytesOk || !shaOk) downloadsOk = false;
      downloadReport.push(`${file.kind}:${shaOk && bytesOk ? 'ok' : 'mismatch'}`);
    }
    record(
      '下载的四个文件 SHA256 / 字节数与导出包一致',
      downloadsOk,
      downloadReport.join(' · '),
    );

    const downloadedMp4 = path.join(downloadDir, `${VIDEO_ID}.mp4`);
    const downloadedSrt = path.join(downloadDir, `${VIDEO_ID}.srt`);
    if (existsSync(downloadedMp4) && existsSync(downloadedSrt)) {
      const downloadProbe = runFfprobe(downloadedMp4);
      const downloadIssues = validateSrt(readFileSync(downloadedSrt, 'utf8'), downloadProbe.durationMs);
      record(
        '下载的 MP4 仍有音轨，下载的 SRT 仍通过独立校验',
        Boolean(downloadProbe.audio) && downloadIssues.length === 0,
        `${downloadProbe.codecName}+${downloadProbe.audio?.codecName ?? 'none'} · ${downloadProbe.durationMs}ms · srt issues=${downloadIssues.length}`,
      );
    } else {
      record('下载的 MP4 / SRT 可读', false, '文件不存在');
    }

    // ── 8. The record is queryable ────────────────────────────────────────
    const listed = await orchestrator.listExportBundles(WORKSPACE_ID, { videoId: VIDEO_ID });
    record(
      '导出包可通过 listExportBundles 查询到',
      listed.some((item) => item.bundle.id === bundle.bundle.id),
      `${listed.length} 个导出包`,
    );

    await orchestrator.stop();

    const durationMs = Date.now() - startedAt;
    const srtPreview = srtContent
      .split(/\n{2,}/)
      .slice(0, 3)
      .join('\n\n');
    process.stdout.write(`\nMP4：${mp4Path}\nSHA256：${videoArtifact.sha256}\n`);
    process.stdout.write(
      `ffprobe：${probe.width}×${probe.height} · ${probe.codecName} + ${probe.audio?.codecName ?? 'none'} · ${probe.durationMs}ms · mean ${volume.toFixed(1)}dB\n`,
    );
    process.stdout.write(`SRT：${fileSizeLabel(srtFile)} · ${srtArtifact?.metadata.cueCount ?? 0} 条\n\n`);
    process.stdout.write(`SRT 预览：\n${srtPreview}\n\n`);
    process.stdout.write(`导出包：${bundle.bundle.id}\n`);
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
    const exportDir = process.env.ASVS_VERIFY_EXPORT_DIR;
    if (exportDir) {
      // CI uploads this directory as the PR's audio evidence; a fresh run
      // replaces it so a stale MP4 can never be mistaken for this run's.
      rmSync(exportDir, { recursive: true, force: true });
      cpSync(tempRoot, exportDir, { recursive: true });
      process.stdout.write(`导出证据已复制：${exportDir}\n`);
    }
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
