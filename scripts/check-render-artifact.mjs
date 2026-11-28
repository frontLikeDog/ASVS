#!/usr/bin/env node
/**
 * Independently re-verifies a render artifact without re-rendering it.
 *
 * The worker already validates before writing, but this script trusts nothing:
 * it re-hashes the MP4, re-runs ffprobe and compares the result with both the
 * manifest and the receipt. Use it in CI after a cached render, or locally to
 * prove a previously produced file is still the one described by its receipt.
 *
 * Usage: node scripts/check-render-artifact.mjs [--dir <artifact dir>]
 */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const workspaceRoot = path.resolve(scriptDir, '..');

function argValue(flag, fallback) {
  const index = process.argv.indexOf(flag);
  if (index === -1) return fallback;
  const value = process.argv[index + 1];
  if (!value) {
    console.error(`\n${flag} 需要一个值\n`);
    process.exit(2);
  }
  return value;
}

const artifactDir = path.resolve(
  workspaceRoot,
  argValue('--dir', 'dist/render-worker/golden-30s'),
);

function readJson(file) {
  return JSON.parse(readFileSync(file, 'utf8'));
}

function sha256(file) {
  return createHash('sha256').update(readFileSync(file)).digest('hex');
}

function parseRate(value) {
  if (!value) return 0;
  const [numerator, denominator] = value.split('/').map(Number);
  if (!numerator || !denominator) return 0;
  return numerator / denominator;
}

function probe(file) {
  const result = spawnSync(
    'ffprobe',
    [
      '-v',
      'error',
      '-count_frames',
      '-print_format',
      'json',
      '-show_format',
      '-show_streams',
      file,
    ],
    { encoding: 'utf8', windowsHide: true, maxBuffer: 16 * 1024 * 1024 },
  );
  if (result.error) throw new Error(`无法运行 ffprobe：${result.error.message}`);
  if (result.status !== 0) throw new Error(`ffprobe 失败：${result.stderr.trim()}`);
  const data = JSON.parse(result.stdout);
  const stream = data.streams?.find((item) => item.codec_type === 'video');
  if (!stream) throw new Error('ffprobe 未找到视频流');
  const audioStream = data.streams?.find((item) => item.codec_type === 'audio');
  const durationMs = Math.round(Number(data.format?.duration ?? 0) * 1000);
  return {
    codecName: stream.codec_name,
    width: stream.width,
    height: stream.height,
    fps: parseRate(stream.r_frame_rate) || parseRate(stream.avg_frame_rate),
    durationMs,
    frameCount: Number(stream.nb_read_frames ?? stream.nb_frames ?? 0),
    audio: audioStream
      ? {
          codecName: audioStream.codec_name,
          sampleRate: Number(audioStream.sample_rate ?? 0),
          channels: Number(audioStream.channels ?? 0),
          durationMs: audioStream.duration
            ? Math.round(Number(audioStream.duration) * 1000)
            : durationMs,
        }
      : null,
  };
}

/** Independent volumedetect pass: silence must never pass as narration. */
function meanVolumeDb(file) {
  const result = spawnSync(
    'ffmpeg',
    ['-v', 'info', '-nostats', '-i', file, '-map', '0:a:0', '-af', 'volumedetect', '-f', 'null', '-'],
    { encoding: 'utf8', windowsHide: true, maxBuffer: 16 * 1024 * 1024 },
  );
  if (result.error) throw new Error(`无法运行 ffmpeg：${result.error.message}`);
  if (result.status !== 0) throw new Error(`volumedetect 失败：${result.stderr.trim()}`);
  const match = result.stderr.match(/mean_volume:\s*(-?[\d.]+|-inf)\s*dB/i);
  if (!match) throw new Error('volumedetect 未返回 mean_volume');
  return match[1].toLowerCase() === '-inf' ? Number.NEGATIVE_INFINITY : Number(match[1]);
}

const SRT_TIMESTAMP = /^(\d{2}):(\d{2}):(\d{2}),(\d{3})$/;

function parseSrtTime(value) {
  const match = SRT_TIMESTAMP.exec(value.trim());
  if (!match) return null;
  const [, hh, mm, ss, mmm] = match.map(Number);
  if (mm > 59 || ss > 59 || mmm > 999) return null;
  return ((hh * 60 + mm) * 60 + ss) * 1000 + mmm;
}

/**
 * Standalone SRT rules (deliberately re-implemented here, not imported): cue
 * indices contiguous from 1, `ms ≤ 999`, start < end, monotonic and
 * non-overlapping, last cue inside the video duration, no blank text.
 */
function validateSrt(content, totalDurationMs) {
  const issues = [];
  const normalized = content.replace(/\r\n/g, '\n').trim();
  if (!normalized) return { issues: ['SRT 为空'], cueCount: 0 };
  const blocks = normalized.split(/\n{2,}/);
  let previousEnd = 0;
  blocks.forEach((block, index) => {
    const lines = block.split('\n');
    const expected = index + 1;
    if (Number(lines[0]) !== expected) {
      issues.push(`第 ${expected} 条字幕序号应为 ${expected}，实际为 ${lines[0]}`);
    }
    const range = /^(.*?)\s*-->\s*(.*?)$/.exec(lines[1] ?? '');
    if (!range) {
      issues.push(`第 ${expected} 条缺少时间轴`);
      return;
    }
    const start = parseSrtTime(range[1]);
    const end = parseSrtTime(range[2]);
    if (start === null) issues.push(`第 ${expected} 条起始时间非法：${range[1]}`);
    if (end === null) issues.push(`第 ${expected} 条结束时间非法：${range[2]}`);
    if (start === null || end === null) return;
    if (start >= end) issues.push(`第 ${expected} 条起始时间不早于结束时间`);
    if (start < previousEnd) issues.push(`第 ${expected} 条与上一条重叠`);
    if (lines.slice(2).join('').trim() === '') issues.push(`第 ${expected} 条文本为空`);
    previousEnd = end;
  });
  if (previousEnd > totalDurationMs + 250) {
    issues.push(`末条字幕 ${previousEnd}ms 超出视频时长 ${totalDurationMs}ms（容差 250ms）`);
  }
  return { issues, cueCount: blocks.length };
}

function main() {
  const manifestFile = path.join(artifactDir, 'manifest.json');
  const receiptFile = path.join(artifactDir, 'receipt.json');
  const failures = [];

  for (const file of [manifestFile, receiptFile]) {
    if (!existsSync(file)) {
      console.error(`\n缺少 ${path.relative(workspaceRoot, file)}。先运行 pnpm render:fixture。\n`);
      process.exit(1);
    }
  }

  const manifest = readJson(manifestFile);
  const receipt = readJson(receiptFile);
  const videoFile = path.join(artifactDir, manifest.output.fileName);

  if (!existsSync(videoFile)) failures.push(`MP4 不存在：${path.relative(workspaceRoot, videoFile)}`);
  if (failures.length === 0) {
    const actualSha = sha256(videoFile);
    const actualBytes = statSync(videoFile).size;
    if (actualSha !== manifest.output.sha256) {
      failures.push(`MP4 SHA256 与 manifest 不一致（${actualSha} vs ${manifest.output.sha256}）`);
    }
    if (actualSha !== receipt.sha256) {
      failures.push(`MP4 SHA256 与 receipt 不一致（${actualSha} vs ${receipt.sha256}）`);
    }
    if (actualBytes !== manifest.output.byteSize) {
      failures.push(`MP4 字节数不一致（${actualBytes} vs ${manifest.output.byteSize}）`);
    }
    if (actualBytes !== receipt.byteSize) {
      failures.push(`MP4 字节数与 receipt 不一致（${actualBytes} vs ${receipt.byteSize}）`);
    }
    if (path.basename(receipt.storageRef) !== manifest.output.fileName) {
      failures.push('receipt.storageRef 与 manifest.output.fileName 指向不同文件');
    }

    const actualProbe = probe(videoFile);
    const recorded = manifest.ffprobe;
    let actualAudio = null;
    let srtFiles = [];
    if (actualProbe.codecName !== recorded.codecName) {
      failures.push(`编码不一致（${actualProbe.codecName} vs ${recorded.codecName}）`);
    }
    if (actualProbe.width !== recorded.width || actualProbe.height !== recorded.height) {
      failures.push(
        `分辨率不一致（${actualProbe.width}×${actualProbe.height} vs ${recorded.width}×${recorded.height}）`,
      );
    }
    if (Math.abs(actualProbe.fps - recorded.fps) > 0.05) {
      failures.push(`帧率不一致（${actualProbe.fps} vs ${recorded.fps}）`);
    }
    if (Math.abs(actualProbe.durationMs - recorded.durationMs) > 250) {
      failures.push(`时长不一致（${actualProbe.durationMs}ms vs ${recorded.durationMs}ms）`);
    }
    if (actualProbe.frameCount !== recorded.frameCount) {
      failures.push(`帧数不一致（${actualProbe.frameCount} vs ${recorded.frameCount}）`);
    }
    if (receipt.durationMs !== recorded.durationMs) {
      failures.push(`receipt 时长与 manifest 不一致（${receipt.durationMs} vs ${recorded.durationMs}）`);
    }
    if (receipt.width !== manifest.renderProfile.width || receipt.height !== manifest.renderProfile.height) {
      failures.push('receipt 尺寸与 manifest.renderProfile 不一致');
    }
    if (Math.abs(receipt.fps - recorded.fps) > 0.05) {
      failures.push(`receipt 帧率与 manifest 不一致（${receipt.fps} vs ${recorded.fps}）`);
    }

    // ── 5B: audio track ──────────────────────────────────────────────────
    // The manifest either records an audio stream or it does not; either way
    // the fresh probe must agree, and a recorded track must be audible.
    const recordedAudio = recorded.audio ?? null;
    if (!recordedAudio && actualProbe.audio) {
      failures.push('manifest 未记录音轨，但 MP4 实际包含音频流');
    } else if (recordedAudio && !actualProbe.audio) {
      failures.push('manifest 记录了音轨，但 MP4 实际没有音频流');
    } else if (recordedAudio && actualProbe.audio) {
      if (actualProbe.audio.codecName !== recordedAudio.codecName) {
        failures.push(`音频编码不一致（${actualProbe.audio.codecName} vs ${recordedAudio.codecName}）`);
      }
      if (actualProbe.audio.sampleRate !== recordedAudio.sampleRate) {
        failures.push(`音频采样率不一致（${actualProbe.audio.sampleRate} vs ${recordedAudio.sampleRate}）`);
      }
      if (actualProbe.audio.channels !== recordedAudio.channels) {
        failures.push(`音频声道数不一致（${actualProbe.audio.channels} vs ${recordedAudio.channels}）`);
      }
      if (Math.abs(actualProbe.audio.durationMs - recordedAudio.durationMs) > 500) {
        failures.push(`音频时长不一致（${actualProbe.audio.durationMs}ms vs ${recordedAudio.durationMs}ms）`);
      }
      if (Math.abs(actualProbe.audio.durationMs - actualProbe.durationMs) > 500) {
        failures.push(`音画时长漂移超过 500ms（音频 ${actualProbe.audio.durationMs}ms vs 视频 ${actualProbe.durationMs}ms）`);
      }
      const volume = meanVolumeDb(videoFile);
      if (!(volume > -90)) {
        failures.push(`音轨疑似静音（mean_volume ${volume}dB，需 > -90dB）`);
      }
      if (recordedAudio.meanVolumeDb !== undefined && Math.abs(volume - recordedAudio.meanVolumeDb) > 1) {
        failures.push(`mean_volume 与 manifest 不一致（${volume}dB vs ${recordedAudio.meanVolumeDb}dB）`);
      }
      actualAudio = { ...actualProbe.audio, meanVolumeDb: volume };
    }

    // ── 5B: subtitles ────────────────────────────────────────────────────
    const recordedSrt = manifest.subtitles ?? null;
    if (recordedSrt) {
      const srtFile = path.join(artifactDir, recordedSrt.fileName);
      if (!existsSync(srtFile)) {
        failures.push(`SRT 不存在：${recordedSrt.fileName}`);
      } else {
        const bytes = readFileSync(srtFile);
        const actualSrtSha = createHash('sha256').update(bytes).digest('hex');
        if (actualSrtSha !== recordedSrt.sha256) {
          failures.push(`SRT SHA256 与 manifest 不一致（${actualSrtSha} vs ${recordedSrt.sha256}）`);
        }
        if (bytes.byteLength !== recordedSrt.byteSize) {
          failures.push(`SRT 字节数不一致（${bytes.byteLength} vs ${recordedSrt.byteSize}）`);
        }
        if (recordedSrt.mimeType !== 'application/x-subrip') {
          failures.push(`SRT MIME 类型应为 application/x-subrip，实际为 ${recordedSrt.mimeType}`);
        }
        const validation = validateSrt(bytes.toString('utf8'), actualProbe.durationMs);
        for (const issue of validation.issues) failures.push(`SRT：${issue}`);
        if (validation.cueCount !== recordedSrt.cueCount) {
          failures.push(`SRT 条数不一致（${validation.cueCount} vs ${recordedSrt.cueCount}）`);
        }
        srtFiles.push({ fileName: recordedSrt.fileName, sha256: actualSrtSha, cues: validation.cueCount });
      }
    } else {
      // A silent fixture may still ship an .srt in its directory; it must not
      // claim to belong to this render unless the manifest says so.
      const stray = readdirSync(artifactDir).filter((name) => name.endsWith('.srt') && !name.startsWith('.'));
      if (stray.length > 0) {
        failures.push(`manifest 未记录字幕，但目录中存在 SRT：${stray.join('、')}`);
      }
    }

    // ── 5B: narration provenance honesty ─────────────────────────────────
    const narration = manifest.narration ?? null;
    if (narration) {
      if (!narration.license) failures.push('narration 缺少许可信息');
      if (narration.clips.length === 0) failures.push('narration 没有任何片段');
      if (narration.synthetic) {
        const policyOk = ['extend_scene', 'fail_on_overflow'].includes(narration.timingPolicy);
        if (!policyOk) failures.push(`narration.timingPolicy 非法：${narration.timingPolicy}`);
      }
      for (const clip of narration.clips) {
        if (clip.endMs > actualProbe.durationMs + 250) {
          failures.push(`旁白片段 ${clip.sceneId} 结束于 ${clip.endMs}ms，超出视频 ${actualProbe.durationMs}ms`);
        }
        if (clip.endMs - clip.startMs !== clip.durationMs) {
          failures.push(`旁白片段 ${clip.sceneId} 的时长与时间窗不一致`);
        }
      }
    }
    if (!narration && recordedAudio) {
      failures.push('MP4 含音轨但 manifest 未记录 narration 溯源信息');
    }
    if (narration && !actualProbe.audio) {
      failures.push('manifest 记录 narration 但 MP4 没有音轨');
    }

    // Real captures are traceable to the exact file that was rendered. A
    // mock asset must never pretend to have one.
    for (const entry of manifest.assetHashes ?? []) {
      if (entry.mock === false) {
        if (!entry.mediaSha256 || !entry.mediaSourceFile) {
          failures.push(`真实 Asset ${entry.assetId} 缺少 mediaSha256 / mediaSourceFile`);
          continue;
        }
        const sourceFile = path.resolve(workspaceRoot, entry.mediaSourceFile);
        if (!existsSync(sourceFile)) {
          failures.push(`真实素材不存在：${entry.mediaSourceFile}`);
        } else {
          const actual = sha256(sourceFile);
          if (actual !== entry.mediaSha256) {
            failures.push(
              `真实素材 SHA256 不一致：${entry.mediaSourceFile}（${actual} vs ${entry.mediaSha256}）`,
            );
          }
        }
      } else if (entry.mediaSha256) {
        failures.push(`mock Asset ${entry.assetId} 不应记录 mediaSha256`);
      }
    }

    console.log('\n渲染产物校验');
    console.log('─'.repeat(64));
    console.log(`  目录       ${path.relative(workspaceRoot, artifactDir)}`);
    console.log(`  MP4        ${manifest.output.fileName} · ${(actualBytes / 1024 / 1024).toFixed(2)} MiB`);
    console.log(`  SHA256     ${actualSha}`);
    console.log(
      `  ffprobe    ${actualProbe.codecName} · ${actualProbe.width}×${actualProbe.height} · ${actualProbe.fps}fps · ${actualProbe.durationMs}ms · ${actualProbe.frameCount} 帧`,
    );
    if (actualAudio) {
      console.log(
        `  音轨       ${actualAudio.codecName} · ${actualAudio.sampleRate}Hz · ${actualAudio.channels}ch · ${actualAudio.durationMs}ms · mean ${actualAudio.meanVolumeDb.toFixed(1)}dB`,
      );
    }
    if (manifest.narration) {
      const { provider, voiceId, language, license, synthetic, timingPolicy } = manifest.narration;
      console.log(
        `  旁白       ${provider}/${voiceId} · ${language} · ${timingPolicy} · ${synthetic ? '合成测试音轨（非真人配音）' : '真实音色'} · ${license}`,
      );
    }
    for (const srt of srtFiles) {
      console.log(`  字幕       ${srt.fileName} · ${srt.cues} 条 · ${srt.sha256.slice(0, 12)}…`);
    }
    console.log(`  renderer   ${manifest.rendererVersion} · ${manifest.compositionId}`);
    console.log('─'.repeat(64));
  }

  if (failures.length > 0) {
    console.error('\n校验失败：\n');
    for (const failure of failures) console.error(`  • ${failure}`);
    console.error('');
    process.exitCode = 1;
    return;
  }

  console.log('manifest、receipt 与 MP4 一致。\n');
}

main();
