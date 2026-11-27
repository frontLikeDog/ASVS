import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { RenderCheckpointFileV1 } from '@asvs/domain';
import {
  decideResumePoint,
  readCheckpointFile,
  sha256File,
  sha256Text,
  verifyExistingReceipt,
  writeCheckpointFile,
} from './resume';

const JOB_DIGEST = 'a'.repeat(64);
const JOB_ID = 'job_render_test';
const ARTIFACT_ID = 'artifact_test';

let dir = '';

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'asvs-resume-'));
  mkdirSync(path.join(dir, '.bundle'), { recursive: true });
  mkdirSync(path.join(dir, '.public'), { recursive: true });
  // Minimal fake chunk that the resume decision only checks for existence.
  writeFileSync(path.join(dir, '.bundle', 'index.html'), '<html></html>', 'utf8');
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function checkpoint(phases: string[], jobDigest = JOB_DIGEST): RenderCheckpointFileV1 {
  return {
    schemaVersion: '1',
    kind: 'asvs.render-checkpoint',
    jobDigest,
    updatedAt: '2026-11-27T10:00:00.000Z',
    phases: phases.map((phase) => ({ phase, at: '2026-11-27T10:00:00.000Z', payload: {} })),
  };
}

function decide(overrides: {
  checkpoint: RenderCheckpointFileV1 | null;
  bundleExists?: boolean;
}) {
  const bundleDir = path.join(dir, '.bundle');
  if (overrides.bundleExists === false) rmSync(bundleDir, { recursive: true, force: true });
  return decideResumePoint({
    checkpoint: overrides.checkpoint,
    jobDigest: JOB_DIGEST,
    bundleDir,
    publicDir: path.join(dir, '.public'),
    outDir: dir,
    outputFile: path.join(dir, 'output.mp4'),
    jobId: JOB_ID,
    artifactId: ARTIFACT_ID,
  });
}

function writeReceiptPair(mp4Content: string, overrides: { sha?: string; bytes?: number } = {}) {
  const mp4 = path.join(dir, 'output.mp4');
  writeFileSync(mp4, mp4Content);
  const sha = overrides.sha ?? sha256Text(mp4Content);
  const bytes = overrides.bytes ?? Buffer.byteLength(mp4Content);
  writeFileSync(
    path.join(dir, 'receipt.json'),
    JSON.stringify({
      schemaVersion: '1',
      jobId: JOB_ID,
      artifactId: ARTIFACT_ID,
      sha256: sha,
      mimeType: 'video/mp4',
      byteSize: bytes,
      storageRef: 'output.mp4',
      durationMs: 30000,
      width: 1920,
      height: 1080,
      fps: 30,
      rendererVersion: '4.0.545',
      compositionId: 'Storyboard',
      createdAt: '2026-11-27T10:00:00.000Z',
    }),
  );
  writeFileSync(
    path.join(dir, 'manifest.json'),
    JSON.stringify({
      schemaVersion: '1',
      jobId: JOB_ID,
      artifactId: ARTIFACT_ID,
      compositionId: 'Storyboard',
      rendererVersion: '4.0.545',
      renderInputDigest: sha,
      storyboardDigest: sha,
      sceneDigests: [],
      assetHashes: [],
      renderProfile: { width: 1920, height: 1080, codec: 'h264', crf: 18 },
      output: { fileName: 'output.mp4', mimeType: 'video/mp4', byteSize: bytes, sha256: sha },
      ffprobe: {
        codecName: 'h264',
        durationMs: 30000,
        width: 1920,
        height: 1080,
        fps: 30,
        frameCount: 900,
      },
      createdAt: '2026-11-27T10:00:00.000Z',
    }),
  );
  return { mp4, sha, bytes };
}

describe('decideResumePoint', () => {
  it('没有 checkpoint 时从零开始', () => {
    expect(decide({ checkpoint: null })).toBe('start');
  });

  it('digest 不匹配（其他任务的 checkpoint）强制重跑', () => {
    expect(decide({ checkpoint: checkpoint(['bundle_ready'], 'b'.repeat(64)) })).toBe('start');
  });

  it('bundle_ready 且 bundle 存在 → 跳过打包', () => {
    expect(decide({ checkpoint: checkpoint(['bundle_ready']) })).toBe('bundle_ready');
  });

  it('bundle_ready 但 bundle 被删除 → 重新打包', () => {
    expect(decide({ checkpoint: checkpoint(['bundle_ready']), bundleExists: false })).toBe('start');
  });

  it('video_rendered + 校验一致的回执 → 只复核', () => {
    writeReceiptPair('fake-mp4-bytes');
    expect(decide({ checkpoint: checkpoint(['bundle_ready', 'video_rendered']) })).toBe(
      'video_rendered',
    );
  });

  it('video_rendered 但 MP4 被截断/篡改 → 不信任，回退到 bundle', () => {
    writeReceiptPair('fake-mp4-bytes');
    writeFileSync(path.join(dir, 'output.mp4'), 'truncated');
    expect(decide({ checkpoint: checkpoint(['bundle_ready', 'video_rendered']) })).toBe(
      'bundle_ready',
    );
  });

  it('video_rendered 但回执不一致且缺少 bundle → 从零重跑', () => {
    writeFileSync(path.join(dir, 'output.mp4'), 'garbage');
    expect(
      decide({ checkpoint: checkpoint(['video_rendered']), bundleExists: false }),
    ).toBe('start');
  });
});

describe('verifyExistingReceipt', () => {
  it('jobId/artifactId 不一致时不通过（不能复用其他任务的产物）', () => {
    writeReceiptPair('fake-mp4-bytes');
    const result = verifyExistingReceipt({
      outDir: dir,
      outputFile: path.join(dir, 'output.mp4'),
      jobId: 'job_other',
      artifactId: ARTIFACT_ID,
    });
    expect(result.ok).toBe(false);
    expect(result.errors.join()).toMatch(/jobId/);
  });

  it('字节数被篡改时不通过', () => {
    writeReceiptPair('fake-mp4-bytes', { bytes: 1 });
    const result = verifyExistingReceipt({
      outDir: dir,
      outputFile: path.join(dir, 'output.mp4'),
      jobId: JOB_ID,
      artifactId: ARTIFACT_ID,
    });
    expect(result.ok).toBe(false);
  });

  it('损坏的回执 JSON 不抛出，返回错误列表', () => {
    writeReceiptPair('fake-mp4-bytes');
    writeFileSync(path.join(dir, 'receipt.json'), '{ broken');
    const result = verifyExistingReceipt({
      outDir: dir,
      outputFile: path.join(dir, 'output.mp4'),
      jobId: JOB_ID,
      artifactId: ARTIFACT_ID,
    });
    expect(result.ok).toBe(false);
    expect(result.errors.length).toBeGreaterThan(0);
  });
});

describe('checkpoint 文件读写', () => {
  it('损坏或不存在的文件视为无 checkpoint', () => {
    const file = path.join(dir, 'checkpoint.json');
    expect(readCheckpointFile(file)).toBeNull();
    writeFileSync(file, '{ not json');
    expect(readCheckpointFile(file)).toBeNull();
  });

  it('写入后可读回同样的阶段', () => {
    const file = path.join(dir, 'checkpoint.json');
    writeCheckpointFile(file, checkpoint(['bundle_ready']));
    const loaded = readCheckpointFile(file);
    expect(loaded?.phases.map((entry) => entry.phase)).toEqual(['bundle_ready']);
  });
});

describe('sha256File', () => {
  it('与一次性读取的哈希一致（流式实现不能丢字节）', () => {
    const file = path.join(dir, 'blob.bin');
    const big = Buffer.alloc(3 * 1024 * 1024 + 17, 7);
    writeFileSync(file, big);
    expect(sha256File(file)).toHaveLength(64);
    expect(sha256File(file)).toBe(sha256Text(readFileSync(file, 'latin1')));
  });
});
