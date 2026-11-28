import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import path from 'node:path';
import { inflateSync } from 'node:zlib';
import { runQaProcess } from './process-runner';
import type { MediaTools, QaProcessContext } from './media-qa';
import type { SceneTimelineWindow } from './scene-mapper';

/**
 * Deterministic frame extraction + evidence-frame generation (docs/16 §5.3).
 *
 * Two hard rules shape this module:
 *
 * 1. **Nothing sensitive survives into evidence.** A frame that contains a
 *    privacy hit is never exposed: `renderRedactedEvidence` blurs the whole
 *    image (`boxblur`) and stamps a border (`drawbox`), and only the result is
 *    registered as `qa_evidence_frame`. No external font is used, so the same
 *    command works on Windows and Linux (drawtext would need fontconfig).
 * 2. **Temporary frames never accumulate.** Extraction writes under
 *    `qa/frames-tmp/`, and the runner removes that directory in a `finally`.
 */

export interface ExtractedFrame {
  /** Absolute path inside `qa/frames-tmp/`. */
  file: string;
  timestampMs: number;
  sha256: string;
  /** Set only when the frame belongs to a specific scene window. */
  sceneId?: string;
  sceneOrder?: number;
  frameIndex: number;
}

export interface FramePlanPoint {
  timestampMs: number;
  sceneId?: string;
  sceneOrder?: number;
}

const MAX_OUTPUT_WIDTH = 1920;

async function runFfmpeg(args: string[], context: QaProcessContext): Promise<void> {
  const result = await runQaProcess('ffmpeg', args, {
    timeoutMs: context.timeoutMs ?? 60_000,
    ...(context.signal ? { signal: context.signal } : {}),
  });
  if (result.spawnError) throw new Error(`无法运行 ffmpeg：${result.spawnError.message}`);
  if (result.code !== 0) {
    throw new Error(`ffmpeg 失败（exit ${result.code}）：${result.stderr.trim().slice(0, 400)}`);
  }
}

function sha256OfFile(file: string): string {
  return createHash('sha256').update(readFileSync(file)).digest('hex');
}

/**
 * Evenly sampled timestamps for a clip of `durationMs`: first frame, last
 * frame, and `fps`-derived points in between, capped at `maxFrames`.
 *
 * The last point must stay strictly **before** the container duration. Seeking
 * to a timestamp at or past the final frame's presentation time makes ffmpeg
 * emit no frame at all (`-frames:v 1` then writes nothing), which the runner
 * reports as `technical.execution_error` — a clean capture would fail QA.
 * `fps` is the sampling rate, not the material's frame rate, so the margin is
 * a fixed 100 ms: wider than one frame at 30 fps (33 ms) and 10 fps (100 ms),
 * and still close enough to the end that a clip frozen on its final frame is
 * sampled there.
 */
const END_MARGIN_MS = 100;

export function planClipFrameTimes(
  durationMs: number,
  maxFrames: number,
  fps = 1,
): number[] {
  if (durationMs <= 0) return [0];
  const cap = Math.max(2, maxFrames);
  const natural = Math.floor((durationMs / 1000) * fps) + 1;
  const count = Math.min(cap, Math.max(2, natural));
  const lastMs = Math.max(0, durationMs - END_MARGIN_MS);
  const times = new Set<number>();
  times.add(0);
  times.add(lastMs);
  for (let index = 1; index <= count; index += 1) {
    times.add(Math.min(lastMs, Math.round((lastMs * index) / count)));
  }
  const sorted = [...times].sort((left, right) => left - right);
  if (sorted.length <= cap) return sorted;
  // Thin the middle only: the first and last probes are the ones that catch a
  // clip that never started or froze on its final frame.
  const picked = new Set<number>([sorted[0]!, sorted[sorted.length - 1]!]);
  for (let index = 1; index < cap - 1; index += 1) {
    picked.add(sorted[Math.round((index * (sorted.length - 1)) / (cap - 1))]!);
  }
  return [...picked].sort((left, right) => left - right);
}

/**
 * Scene-aware sampling for the final film: three probes (15/50/85%) for a
 * static scene, one per second for `real_demo` scenes, capped at `maxFrames`
 * by even thinning.
 */
export function planSceneFrameTimes(
  windows: SceneTimelineWindow[],
  maxFrames: number,
): FramePlanPoint[] {
  const points: FramePlanPoint[] = [];
  for (const window of windows) {
    const length = window.endMs - window.startMs;
    if (length <= 0) continue;
    if (window.visualType === 'real_demo') {
      const perSecond = Math.max(1, Math.floor(length / 1000));
      for (let index = 0; index < perSecond; index += 1) {
        points.push({
          timestampMs: window.startMs + Math.round(((index + 0.5) * length) / perSecond),
          sceneId: window.sceneId,
          sceneOrder: window.sceneOrder,
        });
      }
    } else {
      for (const ratio of [0.15, 0.5, 0.85]) {
        points.push({
          timestampMs: window.startMs + Math.round(length * ratio),
          sceneId: window.sceneId,
          sceneOrder: window.sceneOrder,
        });
      }
    }
  }
  if (points.length <= maxFrames) return points;
  const step = (points.length - 1) / (maxFrames - 1);
  const picked = new Set<number>();
  for (let index = 0; index < maxFrames; index += 1) picked.add(Math.round(index * step));
  return [...picked].sort((left, right) => left - right).map((index) => points[index]!);
}

/** Extract one PNG at a timestamp; returns the SHA256 for cross-frame dedupe. */
export async function extractFrameAt(
  videoFile: string,
  timestampMs: number,
  outFile: string,
  tools: MediaTools,
  context: QaProcessContext = {},
): Promise<string> {
  mkdirSync(path.dirname(outFile), { recursive: true });
  await runFfmpeg(
    [
      '-hide_banner', '-loglevel', 'error', '-nostdin',
      '-ss', (Math.max(0, timestampMs) / 1000).toFixed(3),
      '-i', videoFile,
      '-frames:v', '1',
      '-vf', `scale='min(${MAX_OUTPUT_WIDTH},iw)':-2`,
      '-y', outFile,
    ],
    context,
  );
  if (!existsSync(outFile)) {
    throw new Error(`ffmpeg 未产出帧：${timestampMs}ms`);
  }
  return sha256OfFile(outFile);
}

/** Distinct frames only: identical PNG bytes are OCR'd once. */
export interface FrameBatchResult {
  frames: ExtractedFrame[];
  /** Points skipped because an identical frame was already extracted. */
  duplicates: number;
}

export async function extractFrameBatch(
  videoFile: string,
  points: FramePlanPoint[],
  tempDir: string,
  tools: MediaTools,
  context: QaProcessContext = {},
): Promise<FrameBatchResult> {
  mkdirSync(tempDir, { recursive: true });
  const frames: ExtractedFrame[] = [];
  const seen = new Set<string>();
  let duplicates = 0;
  for (const [index, point] of points.entries()) {
    const file = path.join(tempDir, `frame-${String(index).padStart(4, '0')}.png`);
    const sha256 = await extractFrameAt(videoFile, point.timestampMs, file, tools, context);
    if (seen.has(sha256)) {
      duplicates += 1;
      rmSync(file, { force: true });
      continue;
    }
    seen.add(sha256);
    frames.push({
      file,
      timestampMs: point.timestampMs,
      sha256,
      frameIndex: index,
      ...(point.sceneId ? { sceneId: point.sceneId } : {}),
      ...(point.sceneOrder !== undefined ? { sceneOrder: point.sceneOrder } : {}),
    });
  }
  return { frames, duplicates };
}

/**
 * Privacy evidence frame: whole-image blur + red border. The original never
 * leaves `qa/frames-tmp/`; this output is what Gate 3 may display.
 */
export async function renderRedactedEvidence(
  sourceImage: string,
  outFile: string,
  context: QaProcessContext = {},
): Promise<void> {
  mkdirSync(path.dirname(outFile), { recursive: true });
  await runFfmpeg(
    [
      '-hide_banner', '-loglevel', 'error', '-nostdin',
      '-i', sourceImage,
      '-vf', 'boxblur=18:3,drawbox=x=0:y=0:w=iw:h=ih:color=red@0.8:t=8,format=rgba,colorchannelmixer=aa=1',
      '-frames:v', '1',
      '-y', outFile,
    ],
    context,
  );
}

/** Technical evidence frame: unblurred, with a red border marking the spot. */
export async function renderAnnotatedEvidence(
  sourceImage: string,
  outFile: string,
  context: QaProcessContext = {},
): Promise<void> {
  mkdirSync(path.dirname(outFile), { recursive: true });
  await runFfmpeg(
    [
      '-hide_banner', '-loglevel', 'error', '-nostdin',
      '-i', sourceImage,
      '-vf', 'drawbox=x=0:y=0:w=iw:h=ih:color=red@0.9:t=10',
      '-frames:v', '1',
      '-y', outFile,
    ],
    context,
  );
}

export interface PngTextMetadata {
  keyword: string;
  text: string;
}

/**
 * Read `tEXt` / `zTXt` / `iTXt` chunks from a PNG.
 *
 * Screenshots can smuggle data through ancillary text chunks that no OCR pass
 * would ever see (`tEXt Author: ceo@…`), so AC-07 scans them explicitly. The
 * parser is bounded and tolerant: a malformed chunk ends parsing rather than
 * throwing, because a broken screenshot is a technical finding elsewhere.
 */
export function readPngTextChunks(buffer: Buffer): PngTextMetadata[] {
  if (buffer.length < 8 || buffer.readUInt32BE(0) !== 0x89504e47 || buffer.readUInt32BE(4) !== 0x0d0a1a0a) {
    return [];
  }
  const results: PngTextMetadata[] = [];
  let offset = 8;
  while (offset + 8 <= buffer.length) {
    const length = buffer.readUInt32BE(offset);
    const type = buffer.toString('ascii', offset + 4, offset + 8);
    const dataStart = offset + 8;
    const dataEnd = dataStart + length;
    if (length < 0 || dataEnd + 4 > buffer.length) break;
    const data = buffer.subarray(dataStart, dataEnd);
    try {
      if (type === 'tEXt') {
        const zero = data.indexOf(0);
        if (zero > 0) {
          results.push({
            keyword: data.toString('latin1', 0, zero),
            text: data.toString('latin1', zero + 1),
          });
        }
      } else if (type === 'zTXt') {
        const zero = data.indexOf(0);
        if (zero > 0 && zero + 2 <= data.length) {
          const inflated = inflateSync(data.subarray(zero + 2));
          results.push({
            keyword: data.toString('latin1', 0, zero),
            text: inflated.toString('utf8'),
          });
        }
      } else if (type === 'iTXt') {
        const keywordEnd = data.indexOf(0);
        if (keywordEnd > 0 && keywordEnd + 3 <= data.length) {
          const compressed = data[keywordEnd + 1] === 1;
          // keyword\0 compressionFlag compressionMethod language\0 translated\0 text
          let cursor = keywordEnd + 3;
          const languageEnd = data.indexOf(0, cursor);
          if (languageEnd < 0) break;
          cursor = languageEnd + 1;
          const translatedEnd = data.indexOf(0, cursor);
          if (translatedEnd < 0) break;
          const textData = data.subarray(translatedEnd + 1);
          const text = compressed ? inflateSync(textData).toString('utf8') : textData.toString('utf8');
          results.push({ keyword: data.toString('latin1', 0, keywordEnd), text });
        }
      } else if (type === 'IEND') {
        break;
      }
    } catch {
      // Bad chunk payload: stop rather than trust partial data.
      break;
    }
    offset = dataEnd + 4;
  }
  return results;
}

/** Write a text payload next to an image for the deterministic OCR adapter. */
export function writeOcrSidecar(imageFile: string, text: string): void {
  writeFileSync(`${imageFile}.ocr.txt`, text, 'utf8');
}
