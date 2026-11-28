import { spawnSync } from 'node:child_process';

export interface AudioProbeResult {
  codecName: string;
  sampleRate: number;
  channels: number;
  durationMs: number;
  bitRate?: number;
}

export interface ProbeResult {
  codecName: string;
  width: number;
  height: number;
  fps: number;
  durationMs: number;
  frameCount: number;
  /** Present only when the file really has an audio stream (5B). */
  audio?: AudioProbeResult;
}

export interface ProbeExpectation {
  width: number;
  height: number;
  fps: number;
  durationMs: number;
  frameCount: number;
  /** 5B: require an AAC track, sane sample rate, sync within 500ms, audible. */
  expectAudio?: AudioExpectation;
}

export interface AudioExpectation {
  /** Expected audio track length; defaults to the video duration. */
  durationMs?: number;
  meanVolumeDb?: number;
}

/** Anything quieter than this is treated as a silent track and rejected. */
export const SILENT_TRACK_DB = -90;
/** Allowed audio/video duration drift before the file is considered broken. */
export const AUDIO_VIDEO_SYNC_TOLERANCE_MS = 500;

const AUDIO_CODEC_NAMES: Record<string, string> = {
  // ffprobe reports the encoder name; Remotion writes `aac` for AAC.
  aac: 'aac',
};

interface FfprobeStream {
  codec_type?: string;
  codec_name?: string;
  codec_long_name?: string;
  width?: number;
  height?: number;
  r_frame_rate?: string;
  avg_frame_rate?: string;
  nb_frames?: string;
  nb_read_frames?: string;
  sample_rate?: string;
  channels?: number;
  duration?: string;
  bit_rate?: string;
  tags?: Record<string, string>;
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

function probe(file: string): FfprobeOutput {
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
  return JSON.parse(result.stdout) as FfprobeOutput;
}

function audioFromStream(stream: FfprobeStream, fallbackDurationMs: number): AudioProbeResult {
  const sampleRate = Number(stream.sample_rate ?? 0);
  const channels = Number(stream.channels ?? 0);
  const durationMs = stream.duration
    ? Math.round(Number(stream.duration) * 1000)
    : fallbackDurationMs;
  const bitRate = stream.bit_rate ? Number(stream.bit_rate) : undefined;
  if (!stream.codec_name || !sampleRate || !channels) {
    throw new Error('ffprobe 返回的音频流缺少编码、采样率或声道数');
  }
  return {
    codecName: AUDIO_CODEC_NAMES[stream.codec_name] ?? stream.codec_name,
    sampleRate,
    channels,
    durationMs,
    ...(bitRate ? { bitRate } : {}),
  };
}

export function probeVideo(file: string): ProbeResult {
  const parsed = probe(file);
  const stream = parsed.streams?.find((item) => item.codec_type === 'video');
  if (!stream) throw new Error('ffprobe 未找到视频流');

  const fps = parseFrameRate(stream.r_frame_rate) || parseFrameRate(stream.avg_frame_rate);
  const durationSeconds = Number(parsed.format?.duration ?? 0);
  const frameCount = Number(stream.nb_read_frames ?? stream.nb_frames ?? 0);

  if (!stream.codec_name || !stream.width || !stream.height || !fps || !durationSeconds) {
    throw new Error('ffprobe 返回的视频流缺少编码、尺寸、帧率或时长');
  }
  const videoDurationMs = Math.round(durationSeconds * 1000);
  const audioStream = parsed.streams?.find((item) => item.codec_type === 'audio');

  return {
    codecName: stream.codec_name,
    width: stream.width,
    height: stream.height,
    fps,
    durationMs: videoDurationMs,
    frameCount,
    ...(audioStream ? { audio: audioFromStream(audioStream, videoDurationMs) } : {}),
  };
}

/** Probes a standalone audio file (normalized WAV / provider output). */
export function probeAudio(file: string): AudioProbeResult {
  const parsed = probe(file);
  const stream = parsed.streams?.find((item) => item.codec_type === 'audio');
  if (!stream) throw new Error(`ffprobe 未找到音频流：${file}`);
  const formatDurationMs = Math.round(Number(parsed.format?.duration ?? 0) * 1000);
  const audio = audioFromStream(stream, formatDurationMs);
  if (audio.durationMs <= 0) {
    throw new Error(`音频文件时长非法：${file}`);
  }
  return audio;
}

/**
 * Mean volume of the audio stream, in dB (`ffmpeg -af volumedetect`).
 *
 * Returns -Infinity when ffmpeg reports `mean_volume: -inf`; callers must
 * reject anything at or below `SILENT_TRACK_DB` so an empty AAC track can
 * never pass as narration.
 */
export function measureAudioVolumeDb(file: string): number {
  const result = run('ffmpeg', [
    '-v',
    'info',
    '-nostats',
    '-i',
    file,
    '-map',
    '0:a:0',
    '-af',
    'volumedetect',
    '-f',
    'null',
    '-',
  ]);
  if (result.error) {
    throw new Error(`无法运行 ffmpeg：${result.error.message}。请确认 FFmpeg 已安装并在 PATH 中。`);
  }
  if (result.status !== 0) {
    throw new Error(`ffmpeg volumedetect 失败（exit ${result.status}）：${result.stderr.trim()}`);
  }
  const match = result.stderr.match(/mean_volume:\s*(-?[\d.]+|-inf)\s*dB/i);
  if (!match) throw new Error('ffmpeg volumedetect 未返回 mean_volume');
  return match[1]!.toLowerCase() === '-inf' ? Number.NEGATIVE_INFINITY : Number(match[1]);
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

/**
 * Validates a probed MP4 against the frozen storyboard.
 *
 * With `expectAudio` the file must carry an AAC track whose sample rate is at
 * least 22.05 kHz, whose duration does not drift more than 500 ms from the
 * video, and which is not silent (`meanVolumeDb > -90`). Silent Step 1/2
 * fixtures pass unchanged because they simply omit the expectation.
 */
export function validateProbe(
  probe: ProbeResult,
  expected: ProbeExpectation,
): string[] {
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

  if (expected.expectAudio) {
    const audio = probe.audio;
    if (!audio) {
      errors.push('期望有音轨，但 ffprobe 未找到音频流');
    } else {
      if (audio.codecName !== 'aac') {
        errors.push(`音频编码应为 aac，实际为 ${audio.codecName}`);
      }
      if (audio.sampleRate < 22_050) {
        errors.push(`音频采样率应 ≥ 22050Hz，实际为 ${audio.sampleRate}Hz`);
      }
      if (audio.channels < 1 || audio.channels > 2) {
        errors.push(`音频声道数应为 1–2，实际为 ${audio.channels}`);
      }
      const expectedAudioMs = expected.expectAudio.durationMs ?? expected.durationMs;
      if (Math.abs(audio.durationMs - expectedAudioMs) > AUDIO_VIDEO_SYNC_TOLERANCE_MS) {
        errors.push(
          `音画时长不一致：音频 ${audio.durationMs}ms vs 期望 ${expectedAudioMs}ms（容差 ${AUDIO_VIDEO_SYNC_TOLERANCE_MS}ms）`,
        );
      }
      if (
        expected.expectAudio.meanVolumeDb !== undefined &&
        !(expected.expectAudio.meanVolumeDb > SILENT_TRACK_DB)
      ) {
        errors.push(
          `音轨疑似静音：mean_volume ${expected.expectAudio.meanVolumeDb.toFixed(1)}dB（需 > ${SILENT_TRACK_DB}dB）`,
        );
      }
    }
  } else if (probe.audio) {
    errors.push('静音样片不应包含音轨');
  }

  return errors;
}
