import { runQaProcess } from './process-runner';
import type { SceneTimelineWindow } from './scene-mapper';

/**
 * Deterministic media checks (docs/16 §5.4). Nothing here trusts a worker's
 * JSON report: every fact is re-derived from the bytes on disk with ffmpeg and
 * ffprobe, exactly the tools the renderer used but invoked independently.
 */

export interface MediaTools {
  ffmpegBin: string;
  ffprobeBin: string;
}

export interface QaProcessContext {
  signal?: AbortSignal;
  timeoutMs?: number;
}

export interface ProbeStream {
  codecType: string;
  codecName: string;
  width?: number;
  height?: number;
  fps?: number;
  durationMs?: number;
  frameCount?: number;
  sampleRate?: number;
  channels?: number;
}

export interface MediaProbe {
  durationMs: number;
  bitRate?: number;
  video?: ProbeStream;
  audio?: ProbeStream;
}

export interface DecodeResult {
  ok: boolean;
  /** ffmpeg `-v error` output; empty on a clean decode. */
  stderr: string;
  exitCode: number | null;
}

export interface BlackSpan {
  startMs: number;
  endMs: number;
  durationMs: number;
}

export interface FreezeSpan {
  startMs: number;
  endMs: number;
  durationMs: number;
}

export interface VolumeReport {
  meanVolumeDb: number;
  maxVolumeDb: number;
}

function toMs(seconds: string | number | undefined): number {
  const value = Number(seconds);
  return Number.isFinite(value) ? Math.round(value * 1000) : 0;
}

function parseFrameRate(value: string | undefined): number {
  if (!value) return 0;
  const [numerator, denominator] = value.split('/').map(Number);
  if (!numerator || !denominator) return 0;
  return numerator / denominator;
}

interface FfprobeJson {
  streams?: Array<{
    codec_type?: string;
    codec_name?: string;
    width?: number;
    height?: number;
    r_frame_rate?: string;
    avg_frame_rate?: string;
    nb_frames?: string;
    sample_rate?: string;
    channels?: number;
    duration?: string;
  }>;
  format?: { duration?: string; bit_rate?: string };
}

/** Single ffprobe call; throws for a file ffprobe cannot open at all. */
export async function probeMedia(
  file: string,
  tools: MediaTools,
  context: QaProcessContext = {},
): Promise<MediaProbe> {
  const result = await runQaProcess(
    tools.ffprobeBin,
    ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', file],
    { timeoutMs: context.timeoutMs ?? 60_000, ...(context.signal ? { signal: context.signal } : {}) },
  );
  if (result.spawnError) {
    throw new Error(`无法运行 ffprobe：${result.spawnError.message}`);
  }
  if (result.code !== 0) {
    throw new Error(`ffprobe 读取失败（exit ${result.code}）：${result.stderr.trim().slice(0, 400)}`);
  }
  let parsed: FfprobeJson;
  try {
    parsed = JSON.parse(result.stdout) as FfprobeJson;
  } catch {
    throw new Error('ffprobe 输出不是合法 JSON');
  }
  const videoStream = parsed.streams?.find((stream) => stream.codec_type === 'video');
  const audioStream = parsed.streams?.find((stream) => stream.codec_type === 'audio');
  const durationMs = Math.round(Number(parsed.format?.duration ?? 0) * 1000);
  return {
    durationMs,
    ...(parsed.format?.bit_rate ? { bitRate: Number(parsed.format.bit_rate) } : {}),
    ...(videoStream
      ? {
          video: {
            codecType: 'video',
            codecName: videoStream.codec_name ?? '',
            width: videoStream.width,
            height: videoStream.height,
            fps: parseFrameRate(videoStream.r_frame_rate) || parseFrameRate(videoStream.avg_frame_rate),
            durationMs,
            frameCount: Number(videoStream.nb_frames ?? 0) || undefined,
          },
        }
      : {}),
    ...(audioStream
      ? {
          audio: {
            codecType: 'audio',
            codecName: audioStream.codec_name ?? '',
            sampleRate: Number(audioStream.sample_rate ?? 0) || undefined,
            channels: audioStream.channels,
            durationMs: audioStream.duration ? toMs(audioStream.duration) : durationMs,
          },
        }
      : {}),
  };
}

/** Full decode: a container that exists but cannot be played fails here. */
export async function assertDecodable(
  file: string,
  tools: MediaTools,
  context: QaProcessContext = {},
): Promise<DecodeResult> {
  const result = await runQaProcess(
    tools.ffmpegBin,
    ['-v', 'error', '-nostdin', '-i', file, '-f', 'null', '-'],
    { timeoutMs: context.timeoutMs ?? 120_000, ...(context.signal ? { signal: context.signal } : {}) },
  );
  if (result.spawnError) {
    throw new Error(`无法运行 ffmpeg：${result.spawnError.message}`);
  }
  return {
    ok: result.code === 0 && result.stderr.trim() === '',
    stderr: result.stderr.trim().slice(0, 2000),
    exitCode: result.code,
  };
}

/** `blackdetect` spans (pix_th default 0.10, min span 0.3s). */
export async function detectBlackSpans(
  file: string,
  tools: MediaTools,
  context: QaProcessContext = {},
): Promise<BlackSpan[]> {
  const result = await runQaProcess(
    tools.ffmpegBin,
    ['-hide_banner', '-nostdin', '-i', file, '-vf', 'blackdetect=d=0.3:pix_th=0.10', '-an', '-f', 'null', '-'],
    { timeoutMs: context.timeoutMs ?? 120_000, ...(context.signal ? { signal: context.signal } : {}) },
  );
  if (result.spawnError) {
    throw new Error(`无法运行 ffmpeg：${result.spawnError.message}`);
  }
  if (result.code !== 0) {
    throw new Error(`blackdetect 失败（exit ${result.code}）：${result.stderr.trim().slice(0, 400)}`);
  }
  const spans: BlackSpan[] = [];
  for (const line of result.stderr.split('\n')) {
    const match = line.match(
      /black_start:\s*([\d.]+)\s+black_end:\s*([\d.]+)\s+black_duration:\s*([\d.]+)/,
    );
    if (!match) continue;
    const startMs = toMs(match[1]);
    const endMs = toMs(match[2]);
    spans.push({ startMs, endMs, durationMs: toMs(match[3]) });
  }
  return spans;
}

/**
 * `freezedetect` spans. Callers MUST restrict this to capture clips or
 * `real_demo` scene ranges (docs/16 §10): a title/CTA card is motionless by
 * design and would otherwise be reported as a frozen render.
 */
export async function detectFreezeSpans(
  file: string,
  tools: MediaTools,
  options: QaProcessContext & { minDurationSec?: number; startMs?: number; endMs?: number } = {},
): Promise<FreezeSpan[]> {
  const minDuration = options.minDurationSec ?? 3;
  const args = ['-hide_banner', '-nostdin'];
  if (options.startMs !== undefined) {
    args.push('-ss', (options.startMs / 1000).toFixed(3));
  }
  args.push('-i', file);
  if (options.endMs !== undefined) {
    const durationSec = Math.max(0.001, (options.endMs - (options.startMs ?? 0)) / 1000);
    args.push('-t', durationSec.toFixed(3));
  }
  args.push('-vf', `freezedetect=n=-60dB:d=${minDuration}`, '-an', '-f', 'null', '-');
  const result = await runQaProcess(tools.ffmpegBin, args, {
    timeoutMs: options.timeoutMs ?? 120_000,
    ...(options.signal ? { signal: options.signal } : {}),
  });
  if (result.spawnError) {
    throw new Error(`无法运行 ffmpeg：${result.spawnError.message}`);
  }
  if (result.code !== 0) {
    throw new Error(`freezedetect 失败（exit ${result.code}）：${result.stderr.trim().slice(0, 400)}`);
  }
  return parseFreezedetectLog(result.stderr, options.startMs ?? 0);
}

/**
 * Parse `freezedetect` stderr into spans.
 *
 * ffmpeg only prints `freeze_end` when the picture starts moving again. A clip
 * that is frozen **through its final frame** therefore emits `freeze_start`
 * and nothing else — on some builds not even `freeze_duration`. Treating that
 * as "no span" would let a completely static capture pass QA, which is exactly
 * the failure AC-07/technical QA must catch, so an unterminated freeze is
 * closed at the render's own reported end time (the last `time=` progress
 * line). Exported for unit tests: this is pure log parsing, no subprocess.
 */
export function parseFreezedetectLog(stderr: string, offsetMs = 0): FreezeSpan[] {
  const spans: FreezeSpan[] = [];
  let startSeconds: number | undefined;
  let lastDuration: number | undefined;
  let lastTimeSeconds: number | undefined;
  for (const line of stderr.split('\n')) {
    const progress = line.match(/\btime=(\d+):(\d+):([\d.]+)/);
    if (progress) {
      lastTimeSeconds =
        Number(progress[1]) * 3600 + Number(progress[2]) * 60 + Number(progress[3]);
    }
    const start = line.match(/freeze_start:\s*([\d.]+)/);
    if (start) {
      startSeconds = Number(start[1]);
      lastDuration = undefined;
      continue;
    }
    const duration = line.match(/freeze_duration:\s*([\d.]+)/);
    if (duration) {
      lastDuration = Number(duration[1]);
      continue;
    }
    const end = line.match(/freeze_end:\s*([\d.]+)/);
    if (end && startSeconds !== undefined) {
      const endSeconds = Number(end[1]);
      spans.push({
        startMs: offsetMs + toMs(startSeconds),
        endMs: offsetMs + toMs(endSeconds),
        durationMs: toMs(endSeconds - startSeconds),
      });
      startSeconds = undefined;
      lastDuration = undefined;
      continue;
    }
  }
  if (startSeconds !== undefined) {
    // Prefer ffmpeg's explicit freeze_duration when it printed one; otherwise
    // close the span at the last rendered timestamp.
    const endSeconds =
      lastDuration !== undefined
        ? startSeconds + lastDuration
        : (lastTimeSeconds !== undefined && lastTimeSeconds > startSeconds ? lastTimeSeconds : undefined);
    if (endSeconds !== undefined) {
      spans.push({
        startMs: offsetMs + toMs(startSeconds),
        endMs: offsetMs + toMs(endSeconds),
        durationMs: toMs(endSeconds - startSeconds),
      });
    }
  }
  return spans;
}

/** `volumedetect` mean/max volume in dB (`-Infinity` for a digital-silent track). */
export async function measureVolume(
  file: string,
  tools: MediaTools,
  context: QaProcessContext = {},
): Promise<VolumeReport | null> {
  const result = await runQaProcess(
    tools.ffmpegBin,
    [
      '-hide_banner', '-nostdin', '-v', 'info', '-nostats',
      '-i', file, '-map', '0:a:0', '-af', 'volumedetect', '-f', 'null', '-',
    ],
    { timeoutMs: context.timeoutMs ?? 60_000, ...(context.signal ? { signal: context.signal } : {}) },
  );
  if (result.spawnError) {
    throw new Error(`无法运行 ffmpeg：${result.spawnError.message}`);
  }
  if (result.code !== 0) return null;
  const mean = result.stderr.match(/mean_volume:\s*(-?[\d.]+|-inf)\s*dB/i);
  const max = result.stderr.match(/max_volume:\s*(-?[\d.]+|-inf)\s*dB/i);
  if (!mean) return null;
  const toDb = (value: string): number =>
    value.toLowerCase() === '-inf' ? Number.NEGATIVE_INFINITY : Number(value);
  return {
    meanVolumeDb: toDb(mean[1]!),
    maxVolumeDb: max ? toDb(max[1]!) : Number.NEGATIVE_INFINITY,
  };
}

/**
 * Real audio/video length drift, measured independently. `null` when the file
 * has no audio stream at all (silent fixture runs are legal).
 */
export function audioSyncDriftMs(probe: MediaProbe): number | null {
  if (!probe.audio || !probe.video) return null;
  return Math.abs((probe.audio.durationMs ?? 0) - (probe.video.durationMs ?? 0));
}

/** Fraction of a scene window covered by the union of the given spans. */
export function coverageOfWindow(
  spans: Array<{ startMs: number; endMs: number }>,
  window: { startMs: number; endMs: number },
): number {
  const windowLength = window.endMs - window.startMs;
  if (windowLength <= 0) return 0;
  let covered = 0;
  let cursor = window.startMs;
  for (const span of [...spans].sort((left, right) => left.startMs - right.startMs)) {
    const start = Math.max(span.startMs, cursor);
    const end = Math.min(span.endMs, window.endMs);
    if (end > start) {
      covered += end - start;
      cursor = end;
    }
  }
  return Math.min(1, covered / windowLength);
}

export function windowsOverlapping<T extends SceneTimelineWindow>(
  windows: T[],
  span: { startMs: number; endMs: number },
): T[] {
  return windows.filter((window) => span.startMs < window.endMs && span.endMs > window.startMs);
}
