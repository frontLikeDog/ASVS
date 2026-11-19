import { spawnSync } from 'node:child_process';

export interface ProbeResult {
  codecName: string;
  width: number;
  height: number;
  fps: number;
  durationMs: number;
  frameCount: number;
}

export interface ProbeExpectation {
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

export function parseFrameRate(value: string | undefined): number {
  if (!value) return 0;
  const [numerator, denominator] = value.split('/').map(Number);
  if (!numerator || !denominator) return 0;
  return numerator / denominator;
}

function run(command: string, args: string[]): { status: number | null; stdout: string; stderr: string; error?: Error } {
  const result = spawnSync(command, args, {
    encoding: 'utf8',
    windowsHide: true,
    maxBuffer: 16 * 1024 * 1024,
  });
  return {
    status: result.status,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
    error: result.error,
  };
}

export function probeVideo(file: string): ProbeResult {
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

/**
 * Fully decodes the file so a container that exists but cannot be played fails
 * here, not in a review meeting. `ffmpeg -v error` prints nothing on success.
 */
export function assertDecodable(file: string): void {
  const result = run('ffmpeg', ['-v', 'error', '-i', file, '-f', 'null', '-']);
  if (result.error) {
    throw new Error(`无法运行 ffmpeg：${result.error.message}。请确认 FFmpeg 已安装并在 PATH 中。`);
  }
  if (result.status !== 0 || result.stderr.trim()) {
    throw new Error(`MP4 解码失败（exit ${result.status}）：${result.stderr.trim()}`);
  }
}

export function validateProbe(probe: ProbeResult, expected: ProbeExpectation): string[] {
  const errors: string[] = [];
  if (probe.codecName !== 'h264') {
    errors.push(`编码应为 h264，实际为 ${probe.codecName}`);
  }
  if (probe.width !== expected.width || probe.height !== expected.height) {
    errors.push(
      `分辨率应为 ${expected.width}×${expected.height}，实际为 ${probe.width}×${probe.height}`,
    );
  }
  if (Math.abs(probe.fps - expected.fps) > 0.05) {
    errors.push(`帧率应为 ${expected.fps}，实际为 ${probe.fps.toFixed(3)}`);
  }
  if (Math.abs(probe.durationMs - expected.durationMs) > 250) {
    errors.push(`时长应为 ${expected.durationMs}ms，实际为 ${probe.durationMs}ms（容差 250ms）`);
  }
  if (probe.frameCount !== expected.frameCount) {
    errors.push(`帧数应为 ${expected.frameCount}，实际为 ${probe.frameCount}`);
  }
  return errors;
}
