import { mkdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { bundle, type WebpackOverrideFn } from '@remotion/bundler';
import { renderMedia, selectComposition } from '@remotion/renderer';
import {
  COMPOSITION_ID,
  renderJobDigest,
  stableJson,
  storyboardDurationMs,
  totalStoryboardFrames,
  type ArtifactReceiptV1,
  type RenderCheckpointFileV1,
  type RenderJobInputV1,
  type RenderManifestV1,
  type WorkerEvent,
} from '@asvs/domain';
import { assertDecodable, probeVideo, validateProbe } from './ffprobe';
import { buildArtifactRecords } from './manifest';
import { preparePublicDir } from './media';
import { renderEntry, workspaceRoot } from './paths';
import { rendererVersion } from './renderer-version';
import {
  decideResumePoint,
  readCheckpointFile,
  sha256File,
  verifyExistingReceipt,
  writeCheckpointFile,
  type ResumePoint,
} from './resume';

export interface RenderJobOutcome {
  receipt: ArtifactReceiptV1;
  manifest: RenderManifestV1;
  outputFile: string;
  resumePoint: ResumePoint;
  /** Checkpoint phases hit from the previous attempt (empty on a fresh run). */
  resumedPhases: string[];
}

export class RenderJobError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly retryable: boolean,
  ) {
    super(message);
    this.name = 'RenderJobError';
  }
}

export interface RenderJobOptions {
  job: RenderJobInputV1;
  /** Directory that holds the MP4, receipt, manifest and temporary bundle. */
  outDir: string;
  /** Resumable checkpoint JSON; omit to disable resumability (fixture mode). */
  checkpointFile?: string;
  /** Base for `receipt.storageRef` / `manifest.output.fileName` paths. */
  storageRefBase?: string;
  concurrency?: number;
  /** Emits structured events for the orchestrator (ASVS_EVENT JSONL in CLI). */
  onEvent?: (event: WorkerEvent) => void;
  /** Set false by the plain fixture CLI so reruns always render from scratch. */
  resumable?: boolean;
  /** Keep `.bundle` / `.public` after success (fixture debugging). */
  keepWorkDirs?: boolean;
  heartbeatMs?: number;
}

const webpackOverride: WebpackOverrideFn = (current) => ({
  ...current,
  resolve: {
    ...current.resolve,
    alias: {
      ...(current.resolve?.alias ?? {}),
      '@asvs/domain': path.join(workspaceRoot, 'libs/domain/src/index.ts'),
    },
  },
});

function nowIso(): string {
  return new Date().toISOString();
}

/**
 * Resumable, event-emitting render engine shared by:
 *
 * - `render-job.ts` — the isolated worker process the orchestrator spawns;
 * - `render-fixture.ts` — the golden `pnpm render:fixture` CLI.
 *
 * Checkpoints are only written *after* the artifact they describe is durable on
 * disk. Nothing is deleted on failure, so a `SIGKILL` between checkpoints can
 * always resume from the last one (AC-06).
 */
export async function runRenderJob(options: RenderJobOptions): Promise<RenderJobOutcome> {
  const { job, outDir } = options;
  const emit = options.onEvent ?? (() => undefined);
  const log = (level: 'info' | 'warn' | 'error', message: string) =>
    emit({ type: 'log', level, message, at: nowIso() });
  const progress = (phase: string, percent: number) =>
    emit({ type: 'progress', phase, percent, at: nowIso() });

  const digest = await renderJobDigest({
    jobId: job.jobId,
    artifactId: job.artifactId,
    renderInput: job.input,
    media: job.media,
  });
  if (digest !== job.jobDigest) {
    throw new RenderJobError(
      'invalid_input',
      'render-job 输入与 jobDigest 不一致；拒绝渲染过期或被篡改的输入。',
      false,
    );
  }

  mkdirSync(outDir, { recursive: true });
  const bundleDir = path.join(outDir, '.bundle');
  const publicDir = path.join(outDir, '.public');
  const outputFile = path.join(outDir, job.outputFileName);
  const resumable = options.resumable ?? Boolean(options.checkpointFile);

  let checkpoint: RenderCheckpointFileV1 = resumable && options.checkpointFile
    ? readCheckpointFile(options.checkpointFile) ?? freshCheckpoint(job.jobDigest)
    : freshCheckpoint(job.jobDigest);
  if (checkpoint.jobDigest !== job.jobDigest) {
    // A checkpoint from another job must never leak into this run.
    checkpoint = freshCheckpoint(job.jobDigest);
  }
  const recordCheckpoint = (phase: string, payload: Record<string, unknown>) => {
    checkpoint.phases = checkpoint.phases.filter((entry) => entry.phase !== phase);
    checkpoint.phases.push({ phase, at: nowIso(), payload });
    checkpoint.updatedAt = nowIso();
    if (resumable && options.checkpointFile) writeCheckpointFile(options.checkpointFile, checkpoint);
    emit({ type: 'checkpoint', phase, payload, at: nowIso() });
  };
  const hasPhase = (phase: string) => checkpoint.phases.some((entry) => entry.phase === phase);

  const version = rendererVersion();
  const totalFrames = totalStoryboardFrames(job.input.storyboard);
  const expectedDurationMs = storyboardDurationMs(job.input.storyboard);

  log(
    'info',
    `渲染任务 ${job.jobId} · ${job.input.storyboard.scenes.length} 镜 / ${totalFrames} 帧 / ${expectedDurationMs}ms · ${job.input.renderProfile.width}×${job.input.renderProfile.height}`,
  );

  let resumePoint: ResumePoint = resumable
    ? decideResumePoint({
        checkpoint,
        jobDigest: job.jobDigest,
        bundleDir,
        publicDir,
        outDir,
        outputFile,
        jobId: job.jobId,
        artifactId: job.artifactId,
      })
    : 'start';
  const resumedPhases = [...checkpoint.phases.map((entry) => entry.phase)];
  let serveUrl = bundleDir;

  if (resumePoint === 'start') {
    rmSync(bundleDir, { recursive: true, force: true });
    rmSync(publicDir, { recursive: true, force: true });
  }

  const heartbeat = startHeartbeat(emit, options.heartbeatMs ?? 2000);
  try {
    if (resumePoint === 'video_rendered') {
      try {
        const verified = verifyExistingReceipt({
          outDir,
          outputFile,
          jobId: job.jobId,
          artifactId: job.artifactId,
        });
        if (!verified.ok) {
          throw new RenderJobError('artifact_mismatch', verified.errors.join('；'), true);
        }
        const outcome = finalizeExistingVideo({
          job,
          outputFile,
          outDir,
          storageRefBase: options.storageRefBase,
          expectedDurationMs,
          totalFrames,
          version,
          emit,
          recordCheckpoint,
        });
        log('info', '命中 video_rendered checkpoint：跳过打包与渲染，仅复核回执。');
        cleanupWorkDirs(bundleDir, publicDir, options.keepWorkDirs);
        return { ...outcome, resumePoint, resumedPhases };
      } catch (error) {
        // A file that merely hashes right but cannot be decoded is not a
        // resumable artifact. Fall back instead of failing the whole job.
        const message = error instanceof Error ? error.message : String(error);
        log('warn', `video_rendered checkpoint 复核失败（${message}），回退到重新渲染。`);
        resumePoint = hasPhase('bundle_ready') && existsBundle(bundleDir) ? 'bundle_ready' : 'start';
        if (resumePoint === 'start') {
          rmSync(bundleDir, { recursive: true, force: true });
          rmSync(publicDir, { recursive: true, force: true });
        }
      }
    }

    if (resumePoint === 'bundle_ready') {
      log('info', '命中 bundle_ready checkpoint：跳过 Remotion 打包。');
    } else {
      progress('prepare_media', 0);
      preparePublicDir({ input: job.input, media: job.media, publicDir });
      progress('prepare_media', 100);

      progress('bundle', 0);
      serveUrl = await bundle({
        entryPoint: renderEntry,
        outDir: bundleDir,
        publicDir,
        webpackOverride,
        onProgress: (value) => {
          const percent = Math.floor(value <= 1 ? value * 100 : value);
          progress('bundle', Math.min(100, percent));
        },
      });
      if (!serveUrl) throw new RenderJobError('render_failed', 'Remotion 打包未返回 serveUrl', true);
      recordCheckpoint('bundle_ready', {
        bundleDir,
        publicDir,
        inputDigest: job.jobDigest,
      });
    }

    const inputProps = { input: job.input } as unknown as Record<string, unknown>;
    progress('select_composition', 0);
    const composition = await selectComposition({
      serveUrl,
      id: COMPOSITION_ID,
      inputProps,
    });
    const metadataErrors: string[] = [];
    if (composition.durationInFrames !== totalFrames) {
      metadataErrors.push(
        `时长帧数应为 ${totalFrames}，composition 报告 ${composition.durationInFrames}`,
      );
    }
    if (composition.fps !== job.input.storyboard.fps) {
      metadataErrors.push(`帧率应为 ${job.input.storyboard.fps}，composition 报告 ${composition.fps}`);
    }
    if (
      composition.width !== job.input.renderProfile.width ||
      composition.height !== job.input.renderProfile.height
    ) {
      metadataErrors.push(
        `尺寸应为 ${job.input.renderProfile.width}×${job.input.renderProfile.height}，composition 报告 ${composition.width}×${composition.height}`,
      );
    }
    if (metadataErrors.length > 0) {
      throw new RenderJobError(
        'render_failed',
        `composition 元数据与 Storyboard 不一致：\n- ${metadataErrors.join('\n- ')}`,
        true,
      );
    }
    progress('select_composition', 100);

    progress('render', 0);
    let lastPercent = -5;
    await renderMedia({
      composition,
      serveUrl,
      codec: 'h264',
      outputLocation: outputFile,
      inputProps,
      crf: job.input.renderProfile.crf,
      overwrite: true,
      concurrency: options.concurrency ?? null,
      onProgress: ({ progress: value }) => {
        const percent = Math.floor(value * 100);
        if (percent >= lastPercent + 5 || percent === 100) {
          lastPercent = percent;
          progress('render', Math.min(100, percent));
        }
      },
    });
    progress('render', 100);

    const outputSha256 = sha256File(outputFile);
    // Durable only after the file is closed by Remotion, hence the hash here.
    recordCheckpoint('video_rendered', {
      outputFileName: job.outputFileName,
      outputSha256,
      byteSize: statSync(outputFile).size,
    });

    progress('verify', 0);
    assertDecodable(outputFile);
    const probe = probeVideo(outputFile);
    const probeErrors = validateProbe(probe, {
      width: job.input.renderProfile.width,
      height: job.input.renderProfile.height,
      fps: job.input.storyboard.fps,
      durationMs: expectedDurationMs,
      frameCount: totalFrames,
    });
    if (probeErrors.length > 0) {
      throw new RenderJobError(
        'artifact_mismatch',
        `ffprobe 校验失败：\n- ${probeErrors.join('\n- ')}`,
        true,
      );
    }

    const { receipt, manifest } = buildArtifactRecords({
      jobId: job.jobId,
      artifactId: job.artifactId,
      input: job.input,
      file: outputFile,
      storageRef: storageRefForOutput(outputFile, options.storageRefBase),
      probe,
      rendererVersion: version,
      createdAt: nowIso(),
      media: job.media,
    });
    const receiptFile = path.join(outDir, 'receipt.json');
    const manifestFile = path.join(outDir, 'manifest.json');
    writeFileSync(receiptFile, `${JSON.stringify(receipt, null, 2)}\n`, 'utf8');
    writeFileSync(manifestFile, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
    progress('verify', 100);

    recordCheckpoint('verified_receipt', {
      receiptPath: 'receipt.json',
      manifestPath: 'manifest.json',
      sha256: receipt.sha256,
    });

    log('info', `渲染完成 · ${receipt.storageRef} · SHA256 ${receipt.sha256.slice(0, 12)}…`);
    cleanupWorkDirs(bundleDir, publicDir, options.keepWorkDirs);
    return { receipt, manifest, outputFile, resumePoint, resumedPhases };
  } finally {
    heartbeat.stop();
  }
}

function freshCheckpoint(jobDigest: string): RenderCheckpointFileV1 {
  return {
    schemaVersion: '1',
    kind: 'asvs.render-checkpoint',
    jobDigest,
    updatedAt: nowIso(),
    phases: [],
  };
}

function existsBundle(bundleDir: string): boolean {
  try {
    return statSync(path.join(bundleDir, 'index.html')).isFile();
  } catch {
    return false;
  }
}

function cleanupWorkDirs(bundleDir: string, publicDir: string, keep: boolean | undefined): void {
  if (keep) return;
  // Only after `verified_receipt`: a crash before this point must stay
  // resumable from the bundle.
  rmSync(bundleDir, { recursive: true, force: true });
  rmSync(publicDir, { recursive: true, force: true });
}

function storageRefForOutput(outputFile: string, base: string | undefined): string {
  return path.relative(base ?? workspaceRoot, outputFile).split(path.sep).join('/');
}

function startHeartbeat(emit: (event: WorkerEvent) => void, intervalMs: number) {
  if (intervalMs <= 0) return { stop: () => undefined };
  const timer = setInterval(() => {
    emit({ type: 'heartbeat', pid: process.pid, at: nowIso() });
  }, intervalMs);
  timer.unref?.();
  return { stop: () => clearInterval(timer) };
}

/**
 * Re-verifies an MP4 that survived from a previous attempt. The receipt and
 * manifest already exist; they are only trusted if the file still decodes and
 * ffprobe matches the frozen storyboard.
 */
function finalizeExistingVideo({
  job,
  outputFile,
  outDir,
  storageRefBase,
  expectedDurationMs,
  totalFrames,
  version,
  emit,
  recordCheckpoint,
}: {
  job: RenderJobInputV1;
  outputFile: string;
  outDir: string;
  storageRefBase?: string;
  expectedDurationMs: number;
  totalFrames: number;
  version: string;
  emit: (event: WorkerEvent) => void;
  recordCheckpoint: (phase: string, payload: Record<string, unknown>) => void;
}): Pick<RenderJobOutcome, 'receipt' | 'manifest' | 'outputFile'> {
  assertDecodable(outputFile);
  const probe = probeVideo(outputFile);
  const probeErrors = validateProbe(probe, {
    width: job.input.renderProfile.width,
    height: job.input.renderProfile.height,
    fps: job.input.storyboard.fps,
    durationMs: expectedDurationMs,
    frameCount: totalFrames,
  });
  if (probeErrors.length > 0) {
    throw new RenderJobError('artifact_mismatch', probeErrors.join('；'), true);
  }

  const { receipt, manifest } = buildArtifactRecords({
    jobId: job.jobId,
    artifactId: job.artifactId,
    input: job.input,
    file: outputFile,
    storageRef: storageRefForOutput(outputFile, storageRefBase),
    probe,
    rendererVersion: version,
    createdAt: nowIso(),
    media: job.media,
  });
  const receiptFile = path.join(outDir, 'receipt.json');
  const manifestFile = path.join(outDir, 'manifest.json');
  writeFileSync(receiptFile, `${JSON.stringify(receipt, null, 2)}\n`, 'utf8');
  writeFileSync(manifestFile, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  recordCheckpoint('verified_receipt', {
    receiptPath: 'receipt.json',
    manifestPath: 'manifest.json',
    sha256: receipt.sha256,
  });
  emit({ type: 'progress', phase: 'verify', percent: 100, at: nowIso() });
  return { receipt, manifest, outputFile };
}

/** Canonical JSON of a render job, handy for debugging digest mismatches. */
export function renderJobCanonicalJson(job: RenderJobInputV1): string {
  return stableJson({
    jobId: job.jobId,
    artifactId: job.artifactId,
    input: job.input,
    media: job.media,
  });
}
