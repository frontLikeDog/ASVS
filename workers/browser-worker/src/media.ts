import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

export interface VideoProbe {
  codecName: string;
  width: number;
  height: number;
  fps: number;
  durationMs: number;
  frameCount: number;
}

interface FfprobeStream {
  codec_type?: string;
  codec_name?: string;
  width?: number;
  height?: number;
  r_frame_rate?: string;
  avg_frame_rate?: string;
  nb_frames?: string;
  nb_read_frames?: string;
}

interface FfprobeOutput {
  streams?: FfprobeStream[];
  format?: { duration?: string };
}

function run(command: string, args: string[]): {
  status: number | null;
  stdout: string;
  stderr: string;
  error?: Error;
} {
  const result = spawnSync(command, args, {
    encoding: 'utf8',
    windowsHide: true,
    maxBuffer: 32 * 1024 * 1024,
  });
  return {
    status: result.status,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
    error: result.error,
  };
}

export function sha256Buffer(buffer: Buffer): string {
  return createHash('sha256').update(buffer).digest('hex');
}

export function sha256File(file: string): string {
  return sha256Buffer(readFileSync(file));
}

function parseFrameRate(value: string | undefined): number {
  if (!value) return 0;
  const [numerator, denominator] = value.split('/').map(Number);
  if (!numerator || !denominator) return 0;
  return numerator / denominator;
}

export function probeVideo(file: string): VideoProbe {
  const result = run('ffprobe', [
    '-v',
    'error',
    '-count_frames',
    '-print_format',
    'json',
    '-show_format',
    '-show_streams',
    file,
  ]);
  if (result.error) {
    throw new Error(`无法运行 ffprobe：${result.error.message}。请确认 FFmpeg 已安装并在 PATH 中。`);
  }
  if (result.status !== 0) {
    throw new Error(`ffprobe 读取失败（exit ${result.status}）：${result.stderr.trim()}`);
  }

  const parsed = JSON.parse(result.stdout) as FfprobeOutput;
  const stream = parsed.streams?.find((item) => item.codec_type === 'video');
  if (!stream) throw new Error('ffprobe 未找到视频流');

  const fps = parseFrameRate(stream.r_frame_rate) || parseFrameRate(stream.avg_frame_rate);
  const durationSeconds = Number(parsed.format?.duration ?? 0);
  const frameCount = Number(stream.nb_read_frames ?? stream.nb_frames ?? 0);
  if (!stream.codec_name || !stream.width || !stream.height || !fps || !durationSeconds) {
    throw new Error('ffprobe 返回的视频流缺少编码、尺寸、帧率或时长');
  }
  return {
    codecName: stream.codec_name,
    width: stream.width,
    height: stream.height,
    fps,
    durationMs: Math.round(durationSeconds * 1000),
    frameCount,
  };
}

export function assertDecodable(file: string): void {
  const result = run('ffmpeg', ['-v', 'error', '-i', file, '-f', 'null', '-']);
  if (result.error) {
    throw new Error(`无法运行 ffmpeg：${result.error.message}。请确认 FFmpeg 已安装并在 PATH 中。`);
  }
  if (result.status !== 0 || result.stderr.trim()) {
    throw new Error(`视频解码失败（exit ${result.status}）：${result.stderr.trim()}`);
  }
}

export interface ClipPlan {
  startMs: number;
  durationMs: number;
}

/**
 * The WebM timeline starts a little after `recordingStartedAt` (context
 * creation), so the first ~second is the app's route-loading shell. Step
 * timestamps use the performance clock and therefore run ahead of the video;
 * cut shortly *after* the first passing assertion so the clip opens on a
 * painted screen instead of a spinner, but never beyond the raw recording.
 */
export function planClip({
  rawDurationMs,
  firstMeaningfulAtMs,
  clipDurationMs,
}: {
  rawDurationMs: number;
  firstMeaningfulAtMs: number;
  clipDurationMs: number;
}): ClipPlan {
  const postRollMs = 800;
  const maxStart = Math.max(0, rawDurationMs - 1000);
  const startMs = Math.max(0, Math.min(firstMeaningfulAtMs + postRollMs, maxStart));
  const available = rawDurationMs - startMs;
  const durationMs = Math.max(0, Math.min(clipDurationMs, available));
  return { startMs: Math.round(startMs), durationMs: Math.round(durationMs) };
}

export interface TranscodeOptions {
  input: string;
  output: string;
  startMs: number;
  durationMs: number;
  fps: number;
  width: number;
  height: number;
}

/** Converts Playwright's VP8/WebM into a frame-accurate, silent H.264 clip. */
export function transcodeClip({
  input,
  output,
  startMs,
  durationMs,
  fps,
  width,
  height,
}: TranscodeOptions): VideoProbe {
  const filter = [
    `scale=${width}:${height}:force_original_aspect_ratio=decrease`,
    `pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2:color=black`,
    `fps=${fps}`,
  ].join(',');

  const result = run('ffmpeg', [
    '-y',
    '-v',
    'error',
    '-ss',
    (startMs / 1000).toFixed(3),
    '-i',
    input,
    '-t',
    (durationMs / 1000).toFixed(3),
    '-an',
    '-c:v',
    'libx264',
    '-preset',
    'medium',
    '-crf',
    '18',
    '-pix_fmt',
    'yuv420p',
    '-vf',
    filter,
    '-movflags',
    '+faststart',
    output,
  ]);
  if (result.error) {
    throw new Error(`无法运行 ffmpeg：${result.error.message}。请确认 FFmpeg 已安装并在 PATH 中。`);
  }
  if (result.status !== 0) {
    throw new Error(`录屏转码失败（exit ${result.status}）：${result.stderr.trim()}`);
  }

  const probe = probeVideo(output);
  if (probe.codecName !== 'h264') {
    throw new Error(`转码结果应为 h264，实际 ${probe.codecName}`);
  }
  if (probe.width !== width || probe.height !== height) {
    throw new Error(`转码分辨率应为 ${width}×${height}，实际 ${probe.width}×${probe.height}`);
  }
  if (Math.abs(probe.fps - fps) > 0.05) {
    throw new Error(`转码帧率应为 ${fps}，实际 ${probe.fps}`);
  }
  if (probe.durationMs < 1500) {
    throw new Error(`转码片段过短：${probe.durationMs}ms`);
  }
  return probe;
}
