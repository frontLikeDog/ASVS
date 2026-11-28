import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { DatabaseSync } from 'node:sqlite';
import type { CaptureJobInputV1, DemoStep, StudioSnapshot } from '@asvs/domain';
import type {
  CaptureJobExecutionResult,
  CaptureJobExecutorCallbacks,
  CaptureJobExecutorPort,
  QaRuntimeConfig,
  SpeechRuntimeConfig,
} from '@asvs/ports';
import { openDatabase } from '../db/database';
import { QaReportStore } from '../db/qa-report-store';
import { loadQaConfig } from '../config';
import { IndependentQaRunner } from '../qa/independent-qa-runner';
import { DeterministicTestOcrAdapter } from '../qa/ocr-adapters';
import { SqliteOrchestrationStore } from '../db/orchestration-store';
import { Orchestrator } from '../orchestration/orchestrator';
import { RenderProcessExecutor } from '../orchestration/render-process-executor';
import { CaptureProcessExecutor } from '../orchestration/capture-process-executor';
import { OrchestrationHttpError } from '../orchestration/errors';
import { SpeechService } from '../speech/speech-service';
import { SpeechCacheStore } from '../speech/speech-cache-store';
import { createSpeechPort, speechAudioRoot, DETERMINISTIC_TEST_LICENSE } from '../speech';

/**
 * `pnpm gate2:verify` — the Step 5C acceptance check (WP-14).
 *
 * Everything here is real: an `Orchestrator` over a throwaway SQLite file, the
 * real `CaptureProcessExecutor` spawning `workers/browser-worker` as a child
 * process, a real headless Chromium driving the **production build of
 * web-studio**, real ffmpeg transcoding, the deterministic test voice, and a
 * real Remotion render. Nothing is mocked, and every claim is re-checked
 * against the bytes on disk.
 *
 * What it proves, in order:
 *
 * 1. `plan_demo` produces a rule-driven draft with a digest and a risk
 *    summary, and the run parks at `awaiting_approval` with nothing captured.
 * 2. Approving without the digest (or with a stale one) is refused with 409
 *    and the run stays parked — a reviewer's stale tab cannot approve a plan
 *    they did not see.
 * 3. **API restart**: with the SQLite handle closed and reopened, a fresh
 *    Orchestrator sees the same `approvalId` and `planDigest`, so the gate
 *    survives a process restart rather than living in memory.
 * 4. **Layer 2 tampering**: editing the stored draft after approval makes the
 *    scheduler refuse with `capture_plan_tampered` — no Chromium, no receipt,
 *    no screenshots.
 * 5. **Layer 3 tampering**: rewriting `capture-job-input.json` between write
 *    and spawn makes the worker recompute a different digest and refuse before
 *    it launches a browser.
 * 6. **Happy path**: approve → real capture (all assertions pass) → the clip
 *    is backfilled into the frozen input (`mock: false` + SHA256) → real
 *    narration + SRT → real Remotion MP4 with a non-silent AAC track whose
 *    manifest binds the capture clip SHA256.
 * 7. **Failure evidence**: an assertion that cannot pass fails the run with
 *    `capture_assertion_failed`, registers failure-report / PNG screenshots /
 *    trace as artifacts, and never a receipt.
 * 8. **Zero regression**: a run that does not request capture has
 *    `plan_demo` / `capture_demo` recorded as `skipped` at creation.
 *
 * The `web_studio_tour` template is already exercised end-to-end by
 * `pnpm capture:demo` (Step 2); this script approves a two-landmark `custom`
 * plan against the dashboard so every extra failure mode stays attributable.
 */

const WORKSPACE_ID = 'ws_gate2_verify';
const ISO = '2026-11-28T10:00:00.000Z';
const BASE_URL = process.env.ASVS_CAPTURE_BASE_URL?.trim() || 'http://localhost:4200';
const CAPTURE_WIDTH = 1920;
const CAPTURE_HEIGHT = 1080;
const RENDER_WIDTH = 1280;
const RENDER_HEIGHT = 720;

const here = path.dirname(fileURLToPath(import.meta.url));
/** apps/api/src/scripts → repository root (also the orchestrator's media root). */
const repoRoot = path.resolve(here, '../../../..');

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

function readJson<T>(file: string): T {
  return JSON.parse(readFileSync(file, 'utf8')) as T;
}

function isTerminal(status: string): boolean {
  return status === 'succeeded' || status === 'failed' || status === 'cancelled';
}

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
    await sleep(250);
  }
}

// ── Media probing (independent of the worker's own checks) ──────────────────

interface ProbeResult {
  codecName: string;
  width: number;
  height: number;
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
      sample_rate?: string;
      channels?: number;
      duration?: string;
    }>;
    format?: { duration?: string };
  };
  const video = parsed.streams?.find((stream) => stream.codec_type === 'video');
  if (!video) throw new Error('ffprobe 没有找到视频流');
  const audio = parsed.streams?.find((stream) => stream.codec_type === 'audio');
  const durationMs = Math.round(Number(parsed.format?.duration ?? 0) * 1000);
  return {
    codecName: video.codec_name ?? 'unknown',
    width: video.width ?? 0,
    height: video.height ?? 0,
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

function meanVolumeDb(file: string): number {
  const result = spawnSync(
    'ffmpeg',
    ['-v', 'info', '-nostats', '-i', file, '-map', '0:a:0', '-af', 'volumedetect', '-f', 'null', '-'],
    { encoding: 'utf8', windowsHide: true, maxBuffer: 16 * 1024 * 1024 },
  );
  if (result.status !== 0) throw new Error(`volumedetect 失败：${result.stderr}`);
  const match = result.stderr.match(/mean_volume:\s*(-?[\d.]+|-inf)\s*dB/i);
  if (!match) throw new Error('volumedetect 未返回 mean_volume');
  return match[1]!.toLowerCase() === '-inf' ? Number.NEGATIVE_INFINITY : Number(match[1]);
}

/** Independent SRT validator: numbering, monotonicity, overlap, duration. */
function validateSrt(content: string, totalDurationMs: number): string[] {
  const issues: string[] = [];
  const normalized = content.replace(/\r\n/g, '\n').trim();
  if (!normalized) return ['SRT 为空'];
  const timestamp = /^(\d{2}):(\d{2}):(\d{2}),(\d{3})$/;
  const parse = (value: string): number | null => {
    const match = timestamp.exec(value.trim());
    if (!match) return null;
    const [, hh, mm, ss, ms] = match.map(Number);
    if (mm! > 59 || ss! > 59 || ms! > 999) return null;
    return ((hh! * 60 + mm!) * 60 + ss!) * 1000 + ms!;
  };
  let previousEnd = 0;
  normalized.split(/\n{2,}/).forEach((block, index) => {
    const lines = block.split('\n');
    if (Number(lines[0]) !== index + 1) issues.push(`第 ${index + 1} 条序号错误`);
    const range = /^(.*?)\s*-->\s*(.*?)$/.exec(lines[1] ?? '');
    if (!range) {
      issues.push(`第 ${index + 1} 条缺少时间轴`);
      return;
    }
    const start = parse(range[1]!);
    const end = parse(range[2]!);
    if (start === null || end === null) {
      issues.push(`第 ${index + 1} 条时间码非法`);
      return;
    }
    if (start >= end) issues.push(`第 ${index + 1} 条起始不早于结束`);
    if (start < previousEnd) issues.push(`第 ${index + 1} 条与上一条重叠`);
    previousEnd = end;
  });
  if (previousEnd > totalDurationMs + 250) {
    issues.push(`末条字幕 ${previousEnd}ms 超出视频 ${totalDurationMs}ms`);
  }
  return issues;
}

// ── Workspace fixture ───────────────────────────────────────────────────────

/**
 * The demo a real reviewer approves. It must *move*.
 *
 * Step 5D made `qa_capture` mandatory, and its `technical.freeze_frame` check
 * reads the captured clip with `freezedetect`: a demo that dwells on a static
 * dashboard for seconds records runs of identical frames and is blocked —
 * correctly, because that is what a stuck capture looks like (AC-07/technical
 * QA). The web-studio shell has no ambient animation, so the motion has to
 * come from genuine interaction: navigation mounts pages with a 220 ms
 * entrance, and the command palette / library filters repaint as the query
 * changes.
 *
 * The worker cuts the clip 800 ms after the first assertion and requires
 * ≥17 s of footage (`REAL_DEMO_SECONDS - 1`), so this tour visits the
 * dashboard, the command palette, the video library and the video workspace
 * with ~1 s per stop. Every stop is under `freezedetect`'s 3 s minimum, which
 * is the honest shape of a lively product tour rather than a recording that
 * simply happens to avoid the threshold.
 */
const DEMO_STEPS: DemoStep[] = [
  {
    id: 'dashboard-ready',
    action: 'assert',
    target: 'heading=把可信的产品事实，变成可审阅的视频。',
    assertion: { kind: 'visible', match: 'contains' },
    timeoutMs: 30_000,
    dwellMs: 1200,
    state: 'visible',
    description: '工作台首屏必须真实渲染出来',
  },
  {
    id: 'open-command-palette',
    action: 'click',
    target: 'role=button,name=搜索项目',
    timeoutMs: 20_000,
    dwellMs: 900,
    state: 'visible',
    description: '打开命令面板（真实快捷键入口）',
  },
  {
    id: 'type-palette-query-1',
    action: 'fill',
    target: 'placeholder=输入功能名',
    value: '视',
    timeoutMs: 20_000,
    dwellMs: 600,
    state: 'visible',
    description: '输入第一个字，面板立即重新过滤',
  },
  {
    id: 'type-palette-query-2',
    action: 'fill',
    target: 'placeholder=输入功能名',
    value: '视频',
    timeoutMs: 20_000,
    dwellMs: 800,
    state: 'visible',
    description: '补全关键词：结果集继续收敛',
  },
  {
    id: 'palette-filtered',
    action: 'assert',
    target: 'text=创建一个新视频',
    assertion: { kind: 'visible', match: 'contains' },
    timeoutMs: 20_000,
    dwellMs: 900,
    state: 'visible',
    description: '过滤后仍列出真实命令',
  },
  {
    id: 'dismiss-palette',
    action: 'press',
    target: 'placeholder=输入功能名',
    key: 'Escape',
    timeoutMs: 20_000,
    dwellMs: 700,
    state: 'visible',
    description: 'Esc 关闭面板',
  },
  {
    id: 'open-videos',
    action: 'click',
    target: 'role=link,name="视频工程"',
    timeoutMs: 20_000,
    dwellMs: 1100,
    state: 'visible',
    description: '点击侧边栏「视频工程」，演示真实导航而不是静态截图',
  },
  {
    id: 'videos-mounted',
    action: 'assert',
    target: 'heading=视频工程',
    assertion: { kind: 'visible', match: 'contains' },
    timeoutMs: 20_000,
    dwellMs: 1000,
    state: 'visible',
    description: '视频工程页真实挂载',
  },
  {
    id: 'search-library',
    action: 'fill',
    target: 'label=搜索视频',
    value: 'Lumen',
    timeoutMs: 20_000,
    dwellMs: 900,
    state: 'visible',
    description: '在视频库里搜索，列表随输入重新过滤',
  },
  {
    id: 'search-applied',
    action: 'assert',
    target: 'text=1 条结果',
    assertion: { kind: 'visible', match: 'contains' },
    timeoutMs: 20_000,
    dwellMs: 800,
    state: 'visible',
    description: '过滤结果数量真实更新为 1',
  },
  {
    id: 'clear-search',
    action: 'fill',
    target: 'label=搜索视频',
    value: '',
    timeoutMs: 20_000,
    dwellMs: 700,
    state: 'visible',
    description: '清空搜索，列表恢复',
  },
  {
    id: 'filter-review',
    action: 'click',
    target: 'role=button,name=待审核',
    timeoutMs: 20_000,
    dwellMs: 900,
    state: 'visible',
    description: '按「待审核」筛选视频库',
  },
  {
    id: 'review-filter-applied',
    action: 'assert',
    target: 'text=1 条结果',
    assertion: { kind: 'visible', match: 'contains' },
    timeoutMs: 20_000,
    dwellMs: 800,
    state: 'visible',
    description: '筛选后的结果数量真实更新',
  },
  {
    id: 'filter-all',
    action: 'click',
    target: 'role=button,name=全部',
    timeoutMs: 20_000,
    dwellMs: 800,
    state: 'visible',
    description: '恢复「全部」筛选',
  },
  {
    id: 'all-filter-applied',
    action: 'assert',
    target: 'text=2 条结果',
    assertion: { kind: 'visible', match: 'contains' },
    timeoutMs: 20_000,
    dwellMs: 800,
    state: 'visible',
    description: '两条视频重新出现',
  },
  {
    id: 'open-video',
    action: 'click',
    target: 'role=link,name="Lumen 2.8 · 让问题更快被看见"',
    timeoutMs: 20_000,
    dwellMs: 1200,
    state: 'visible',
    description: '打开真实的视频工程（进入审核页）',
  },
  {
    id: 'review-landing',
    action: 'assert',
    target: 'heading=审核与导出',
    assertion: { kind: 'visible', match: 'contains' },
    timeoutMs: 20_000,
    dwellMs: 1100,
    state: 'visible',
    description: '审核与导出页真实渲染',
  },
  {
    id: 'open-storyboard',
    action: 'click',
    target: 'role=link,name="分镜剧本"',
    timeoutMs: 20_000,
    dwellMs: 1100,
    state: 'visible',
    description: '在视频工作区内切换到分镜剧本',
  },
  {
    id: 'storyboard-ready',
    action: 'assert',
    target: 'heading=镜头序列',
    assertion: { kind: 'visible', match: 'contains' },
    timeoutMs: 20_000,
    dwellMs: 1100,
    state: 'visible',
    description: '分镜序列真实挂载',
  },
];

/** Reaches the page, then asserts something that cannot exist: failure evidence. */
const FAILING_STEPS: DemoStep[] = [
  {
    ...DEMO_STEPS[0]!,
    dwellMs: 0,
  },
  {
    id: 'impossible-assertion',
    action: 'assert',
    target: 'text=这段文案在页面上绝不存在',
    assertion: { kind: 'visible', match: 'contains' },
    timeoutMs: 4_000,
    dwellMs: 0,
    state: 'visible',
    description: '故意失败：验证失败证据（报告 / 截图 / trace）被登记',
  },
];

function buildVideo(options: { id: string; title: string }): StudioSnapshot['videos'][number] {
  return {
    id: options.id,
    projectId: 'proj_gate2',
    title: options.title,
    mode: 'release_video',
    stage: 'review',
    fps: 30,
    brief: {
      objective: '验证 Gate 2 审批与受控真实录屏',
      audience: '工程团队',
      featureIds: ['feat_gate2'],
      durationSec: 12,
      aspect: '16:9',
      language: 'zh-CN',
      tone: 'confident',
      style: 'editorial',
      templateId: 'tpl_signal',
      useRealCapture: true,
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
        intent: '一个短标题镜头',
        narration: '这是 Gate 2 真实录屏验收。',
        caption: 'Gate 2',
        durationSec: 2,
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
        id: `${options.id}_scene_demo`,
        order: 1,
        revision: 1,
        title: '真实界面',
        intent: '由已批准的 DemoPlan 录制的真实 web-studio',
        narration: '下面这段画面来自真实浏览器录制。',
        caption: '真实录屏',
        durationSec: 10,
        visualType: 'real_demo',
        visual: { type: 'real_demo' },
        templateId: 'tpl_signal',
        claimIds: ['claim_gate2'],
        featureId: 'feat_gate2',
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

const GATE_VIDEO_ID = 'vid_gate2_gate';
const DISK_VIDEO_ID = 'vid_gate2_disk';
const HAPPY_VIDEO_ID = 'vid_gate2_happy';
const FAILURE_VIDEO_ID = 'vid_gate2_failure';
const SILENT_VIDEO_ID = 'vid_gate2_silent';

function buildWorkspaceSnapshot(): StudioSnapshot {
  return {
    projects: [
      {
        id: 'proj_gate2',
        name: 'Gate2',
        productName: 'Gate2',
        description: 'Gate 2 验收项目',
        website: 'https://gate2.demo.invalid',
        stage: 'active',
        brand: {
          logoText: 'G2',
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
        id: 'feat_gate2',
        projectId: 'proj_gate2',
        name: '真实录屏',
        summary: '已批准的演示计划驱动真实浏览器',
        category: '演示',
        status: 'verified',
        confidence: 95,
        userConfirmed: true,
        sourceRefs: [],
        claimIds: ['claim_gate2'],
        prIds: [],
        demoRoute: '/videos',
        updatedAt: ISO,
        tags: [],
        demo: true,
      },
    ],
    claims: [
      {
        id: 'claim_gate2',
        projectId: 'proj_gate2',
        featureId: 'feat_gate2',
        statement: '只有全部 UI 断言通过，真实录屏才会进入成片。',
        audience: '工程团队',
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
      buildVideo({ id: GATE_VIDEO_ID, title: 'Gate 2 门禁与篡改验收' }),
      buildVideo({ id: DISK_VIDEO_ID, title: 'Gate 2 磁盘篡改验收' }),
      buildVideo({ id: HAPPY_VIDEO_ID, title: 'Gate 2 真实验收' }),
      buildVideo({ id: FAILURE_VIDEO_ID, title: 'Gate 2 失败证据' }),
      buildVideo({ id: SILENT_VIDEO_ID, title: 'Gate 2 零回归' }),
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

// ── Executors ───────────────────────────────────────────────────────────────

/**
 * Layer-3 adversary: rewrites the job file between the orchestrator's digest
 * check and the worker's own check, exactly as someone with disk access would.
 * `planDigest` and `approval.approvedPlanDigest` are left untouched, so the
 * only thing that can catch this is the worker recomputing the digest itself.
 */
class TamperingCaptureExecutor implements CaptureJobExecutorPort {
  constructor(private readonly inner: CaptureProcessExecutor) {}

  isRunning(): boolean {
    return this.inner.isRunning();
  }

  abort(): void {
    this.inner.abort();
  }

  async execute(
    job: CaptureJobInputV1,
    inputFile: string,
    outDir: string,
    checkpointFile: string,
    callbacks: CaptureJobExecutorCallbacks,
  ): Promise<CaptureJobExecutionResult> {
    const tampered = readJson<{ plan: { steps: unknown[] } } & Record<string, unknown>>(inputFile);
    // A schema-valid extra step: only the digest can reveal it.
    tampered.plan.steps = [
      ...tampered.plan.steps,
      {
        id: 'injected-step',
        action: 'click',
        target: 'role=link,name="注入"',
        timeoutMs: 1000,
        dwellMs: 0,
        state: 'visible',
      },
    ];
    writeFileSync(inputFile, `${JSON.stringify(tampered, null, 2)}\n`, 'utf8');
    return this.inner.execute(job, inputFile, outDir, checkpointFile, callbacks);
  }
}

// ── Orchestrator stack over one SQLite file ─────────────────────────────────

interface Stack {
  db: DatabaseSync;
  store: SqliteOrchestrationStore;
  orchestrator: Orchestrator;
}

interface StackOptions {
  artifactDir: string;
  snapshot: StudioSnapshot;
  captureExecutor?: CaptureJobExecutorPort;
}

/**
 * Opens a complete API-equivalent stack over `dbPath`. Calling this again
 * after closing the previous handle is the in-process analogue of restarting
 * the API process: nothing survives in memory except what SQLite persisted.
 */
function openStack(dbPath: string, options: StackOptions): Stack {
  const db = openDatabase(dbPath);
  const store = new SqliteOrchestrationStore(db);
  const speech = new SpeechService({
    port: createSpeechPort(SPEECH_CONFIG),
    cache: new SpeechCacheStore(db),
    audioRoot: speechAudioRoot(options.artifactDir),
  });
  const orchestrator = new Orchestrator({
    store,
    artifactDir: options.artifactDir,
    // Receipt refs are workspace-relative; the repo root is the media root.
    mediaRoot: repoRoot,
    loadWorkspace: () => options.snapshot,
    executor: new RenderProcessExecutor({}),
    captureExecutor: options.captureExecutor ?? new CaptureProcessExecutor({}),
    captureConfig: {
      enabled: true,
      allowedOrigins: [BASE_URL, BASE_URL.replace('localhost', '127.0.0.1')],
      defaultBaseUrl: BASE_URL,
      // The worker starts `vite preview` over the production build when the
      // target is down, so CI needs no separately managed dev server.
      allowAutoServe: true,
    },
    speech,
    // Step 5D made QA a mandatory step in the DAG: without a runner the run
    // stops at `qa_execution_failed`. This script proves the *capture* path, so
    // it uses the real runner over the real clip with the labelled
    // deterministic OCR — never a pass-by-default double. The full AC-07
    // privacy proof (real secrets, real ffmpeg) is `pnpm qa:verify`.
    qaRunner: new IndependentQaRunner({
      config: gate2QaConfig(),
      ocr: new DeterministicTestOcrAdapter(),
      logger: { warn: () => undefined },
    }),
    qaReportStore: new QaReportStore(db),
    instanceId: 'api_gate2_verify',
    maxAttempts: 1,
    schedulerIntervalMs: 150,
  });
  return { db, store, orchestrator };
}

/**
 * QA settings for the Gate 2 acceptance script.
 *
 * `deterministic_test` is the honest choice here: this machine may have no
 * Tesseract, and a real-OCR run would fail closed on the first captured
 * screenshot — turning a capture acceptance script red for an OCR reason it is
 * not testing. The provider is recorded as `synthetic` in every report, so
 * nothing downstream can mistake it for a real image scan.
 */
function gate2QaConfig(): QaRuntimeConfig {
  return loadQaConfig({ ...process.env, ASVS_QA_OCR_PROVIDER: 'deterministic_test' });
}

// ── Main ────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const startedAt = Date.now();
  // The artifact dir must live under the repo root: the browser worker writes
  // workspace-relative receipt refs, and the orchestrator only resolves refs
  // under the artifact dir or the media root (the repo).
  const distRoot = path.join(repoRoot, 'dist');
  mkdirSync(distRoot, { recursive: true });
  const tempRoot = mkdtempSync(path.join(distRoot, 'gate2-verify-'));
  const dbPath = path.join(tempRoot, 'gate2.sqlite');
  const artifactDir = path.join(tempRoot, 'artifacts');
  const webStudioDist = path.join(distRoot, 'apps/web-studio');

  process.stdout.write(`\nGate 2 真实录屏验收（WP-14）\n${'─'.repeat(78)}\n`);
  process.stdout.write(`  数据库    ${dbPath}\n  产物目录  ${artifactDir}\n  录屏目标  ${BASE_URL}\n\n`);

  if (!existsSync(path.join(webStudioDist, 'index.html'))) {
    process.stderr.write(
      `未找到 web-studio 构建产物：${webStudioDist}。请先运行 pnpm build 再执行 gate2:verify。\n`,
    );
    process.exitCode = 1;
    return;
  }

  const snapshot = buildWorkspaceSnapshot();
  let stack: Stack | null = openStack(dbPath, { artifactDir, snapshot });
  insertWorkspace(stack.db, snapshot);

  const runDirFor = (runId: string) =>
    path.join(artifactDir, 'workspaces', WORKSPACE_ID, 'runs', runId);

  try {
    // ── 1. plan_demo parks the run at Gate 2 ──────────────────────────────
    await stack.orchestrator.start();
    const gateRun = await stack.orchestrator.createRun(WORKSPACE_ID, {
      videoId: GATE_VIDEO_ID,
      idempotencyKey: `gate2-gate-${Date.now()}`,
      narration: { enabled: true, speed: 1, timingPolicy: 'extend_scene' },
      capture: { enabled: true, template: 'custom', customSteps: DEMO_STEPS, resetStrategy: 'fixture' },
      renderProfile: { width: RENDER_WIDTH, height: RENDER_HEIGHT },
    });
    const gateRunId = gateRun.run.id;
    const waiting = await waitFor(
      () => stack!.orchestrator.getRun(WORKSPACE_ID, gateRunId),
      (detail) => detail?.run.status === 'awaiting_approval',
      120_000,
      '运行进入 awaiting_approval',
    );
    const parked = waiting!.run;
    record(
      'plan_demo 生成规则驱动的计划并挂起 Gate 2',
      Boolean(parked.demoPlan) &&
        Boolean(parked.approval) &&
        parked.approval!.status === 'pending' &&
        parked.approval!.gateType === 'gate2_demo_capture' &&
        parked.demoPlan!.planDigest.length === 64 &&
        parked.demoPlan!.risk.assertionCount >= 1,
      `plan=${parked.demoPlan?.planId ?? '-'} digest=${parked.demoPlan?.planDigest.slice(0, 12) ?? '-'}… 断言=${parked.demoPlan?.risk.assertionCount ?? 0} 风险=${parked.demoPlan?.risk.level ?? '-'}`,
    );
    const captureStep = parked.steps.find((step) => step.stepKey === 'capture_demo');
    record(
      '挂起期间 plan_demo 已完成、capture_demo 未执行、没有任何录屏文件',
      parked.steps.find((step) => step.stepKey === 'plan_demo')?.status === 'succeeded' &&
        captureStep?.status !== 'running' &&
        captureStep?.status !== 'succeeded' &&
        !existsSync(path.join(runDirFor(gateRunId), 'capture')),
      `${parked.steps.map((step) => `${step.stepKey}:${step.status}`).join(' · ')}`,
    );

    // ── 2. Approval requires the digest the reviewer saw ──────────────────
    let missing: unknown = null;
    try {
      await stack.orchestrator.approveRun(WORKSPACE_ID, gateRunId, {
        approvalId: parked.approval!.approvalId,
      });
    } catch (error) {
      missing = error;
    }
    record(
      '审批缺少 subjectDigest 返回 409 approval_subject_missing',
      missing instanceof OrchestrationHttpError &&
        missing.httpStatus === 409 &&
        missing.code === 'approval_subject_missing',
      missing instanceof OrchestrationHttpError ? `${missing.httpStatus} ${missing.code}` : '未被拒绝',
    );
    let stale: unknown = null;
    try {
      await stack.orchestrator.approveRun(WORKSPACE_ID, gateRunId, {
        approvalId: parked.approval!.approvalId,
        subjectDigest: 'a'.repeat(64),
      });
    } catch (error) {
      stale = error;
    }
    const afterRejections = await stack.orchestrator.getRun(WORKSPACE_ID, gateRunId);
    record(
      '过期摘要返回 409 approval_subject_mismatch，运行仍停在 Gate 2',
      stale instanceof OrchestrationHttpError &&
        stale.httpStatus === 409 &&
        stale.code === 'approval_subject_mismatch' &&
        afterRejections?.run.status === 'awaiting_approval' &&
        afterRejections.run.approval?.status === 'pending',
      stale instanceof OrchestrationHttpError ? `${stale.httpStatus} ${stale.code}` : '未被拒绝',
    );

    // ── 3. API restart keeps the same approval binding ────────────────────
    await stack.orchestrator.stop();
    stack.db.close();
    stack = openStack(dbPath, { artifactDir, snapshot });
    const afterRestart = await stack.orchestrator.getRun(WORKSPACE_ID, gateRunId);
    record(
      'API 重启后仍停在 awaiting_approval，approvalId 与 planDigest 不变',
      afterRestart?.run.status === 'awaiting_approval' &&
        afterRestart.run.approval?.approvalId === parked.approval!.approvalId &&
        afterRestart.run.approval?.status === 'pending' &&
        afterRestart.run.demoPlan?.planDigest === parked.demoPlan!.planDigest,
      `approval=${afterRestart?.run.approval?.approvalId ?? '-'} digest=${afterRestart?.run.demoPlan?.planDigest.slice(0, 12) ?? '-'}…`,
    );

    // ── 4. Layer 2: edit the stored draft after approval ──────────────────
    // Approve while the scheduler is stopped so the tamper lands before the
    // capture step runs; then reopen the DB and start a fresh orchestrator to
    // show the refusal comes from persisted state, not in-memory bookkeeping.
    await stack.orchestrator.approveRun(WORKSPACE_ID, gateRunId, {
      approvalId: parked.approval!.approvalId,
      subjectDigest: parked.demoPlan!.planDigest,
      note: 'Gate 2 验收：批准后篡改',
    });
    const approvedRow = stack.store.getRun(gateRunId)!;
    stack.store.updateRun({
      ...approvedRow,
      demoPlan: {
        ...approvedRow.demoPlan!,
        draft: {
          ...approvedRow.demoPlan!.draft,
          steps: approvedRow.demoPlan!.draft.steps.slice(0, -1),
        },
      },
    });
    stack.db.close();
    stack = openStack(dbPath, { artifactDir, snapshot });
    await stack.orchestrator.start();
    const tamperedRun = await waitFor(
      () => stack!.orchestrator.getRun(WORKSPACE_ID, gateRunId),
      (detail) => detail !== null && isTerminal(detail.run.status),
      120_000,
      '篡改计划后的运行进入终态',
    );
    const tamperedKinds = tamperedRun!.artifacts.map((artifact) => artifact.kind);
    record(
      '（第 2 层）审批后修改计划 → capture_plan_tampered，且从未启动 Chromium',
      tamperedRun!.run.status === 'failed' &&
        tamperedRun!.run.failure?.code === 'capture_plan_tampered' &&
        !tamperedKinds.includes('capture_receipt') &&
        !tamperedKinds.includes('capture_clip') &&
        !existsSync(path.join(runDirFor(gateRunId), 'capture', 'screenshots')),
      `${tamperedRun!.run.status} ${tamperedRun!.run.failure?.code ?? ''} · artifacts=${tamperedKinds.join(',') || '无'}`,
    );
    await stack.orchestrator.stop();

    // ── 5. Layer 3: tamper with capture-job-input.json on disk ────────────
    stack.db.close();
    stack = openStack(dbPath, {
      artifactDir,
      snapshot,
      captureExecutor: new TamperingCaptureExecutor(new CaptureProcessExecutor({})),
    });
    await stack.orchestrator.start();
    const diskRun = await stack.orchestrator.createRun(WORKSPACE_ID, {
      videoId: DISK_VIDEO_ID,
      idempotencyKey: `gate2-disk-${Date.now()}`,
      narration: { enabled: false },
      capture: { enabled: true, template: 'custom', customSteps: DEMO_STEPS },
      renderProfile: { width: RENDER_WIDTH, height: RENDER_HEIGHT },
    });
    const diskRunId = diskRun.run.id;
    const diskWaiting = await waitFor(
      () => stack!.orchestrator.getRun(WORKSPACE_ID, diskRunId),
      (detail) => detail?.run.status === 'awaiting_approval',
      120_000,
      '磁盘篡改用例进入 awaiting_approval',
    );
    await stack.orchestrator.approveRun(WORKSPACE_ID, diskRunId, {
      approvalId: diskWaiting!.run.approval!.approvalId,
      subjectDigest: diskWaiting!.run.demoPlan!.planDigest,
    });
    const diskFinished = await waitFor(
      () => stack!.orchestrator.getRun(WORKSPACE_ID, diskRunId),
      (detail) => detail !== null && isTerminal(detail.run.status),
      180_000,
      '磁盘篡改运行进入终态',
    );
    const diskKinds = diskFinished!.artifacts.map((artifact) => artifact.kind);
    record(
      '（第 3 层）worker 复算摘要不一致 → capture_plan_tampered，零浏览器启动、无回执',
      diskFinished!.run.status === 'failed' &&
        diskFinished!.run.failure?.code === 'capture_plan_tampered' &&
        !diskKinds.includes('capture_receipt') &&
        !diskKinds.includes('capture_clip') &&
        !existsSync(path.join(runDirFor(diskRunId), 'capture', 'screenshots')),
      `${diskFinished!.run.status} ${diskFinished!.run.failure?.code ?? ''} · ${(diskFinished!.run.failure?.message ?? '').slice(0, 60)}`,
    );
    await stack.orchestrator.stop();

    // ── 6. Happy path: real capture → backfill → narrated render ──────────
    stack.db.close();
    stack = openStack(dbPath, { artifactDir, snapshot });
    await stack.orchestrator.start();
    const happy = await stack.orchestrator.createRun(WORKSPACE_ID, {
      videoId: HAPPY_VIDEO_ID,
      idempotencyKey: `gate2-happy-${Date.now()}`,
      narration: { enabled: true, speed: 1, timingPolicy: 'extend_scene' },
      capture: {
        enabled: true,
        template: 'custom',
        customSteps: DEMO_STEPS,
        resetStrategy: 'fixture',
        viewport: { width: CAPTURE_WIDTH, height: CAPTURE_HEIGHT },
      },
      renderProfile: { width: RENDER_WIDTH, height: RENDER_HEIGHT },
    });
    const happyId = happy.run.id;
    const happyWaiting = await waitFor(
      () => stack!.orchestrator.getRun(WORKSPACE_ID, happyId),
      (detail) => detail?.run.status === 'awaiting_approval',
      120_000,
      '成功用例进入 awaiting_approval',
    );
    await stack.orchestrator.approveRun(WORKSPACE_ID, happyId, {
      approvalId: happyWaiting!.run.approval!.approvalId,
      subjectDigest: happyWaiting!.run.demoPlan!.planDigest,
      note: 'Gate 2 验收：真实录屏',
    });
    const happyDone = await waitFor(
      () => stack!.orchestrator.getRun(WORKSPACE_ID, happyId),
      (detail) => detail !== null && isTerminal(detail.run.status),
      25 * 60_000,
      '真实录屏 + 旁白 + 渲染进入终态',
    );
    if (happyDone!.run.status !== 'succeeded') {
      record(
        '真实录屏 + 旁白 + 渲染完整成功',
        false,
        `${happyDone!.run.status} ${happyDone!.run.failure?.code ?? ''} ${happyDone!.run.failure?.message ?? ''}`,
      );
    } else {
      const runDir = runDirFor(happyId);
      const frozen = readJson<{
        input: { assets: Array<Record<string, unknown>> };
        digest: string;
        capture?: {
          planDigest: string;
          clipSha256: string;
          assertions: { total: number; passed: number };
        };
      }>(path.join(runDir, 'input.json'));
      const receiptFile = path.join(runDir, 'capture', 'capture-receipt.json');
      const receipt = existsSync(receiptFile)
        ? readJson<{
            assertions: { total: number; passed: number; failed: number };
            clip: { sha256: string; durationMs: number };
            planDigest: string;
          }>(receiptFile)
        : null;
      const clipArtifact = happyDone!.artifacts.find((artifact) => artifact.kind === 'capture_clip');
      const receiptArtifact = happyDone!.artifacts.find(
        (artifact) => artifact.kind === 'capture_receipt',
      );
      const realAsset = frozen.input.assets.find((asset) => asset.mock === false) as
        | { id: string; mock: boolean; media?: { sha256: string; sourceFile: string } }
        | undefined;
      record(
        '真实录屏通过全部 UI 断言并写回执',
        receipt !== null &&
          receipt.assertions.failed === 0 &&
          receipt.assertions.passed === receipt.assertions.total &&
          receipt.assertions.total >= 3 &&
          receipt.planDigest === happyWaiting!.run.demoPlan!.planDigest,
        receipt
          ? `${receipt.assertions.passed}/${receipt.assertions.total} 断言 · clip ${receipt.clip.sha256.slice(0, 12)}…`
          : '缺少 capture-receipt.json',
      );
      const receiptSha = receipt?.clip.sha256 ?? null;
      const assetSha = realAsset?.media?.sha256 ?? null;
      const frozenSha = frozen.capture?.clipSha256 ?? null;
      const runSha = happyDone!.run.input.capture?.clipSha256 ?? null;
      record(
        '真实片段回填进冻结渲染输入（mock: false + SHA256）',
        Boolean(realAsset) &&
          assetSha === receiptSha &&
          frozenSha === receiptSha &&
          runSha === receiptSha &&
          happyDone!.run.input.usingPlaceholder === false,
        `asset=${realAsset?.id ?? '-'} mock=${String(realAsset?.mock)} ` +
          `receipt=${receiptSha?.slice(0, 12) ?? '-'} asset.media=${assetSha?.slice(0, 12) ?? '-'} ` +
          `input.capture=${frozenSha?.slice(0, 12) ?? '-'} run.capture=${runSha?.slice(0, 12) ?? '-'} ` +
          `placeholder=${String(happyDone!.run.input.usingPlaceholder)}`,
      );
      record(
        'capture_clip / capture_receipt / 截图 已登记为可下载产物',
        Boolean(clipArtifact) &&
          Boolean(receiptArtifact) &&
          happyDone!.artifacts.some((artifact) => artifact.kind === 'capture_screenshot'),
        happyDone!.artifacts
          .filter((artifact) => artifact.kind.startsWith('capture_'))
          .map((artifact) => artifact.kind)
          .join(' · '),
      );

      const mp4Artifact = happyDone!.artifacts.find((artifact) => artifact.kind === 'video_mp4');
      const srtArtifact = happyDone!.artifacts.find((artifact) => artifact.kind === 'subtitles_srt');
      const manifestArtifact = happyDone!.artifacts.find(
        (artifact) => artifact.kind === 'render_manifest',
      );
      if (!mp4Artifact || !srtArtifact || !manifestArtifact) {
        throw new Error('成片产物登记不完整（缺少 MP4 / SRT / manifest）');
      }
      const resolvedMp4 = await stack.orchestrator.resolveArtifactFile(WORKSPACE_ID, mp4Artifact.id);
      if (!resolvedMp4) throw new Error('缺少 MP4 文件');
      const probe = runFfprobe(resolvedMp4.file);
      const volume = meanVolumeDb(resolvedMp4.file);
      record(
        '成片为 16:9 H.264 + AAC，且有非静音旁白',
        probe.codecName === 'h264' &&
          probe.audio?.codecName === 'aac' &&
          probe.width === RENDER_WIDTH &&
          probe.height === RENDER_HEIGHT &&
          volume > -90,
        `${probe.width}×${probe.height} · ${probe.codecName}+${probe.audio?.codecName ?? 'none'} · ${probe.durationMs}ms · mean ${volume.toFixed(1)}dB`,
      );

      const manifest = readJson<{
        assetHashes: Array<{ mock: boolean; mediaSha256?: string }>;
        narration?: {
          synthetic: boolean;
          license: string;
          voiceId: string;
          timingPolicy: string;
        };
      }>(path.join(path.dirname(resolvedMp4.file), 'manifest.json'));
      const realHash = manifest.assetHashes.find((entry) => entry.mock === false);
      record(
        'manifest 记录真实素材哈希，与录屏回执逐字节一致',
        realHash?.mediaSha256 === receipt?.clip.sha256,
        `${realHash?.mediaSha256?.slice(0, 12) ?? '-'}… vs ${receipt?.clip.sha256.slice(0, 12) ?? '-'}…`,
      );
      record(
        'manifest 诚实标注合成音轨（确定性的测试音色）',
        manifest.narration?.synthetic === true &&
          manifest.narration?.license === DETERMINISTIC_TEST_LICENSE,
        `${manifest.narration?.license ?? '-'} · ${manifest.narration?.voiceId ?? '-'}`,
      );

      const srtFile = path.join(runDir, 'subtitles.srt');
      const srtIssues = existsSync(srtFile)
        ? validateSrt(readFileSync(srtFile, 'utf8'), probe.durationMs)
        : ['缺少 subtitles.srt'];
      record(
        'SRT 独立校验通过且与成片时长匹配',
        srtIssues.length === 0,
        srtIssues.length === 0
          ? `${String(srtArtifact.metadata.cueCount ?? '?')} 条`
          : srtIssues.join('；'),
      );

      const clipResolved = await stack.orchestrator.resolveArtifactFile(
        WORKSPACE_ID,
        clipArtifact!.id,
      );
      record(
        '录屏片段下载与回执 SHA256 一致',
        Boolean(clipResolved) && sha256File(clipResolved!.file) === receipt?.clip.sha256,
        clipArtifact?.sha256.slice(0, 12) ?? '-',
      );
    }
    await stack.orchestrator.stop();

    // ── 7. Failure evidence ───────────────────────────────────────────────
    stack.db.close();
    stack = openStack(dbPath, { artifactDir, snapshot });
    await stack.orchestrator.start();
    const failing = await stack.orchestrator.createRun(WORKSPACE_ID, {
      videoId: FAILURE_VIDEO_ID,
      idempotencyKey: `gate2-fail-${Date.now()}`,
      narration: { enabled: false },
      capture: {
        enabled: true,
        template: 'custom',
        customSteps: FAILING_STEPS,
        viewport: { width: CAPTURE_WIDTH, height: CAPTURE_HEIGHT },
      },
      renderProfile: { width: RENDER_WIDTH, height: RENDER_HEIGHT },
    });
    const failId = failing.run.id;
    const failWaiting = await waitFor(
      () => stack!.orchestrator.getRun(WORKSPACE_ID, failId),
      (detail) => detail?.run.status === 'awaiting_approval',
      120_000,
      '失败用例进入 awaiting_approval',
    );
    await stack.orchestrator.approveRun(WORKSPACE_ID, failId, {
      approvalId: failWaiting!.run.approval!.approvalId,
      subjectDigest: failWaiting!.run.demoPlan!.planDigest,
    });
    const failDone = await waitFor(
      () => stack!.orchestrator.getRun(WORKSPACE_ID, failId),
      (detail) => detail !== null && isTerminal(detail.run.status),
      10 * 60_000,
      '断言失败运行进入终态',
    );
    const failKinds = failDone!.artifacts.map((artifact) => artifact.kind);
    const failureDir = path.join(runDirFor(failId), 'capture');
    const screenshotFiles = existsSync(path.join(failureDir, 'screenshots'))
      ? readdirSync(path.join(failureDir, 'screenshots')).filter((name) => name.endsWith('.png'))
      : [];
    record(
      '断言失败 → capture_assertion_failed，且绝不伪造回执',
      failDone!.run.status === 'failed' &&
        failDone!.run.failure?.code === 'capture_assertion_failed' &&
        !failKinds.includes('capture_receipt') &&
        !failKinds.includes('capture_clip'),
      `${failDone!.run.status} ${failDone!.run.failure?.code ?? ''}`,
    );
    record(
      '失败证据已登记：failure-report.json + PNG 截图 + trace.zip',
      failKinds.includes('capture_failure_report') &&
        failKinds.includes('capture_screenshot') &&
        failKinds.includes('capture_trace') &&
        screenshotFiles.length > 0,
      `${failKinds.filter((kind) => kind.startsWith('capture_')).join(' · ')} · 截图 ${screenshotFiles.length} 张`,
    );
    record(
      '运行携带结构化 captureFailure，供 Web 证据面板展示',
      failDone!.run.captureFailure?.code === 'capture_assertion_failed' &&
        failDone!.run.captureFailure.assertionFailures >= 1 &&
        failDone!.run.captureFailure.screenshotArtifactIds.length > 0,
      `code=${failDone!.run.captureFailure?.code ?? '-'} 失败断言=${failDone!.run.captureFailure?.assertionFailures ?? 0} 截图=${failDone!.run.captureFailure?.screenshotArtifactIds.length ?? 0}`,
    );
    await stack.orchestrator.stop();

    // ── 8. Zero regression: no capture request still skips the capture steps ─
    // The scheduler is deliberately *not* started: the contract under test is
    // what `createRun` persists, so launching a full Remotion render here
    // would only add minutes and a child process to shut down.
    stack.db.close();
    stack = openStack(dbPath, { artifactDir, snapshot });
    const silent = await stack.orchestrator.createRun(WORKSPACE_ID, {
      videoId: SILENT_VIDEO_ID,
      idempotencyKey: `gate2-off-${Date.now()}`,
      narration: { enabled: false },
      renderProfile: { width: RENDER_WIDTH, height: RENDER_HEIGHT },
    });
    const skipped = silent.run.steps
      .filter((step) => step.status === 'skipped')
      .map((step) => step.stepKey);
    record(
      '未请求录屏时 plan_demo / capture_demo / qa_capture 在创建时即标记 skipped（5A/5B 零回归）',
      skipped.includes('plan_demo') &&
        skipped.includes('capture_demo') &&
        skipped.includes('qa_capture') &&
        silent.run.input.capture?.enabled === false,
      `skipped=${skipped.join(',')} capture.enabled=${String(silent.run.input.capture?.enabled)}`,
    );

    const elapsed = ((Date.now() - startedAt) / 1000).toFixed(1);
    process.stdout.write(`\n用时：${elapsed}s\n`);
    const failed = reports.filter((report) => !report.ok);
    if (failed.length > 0) {
      process.stderr.write(`\n验收失败：${failed.length} 项未通过\n`);
      for (const check of failed) process.stderr.write(`  ✗ ${check.name} — ${check.detail}\n`);
      process.exitCode = 1;
      return;
    }
    process.stdout.write(`全部 ${reports.length} 项验收通过。\n`);
  } finally {
    if (stack) {
      const current: Stack = stack;
      stack = null;
      await current.orchestrator.stop();
      current.db.close();
    }
    const exportDir = process.env.ASVS_VERIFY_CAPTURE_DIR?.trim();
    if (exportDir) {
      const target = path.resolve(exportDir);
      rmSync(target, { recursive: true, force: true });
      cpSync(tempRoot, target, { recursive: true });
      process.stdout.write(`验收证据已复制：${target}\n`);
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
