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
  statSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { deflateRawSync } from 'node:zlib';
import type { DatabaseSync } from 'node:sqlite';
import {
  captureReceiptV1Schema,
  type CaptureJobInputV1,
  type CaptureJobResultV1,
  type OrchestrationArtifactV1,
  type StudioSnapshot,
} from '@asvs/domain';
import type {
  CaptureJobExecutionResult,
  CaptureJobExecutorCallbacks,
  CaptureJobExecutorPort,
  QaRuntimeConfig,
  RenderJobExecutionResult,
  RenderJobExecutorCallbacks,
  RenderJobExecutorPort,
  SpeechRuntimeConfig,
} from '@asvs/ports';
import { loadQaConfig } from '../config';
import { openDatabase } from '../db/database';
import { ExportBundleStore } from '../db/export-bundle-store';
import { QaReportStore } from '../db/qa-report-store';
import { SqliteOrchestrationStore } from '../db/orchestration-store';
import { OrchestrationHttpError } from '../orchestration/errors';
import { Orchestrator } from '../orchestration/orchestrator';
import { IndependentQaRunner } from '../qa/independent-qa-runner';
import {
  DeterministicTestOcrAdapter,
  TesseractCliOcrAdapter,
  UnconfiguredOcrAdapter,
} from '../qa/ocr-adapters';
import {
  DETERMINISTIC_TEST_LICENSE,
  DeterministicTestSpeechAdapter,
  SpeechCacheStore,
  SpeechService,
} from '../speech';

/**
 * `pnpm qa:verify` — the Step 5D acceptance check (WP-16 / AC-07).
 *
 * Real here: a real `Orchestrator` over a throwaway SQLite file, the production
 * `IndependentQaRunner`, real `ffmpeg`/`ffprobe` (decode, `blackdetect`,
 * `freezedetect`, `volumedetect`, frame extraction), a structurally valid
 * Playwright `trace.zip` inflated by our own ZIP reader, PNG `tEXt` chunks
 * carrying real secrets, real SHA256 checks on every byte a report claims, and
 * real `boxblur` redaction of the evidence frame AC-07 demands.
 *
 * Doubles here: the render worker and the browser worker, because they need
 * Chromium + Remotion (proven by `render:fixture`, `gate2:verify`,
 * `export:verify`). Unlike the unit-test doubles these write **genuinely
 * ffmpeg-encoded media**, so QA reads real video (docs/16 red line 4).
 *
 * OCR: `#8`/`#9` need a real Tesseract binary. Without one this script runs the
 * whole orchestration with the labelled `deterministic_test` OCR provider —
 * which never claims to have read pixels — and prints those two assertions as
 * **SKIPPED with the reason**, never as a pass. The fail-closed path (`#14`)
 * and every text/PNG-chunk/trace scan are still proven with real bytes.
 */

const WORKSPACE_ID = 'ws_qa_verify';
const PROJECT_ID = 'proj_qa_verify';
const ISO = '2026-11-28T10:00:00.000Z';
const BASE_URL = 'http://localhost:4200';

// One video per scenario, so one run's artifacts can never satisfy another
// scenario's assertion.
const VIDEO_CLEAN = 'vid_qa_clean';
const VIDEO_TRACE = 'vid_qa_trace';
const VIDEO_SUBTITLE = 'vid_qa_subtitle';
const VIDEO_BLACK = 'vid_qa_black';
const VIDEO_FREEZE = 'vid_qa_freeze';
const VIDEO_UNCONFIGURED = 'vid_qa_unconfigured';
const VIDEO_SILENT = 'vid_qa_silent';
const VIDEO_OCR = 'vid_qa_ocr';

/** Synthetic secrets. Assertions #5/#7 require these never leave the scanner. */
const SECRET_EMAIL = 'alice.secret@corp.internal';
const SECRET_TOKEN = 'ghp_QaVerifyFakeToken012345678901234567';
const SECRET_JWT =
  `${Buffer.from('{"alg":"HS256","typ":"JWT"}').toString('base64url')}` +
  `.${Buffer.from('{"sub":"qa-verify","role":"admin"}').toString('base64url')}` +
  '.qaVerifySignature';
const SECRET_BEARER = `Bearer ${SECRET_JWT}`;

const here = path.dirname(fileURLToPath(import.meta.url));
/** `apps/api/src/scripts` → repository root; the orchestrator's media root. */
const repoRoot = path.resolve(here, '../../../..');

const SPEECH_CONFIG: SpeechRuntimeConfig = {
  provider: 'deterministic_test',
  model: 'tone-v1',
  voiceZh: 'test-voice-zh',
  voiceEn: 'test-voice-en',
  license: DETERMINISTIC_TEST_LICENSE,
  timeoutMs: 15_000,
  maxRetries: 1,
};

// ── OCR availability, decided before anything else ─────────────────────────

const explicitProvider = process.env.ASVS_QA_OCR_PROVIDER?.trim();

/** `true` only when a real Tesseract binary actually answers `--version`. */
const hasTesseract = ((): boolean => {
  if (explicitProvider === 'deterministic_test' || explicitProvider === 'unconfigured') return false;
  const bin = process.env.ASVS_QA_TESSERACT_BIN?.trim() || 'tesseract';
  if (path.isAbsolute(bin)) return existsSync(bin);
  const probe = spawnSync(bin, ['--version'], {
    encoding: 'utf8',
    windowsHide: true,
    timeout: 15_000,
  });
  return probe.status === 0;
})();

/**
 * Real OCR when it exists, otherwise the *labelled* deterministic provider. It
 * is never presented as having read pixels: its reports carry
 * `coverage.ocrSynthetic = true` and #8/#9 are skipped below.
 */
const BASE_QA_CONFIG: QaRuntimeConfig = loadQaConfig({
  ...process.env,
  ASVS_QA_OCR_PROVIDER: hasTesseract ? 'tesseract_cli' : 'deterministic_test',
});

// ── Reporting ───────────────────────────────────────────────────────────────

type Status = 'pass' | 'fail' | 'skip';

interface StepReport {
  id: number;
  name: string;
  status: Status;
  detail: string;
}

const reports: StepReport[] = [];

function record(id: number, name: string, ok: boolean, detail: string): void {
  reports.push({ id, name, status: ok ? 'pass' : 'fail', detail });
  process.stdout.write(`  ${ok ? '✓' : '✗'} #${id} ${name} — ${detail}\n`);
}

function skip(id: number, name: string, detail: string): void {
  reports.push({ id, name, status: 'skip', detail });
  process.stdout.write(`  ○ #${id} ${name} — SKIPPED（${detail}）\n`);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function sha256File(file: string): string {
  return createHash('sha256').update(readFileSync(file)).digest('hex');
}

function sha256Text(text: string): string {
  return createHash('sha256').update(text).digest('hex');
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
    await sleep(100);
  }
}

// ── Real media ──────────────────────────────────────────────────────────────

function ffmpeg(args: string[], label: string): void {
  const result = spawnSync('ffmpeg', args, {
    encoding: 'utf8',
    windowsHide: true,
    maxBuffer: 64 * 1024 * 1024,
    timeout: 180_000,
  });
  if (result.status !== 0) {
    throw new Error(`ffmpeg 失败（${label}）：${(result.stderr ?? '').slice(-1500)}`);
  }
}

interface ProbeResult {
  codecName: string;
  width: number;
  height: number;
  durationMs: number;
  fps: number;
  audio: { codecName: string; sampleRate: number; channels: number; durationMs: number } | null;
}

function probe(file: string): ProbeResult {
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
      avg_frame_rate?: string;
      duration?: string;
    }>;
    format?: { duration?: string };
  };
  const video = parsed.streams?.find((stream) => stream.codec_type === 'video');
  if (!video) throw new Error('ffprobe 没有找到视频流');
  const audio = parsed.streams?.find((stream) => stream.codec_type === 'audio');
  const durationMs = Math.round(Number(parsed.format?.duration ?? 0) * 1000);
  const [num, den] = (video.avg_frame_rate ?? '30/1').split('/').map(Number);
  return {
    codecName: video.codec_name ?? 'unknown',
    width: video.width ?? 0,
    height: video.height ?? 0,
    durationMs,
    fps: den ? (num ?? 30) / den : 30,
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
 * A drawtext-capable font. ffmpeg's fontconfig lookup does not work on a bare
 * Windows box, so the path is pinned and escaped for the filter parser (`:` is
 * filter syntax and follows the drive letter).
 */
const FONT_FILE = ((): string => {
  const candidates = [
    'C:\\Windows\\Fonts\\arial.ttf',
    '/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf',
    '/usr/share/fonts/truetype/liberation/LiberationSans-Regular.ttf',
    '/System/Library/Fonts/Supplemental/Arial.ttf',
  ];
  const found = candidates.find((file) => existsSync(file));
  if (!found) throw new Error('找不到 drawtext 可用的字体（Arial / DejaVu）；无法绘制真实文本。');
  return found.replace(/\\/g, '/').replace(/^([A-Za-z]):/, '$1\\:');
})();

function escapeDrawText(value: string): string {
  return value
    .replace(/\\/g, '\\\\')
    .replace(/'/g, "\\'")
    .replace(/:/g, '\\:')
    .replace(/,/g, '\\,')
    .replace(/%/g, '\\%');
}

interface ClipOptions {
  file: string;
  durationSec: number;
  /**
   * `true` renders `testsrc2`, which changes every frame (so `freezedetect`
   * stays silent and the picture is not black); `false` renders a motionless
   * card, which is exactly what a stuck capture looks like.
   */
  motion: boolean;
  withAudio?: boolean;
  /** Pure-black overlay window, for the `technical.black_frame` scenario. */
  black?: { startSec: number; durationSec: number };
  /** Large glyphs painted into every frame, for the real-OCR scenario. */
  overlayText?: string;
  width?: number;
  height?: number;
}

function renderClip(options: ClipOptions): void {
  const width = options.width ?? 640;
  const height = options.height ?? 360;
  const args = ['-hide_banner', '-loglevel', 'error', '-y'];
  if (options.motion) {
    args.push('-f', 'lavfi', '-i', `testsrc2=s=${width}x${height}:r=30:d=${options.durationSec}`);
  } else {
    args.push(
      '-f', 'lavfi', '-i', `color=c=0xE8EEF7:s=${width}x${height}:r=30:d=${options.durationSec}`,
    );
  }
  if (options.withAudio) {
    args.push(
      '-f', 'lavfi', '-i', `sine=frequency=440:sample_rate=48000:duration=${options.durationSec}`,
    );
  }
  const filters: string[] = [];
  if (options.overlayText) {
    filters.push(
      `drawtext=fontfile='${FONT_FILE}':text='${escapeDrawText(options.overlayText)}':` +
        `fontcolor=black:fontsize=${Math.round(height / 8)}:x=(w-text_w)/2:y=(h-text_h)/2:` +
        'box=1:boxcolor=white@0.95',
    );
  }
  if (options.black) {
    const start = options.black.startSec;
    const end = start + options.black.durationSec;
    // Last filter in the chain: an opaque full-frame box wins over everything
    // above it, which is what `blackdetect` must see.
    filters.push(
      `drawbox=x=0:y=0:w=iw:h=ih:color=black@1:t=fill:enable='between(t,${start.toFixed(3)},${end.toFixed(3)})'`,
    );
  }
  if (filters.length > 0) args.push('-vf', filters.join(','));
  args.push('-c:v', 'libx264', '-preset', 'veryfast', '-pix_fmt', 'yuv420p');
  if (options.withAudio) args.push('-c:a', 'aac', '-b:a', '96k', '-shortest');
  args.push(options.file);
  ffmpeg(args, path.basename(options.file));
}

/** A real PNG with real glyphs (for the OCR scenarios). */
function renderPng(file: string, text: string): void {
  ffmpeg(
    [
      '-hide_banner', '-loglevel', 'error', '-y',
      '-f', 'lavfi', '-i', 'color=c=white:s=1280x720:d=1',
      '-frames:v', '1',
      '-vf',
      `drawtext=fontfile='${FONT_FILE}':text='${escapeDrawText(text)}':` +
        'fontcolor=black:fontsize=52:x=(w-text_w)/2:y=(h-text_h)/2',
      file,
    ],
    path.basename(file),
  );
}

// ── PNG text chunks ─────────────────────────────────────────────────────────

const CRC_TABLE = ((): Uint32Array => {
  const table = new Uint32Array(256);
  for (let index = 0; index < 256; index += 1) {
    let value = index;
    for (let bit = 0; bit < 8; bit += 1) {
      value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    }
    table[index] = value >>> 0;
  }
  return table;
})();

function crc32(bytes: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of bytes) crc = CRC_TABLE[(crc ^ byte) & 0xff]! ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

/**
 * Insert a real `tEXt` chunk before `IEND`. QA reads ancillary text chunks
 * *before* it ever asks OCR anything, so this is how the "an image carried a
 * secret nobody could see in the pixels" path is proven with real bytes and
 * without a Tesseract install.
 */
function injectPngText(file: string, keyword: string, text: string): void {
  const source = readFileSync(file);
  if (source.readUInt32BE(0) !== 0x89504e47 || source.readUInt32BE(4) !== 0x0d0a1a0a) {
    throw new Error(`${path.basename(file)} 不是 PNG，无法写入 tEXt 块`);
  }
  const data = Buffer.concat([Buffer.from(keyword, 'latin1'), Buffer.from([0]), Buffer.from(text, 'latin1')]);
  const type = Buffer.from('tEXt', 'ascii');
  const chunk = Buffer.alloc(8 + data.length + 4);
  chunk.writeUInt32BE(data.length, 0);
  type.copy(chunk, 4);
  data.copy(chunk, 8);
  chunk.writeUInt32BE(crc32(Buffer.concat([type, data])), 8 + data.length);

  const chunks: Buffer[] = [source.subarray(0, 8)];
  let offset = 8;
  let injected = false;
  while (offset + 8 <= source.length) {
    const length = source.readUInt32BE(offset);
    const typeName = source.toString('ascii', offset + 4, offset + 8);
    const end = offset + 12 + length;
    if (end > source.length) throw new Error('PNG 块结构被截断');
    if (typeName === 'IEND' && !injected) {
      chunks.push(chunk);
      injected = true;
    }
    chunks.push(source.subarray(offset, end));
    offset = end;
  }
  if (!injected) throw new Error('PNG 缺少 IEND，无法注入 tEXt');
  writeFileSync(file, Buffer.concat(chunks));
}

// ── A structurally valid Playwright trace ───────────────────────────────────

interface ZipMember {
  name: string;
  bytes: Buffer;
}

/** Minimal ZIP writer (deflate + central directory) read by the real reader. */
function buildZip(members: ZipMember[]): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  const dosDate = (46 << 9) | (1 << 5) | 1; // 2026-01-01
  for (const member of members) {
    const name = Buffer.from(member.name, 'utf8');
    const compressed = deflateRawSync(member.bytes);
    const crc = crc32(member.bytes);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6);
    local.writeUInt16LE(8, 8);
    local.writeUInt16LE(0, 10);
    local.writeUInt16LE(dosDate, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(compressed.length, 18);
    local.writeUInt32LE(member.bytes.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);
    const record = Buffer.concat([local, name, compressed]);
    locals.push(record);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(8, 10);
    central.writeUInt16LE(0, 12);
    central.writeUInt16LE(dosDate, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(compressed.length, 20);
    central.writeUInt32LE(member.bytes.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(offset, 42);
    centrals.push(Buffer.concat([central, name]));
    offset += record.length;
  }
  const centralDir = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(members.length, 8);
  end.writeUInt16LE(members.length, 10);
  end.writeUInt32LE(centralDir.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, centralDir, end]);
}

function ndjson(events: unknown[]): Buffer {
  return Buffer.from(events.map((event) => JSON.stringify(event)).join('\n'), 'utf8');
}

/** A clean trace: real action/network entries, no secrets anywhere. */
function buildCleanTraceZip(): Buffer {
  const trace = [
    { type: 'context-options', version: 7, origin: 'library', wallTime: Date.parse(ISO) },
    {
      type: 'before',
      callId: 'call@1',
      startTime: Date.parse(ISO),
      class: 'Frame',
      method: 'goto',
      params: { url: `${BASE_URL}/projects` },
      pageId: 'page@1',
    },
    { type: 'after', callId: 'call@1', endTime: Date.parse(ISO) + 120 },
  ];
  const network = [
    {
      type: 'resource-snapshot',
      snapshot: {
        request: {
          url: `${BASE_URL}/api/v1/workspaces`,
          method: 'GET',
          headers: [['accept', 'application/json']],
        },
        response: {
          url: `${BASE_URL}/api/v1/workspaces`,
          status: 200,
          headers: [['content-type', 'application/json']],
          content: { mimeType: 'application/json', _sha1: 'b'.repeat(40), size: 14 },
        },
        _sha1: 'b'.repeat(40),
      },
    },
  ];
  return buildZip([
    { name: 'trace.trace', bytes: ndjson(trace) },
    { name: 'trace.network', bytes: ndjson(network) },
    { name: `resources/${'b'.repeat(40)}`, bytes: Buffer.from('{"ok":true}\n', 'utf8') },
  ]);
}

/**
 * A leaky trace, shaped exactly like Playwright writes one: request headers as
 * `[name, value]` pairs, a console line and an action error carrying text.
 */
function buildLeakyTraceZip(): Buffer {
  const trace = [
    { type: 'context-options', version: 7, origin: 'library', wallTime: Date.parse(ISO) },
    {
      type: 'before',
      callId: 'call@1',
      startTime: Date.parse(ISO),
      class: 'Frame',
      method: 'goto',
      params: { url: `${BASE_URL}/projects` },
      pageId: 'page@1',
    },
    {
      type: 'after',
      callId: 'call@1',
      endTime: Date.parse(ISO) + 120,
      error: `导航失败：账号 ${SECRET_EMAIL} 没有权限`,
    },
    {
      type: 'console',
      callId: 'call@2',
      time: Date.parse(ISO) + 200,
      messageType: 'error',
      text: `请求头 Authorization: ${SECRET_BEARER}`,
    },
  ];
  const network = [
    {
      type: 'resource-snapshot',
      snapshot: {
        request: {
          url: `${BASE_URL}/api/v1/workspaces`,
          method: 'GET',
          headers: [
            ['authorization', SECRET_BEARER],
            ['x-github-token', SECRET_TOKEN],
            ['accept', 'application/json'],
          ],
        },
        response: {
          url: `${BASE_URL}/api/v1/workspaces`,
          status: 200,
          headers: [['content-type', 'application/json']],
          content: { mimeType: 'application/json', _sha1: 'a'.repeat(40), size: 96 },
        },
        _sha1: 'a'.repeat(40),
      },
    },
  ];
  return buildZip([
    { name: 'trace.trace', bytes: ndjson(trace) },
    { name: 'trace.network', bytes: ndjson(network) },
    {
      name: `resources/${'a'.repeat(40)}`,
      bytes: Buffer.from(JSON.stringify({ owner: SECRET_EMAIL, token: SECRET_TOKEN }), 'utf8'),
    },
  ]);
}

// ── Workspace fixture ───────────────────────────────────────────────────────

interface SceneOptions {
  title: string;
  narration: string;
  caption: string;
  durationSec: number;
  realDemo?: boolean;
}

function scene(id: string, order: number, options: SceneOptions) {
  return {
    id,
    order,
    revision: 1,
    title: options.title,
    intent: options.title,
    narration: options.narration,
    caption: options.caption,
    durationSec: options.durationSec,
    visualType: options.realDemo ? ('real_demo' as const) : ('title' as const),
    templateId: 'tpl_signal',
    claimIds: [] as string[],
    ...(options.realDemo ? { featureId: 'feat_qa' } : {}),
    status: 'approved' as const,
    look: 'cinematic' as const,
    brightness: 1,
    vignette: true,
  };
}

function buildVideo(options: {
  id: string;
  title: string;
  scenes: ReturnType<typeof scene>[];
  approved?: boolean;
}): StudioSnapshot['videos'][number] {
  const durationSec = options.scenes.reduce((sum, item) => sum + item.durationSec, 0);
  return {
    id: options.id,
    projectId: PROJECT_ID,
    title: options.title,
    mode: 'release_video',
    // Every scenario's video is approved so each refusal provably comes from
    // QA, never from the approval gate (#16 is the point of that).
    stage: 'approved',
    fps: 30,
    brief: {
      objective: 'Step 5D 独立 QA 与 AC-07 隐私守门验收',
      audience: '工程团队',
      featureIds: ['feat_qa'],
      durationSec,
      aspect: '16:9',
      language: 'zh-CN',
      tone: 'confident',
      style: 'editorial',
      templateId: 'tpl_signal',
      useRealCapture: false,
      useGeneratedVisuals: true,
      // A CTA is present so `content.brand_kit` cannot add a warning that
      // would obscure what each assertion is about.
      cta: '立即体验',
      bannedPhrases: [],
    },
    scenes: options.scenes,
    directorMessages: [],
    scriptVersion: 1,
    createdAt: ISO,
    updatedAt: ISO,
    demo: true,
    review: { status: 'approved' as const, note: 'AC-07 验收：已批准', decidedAt: ISO },
  };
}

function buildSnapshot(): StudioSnapshot {
  return {
    projects: [
      {
        id: PROJECT_ID,
        name: 'QA Verify',
        productName: 'QA Verify',
        description: 'Step 5D 验收项目',
        website: 'https://qa-verify.demo.invalid',
        stage: 'active',
        brand: {
          logoText: 'QAV',
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
    features: [
      {
        id: 'feat_qa',
        projectId: PROJECT_ID,
        name: '独立 QA',
        summary: '隐私 / 技术 / 事实 / 内容四维复核',
        category: '验收',
        status: 'verified',
        confidence: 96,
        userConfirmed: true,
        sourceRefs: [],
        claimIds: [],
        prIds: [],
        demoRoute: '/videos',
        updatedAt: ISO,
        tags: [],
        demo: true,
      },
    ],
    // No claims: a claim would drag `fact.claim_eligibility` into every report.
    claims: [],
    evidence: [],
    pullRequests: [],
    releases: [],
    suggestions: [],
    assets: [],
    templates: [],
    videos: [
      buildVideo({
        id: VIDEO_CLEAN,
        title: 'Clean capture',
        scenes: [
          scene('scene_clean_1', 0, {
            title: '开场', narration: '一段干净的演示。', caption: '开场', durationSec: 4,
          }),
          scene('scene_clean_2', 1, {
            title: '演示',
            narration: '录屏没有任何敏感信息。',
            caption: '演示',
            durationSec: 6,
            realDemo: true,
          }),
          scene('scene_clean_3', 2, {
            title: '结尾', narration: '立即体验。', caption: '立即体验', durationSec: 4,
          }),
        ],
      }),
      buildVideo({
        id: VIDEO_TRACE,
        title: 'Trace privacy',
        scenes: [
          scene('scene_trace_1', 0, {
            title: '演示',
            narration: '这段录屏的 trace 里藏着凭据。',
            caption: '演示',
            durationSec: 6,
            realDemo: true,
          }),
          scene('scene_trace_2', 1, {
            title: '结尾', narration: '立即体验。', caption: '立即体验', durationSec: 4,
          }),
        ],
      }),
      buildVideo({
        id: VIDEO_SUBTITLE,
        title: 'Subtitle privacy',
        scenes: [
          scene('scene_subtitle_1', 0, {
            title: '联系',
            narration: '请联系 privacy.leak@corp.internal 获取权限。',
            caption: '联系',
            durationSec: 6,
          }),
          scene('scene_subtitle_2', 1, {
            title: '结尾', narration: '立即体验。', caption: '立即体验', durationSec: 4,
          }),
        ],
      }),
      buildVideo({
        id: VIDEO_BLACK,
        title: 'Black frame',
        scenes: [
          scene('scene_black_1', 0, {
            title: '开场', narration: '开始。', caption: '开场', durationSec: 3,
          }),
          scene('scene_black_2', 1, {
            title: '黑屏', narration: '中间会黑屏。', caption: '黑屏', durationSec: 5,
          }),
          scene('scene_black_3', 2, {
            title: '结尾', narration: '立即体验。', caption: '立即体验', durationSec: 3,
          }),
        ],
      }),
      buildVideo({
        id: VIDEO_FREEZE,
        title: 'Freeze clip',
        scenes: [
          scene('scene_freeze_1', 0, {
            title: '静止',
            narration: '录屏画面完全没有变化。',
            caption: '静止',
            durationSec: 8,
            realDemo: true,
          }),
          scene('scene_freeze_2', 1, {
            title: '结尾', narration: '立即体验。', caption: '立即体验', durationSec: 4,
          }),
        ],
      }),
      buildVideo({
        id: VIDEO_UNCONFIGURED,
        title: 'Fail-closed OCR',
        scenes: [
          scene('scene_unconfigured_1', 0, {
            title: '画面',
            narration: '这一帧必须被真正读取。',
            caption: '画面',
            durationSec: 6,
            realDemo: true,
          }),
          scene('scene_unconfigured_2', 1, {
            title: '结尾', narration: '立即体验。', caption: '立即体验', durationSec: 4,
          }),
        ],
      }),
      buildVideo({
        id: VIDEO_SILENT,
        title: 'Silent regression',
        scenes: [
          scene('scene_silent_1', 0, {
            title: '无声', narration: '没有旁白与录屏。', caption: '无声', durationSec: 5,
          }),
          scene('scene_silent_2', 1, {
            title: '结尾', narration: '立即体验。', caption: '立即体验', durationSec: 4,
          }),
        ],
      }),
      buildVideo({
        id: VIDEO_OCR,
        title: 'Screenshot OCR',
        scenes: [
          scene('scene_ocr_1', 0, {
            title: '截图',
            narration: '截图里有真实凭据。',
            caption: '截图',
            durationSec: 6,
            realDemo: true,
          }),
          scene('scene_ocr_2', 1, {
            title: '结尾', narration: '立即体验。', caption: '立即体验', durationSec: 4,
          }),
        ],
      }),
    ],
    runs: [],
    exports: [],
    activity: [],
  };
}

// ── Render double (real encoded media) ──────────────────────────────────────

function storyboardDurationMs(input: {
  storyboard: { fps: number; scenes: Array<{ durationFrames: number }> };
}): number {
  const frames = input.storyboard.scenes.reduce((sum, item) => sum + item.durationFrames, 0);
  return Math.round((frames / input.storyboard.fps) * 1000);
}

/** Start offset (ms) of one storyboard scene in the final timeline. */
function sceneStartMs(
  input: { storyboard: { fps: number; scenes: Array<{ id: string; durationFrames: number }> } },
  sceneId: string,
): number | undefined {
  const { scenes, fps } = input.storyboard;
  const index = scenes.findIndex((item) => item.id === sceneId);
  if (index < 0) return undefined;
  const frames = scenes.slice(0, index).reduce((sum, item) => sum + item.durationFrames, 0);
  return Math.round((frames / fps) * 1000);
}

/**
 * Writes a genuine ffmpeg MP4 plus the receipt/manifest that
 * `register_artifacts` re-verifies.
 *
 * The picture is chosen per video: a real black window inside scene 2 for the
 * black-frame scenario, moving `testsrc2` everywhere else. Duration always
 * comes from the *frozen* storyboard the orchestrator handed over — narration
 * may have extended it — so the SRT (built from that same timeline) always
 * fits inside the film and the subtitle check stays about subtitles.
 */
class RealMediaRenderExecutor implements RenderJobExecutorPort {
  calls = 0;
  private running = false;
  constructor(private readonly options: { blackVideoIds: Set<string>; ocrOverlays: Map<string, string> }) {}
  isRunning(): boolean {
    return this.running;
  }
  abort(): void {
    /* nothing to kill */
  }
  async execute(
    job: unknown,
    _inputFile: string,
    outDir: string,
    _checkpointFile: string,
    callbacks: RenderJobExecutorCallbacks,
  ): Promise<RenderJobExecutionResult> {
    this.calls += 1;
    this.running = true;
    try {
      const typed = job as {
        jobId: string;
        runId: string;
        subtitlesPath?: string;
        input: {
          storyboard: {
            fps: number;
            videoProjectId: string;
            scenes: Array<{ id: string; durationFrames: number }>;
          };
        };
      };
      mkdirSync(outDir, { recursive: true });
      const mp4 = path.join(outDir, `${typed.runId}.mp4`);
      const durationMs = storyboardDurationMs(typed.input);
      const videoId = typed.input.storyboard.videoProjectId;
      const blackStart = sceneStartMs(typed.input, 'scene_black_2');
      const overlayText = this.options.ocrOverlays.get(videoId);
      renderClip({
        file: mp4,
        durationSec: durationMs / 1000,
        // The black scenario still moves underneath the overlay except during
        // the window, so a *frozen* clip never accidentally satisfies #12.
        motion: true,
        withAudio: true,
        ...(this.options.blackVideoIds.has(videoId) && blackStart !== undefined
          ? { black: { startSec: (blackStart + 200) / 1000, durationSec: 1.5 } }
          : {}),
        ...(overlayText ? { overlayText } : {}),
      });
      callbacks.onCheckpoint?.('verified_receipt', {});

      const digest = sha256File(mp4);
      const bytes = statSync(mp4).size;
      const probed = probe(mp4);
      const artifactId = typed.jobId.replace(/^orchjob/, 'artifact');

      let srtBinding:
        | {
            fileName: string;
            mimeType: string;
            byteSize: number;
            sha256: string;
            cueCount: number;
            durationMs: number;
          }
        | undefined;
      if (typed.subtitlesPath && existsSync(typed.subtitlesPath)) {
        const content = readFileSync(typed.subtitlesPath, 'utf8');
        srtBinding = {
          fileName: 'subtitles.srt',
          mimeType: 'application/x-subrip',
          byteSize: Buffer.byteLength(content),
          sha256: sha256Text(content),
          cueCount: (content.match(/-->/g) ?? []).length,
          durationMs: probed.durationMs,
        };
      }

      writeFileSync(
        path.join(outDir, 'receipt.json'),
        JSON.stringify({
          schemaVersion: '1',
          jobId: typed.jobId,
          artifactId,
          sha256: digest,
          mimeType: 'video/mp4',
          byteSize: bytes,
          storageRef: `workspaces/${WORKSPACE_ID}/runs/${typed.runId}/artifacts/${typed.runId}.mp4`,
          durationMs: probed.durationMs,
          width: probed.width,
          height: probed.height,
          fps: probed.fps,
          rendererVersion: 'qa-verify-ffmpeg',
          compositionId: 'AsvsVideo',
          createdAt: ISO,
        }),
      );
      writeFileSync(
        path.join(outDir, 'manifest.json'),
        JSON.stringify({
          schemaVersion: '1',
          jobId: typed.jobId,
          artifactId,
          compositionId: 'AsvsVideo',
          rendererVersion: 'qa-verify-ffmpeg',
          renderInputDigest: sha256Text(`${typed.runId}:input`),
          storyboardDigest: sha256Text(`${typed.runId}:storyboard`),
          sceneDigests: [],
          assetHashes: [],
          renderProfile: { width: probed.width, height: probed.height, codec: 'h264', crf: 18 },
          output: { fileName: `${typed.runId}.mp4`, mimeType: 'video/mp4', byteSize: bytes, sha256: digest },
          ffprobe: {
            codecName: probed.codecName,
            durationMs: probed.durationMs,
            width: probed.width,
            height: probed.height,
            fps: probed.fps,
            frameCount: Math.round((probed.durationMs / 1000) * probed.fps),
            ...(probed.audio
              ? {
                  audio: {
                    codecName: probed.audio.codecName,
                    sampleRate: probed.audio.sampleRate,
                    channels: probed.audio.channels,
                    durationMs: probed.audio.durationMs,
                    meanVolumeDb: -22,
                  },
                }
              : {}),
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

// ── Capture double (real encoded media) ─────────────────────────────────────

const DEFAULT_DEMO_STEPS = [
  {
    id: 'dashboard-ready',
    action: 'assert' as const,
    target: 'testid=qa-verify-dashboard',
    assertion: { kind: 'visible' as const, match: 'contains' as const },
    timeoutMs: 20_000,
    dwellMs: 4000,
    state: 'visible' as const,
    description: '工作台首屏必须真实渲染出来',
  },
];

interface CaptureScenario {
  /** `static` clips never change a pixel — exactly what #13 must catch. */
  clip: 'motion' | 'static';
  /** `clean` traces carry no secrets; `leaky` traces carry token + email. */
  trace: 'clean' | 'leaky';
  /** Written into a PNG `tEXt` chunk, invisible in the pixels (#10). */
  pngText?: { keyword: string; text: string };
  /** Glyphs painted into the screenshot, for real OCR (#8). */
  screenshotText?: string;
  /** Glyphs painted into the clip, for real OCR (#9). */
  clipText?: string;
}

/**
 * Writes what a real `browser-worker` leaves behind: a genuine MP4 clip, a real
 * PNG screenshot, a structurally valid `trace.zip` and a receipt bound to the
 * approved plan — all hashed from the bytes actually written.
 */
class RealMediaCaptureExecutor implements CaptureJobExecutorPort {
  calls = 0;
  private running = false;
  constructor(private readonly scenarioFor: (runId: string) => CaptureScenario) {}
  isRunning(): boolean {
    return this.running;
  }
  abort(): void {
    /* nothing to kill */
  }
  async execute(
    job: CaptureJobInputV1,
    _inputFile: string,
    outDir: string,
    _checkpointFile: string,
    callbacks: CaptureJobExecutorCallbacks,
  ): Promise<CaptureJobExecutionResult> {
    this.calls += 1;
    this.running = true;
    const checkpoints: Array<{ phase: string; payload: Record<string, unknown> }> = [];
    const checkpoint = (phase: string, payload: Record<string, unknown> = {}): void => {
      checkpoints.push({ phase, payload });
      callbacks.onCheckpoint?.(phase, payload);
    };
    callbacks.onSpawn?.(5151);
    callbacks.onHeartbeat?.(5151);
    checkpoint('plan_verified', { planId: job.plan.id });
    checkpoint('capture_started', { baseUrl: job.plan.baseUrl });
    try {
      const scenario = this.scenarioFor(job.runId);
      mkdirSync(path.join(outDir, 'screenshots'), { recursive: true });

      const slug = job.plan.id.replace(/^plan_/, '');
      const clip = path.join(outDir, `${slug}.mp4`);
      renderClip({
        file: clip,
        durationSec: 8,
        motion: scenario.clip === 'motion',
        ...(scenario.clipText ? { overlayText: scenario.clipText } : {}),
      });
      checkpoint('capture_recorded', { clip: `${slug}.mp4` });
      const clipSha = sha256File(clip);
      const clipProbe = probe(clip);

      const screenshotRel = 'screenshots/01-dashboard.png';
      const screenshot = path.join(outDir, screenshotRel);
      renderPng(screenshot, scenario.screenshotText ?? 'dashboard ready');
      if (scenario.pngText) {
        injectPngText(screenshot, scenario.pngText.keyword, scenario.pngText.text);
      }

      const traceRel = 'trace.zip';
      const trace = path.join(outDir, traceRel);
      writeFileSync(trace, scenario.trace === 'leaky' ? buildLeakyTraceZip() : buildCleanTraceZip());
      checkpoint('clip_transcoded', {});

      const receiptFile = path.join(outDir, 'capture-receipt.json');
      // Two different conventions, and mixing them silently drops evidence:
      //
      // - receipt `file` fields are **outDir-relative** (`fileArtifact` in the
      //   real worker). The orchestrator registers them with
      //   `path.join(outDir, shot.file)`, and the runner resolves screenshots
      //   and the trace against `outDir` too. A repo-relative path here makes
      //   every one of those joins miss, so the files fail `existsSync` and are
      //   skipped without an error — leaving `scannedScreenshots` and
      //   `scannedTraceEntries` at 0 while the run still looks clean.
      // - `media.sourceFile` is **workspace-relative** POSIX
      //   (`storageRefFor`), because `backfillCapture` resolves it against
      //   `mediaRoot` (= the repository root here).
      const outRel = (file: string) => path.relative(outDir, file).split(path.sep).join('/');
      const wsRel = (file: string) => path.relative(repoRoot, file).split(path.sep).join('/');
      const artifact = (file: string, mimeType: string) => ({
        file: outRel(file),
        sha256: sha256File(file),
        byteSize: statSync(file).size,
        mimeType,
      });

      const receipt = captureReceiptV1Schema.parse({
        schemaVersion: '1',
        kind: 'asvs.capture-receipt',
        jobId: job.jobId,
        planId: job.plan.id,
        planFile: 'capture-job-input.json',
        planDigest: job.planDigest,
        approvalId: job.plan.approval.approvalId,
        createdAt: ISO,
        environment: {
          baseUrl: job.plan.baseUrl,
          browser: 'Chromium (qa:verify double)',
          viewport: {
            width: job.plan.viewport.width,
            height: job.plan.viewport.height,
            deviceScaleFactor: job.plan.viewport.deviceScaleFactor,
          },
          locale: job.plan.locale,
          timezoneId: job.plan.timezoneId,
          colorScheme: job.plan.colorScheme,
          reducedMotion: job.plan.reducedMotion,
        },
        assertions: { total: job.plan.steps.length, passed: job.plan.steps.length, failed: 0 },
        steps: job.plan.steps.map((step, index) => ({
          id: step.id,
          action: step.action,
          status: 'passed' as const,
          startedAtMs: index * 1200,
          durationMs: 1100,
          ...(step.action === 'assert'
            ? { assertion: { kind: 'visible' as const, passed: true } }
            : {}),
          ...(index === 0 ? { screenshot: screenshotRel } : {}),
        })),
        rawVideo: {
          ...artifact(clip, 'video/webm'),
          width: clipProbe.width,
          height: clipProbe.height,
          fps: clipProbe.fps,
          durationMs: clipProbe.durationMs,
          codecName: 'vp8',
        },
        clip: {
          ...artifact(clip, 'video/mp4'),
          width: clipProbe.width,
          height: clipProbe.height,
          fps: clipProbe.fps,
          durationMs: clipProbe.durationMs,
          codecName: clipProbe.codecName,
        },
        trace: artifact(trace, 'application/zip'),
        // `captureArtifactFileV1Schema` is strict: hashes and size only.
        screenshots: [artifact(screenshot, 'image/png')],
        asset: {
          id: job.plan.asset.id,
          projectId: job.plan.projectId,
          name: job.plan.asset.name,
          kind: 'capture' as const,
          durationSec: Math.max(1, Math.round(clipProbe.durationMs / 1000)),
          description: job.plan.asset.description,
          palette: job.plan.asset.palette,
          mock: false,
          media: {
            src: wsRel(clip),
            mimeType: 'video/mp4',
            width: clipProbe.width,
            height: clipProbe.height,
            durationMs: clipProbe.durationMs,
            sha256: clipSha,
            capturePlanId: job.plan.id,
            captureReceiptRef: wsRel(receiptFile),
          },
        },
        media: {
          assetId: job.plan.asset.id,
          sourceFile: wsRel(clip),
          sha256: clipSha,
          mimeType: 'video/mp4',
          width: clipProbe.width,
          height: clipProbe.height,
          durationMs: clipProbe.durationMs,
        },
        renderFixture: { file: 'captured.json', sha256: sha256Text('fixture') },
      });
      writeFileSync(receiptFile, `${JSON.stringify(receipt, null, 2)}\n`);

      const result: CaptureJobResultV1 = {
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
          receiptFile: outRel(receiptFile),
          receiptSha256: sha256File(receiptFile),
          clipFile: wsRel(clip),
          clipSha256: clipSha,
          clipDurationMs: clipProbe.durationMs,
          clipWidth: clipProbe.width,
          clipHeight: clipProbe.height,
          assertions: { total: receipt.assertions.total, passed: receipt.assertions.passed, failed: 0 },
          screenshotCount: receipt.screenshots.length,
          completedAt: ISO,
        },
        durationMs: 1200,
        writtenAt: ISO,
      };
      return { ok: true, workerPid: 5151, exitCode: 0, checkpoints, result };
    } finally {
      this.running = false;
    }
  }
}

// ── Stack ───────────────────────────────────────────────────────────────────

interface StackOptions {
  dbPath: string;
  artifactDir: string;
  snapshot: () => StudioSnapshot;
  qaConfig: QaRuntimeConfig;
  /** `unconfigured` builds the fail-closed adapter (#14). */
  ocr?: 'unconfigured';
  capture?: CaptureJobExecutorPort | null;
  renderExecutor: RealMediaRenderExecutor;
}

interface Stack {
  db: DatabaseSync;
  orchestrator: Orchestrator;
  qaReports: QaReportStore;
  artifactDir: string;
}

function openStack(options: StackOptions): Stack {
  const db = openDatabase(options.dbPath);
  const store = new SqliteOrchestrationStore(db);
  const qaReports = new QaReportStore(db);
  // The adapter must follow the configured provider. Building a Tesseract
  // adapter while the config says `deterministic_test` would silently make
  // every image fail closed on a machine without the binary — and the health
  // block would then disagree with the config the report claims.
  const ocr =
    options.ocr === 'unconfigured' || options.qaConfig.ocrProvider === 'unconfigured'
      ? new UnconfiguredOcrAdapter()
      : options.qaConfig.ocrProvider === 'deterministic_test'
        ? new DeterministicTestOcrAdapter()
        : new TesseractCliOcrAdapter({
            bin: options.qaConfig.tesseractBin,
            language: options.qaConfig.ocrLanguage,
            timeoutMs: options.qaConfig.ocrTimeoutMs,
          });
  const orchestrator = new Orchestrator({
    store,
    artifactDir: options.artifactDir,
    // Receipt refs are workspace-relative to the repository root.
    mediaRoot: repoRoot,
    loadWorkspace: () => options.snapshot(),
    executor: options.renderExecutor,
    captureExecutor: options.capture ?? null,
    captureConfig: {
      enabled: Boolean(options.capture),
      allowedOrigins: [BASE_URL],
      defaultBaseUrl: BASE_URL,
      allowAutoServe: false,
    },
    speech: new SpeechService({
      port: new DeterministicTestSpeechAdapter(SPEECH_CONFIG),
      cache: new SpeechCacheStore(db),
      audioRoot: path.join(options.artifactDir, 'tts'),
    }),
    qaRunner: new IndependentQaRunner({
      config: options.qaConfig,
      ocr,
      logger: { warn: () => undefined },
    }),
    qaReportStore: qaReports,
    exportStore: new ExportBundleStore(db),
    instanceId: 'api_qa_verify',
    maxAttempts: 1,
    schedulerIntervalMs: 100,
  });
  return { db, orchestrator, qaReports, artifactDir: options.artifactDir };
}

function insertWorkspace(db: DatabaseSync, snapshot: StudioSnapshot): void {
  db.prepare(
    'INSERT INTO workspaces (id, revision, schema_version, payload, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)',
  ).run(WORKSPACE_ID, 1, 2, JSON.stringify(snapshot), ISO, ISO);
}

// ── Scenario helpers ────────────────────────────────────────────────────────

interface RunOutcome {
  runId: string;
  status: string;
  failureCode?: string;
  failureRetryable?: boolean;
  stepStatus: Map<string, string>;
}

async function finishRun(stack: Stack, runId: string, timeoutMs = 900_000): Promise<RunOutcome> {
  const detail = await waitFor(
    () => stack.orchestrator.getRun(WORKSPACE_ID, runId),
    (value) => value !== null && isTerminal(value.run.status),
    timeoutMs,
    `运行 ${runId} 进入终态`,
  );
  if (!detail) throw new Error(`运行 ${runId} 不存在`);
  return {
    runId,
    status: detail.run.status,
    ...(detail.run.failure ? { failureCode: detail.run.failure.code } : {}),
    ...(detail.run.failure ? { failureRetryable: detail.run.failure.retryable } : {}),
    stepStatus: new Map(detail.run.steps.map((step) => [step.stepKey, step.status])),
  };
}

async function createRun(
  stack: Stack,
  body: {
    videoId: string;
    idempotencyKey: string;
    narration?: { enabled: boolean; speed?: number; timingPolicy: 'extend_scene' };
    capture?: { enabled: boolean };
  },
): Promise<string> {
  const created = await stack.orchestrator.createRun(WORKSPACE_ID, {
    videoId: body.videoId,
    idempotencyKey: `${body.idempotencyKey}-${Date.now()}`,
    narration: body.narration ?? { enabled: true, speed: 1, timingPolicy: 'extend_scene' },
    ...(body.capture?.enabled
      ? {
          capture: {
            enabled: true,
            template: 'custom' as const,
            baseUrl: BASE_URL,
            customSteps: DEFAULT_DEMO_STEPS,
            resetStrategy: 'fixture' as const,
          },
        }
      : { capture: { enabled: false } }),
  });
  return created.run.id;
}

/** Approves Gate 2 with the digest the reviewer was shown, then waits. */
async function approveAndFinish(stack: Stack, runId: string): Promise<RunOutcome> {
  const parked = await waitFor(
    () => stack.orchestrator.getRun(WORKSPACE_ID, runId),
    (detail) => detail?.run.status === 'awaiting_approval',
    180_000,
    `运行 ${runId} 进入 Gate 2`,
  );
  const run = parked!.run;
  if (!run.approval || !run.demoPlan) throw new Error('Gate 2 挂起但缺少 approval / demoPlan');
  await stack.orchestrator.approveRun(WORKSPACE_ID, run.id, {
    approvalId: run.approval.approvalId,
    subjectDigest: run.demoPlan.planDigest,
    decidedBy: 'qa-verify',
    note: 'AC-07 验收',
  });
  return finishRun(stack, run.id);
}

async function captureError(
  action: () => Promise<unknown>,
): Promise<{ httpStatus: number; code: string }> {
  try {
    await action();
    return { httpStatus: 0, code: 'no_error' };
  } catch (error) {
    if (error instanceof OrchestrationHttpError) {
      return { httpStatus: error.httpStatus, code: error.code };
    }
    return { httpStatus: 0, code: error instanceof Error ? error.message : String(error) };
  }
}

function runDirOf(artifactDir: string, runId: string): string {
  return path.join(artifactDir, 'workspaces', WORKSPACE_ID, 'runs', runId);
}

function artifactFile(artifactDir: string, artifact: OrchestrationArtifactV1): string {
  return path.join(artifactDir, ...artifact.storageRef.split('/'));
}

/** The envelope's `evidenceArtifacts` is `unknown[]` in the domain schema. */
function evidenceOf(envelope: { evidenceArtifacts: unknown[] } | null): OrchestrationArtifactV1[] {
  return (envelope?.evidenceArtifacts ?? []) as OrchestrationArtifactV1[];
}

// ── Main ────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const startedAt = Date.now();
  const distDir = path.join(repoRoot, 'dist');
  mkdirSync(distDir, { recursive: true });
  const tempRoot = mkdtempSync(path.join(distDir, 'qa-verify-'));
  const dbPath = path.join(tempRoot, 'qa.sqlite');
  const artifactDir = path.join(tempRoot, 'artifacts');
  mkdirSync(artifactDir, { recursive: true });

  const qaConfig: QaRuntimeConfig = { ...BASE_QA_CONFIG, maxFrames: 12, maxTraceFrames: 6 };

  process.stdout.write(`\n独立 QA 与 AC-07 隐私守门验收（WP-16）\n${'─'.repeat(78)}\n`);
  process.stdout.write(`  数据库    ${dbPath}\n  产物目录  ${artifactDir}\n`);
  process.stdout.write(
    `  OCR       ${hasTesseract ? `tesseract_cli · ${BASE_QA_CONFIG.tesseractBin}（真实识别）` : 'deterministic_test（标注为合成，未读像素）'}\n\n`,
  );
  if (!hasTesseract) {
    process.stdout.write(
      '  ⚠ 未检测到 tesseract：OCR 引擎本身无法验证，#8/#9 会标记为 SKIPPED 而不是假装通过；\n' +
        '    其余断言（trace 扫描、PNG 文本块、黑屏/静帧、脱敏证据帧、导出闸门）全部以真实字节执行。\n' +
        '    安装 Tesseract（或设置 ASVS_QA_TESSERNET_BIN）后重跑即可获得完整证明。\n\n'.replace(
          'ASVS_QA_TESSERNET_BIN',
          'ASVS_QA_TESSERACT_BIN',
        ),
    );
  }

  const snapshot = buildSnapshot();
  // Run id → capture scenario. Registered right after `createRun`, which is
  // always before Gate 2 is approved, so `capture_demo` cannot race it.
  const captureScenarios = new Map<string, CaptureScenario>();
  const capture = new RealMediaCaptureExecutor((runId) => {
    const scenario = captureScenarios.get(runId);
    if (!scenario) throw new Error(`未登记录屏场景的 run：${runId}`);
    return scenario;
  });
  const renderOptions = {
    blackVideoIds: new Set([VIDEO_BLACK]),
    ocrOverlays: new Map<string, string>(
      hasTesseract ? [[VIDEO_OCR, 'ceo@acme-internal.io']] : [],
    ),
  };
  const stack = openStack({
    dbPath,
    artifactDir,
    snapshot: () => snapshot,
    qaConfig,
    capture,
    renderExecutor: new RealMediaRenderExecutor(renderOptions),
  });
  insertWorkspace(stack.db, snapshot);

  try {
    await stack.orchestrator.start();

    // ── #1 health ─────────────────────────────────────────────────────────
    const health = stack.orchestrator.qaHealth();
    const expectedProvider = hasTesseract ? 'tesseract_cli' : 'deterministic_test';
    record(
      1,
      '健康检查如实报告 QA 能力（policy qa-v1）',
      health.enabled === true &&
        health.policyVersion === 'qa-v1' &&
        health.ocrProvider === expectedProvider &&
        health.ocrConfigured === true,
      `enabled=${health.enabled} provider=${health.ocrProvider} configured=${health.ocrConfigured} policy=${health.policyVersion}`,
    );

    // ── #2 / #3 / #4 clean capture run ────────────────────────────────────
    const cleanRunId = await createRun(stack, {
      videoId: VIDEO_CLEAN,
      idempotencyKey: 'qa-clean',
      capture: { enabled: true },
    });
    captureScenarios.set(cleanRunId, { clip: 'motion', trace: 'clean' });
    const clean = await approveAndFinish(stack, cleanRunId);
    const cleanFinal = stack.qaReports.getByRun(WORKSPACE_ID, cleanRunId, 'final');
    const cleanCapture = stack.qaReports.getByRun(WORKSPACE_ID, cleanRunId, 'capture');
    record(
      2,
      '干净录屏 + 旁白 + 渲染：qa_capture 与 qa_final 均成功，0 blockers',
      clean.status === 'succeeded' &&
        clean.stepStatus.get('qa_capture') === 'succeeded' &&
        clean.stepStatus.get('qa_final') === 'succeeded' &&
        cleanFinal?.report.summary.blockerCount === 0 &&
        (cleanFinal?.report.verdict === 'pass' || cleanFinal?.report.verdict === 'pass_with_warnings'),
      cleanFinal
        ? `status=${clean.status} verdict=${cleanFinal.report.verdict} blockers=${cleanFinal.report.summary.blockerCount} warnings=${cleanFinal.report.summary.warningCount}`
        : `没有 qa_final 报告（status=${clean.status} code=${clean.failureCode ?? '-'}）`,
    );

    const cleanDetail = await stack.orchestrator.getRun(WORKSPACE_ID, cleanRunId);
    const cleanTraceArtifact = cleanDetail?.artifacts.find(
      (artifact) => artifact.kind === 'capture_trace',
    );
    const capCoverage = cleanCapture?.report.coverage;
    const finalCoverage = cleanFinal?.report.coverage;
    record(
      3,
      '成功态登记 capture_trace，QA 覆盖率真实非零（trace/截图/录屏帧/成片帧/镜头/字幕）',
      Boolean(cleanTraceArtifact) &&
        (capCoverage?.scannedTraceEntries ?? 0) > 0 &&
        (capCoverage?.scannedScreenshots ?? 0) > 0 &&
        (capCoverage?.scannedCaptureFrames ?? 0) > 0 &&
        (finalCoverage?.scannedRenderFrames ?? 0) > 0 &&
        (finalCoverage?.scannedScenes ?? 0) >= 3 &&
        (finalCoverage?.scannedSrtCues ?? 0) > 0,
      capCoverage && finalCoverage
        ? `trace=${capCoverage.scannedTraceEntries} 截图=${capCoverage.scannedScreenshots} 录屏帧=${capCoverage.scannedCaptureFrames} 成片帧=${finalCoverage.scannedRenderFrames} 镜头=${finalCoverage.scannedScenes} 字幕=${finalCoverage.scannedSrtCues} trace产物=${Boolean(cleanTraceArtifact)}`
        : '报告或 trace 产物缺失',
    );

    const cleanRunDir = runDirOf(artifactDir, cleanRunId);
    const cleanFinalFile = path.join(cleanRunDir, 'qa', 'qa-final-report.json');
    const bundle = await stack.orchestrator.createExportBundle(WORKSPACE_ID, {
      videoId: VIDEO_CLEAN,
      runId: cleanRunId,
      approvalNote: 'AC-07 验收',
    });
    const bundleQa = bundle.files.find((file) => file.kind === 'qa_report');
    record(
      4,
      'Gate 3 交付包为成功运行产出，qa-report.json 哈希与 qa_reports 及磁盘字节三方一致',
      bundle.files.length === 5 &&
        Boolean(bundleQa) &&
        bundleQa?.sha256 === cleanFinal?.reportSha256 &&
        bundle.bundle.qaReportSha256 === cleanFinal?.reportSha256 &&
        existsSync(cleanFinalFile) &&
        sha256File(cleanFinalFile) === bundleQa?.sha256,
      bundleQa
        ? `files=${bundle.files.length} qa=${bundleQa.fileName} sha=${bundleQa.sha256.slice(0, 12)}…`
        : `交付包缺少 qa_report（files=${bundle.files.length}）`,
    );

    // ── #5 / #6 / #7 / #10 trace privacy block ────────────────────────────
    const traceRunId = await createRun(stack, {
      videoId: VIDEO_TRACE,
      idempotencyKey: 'qa-trace',
      capture: { enabled: true },
    });
    captureScenarios.set(traceRunId, {
      clip: 'motion',
      trace: 'leaky',
      // A secret in an ancillary PNG chunk: invisible in the pixels, readable
      // by anyone who opens the file, and the reason a *real* image hit yields
      // a server-redacted evidence frame without needing OCR (#10).
      pngText: { keyword: 'Author', text: `owner=${SECRET_EMAIL}` },
    });
    const traceOutcome = await approveAndFinish(stack, traceRunId);
    const traceCaptureReport = stack.qaReports.getByRun(WORKSPACE_ID, traceRunId, 'capture');
    const traceHits =
      traceCaptureReport?.report.findings.filter(
        (finding) => finding.sourceKind === 'capture_trace' && finding.category === 'privacy',
      ) ?? [];
    const screenshotHits =
      traceCaptureReport?.report.findings.filter(
        (finding) => finding.sourceKind === 'capture_screenshot' && finding.category === 'privacy',
      ) ?? [];
    record(
      5,
      'AC-07 · trace 中的 Bearer JWT / GitHub Token / 邮箱让 qa_capture 以 qa_privacy_blocked 终态失败',
      traceOutcome.status === 'failed' &&
        traceOutcome.failureCode === 'qa_privacy_blocked' &&
        traceOutcome.stepStatus.get('qa_capture') === 'failed' &&
        traceOutcome.failureRetryable === false &&
        (traceCaptureReport?.report.summary.privacyBlockerCount ?? 0) > 0 &&
        traceHits.length > 0,
      `status=${traceOutcome.status} code=${traceOutcome.failureCode ?? '-'} retryable=${traceOutcome.failureRetryable ?? '-'} privacyBlockers=${traceCaptureReport?.report.summary.privacyBlockerCount ?? 0} trace命中=${traceHits.length} 截图命中=${screenshotHits.length}`,
    );

    const traceRunDir = runDirOf(artifactDir, traceRunId);
    const traceArtifactsDir = path.join(traceRunDir, 'artifacts');
    const strayMp4 = existsSync(traceArtifactsDir)
      ? readdirSync(traceArtifactsDir).filter((name) => name.endsWith('.mp4'))
      : [];
    record(
      6,
      '早拦截止损：TTS 与渲染从未执行，运行目录里没有任何成片 MP4',
      traceOutcome.stepStatus.get('synthesize_voice') === 'pending' &&
        traceOutcome.stepStatus.get('render_video') === 'pending' &&
        strayMp4.length === 0,
      `synthesize_voice=${traceOutcome.stepStatus.get('synthesize_voice') ?? '-'} render_video=${traceOutcome.stepStatus.get('render_video') ?? '-'} mp4=${strayMp4.length}`,
    );

    const traceCaptureFile = path.join(traceRunDir, 'qa', 'qa-capture-report.json');
    const traceReportText = existsSync(traceCaptureFile) ? readFileSync(traceCaptureFile, 'utf8') : '';
    const traceEnvelope = await stack.orchestrator.getLatestQaReport(WORKSPACE_ID, VIDEO_TRACE);
    const traceApiText = traceEnvelope ? JSON.stringify(traceEnvelope) : '';
    const secrets = [SECRET_EMAIL, SECRET_TOKEN, SECRET_JWT];
    const leaked = secrets.filter(
      (secret) => traceReportText.includes(secret) || traceApiText.includes(secret),
    );
    const redactedHits =
      traceCaptureReport?.report.findings.filter(
        (finding) => finding.matchRedacted !== undefined && finding.matchSha256 !== undefined,
      ) ?? [];
    record(
      7,
      '反向泄密零明文：报告磁盘字节与 Gate 3 API 响应都不含原始 token / 邮箱 / JWT，只保留脱敏与哈希',
      traceReportText.length > 0 &&
        traceApiText.length > 0 &&
        leaked.length === 0 &&
        redactedHits.length === traceCaptureReport?.report.findings.length,
      `报告字节=${traceReportText.length} api字节=${traceApiText.length} 明文泄漏=${leaked.length} 脱敏命中=${redactedHits.length}/${traceCaptureReport?.report.findings.length ?? 0}`,
    );

    const traceDetail = await stack.orchestrator.getRun(WORKSPACE_ID, traceRunId);
    const evidenceArtifacts =
      traceDetail?.artifacts.filter((artifact) => artifact.kind === 'qa_evidence_frame') ?? [];
    const redactedEvidence = evidenceArtifacts.find(
      (artifact) => artifact.metadata.redacted === true,
    );
    const screenshotArtifact = traceDetail?.artifacts.find(
      (artifact) => artifact.kind === 'capture_screenshot',
    );
    const evidenceFile = redactedEvidence ? artifactFile(artifactDir, redactedEvidence) : undefined;
    const screenshotFile = screenshotArtifact ? artifactFile(artifactDir, screenshotArtifact) : undefined;
    record(
      10,
      '隐私证据帧经服务端 boxblur 脱敏后登记为 qa_evidence_frame，SHA256 与原始截图不同且为合法 PNG',
      Boolean(redactedEvidence && evidenceFile && existsSync(evidenceFile)) &&
        evidenceFile !== undefined &&
        sha256File(evidenceFile) === redactedEvidence?.sha256 &&
        readFileSync(evidenceFile).subarray(1, 4).toString('ascii') === 'PNG' &&
        Boolean(
          screenshotFile &&
            existsSync(screenshotFile) &&
            screenshotArtifact?.sha256 !== redactedEvidence?.sha256,
        ),
      redactedEvidence && evidenceFile
        ? `evidence=${redactedEvidence.fileName} sha=${redactedEvidence.sha256.slice(0, 12)}… 原截图sha=${screenshotArtifact?.sha256.slice(0, 12) ?? '-'}…`
        : `没有 redacted qa_evidence_frame（证据帧=${evidenceArtifacts.length}）`,
    );

    // ── #15 Gate 3 can see the blocked run ────────────────────────────────
    const envelopeEvidence = evidenceOf(traceEnvelope);
    record(
      15,
      'Gate 3 接口对被 QA 阻断的运行返回完整定位报告与证据帧列表',
      traceEnvelope !== null &&
        traceEnvelope.report.verdict === 'fail' &&
        traceEnvelope.report.findings.some((finding) => finding.category === 'privacy') &&
        traceEnvelope.report.findings.some((finding) => finding.matchRedacted !== undefined) &&
        envelopeEvidence.length > 0,
      traceEnvelope
        ? `verdict=${traceEnvelope.report.verdict} findings=${traceEnvelope.report.findings.length} evidence=${envelopeEvidence.length}`
        : '没有取到报告',
    );

    // ── #16 export bypass refused ─────────────────────────────────────────
    const bypass = await captureError(() =>
      stack.orchestrator.createExportBundle(WORKSPACE_ID, {
        videoId: VIDEO_TRACE,
        runId: traceRunId,
      }),
    );
    record(
      16,
      'Gate 3 防绕过：视频已批准但运行被 QA 阻断时，导出仍以 409 拒绝',
      bypass.httpStatus === 409 &&
        ['export_run_missing', 'export_qa_missing', 'export_qa_blocked'].includes(bypass.code),
      `status=${bypass.httpStatus} code=${bypass.code}`,
    );

    // ── #11 subtitle / scene-text privacy block ───────────────────────────
    const subtitleRunId = await createRun(stack, {
      videoId: VIDEO_SUBTITLE,
      idempotencyKey: 'qa-subtitle',
      capture: { enabled: false },
    });
    const subtitle = await finishRun(stack, subtitleRunId);
    const subtitleFinal = stack.qaReports.getByRun(WORKSPACE_ID, subtitleRunId, 'final');
    const subtitleSources = new Set(
      (subtitleFinal?.report.findings ?? [])
        .filter((finding) => finding.category === 'privacy')
        .map((finding) => finding.sourceKind),
    );
    const subtitleDetail = await stack.orchestrator.getRun(WORKSPACE_ID, subtitleRunId);
    const subtitleMp4 = (subtitleDetail?.artifacts ?? []).some(
      (artifact) => artifact.kind === 'video_mp4',
    );
    record(
      11,
      'AC-07 · 镜头字幕中的邮箱让 qa_final 命中 scene_text / subtitle_srt 并阻断，不登记 video_mp4',
      subtitle.status === 'failed' &&
        subtitle.failureCode === 'qa_privacy_blocked' &&
        (subtitleSources.has('scene_text') || subtitleSources.has('subtitle_srt')) &&
        !subtitleMp4,
      `status=${subtitle.status} code=${subtitle.failureCode ?? '-'} sources=${[...subtitleSources].join(',') || '-'} video_mp4=${subtitleMp4}`,
    );

    // ── #12 black frame ───────────────────────────────────────────────────
    const blackRunId = await createRun(stack, {
      videoId: VIDEO_BLACK,
      idempotencyKey: 'qa-black',
      capture: { enabled: false },
    });
    const black = await finishRun(stack, blackRunId);
    const blackFinal = stack.qaReports.getByRun(WORKSPACE_ID, blackRunId, 'final');
    const blackFinding = blackFinal?.report.findings.find(
      (finding) => finding.ruleId === 'technical.black_frame',
    );
    record(
      12,
      '技术 QA · 第 2 镜内 1.5s 纯黑帧命中 technical.black_frame blocker，并定位到镜头与时间点',
      black.status === 'failed' &&
        black.failureCode === 'qa_technical_blocked' &&
        blackFinding?.severity === 'blocker' &&
        blackFinding.location.scope === 'scene' &&
        blackFinding.location.sceneId === 'scene_black_2' &&
        typeof blackFinding.location.timestampMs === 'number',
      blackFinding
        ? `code=${black.failureCode ?? '-'} scene=${blackFinding.location.sceneId ?? '-'} @${blackFinding.location.timestampMs ?? '-'}ms duration=${blackFinding.location.durationMs ?? '-'}ms severity=${blackFinding.severity}`
        : `没有命中（status=${black.status} code=${black.failureCode ?? '-'}）`,
    );

    // ── #13 freeze frame ──────────────────────────────────────────────────
    const freezeRunId = await createRun(stack, {
      videoId: VIDEO_FREEZE,
      idempotencyKey: 'qa-freeze',
      capture: { enabled: true },
    });
    captureScenarios.set(freezeRunId, { clip: 'static', trace: 'clean' });
    const freeze = await approveAndFinish(stack, freezeRunId);
    const freezeCapture = stack.qaReports.getByRun(WORKSPACE_ID, freezeRunId, 'capture');
    const freezeFinding = freezeCapture?.report.findings.find(
      (finding) => finding.ruleId === 'technical.freeze_frame',
    );
    record(
      13,
      '技术 QA · 全程静止 8s 的录屏片段命中 technical.freeze_frame blocker（含末帧仍静止的收口）',
      freeze.failureCode === 'qa_technical_blocked' && freezeFinding?.severity === 'blocker',
      freezeFinding
        ? `code=${freeze.failureCode ?? '-'} severity=${freezeFinding.severity} @${freezeFinding.location.timestampMs ?? '-'}ms duration=${freezeFinding.location.durationMs ?? '-'}ms`
        : `没有命中（status=${freeze.status} code=${freeze.failureCode ?? '-'}）`,
    );

    // ── #17 tampered report ───────────────────────────────────────────────
    if (!existsSync(cleanFinalFile)) throw new Error('干净运行没有 qa-final-report.json');
    const originalBytes = readFileSync(cleanFinalFile);
    writeFileSync(cleanFinalFile, Buffer.concat([originalBytes, Buffer.from(' ')]));
    let readCode: string | undefined;
    try {
      await stack.orchestrator.getRunQaReport(WORKSPACE_ID, cleanRunId, 'final');
    } catch (error) {
      readCode = error instanceof OrchestrationHttpError ? error.code : undefined;
    }
    const tamperExport = await captureError(() =>
      stack.orchestrator.createExportBundle(WORKSPACE_ID, {
        videoId: VIDEO_CLEAN,
        runId: cleanRunId,
      }),
    );
    writeFileSync(cleanFinalFile, originalBytes);
    record(
      17,
      'Gate 3 防绕过：篡改 qa-final-report.json 后读取 409 qa_report_tampered，导出 409 export_hash_mismatch',
      readCode === 'qa_report_tampered' && tamperExport.code === 'export_hash_mismatch',
      `read=${readCode ?? '-'} export=${tamperExport.code}（原文件已还原）`,
    );

    // ── #14 fail closed when OCR is unavailable ───────────────────────────
    const failClosed = await runFailClosedScenario(tempRoot, snapshot);
    record(
      14,
      'Fail-Closed · OCR 不可用时阻断 qa_ocr_unavailable，绝不放行 pass',
      failClosed.status === 'failed' &&
        failClosed.failureCode === 'qa_ocr_unavailable' &&
        failClosed.reportVerdict === 'fail',
      `status=${failClosed.status} code=${failClosed.failureCode ?? '-'} verdict=${failClosed.reportVerdict ?? '-'}`,
    );

    // ── #18 silent regression ─────────────────────────────────────────────
    const silentRunId = await createRun(stack, {
      videoId: VIDEO_SILENT,
      idempotencyKey: 'qa-silent',
      narration: { enabled: false, timingPolicy: 'extend_scene' },
      capture: { enabled: false },
    });
    const silent = await finishRun(stack, silentRunId);
    const silentKeys = [
      'plan_demo',
      'capture_demo',
      'qa_capture',
      'synthesize_voice',
      'generate_subtitles',
    ];
    record(
      18,
      '5A/5B 零回归：capture/narration 关闭时 5 个步骤创建即 skipped，qa_final 仍执行并通过',
      silent.status === 'succeeded' &&
        silentKeys.every((key) => silent.stepStatus.get(key) === 'skipped') &&
        silent.stepStatus.get('qa_final') === 'succeeded',
      silent.status === 'succeeded'
        ? `${silentKeys.map((key) => `${key}:${silent.stepStatus.get(key)}`).join(' · ')} · qa_final:${silent.stepStatus.get('qa_final')}`
        : `status=${silent.status} code=${silent.failureCode ?? '-'}`,
    );

    // ── #8 / #9 real OCR ──────────────────────────────────────────────────
    if (hasTesseract) {
      const ocrRunId = await createRun(stack, {
        videoId: VIDEO_OCR,
        idempotencyKey: 'qa-ocr',
        capture: { enabled: true },
      });
      captureScenarios.set(ocrRunId, {
        clip: 'motion',
        trace: 'clean',
        screenshotText: SECRET_TOKEN,
        clipText: 'ceo@acme-internal.io',
      });
      const ocr = await approveAndFinish(stack, ocrRunId);
      const ocrCapture = stack.qaReports.getByRun(WORKSPACE_ID, ocrRunId, 'capture');
      const screenshotHits =
        ocrCapture?.report.findings.filter(
          (finding) => finding.sourceKind === 'capture_screenshot' && finding.category === 'privacy',
        ) ?? [];
      const clipFrameHits =
        ocrCapture?.report.findings.filter(
          (finding) => finding.sourceKind === 'capture_frame' && finding.category === 'privacy',
        ) ?? [];
      record(
        8,
        'AC-07 · 截图 PNG 经真实 OCR 命中 GitHub Token 并阻断',
        ocr.failureCode === 'qa_privacy_blocked' && screenshotHits.length > 0,
        `code=${ocr.failureCode ?? '-'} 截图命中=${screenshotHits.length}`,
      );
      record(
        9,
        'AC-07 · 录屏视频帧经真实 OCR 命中邮箱，并定位到 timestampMs',
        ocr.failureCode === 'qa_privacy_blocked' &&
          clipFrameHits.length > 0 &&
          clipFrameHits.some((finding) => typeof finding.location.timestampMs === 'number'),
        `录屏帧命中=${clipFrameHits.length} ts=${clipFrameHits.map((finding) => finding.location.timestampMs ?? '-').join(',') || '-'}`,
      );
    } else {
      skip(
        8,
        'AC-07 · 截图 PNG 真实 OCR 阻断',
        '本机没有 tesseract；#10 已用真实 PNG tEXt 命中证明「图像命中 → 服务端脱敏证据帧」整条链路，仅 OCR 引擎本身未验证',
      );
      skip(
        9,
        'AC-07 · 录屏视频帧真实 OCR 扫描',
        '本机没有 tesseract；抽帧、扫描与定位逻辑由 #12/#13 的真实 ffmpeg 路径覆盖，OCR 文本未执行',
      );
    }
  } finally {
    await stack.orchestrator.stop().catch(() => undefined);
    stack.db.close();
    const exportDir = process.env.ASVS_VERIFY_EXPORT_DIR?.trim();
    if (exportDir) {
      rmSync(exportDir, { recursive: true, force: true });
      cpSync(tempRoot, exportDir, { recursive: true });
      process.stdout.write(`\n验收证据已复制：${exportDir}\n`);
    }
    if (process.env.ASVS_KEEP_VERIFY_DIR) {
      process.stdout.write(`临时目录保留：${tempRoot}\n`);
    } else if (!exportDir) {
      rmSync(tempRoot, { recursive: true, force: true });
    }
  }

  // ── Summary ─────────────────────────────────────────────────────────────
  const passed = reports.filter((report) => report.status === 'pass').length;
  const failed = reports.filter((report) => report.status === 'fail');
  const skipped = reports.filter((report) => report.status === 'skip');
  process.stdout.write(`${'─'.repeat(78)}\n`);
  process.stdout.write(
    `  ${passed} 项通过 · ${failed.length} 项失败 · ${skipped.length} 项跳过 · 用时 ${((Date.now() - startedAt) / 1000).toFixed(1)}s\n`,
  );
  if (skipped.length > 0) {
    process.stdout.write(
      `  跳过：${skipped.map((report) => `#${report.id}`).join(' ')}（本机缺 tesseract，未冒充通过）\n`,
    );
  }
  if (failed.length > 0) {
    process.stdout.write('\n失败项：\n');
    for (const report of failed) {
      process.stdout.write(`  ✗ #${report.id} ${report.name}\n      ${report.detail}\n`);
    }
    process.exitCode = 1;
    return;
  }
  process.stdout.write('\n所有可执行的 QA 断言均通过。\n\n');
}

/** A second stack whose OCR provider is `unconfigured`: QA must fail closed. */
async function runFailClosedScenario(
  parentTempRoot: string,
  snapshot: StudioSnapshot,
): Promise<{ status: string; failureCode?: string; reportVerdict?: string }> {
  const root = path.join(parentTempRoot, 'failclosed');
  mkdirSync(root, { recursive: true });
  const scenarios = new Map<string, CaptureScenario>();
  const stack = openStack({
    dbPath: path.join(root, 'qa.sqlite'),
    artifactDir: path.join(root, 'artifacts'),
    snapshot: () => snapshot,
    qaConfig: { ...BASE_QA_CONFIG, ocrProvider: 'unconfigured' },
    ocr: 'unconfigured',
    renderExecutor: new RealMediaRenderExecutor({
      blackVideoIds: new Set(),
      ocrOverlays: new Map(),
    }),
    capture: new RealMediaCaptureExecutor((runId) => {
      const scenario = scenarios.get(runId);
      if (!scenario) throw new Error(`未登记录屏场景的 run：${runId}`);
      return scenario;
    }),
  });
  insertWorkspace(stack.db, snapshot);
  try {
    await stack.orchestrator.start();
    const runId = await createRun(stack, {
      videoId: VIDEO_UNCONFIGURED,
      idempotencyKey: 'qa-unconfigured',
      capture: { enabled: true },
    });
    scenarios.set(runId, { clip: 'motion', trace: 'clean', screenshotText: 'no ocr available' });
    const outcome = await approveAndFinish(stack, runId);
    const report = stack.qaReports.getByRun(WORKSPACE_ID, runId, 'capture');
    return {
      status: outcome.status,
      ...(outcome.failureCode ? { failureCode: outcome.failureCode } : {}),
      ...(report ? { reportVerdict: report.report.verdict } : {}),
    };
  } finally {
    await stack.orchestrator.stop().catch(() => undefined);
    stack.db.close();
  }
}

main().catch((error) => {
  process.stderr.write(
    `\n验收脚本异常：${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`,
  );
  process.exitCode = 1;
});
