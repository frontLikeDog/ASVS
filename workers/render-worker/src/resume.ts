import { createHash } from 'node:crypto';
import {
  closeSync,
  existsSync,
  openSync,
  readFileSync,
  readSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import type { ArtifactReceiptV1, RenderManifestV1 } from '@asvs/domain';
import {
  artifactReceiptV1Schema,
  renderCheckpointFileV1Schema,
  renderManifestV1Schema,
  type RenderCheckpointFileV1,
} from '@asvs/domain';

/** Streaming SHA-256 so a 5 MB+ MP4 never has to be loaded whole twice. */
export function sha256File(file: string): string {
  const hash = createHash('sha256');
  const fd = openSync(file, 'r');
  try {
    const buffer = Buffer.allocUnsafe(1024 * 1024);
    let position = 0;
    for (;;) {
      const bytes = readSync(fd, buffer, 0, buffer.length, position);
      if (bytes <= 0) break;
      hash.update(buffer.subarray(0, bytes));
      position += bytes;
    }
  } finally {
    closeSync(fd);
  }
  return hash.digest('hex');
}

export function sha256Text(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

export function fileExists(file: string): boolean {
  return existsSync(file) && statSync(file).isFile();
}

export interface ReceiptVerification {
  ok: boolean;
  errors: string[];
  receipt: ArtifactReceiptV1 | null;
  manifest: RenderManifestV1 | null;
}

/**
 * Verifies that an existing `receipt.json` + `manifest.json` pair still
 * describes the MP4 on disk. Used before resuming from `video_rendered`: a
 * truncated or foreign file must force a re-render, never be trusted.
 */
export function verifyExistingReceipt({
  outDir,
  outputFile,
  jobId,
  artifactId,
}: {
  outDir: string;
  outputFile: string;
  jobId: string;
  artifactId: string;
}): ReceiptVerification {
  const errors: string[] = [];
  const receiptFile = path.join(outDir, 'receipt.json');
  const manifestFile = path.join(outDir, 'manifest.json');
  if (!fileExists(outputFile)) errors.push(`输出文件不存在：${outputFile}`);
  if (!fileExists(receiptFile)) errors.push('receipt.json 不存在');
  if (!fileExists(manifestFile)) errors.push('manifest.json 不存在');
  if (errors.length > 0) return { ok: false, errors, receipt: null, manifest: null };

  let receipt: ArtifactReceiptV1;
  let manifest: RenderManifestV1;
  try {
    receipt = artifactReceiptV1Schema.parse(JSON.parse(readFileSync(receiptFile, 'utf8')));
    manifest = renderManifestV1Schema.parse(JSON.parse(readFileSync(manifestFile, 'utf8')));
  } catch (error) {
    errors.push(`回执/清单解析失败：${error instanceof Error ? error.message : String(error)}`);
    return { ok: false, errors, receipt: null, manifest: null };
  }

  if (receipt.jobId !== jobId || receipt.artifactId !== artifactId) {
    errors.push('回执的 jobId / artifactId 与本次任务不一致');
  }
  if (manifest.jobId !== jobId || manifest.artifactId !== artifactId) {
    errors.push('清单的 jobId / artifactId 与本次任务不一致');
  }
  const actualSha = sha256File(outputFile);
  const actualBytes = statSync(outputFile).size;
  if (actualSha !== receipt.sha256) errors.push('MP4 SHA256 与回执不一致');
  if (actualSha !== manifest.output.sha256) errors.push('MP4 SHA256 与清单不一致');
  if (actualBytes !== receipt.byteSize) errors.push('MP4 字节数与回执不一致');
  if (actualBytes !== manifest.output.byteSize) errors.push('MP4 字节数与清单不一致');
  return { ok: errors.length === 0, errors, receipt, manifest };
}

/** Reads the worker checkpoint file; a corrupt file is treated as absent. */
export function readCheckpointFile(file: string): RenderCheckpointFileV1 | null {
  if (!fileExists(file)) return null;
  try {
    const raw = JSON.parse(readFileSync(file, 'utf8')) as unknown;
    const parsed = renderCheckpointFileV1Schema.safeParse(raw);
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

export function writeCheckpointFile(file: string, checkpoint: RenderCheckpointFileV1): void {
  writeFileSync(file, `${JSON.stringify(checkpoint, null, 2)}\n`, 'utf8');
}

export type ResumePoint = 'bundle_ready' | 'video_rendered' | 'start';

/**
 * Decides where the worker resumes.
 *
 * - `video_rendered`: a receipt+manifest pair still matches the MP4 bytes on
 *   disk (and the ffprobe identity), so only the final verification must run.
 * - `bundle_ready`: the Remotion bundle/public dir survived, so webpack can
 *   be skipped and rendering restarts from `selectComposition`.
 * - `start`: anything else, including a digest mismatch from another job.
 */
export function decideResumePoint({
  checkpoint,
  jobDigest,
  bundleDir,
  publicDir,
  outDir,
  outputFile,
  jobId,
  artifactId,
}: {
  checkpoint: RenderCheckpointFileV1 | null;
  jobDigest: string;
  bundleDir: string;
  publicDir: string;
  outDir: string;
  outputFile: string;
  jobId: string;
  artifactId: string;
}): ResumePoint {
  if (!checkpoint || checkpoint.jobDigest !== jobDigest) return 'start';

  const hasVideoRendered = checkpoint.phases.some((entry) => entry.phase === 'video_rendered');
  if (hasVideoRendered) {
    const verification = verifyExistingReceipt({ outDir, outputFile, jobId, artifactId });
    if (verification.ok) return 'video_rendered';
  }

  const hasBundleReady = checkpoint.phases.some((entry) => entry.phase === 'bundle_ready');
  if (hasBundleReady && fileExists(path.join(bundleDir, 'index.html'))) {
    // A fresh public dir is cheap to rebuild and guards against a capture file
    // that changed between attempts.
    return 'bundle_ready';
  }
  return 'start';
}
