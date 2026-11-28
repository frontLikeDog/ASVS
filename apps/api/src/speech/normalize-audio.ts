import { spawnSync } from 'node:child_process';
import { mkdirSync, rmSync } from 'node:fs';
import path from 'node:path';

/**
 * Normalizes any provider output (mp3/wav/opus/pcm) to the one format the
 * rest of the pipeline assumes: **WAV, `pcm_s16le`, 48 kHz, mono**
 * (docs/06 §5 pitfall #2).
 *
 * ffprobe measurements, SHA256 hashes and the render cache key all describe
 * this normalized file, never the raw provider bytes — so a provider that
 * changes its container cannot change our contract.
 */

export const NORMALIZED_SAMPLE_RATE = 48_000;
export const NORMALIZED_CHANNELS = 1;

export interface NormalizedAudio {
  file: string;
  sha256: string;
  byteSize: number;
  durationMs: number;
  sampleRate: number;
  channels: number;
}

export class AudioNormalizationError extends Error {
  readonly code = 'tts_failed';

  constructor(message: string) {
    super(message);
    this.name = 'AudioNormalizationError';
  }
}

interface RunResult {
  status: number | null;
  stdout: string;
  stderr: string;
  error?: Error;
}

function run(command: string, args: string[]): RunResult {
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

/**
 * Runs ffmpeg to produce the normalized WAV at `outFile`. The caller supplies
 * the raw bytes on disk; this function never fetches anything.
 */
export function normalizeAudioToWav(inputFile: string, outFile: string): void {
  mkdirSync(path.dirname(outFile), { recursive: true });
  const result = run('ffmpeg', [
    '-v',
    'error',
    '-y',
    '-i',
    inputFile,
    '-ac',
    String(NORMALIZED_CHANNELS),
    '-ar',
    String(NORMALIZED_SAMPLE_RATE),
    '-c:a',
    'pcm_s16le',
    '-f',
    'wav',
    outFile,
  ]);
  if (result.error) {
    throw new AudioNormalizationError(
      `无法运行 ffmpeg：${result.error.message}。请确认 FFmpeg 已安装并在 PATH 中。`,
    );
  }
  if (result.status !== 0) {
    rmSync(outFile, { force: true });
    throw new AudioNormalizationError(
      `音频归一化失败（exit ${result.status}）：${result.stderr.trim().slice(0, 400)}`,
    );
  }
}

export interface ProbeAudioFileResult {
  durationMs: number;
  sampleRate: number;
  channels: number;
  codecName: string;
}

/** ffprobe of a normalized file; rejects anything ffmpeg could not produce. */
export function probeNormalizedAudio(file: string): ProbeAudioFileResult {
  const result = run('ffprobe', [
    '-v',
    'error',
    '-print_format',
    'json',
    '-show_format',
    '-show_streams',
    file,
  ]);
  if (result.error) {
    throw new AudioNormalizationError(`无法运行 ffprobe：${result.error.message}`);
  }
  if (result.status !== 0) {
    throw new AudioNormalizationError(`ffprobe 读取失败：${result.stderr.trim().slice(0, 400)}`);
  }
  const data = JSON.parse(result.stdout) as {
    streams?: Array<{
      codec_type?: string;
      codec_name?: string;
      sample_rate?: string;
      channels?: number;
      duration?: string;
    }>;
    format?: { duration?: string };
  };
  const stream = data.streams?.find((item) => item.codec_type === 'audio');
  if (!stream) throw new AudioNormalizationError(`归一化文件缺少音频流：${file}`);
  const durationMs = Math.round(
    Number(stream.duration ?? data.format?.duration ?? 0) * 1000,
  );
  if (!(durationMs > 0)) throw new AudioNormalizationError(`归一化音频时长非法：${file}`);
  return {
    durationMs,
    sampleRate: Number(stream.sample_rate ?? 0),
    channels: Number(stream.channels ?? 0),
    codecName: stream.codec_name ?? 'unknown',
  };
}
