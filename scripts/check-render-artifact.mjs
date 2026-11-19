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
import { existsSync, readFileSync, statSync } from 'node:fs';
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
  return {
    codecName: stream.codec_name,
    width: stream.width,
    height: stream.height,
    fps: parseRate(stream.r_frame_rate) || parseRate(stream.avg_frame_rate),
    durationMs: Math.round(Number(data.format?.duration ?? 0) * 1000),
    frameCount: Number(stream.nb_read_frames ?? stream.nb_frames ?? 0),
  };
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

    console.log('\n渲染产物校验');
    console.log('─'.repeat(64));
    console.log(`  目录       ${path.relative(workspaceRoot, artifactDir)}`);
    console.log(`  MP4        ${manifest.output.fileName} · ${(actualBytes / 1024 / 1024).toFixed(2)} MiB`);
    console.log(`  SHA256     ${actualSha}`);
    console.log(
      `  ffprobe    ${actualProbe.codecName} · ${actualProbe.width}×${actualProbe.height} · ${actualProbe.fps}fps · ${actualProbe.durationMs}ms · ${actualProbe.frameCount} 帧`,
    );
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
