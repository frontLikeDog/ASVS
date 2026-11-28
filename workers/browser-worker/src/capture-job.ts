import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  CAPTURE_SCHEMA_VERSION,
  captureCheckpointFileV1Schema,
  captureFailureV1Schema,
  captureJobInputV1Schema,
  captureJobResultV1Schema,
  captureReceiptV1Schema,
  computeDemoPlanDigest,
  demoPlanV1Schema,
  encodeWorkerEvent,
  isRetryableCaptureCode,
  stableStringify,
  type CaptureCheckpointFileV1,
  type CaptureFailureKind,
  type CaptureJobInputV1,
  type CaptureJobResultV1,
  type DemoPlanV1,
  type WorkerEvent,
} from '@asvs/domain';
import { ensureWebServer, type WebServerMode } from './browser';
import { captureOnce, type CaptureRunResult } from './capture';
import type { ParsedDemoPlan } from './plan';

/**
 * Capture job worker (Step 5C).
 *
 * Spawned by `apps/api/src/orchestration/capture-process-executor.ts` as an
 * isolated OS process:
 *
 *   tsx src/capture-job.ts --input <job.json> --out <dir> \
 *       --checkpoint <dir>/checkpoints.json --storage-ref-base <root>
 *
 * Protocol:
 *   stdout  — one `ASVS_EVENT <json>` line per event (heartbeat / checkpoint /
 *             log / completed / failed). Human output goes to stderr.
 *   on disk — `<out>/job-result.json` is written *before* the process exits,
 *             so a crash between the `failed` event and exit still leaves the
 *             structured failure for the orchestrator.
 *
 * Anti-tampering (layer 3 of 3): this process re-parses the plan from the job
 * file, recomputes its digest with the same canonical algorithm the planner
 * used, and refuses to launch Chromium when the digest does not equal
 * `approval.approvedPlanDigest`. A tampered `capture-job-input.json` therefore
 * produces `capture_plan_tampered`, never a receipt.
 */

const HEARTBEAT_INTERVAL_MS = 3000;

interface CliOptions {
  inputFile: string;
  outDir: string;
  checkpointFile: string;
  storageRefBase: string;
  serve: boolean;
  serveMode: WebServerMode;
}

function log(message: string): void {
  process.stderr.write(`${message}\n`);
}

function emit(event: WorkerEvent): void {
  process.stdout.write(`${encodeWorkerEvent(event)}\n`);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function sha256Text(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

function sha256File(file: string): string {
  return createHash('sha256').update(readFileSync(file)).digest('hex');
}

/**
 * The worker's own copy of the canonical digest. It must equal the domain
 * implementation used by the planner; a divergence would make every plan look
 * tampered, so `capture-job.test.ts` pins them together with a known vector.
 */
export function workerPlanDigest(plan: DemoPlanV1): string {
  const { approval: _approval, ...rest } = plan;
  return createHash('sha256').update(stableStringify(rest), 'utf8').digest('hex');
}

export function parseArgs(argv: string[]): CliOptions {
  const options: Partial<CliOptions> = { serve: false, serveMode: 'preview' };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--input') {
      const value = argv[++index];
      if (!value) throw new Error('--input 需要一个路径');
      options.inputFile = path.resolve(process.cwd(), value);
    } else if (arg === '--out') {
      const value = argv[++index];
      if (!value) throw new Error('--out 需要一个目录');
      options.outDir = path.resolve(process.cwd(), value);
    } else if (arg === '--checkpoint') {
      const value = argv[++index];
      if (!value) throw new Error('--checkpoint 需要一个路径');
      options.checkpointFile = path.resolve(process.cwd(), value);
    } else if (arg === '--storage-ref-base') {
      const value = argv[++index];
      if (!value) throw new Error('--storage-ref-base 需要一个路径');
      options.storageRefBase = path.resolve(process.cwd(), value);
    } else if (arg === '--serve') {
      const value = argv[++index];
      if (value !== 'dev' && value !== 'preview') throw new Error('--serve 只支持 dev 或 preview');
      options.serve = true;
      options.serveMode = value;
    } else if (arg.startsWith('--serve=')) {
      const value = arg.slice('--serve='.length);
      if (value !== 'dev' && value !== 'preview') throw new Error('--serve 只支持 dev 或 preview');
      options.serve = true;
      options.serveMode = value;
    } else if (arg === '--help' || arg === '-h') {
      process.stdout.write(
        '用法：tsx src/capture-job.ts --input <job.json> --out <dir> --checkpoint <file> --storage-ref-base <root> [--serve=preview|dev]\n',
      );
      process.exit(0);
    } else {
      throw new Error(`未知参数：${arg}`);
    }
  }
  if (!options.inputFile) throw new Error('缺少 --input');
  if (!options.outDir) throw new Error('缺少 --out');
  if (!options.checkpointFile) throw new Error('缺少 --checkpoint');
  if (!options.storageRefBase) throw new Error('缺少 --storage-ref-base');
  return options as CliOptions;
}

interface JobState {
  job: CaptureJobInputV1;
  outDir: string;
  checkpointFile: string;
  storageRefBase: string;
  phases: Array<{ phase: string; at: string; payload: Record<string, unknown> }>;
}

function writeCheckpoint(state: JobState, phase: string, payload: Record<string, unknown> = {}): void {
  const at = new Date().toISOString();
  state.phases.push({ phase, at, payload });
  const checkpoint: CaptureCheckpointFileV1 = captureCheckpointFileV1Schema.parse({
    schemaVersion: CAPTURE_SCHEMA_VERSION,
    kind: 'asvs.capture-checkpoint',
    jobDigest: state.job.jobDigest,
    updatedAt: at,
    phases: state.phases,
  });
  mkdirSync(path.dirname(state.checkpointFile), { recursive: true });
  writeFileSync(state.checkpointFile, `${JSON.stringify(checkpoint, null, 2)}\n`, 'utf8');
  emit({ type: 'checkpoint', phase, payload, at });
}

function ref(state: JobState, file: string): string {
  return path.relative(state.storageRefBase, file).split(path.sep).join('/');
}

function writeResult(outDir: string, result: CaptureJobResultV1): void {
  const validated = captureJobResultV1Schema.parse(result);
  mkdirSync(outDir, { recursive: true });
  writeFileSync(path.join(outDir, 'job-result.json'), `${JSON.stringify(validated, null, 2)}\n`, 'utf8');
}

function failedResult(
  state: JobState,
  code: CaptureFailureKind,
  message: string,
  extra: {
    failedStepId?: string;
    failureReportRef?: string;
    traceRef?: string;
    screenshotRefs?: string[];
    assertionFailures?: number;
  } = {},
  startedAt = Date.now(),
): CaptureJobResultV1 {
  return captureJobResultV1Schema.parse({
    schemaVersion: CAPTURE_SCHEMA_VERSION,
    kind: 'asvs.capture-job-result',
    jobId: state.job.jobId,
    planId: state.job.plan.id,
    planDigest: state.job.planDigest,
    policyVersion: state.job.policyVersion,
    passed: false,
    failed: {
      kind: 'asvs.capture-job-failed',
      jobId: state.job.jobId,
      code,
      message,
      ...(extra.failedStepId ? { failedStepId: extra.failedStepId } : {}),
      ...(extra.failureReportRef ? { failureReportRef: extra.failureReportRef } : {}),
      ...(extra.traceRef ? { traceRef: extra.traceRef } : {}),
      screenshotRefs: extra.screenshotRefs ?? [],
      assertionFailures: extra.assertionFailures ?? 0,
      retryable: isRetryableCaptureCode(code),
      failedAt: new Date().toISOString(),
    },
    durationMs: Date.now() - startedAt,
    writtenAt: new Date().toISOString(),
  });
}

/** Reads the job file, validates it, and re-checks the plan digest. */
async function loadJob(inputFile: string): Promise<
  | { ok: true; job: CaptureJobInputV1; parsed: ParsedDemoPlan }
  | { ok: false; code: CaptureFailureKind; message: string }
> {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(inputFile, 'utf8')) as unknown;
  } catch (error) {
    return {
      ok: false,
      code: 'capture_invalid_input',
      message: `无法读取 capture-job-input.json：${errorMessage(error)}`,
    };
  }
  const parsedJob = captureJobInputV1Schema.safeParse(raw);
  if (!parsedJob.success) {
    return {
      ok: false,
      code: 'capture_invalid_input',
      message: `capture-job 校验失败：${parsedJob.error.issues
        .slice(0, 4)
        .map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`)
        .join('；')}`,
    };
  }
  const job = parsedJob.data;

  // Re-parse the plan from scratch. `demoPlanV1Schema` is strict, so an
  // injected field fails here rather than reaching the executor.
  const planResult = demoPlanV1Schema.safeParse(job.plan);
  if (!planResult.success) {
    return {
      ok: false,
      code: 'capture_plan_tampered',
      message: `计划未通过 schema 复检：${planResult.error.issues
        .slice(0, 4)
        .map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`)
        .join('；')}`,
    };
  }
  const plan = planResult.data;
  const actual = workerPlanDigest(plan);
  const expectedDomain = await computeDemoPlanDigest(plan);
  if (actual !== expectedDomain) {
    return {
      ok: false,
      code: 'capture_plan_tampered',
      message: 'worker 与领域层对同一计划算出了不同的摘要；拒绝启动浏览器。',
    };
  }
  if (actual !== job.planDigest || actual !== plan.approval.approvedPlanDigest) {
    return {
      ok: false,
      code: 'capture_plan_tampered',
      message: [
        '计划内容与批准的摘要不一致，拒绝启动 Chromium（docs/08 §9 用例 7）。',
        `job.planDigest: ${job.planDigest}`,
        `approval.approvedPlanDigest: ${plan.approval.approvedPlanDigest}`,
        `实际摘要: ${actual}`,
      ].join('\n'),
    };
  }
  const relativeFile = path
    .relative(job.storageRefBase, inputFile)
    .split(path.sep)
    .join('/');
  return {
    ok: true,
    job,
    parsed: { plan, digest: actual, file: inputFile, relativeFile },
  };
}

async function run(options: CliOptions): Promise<CaptureJobResultV1> {
  const startedAt = Date.now();
  const loaded = await loadJob(options.inputFile);
  if (!loaded.ok) {
    // Nothing exists yet, so the failure is written next to the (future) job
    // result with only what the job file itself told us.
    let jobId = 'unknown';
    let planId = 'unknown';
    let planDigest = '0'.repeat(64);
    let policyVersion = 'unknown';
    try {
      const raw = JSON.parse(readFileSync(options.inputFile, 'utf8')) as Partial<CaptureJobInputV1>;
      jobId = typeof raw.jobId === 'string' ? raw.jobId : jobId;
      planId = typeof raw.plan?.id === 'string' ? raw.plan.id : planId;
      planDigest = typeof raw.planDigest === 'string' ? raw.planDigest : planDigest;
      policyVersion = typeof raw.policyVersion === 'string' ? raw.policyVersion : policyVersion;
    } catch {
      // Keep the placeholders.
    }
    const result = captureJobResultV1Schema.parse({
      schemaVersion: CAPTURE_SCHEMA_VERSION,
      kind: 'asvs.capture-job-result',
      jobId,
      planId,
      planDigest,
      policyVersion,
      passed: false,
      failed: {
        kind: 'asvs.capture-job-failed',
        jobId,
        code: loaded.code,
        message: loaded.message,
        screenshotRefs: [],
        assertionFailures: 0,
        retryable: isRetryableCaptureCode(loaded.code),
        failedAt: new Date().toISOString(),
      },
      durationMs: Date.now() - startedAt,
      writtenAt: new Date().toISOString(),
    });
    writeResult(options.outDir, result);
    emit({
      type: 'failed',
      code: loaded.code,
      message: loaded.message,
      at: new Date().toISOString(),
    });
    return result;
  }

  const { job, parsed } = loaded;
  const state: JobState = {
    job,
    outDir: options.outDir,
    checkpointFile: options.checkpointFile,
    storageRefBase: options.storageRefBase,
    phases: [],
  };

  // The server-level allowlist is re-checked here: a job written by an older
  // API (or edited on disk) must not capture an origin the server refuses.
  for (const origin of job.plan.allowedOrigins) {
    if (!job.allowedOrigins.includes(origin)) {
      const message = `计划 origin ${origin} 不在服务端 allowlist 中，拒绝录屏。`;
      const result = failedResult(state, 'capture_origin_blocked', message, {}, startedAt);
      writeResult(options.outDir, result);
      emit({ type: 'failed', code: 'capture_origin_blocked', message, at: new Date().toISOString() });
      return result;
    }
  }

  writeCheckpoint(state, 'plan_verified', { planDigest: job.planDigest, planId: job.plan.id });

  const heartbeat = setInterval(() => {
    emit({ type: 'heartbeat', pid: process.pid, at: new Date().toISOString() });
  }, HEARTBEAT_INTERVAL_MS);
  heartbeat.unref?.();

  let server: Awaited<ReturnType<typeof ensureWebServer>> | null = null;
  try {
    server = await ensureWebServer(job.plan.baseUrl, {
      serve: options.serve,
      mode: options.serveMode,
      log,
    });
    writeCheckpoint(state, 'capture_started', { baseUrl: job.plan.baseUrl });
    emit({ type: 'progress', phase: 'capture_started', percent: 10 });

    const runResult: CaptureRunResult = await captureOnce({
      parsed,
      outDir: options.outDir,
      log,
    });

    if (!runResult.passed) {
      const code: CaptureFailureKind = classifyFailure(runResult);
      const reportFile = runResult.failureFile;
      const traceFile = path.join(options.outDir, 'trace.zip');
      const screenshotFiles = existsSync(options.outDir)
        ? listScreenshots(options.outDir)
        : [];
      const result = failedResult(
        state,
        code,
        runResult.error ?? '录屏失败',
        {
          ...(runResult.failedStepId ? { failedStepId: runResult.failedStepId } : {}),
          ...(reportFile ? { failureReportRef: ref(state, reportFile) } : {}),
          ...(existsSync(traceFile) ? { traceRef: ref(state, traceFile) } : {}),
          screenshotRefs: screenshotFiles.map((file) => ref(state, file)),
          assertionFailures: runResult.assertions.failed,
        },
        startedAt,
      );
      writeResult(options.outDir, result);
      const failed = result.failed!;
      emit({
        type: 'failed',
        code,
        message: failed.message,
        ...(runResult.failedStepId ? { failedStepId: runResult.failedStepId } : {}),
        artifacts: {
          ...(reportFile ? { failureReportPath: reportFile } : {}),
          ...(existsSync(traceFile) ? { tracePath: traceFile } : {}),
          screenshotPaths: screenshotFiles,
        },
        at: new Date().toISOString(),
      });
      return result;
    }

    if (!runResult.receiptFile) {
      const result = failedResult(
        state,
        'capture_artifact_mismatch',
        '录屏报告通过但没有写回执；拒绝把无回执的结果当作成功。',
        {},
        startedAt,
      );
      writeResult(options.outDir, result);
      emit({ type: 'failed', code: 'capture_artifact_mismatch', message: result.failed!.message, at: new Date().toISOString() });
      return result;
    }

    const receiptRaw = JSON.parse(readFileSync(runResult.receiptFile, 'utf8')) as unknown;
    const receipt = captureReceiptV1Schema.parse(receiptRaw);
    // The worker re-hashes the clip it is about to hand over: the receipt is
    // only a claim until the bytes on disk match it.
    const clipFile = path.isAbsolute(receipt.media.sourceFile)
      ? receipt.media.sourceFile
      : path.resolve(options.storageRefBase, ...receipt.media.sourceFile.split('/'));
    if (!existsSync(clipFile)) {
      const result = failedResult(
        state,
        'capture_artifact_mismatch',
        `回执指向的片段不存在：${receipt.media.sourceFile}`,
        {},
        startedAt,
      );
      writeResult(options.outDir, result);
      emit({ type: 'failed', code: 'capture_artifact_mismatch', message: result.failed!.message, at: new Date().toISOString() });
      return result;
    }
    const clipSha = sha256File(clipFile);
    if (clipSha !== receipt.clip.sha256 || clipSha !== receipt.media.sha256) {
      const result = failedResult(
        state,
        'capture_artifact_mismatch',
        `片段 SHA256 与回执不一致：${clipSha.slice(0, 12)}… vs ${receipt.clip.sha256.slice(0, 12)}…`,
        {},
        startedAt,
      );
      writeResult(options.outDir, result);
      emit({ type: 'failed', code: 'capture_artifact_mismatch', message: result.failed!.message, at: new Date().toISOString() });
      return result;
    }

    writeCheckpoint(state, 'capture_recorded', {
      clipSha256: clipSha,
      screenshotCount: receipt.screenshots.length,
    });
    writeCheckpoint(state, 'clip_transcoded', {
      clipDurationMs: receipt.clip.durationMs,
      width: receipt.clip.width,
      height: receipt.clip.height,
    });
    emit({ type: 'progress', phase: 'capture_complete', percent: 100 });

    const completed = {
      kind: 'asvs.capture-job-completed' as const,
      jobId: job.jobId,
      planId: receipt.planId,
      planDigest: receipt.planDigest,
      receiptFile: ref(state, runResult.receiptFile),
      receiptSha256: sha256File(runResult.receiptFile),
      clipFile: ref(state, clipFile),
      clipSha256: clipSha,
      clipDurationMs: receipt.clip.durationMs,
      clipWidth: receipt.clip.width,
      clipHeight: receipt.clip.height,
      assertions: { total: receipt.assertions.total, passed: receipt.assertions.passed, failed: 0 as const },
      screenshotCount: receipt.screenshots.length,
      completedAt: new Date().toISOString(),
    };
    const failureReport = path.join(options.outDir, 'failure-report.json');
    const result = captureJobResultV1Schema.parse({
      schemaVersion: CAPTURE_SCHEMA_VERSION,
      kind: 'asvs.capture-job-result',
      jobId: job.jobId,
      planId: receipt.planId,
      planDigest: receipt.planDigest,
      policyVersion: job.policyVersion,
      passed: true,
      completed,
      durationMs: Date.now() - startedAt,
      writtenAt: new Date().toISOString(),
    });
    writeResult(options.outDir, result);
    emit({
      type: 'completed',
      receiptPath: runResult.receiptFile,
      manifestPath: path.join(options.outDir, 'asset.json'),
      outputPath: clipFile,
      outputSha256: clipSha,
      byteSize: existsSync(clipFile) ? readFileSync(clipFile).byteLength : 0,
      capture: {
        planId: receipt.planId,
        planDigest: receipt.planDigest,
        receiptPath: runResult.receiptFile,
        receiptSha256: sha256File(runResult.receiptFile),
        clipPath: clipFile,
        clipSha256: clipSha,
        clipWidth: receipt.clip.width,
        clipHeight: receipt.clip.height,
        clipDurationMs: receipt.clip.durationMs,
        assertions: { total: receipt.assertions.total, passed: receipt.assertions.passed },
        ...(existsSync(failureReport) ? { failureReportPath: failureReport } : {}),
      },
      at: new Date().toISOString(),
    });
    return result;
  } catch (error) {
    const message = errorMessage(error);
    const code: CaptureFailureKind = /allowlist|origin/i.test(message)
      ? 'capture_origin_blocked'
      : /未启动|未就绪|ECONNREFUSED|ETIMEDOUT|启动失败/i.test(message)
        ? 'capture_target_unreachable'
        : 'capture_worker_crashed';
    const result = failedResult(state, code, message, {}, startedAt);
    writeResult(options.outDir, result);
    emit({ type: 'failed', code, message, at: new Date().toISOString() });
    return result;
  } finally {
    clearInterval(heartbeat);
    await server?.stop();
  }
}

function listScreenshots(outDir: string): string[] {
  const dir = path.join(outDir, 'screenshots');
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((name) => name.toLowerCase().endsWith('.png'))
    .sort()
    .map((name) => path.join(dir, name));
}

/**
 * Maps a capture run's free-form error to the protocol's fixed codes. The
 * mapping is deliberately conservative: anything we cannot classify is a
 * worker crash, which the orchestrator treats as retryable-with-evidence.
 */
export function classifyFailure(runResult: Pick<CaptureRunResult, 'error' | 'failedStepId'>): CaptureFailureKind {
  const message = runResult.error ?? '';
  // A failed step is an assertion result first, whatever words its message
  // happens to contain. A missing landmark reports "超时仍不可见（4000ms）",
  // which would otherwise be misfiled as a page-wide timeout and hide the
  // fact that the plan ran and one assertion rejected the page.
  if (runResult.failedStepId) return 'capture_assertion_failed';
  if (/allowlist|origin/i.test(message)) return 'capture_origin_blocked';
  if (/未启动|未就绪|ECONNREFUSED|ENOTFOUND|net::ERR|启动失败/i.test(message)) {
    return 'capture_target_unreachable';
  }
  if (/timeout|超时|Timeout/i.test(message)) return 'capture_timeout';
  if (/断言失败|assert/i.test(message)) return 'capture_assertion_failed';
  if (/后处理失败|SHA256|解码|ffprobe|ffmpeg/i.test(message)) return 'capture_artifact_mismatch';
  return 'capture_worker_crashed';
}

/** Exported for the API's verifier: failure reports must be real files. */
export function readFailureReport(file: string) {
  return captureFailureV1Schema.parse(JSON.parse(readFileSync(file, 'utf8')) as unknown);
}

export { sha256Text, ref as storageRefFromBase, emit as emitWorkerEvent, log as logLine };

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const result = await run(options);
  process.exitCode = result.passed ? 0 : 1;
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : '';
const modulePath = path.resolve(fileURLToPath(import.meta.url));
if (invokedPath && modulePath === invokedPath) {
  main().catch((error: unknown) => {
    log(`\ncapture-job 无法启动：${errorMessage(error)}`);
    process.exitCode = 1;
  });
}
