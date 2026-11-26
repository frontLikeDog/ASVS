import {
  copyFileSync,
  existsSync,
  mkdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import {
  captureFailureV1Schema,
  captureReceiptV1Schema,
  type CaptureFailureV1,
  type CaptureReceiptV1,
  type DemoPlanV1,
} from '@asvs/domain';
import { ensureWebServer, launchCaptureBrowser, type WebServerMode } from './browser';
import { executeDemoPlan, type ExecutionOutcome } from './executor';
import {
  assertDecodable,
  planClip,
  probeVideo,
  sha256File,
  transcodeClip,
  type VideoProbe,
} from './media';
import { loadApprovedDemoPlan, type ParsedDemoPlan } from './plan';
import { defaultOutDir, defaultPlan, storageRefFor } from './paths';
import {
  assertClipLongEnough,
  buildAsset,
  buildCaptureRenderFixture,
  writeCaptureRenderFixture,
} from './render-fixture';

export interface CaptureRunResult {
  passed: boolean;
  planId: string;
  planDigest: string;
  outDir: string;
  receiptFile?: string;
  failureFile?: string;
  error?: string;
  failedStepId?: string;
  assertions: { total: number; passed: number; failed: number };
  durationMs: number;
}

interface CliOptions {
  plan: string;
  outDir: string;
  serve: boolean;
  serveMode: WebServerMode;
}

function printHelp(): void {
  console.log(`用法：tsx src/capture.ts [选项]

  --plan <path>      已批准的 DemoPlan YAML/JSON（默认 plans/web-studio-tour.yaml）
  --out <dir>        输出目录（默认 dist/browser-worker/web-studio-tour）
  --serve=preview    自动启动 production build（默认，需先 pnpm build）
  --serve=dev        自动启动 Vite 开发服务器
  --no-serve         不自动启动 web-studio；目标地址必须已就绪
`);
}

function parseServeMode(value: string | undefined): WebServerMode {
  if (value === 'dev' || value === 'preview') return value;
  throw new Error('--serve 只支持 dev 或 preview');
}

function parseArgs(argv: string[]): CliOptions {
  const options: CliOptions = {
    plan: defaultPlan,
    outDir: defaultOutDir,
    serve: true,
    serveMode: 'preview',
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--plan') {
      const value = argv[++index];
      if (!value) throw new Error('--plan 需要一个路径');
      options.plan = path.resolve(process.cwd(), value);
    } else if (arg === '--out') {
      const value = argv[++index];
      if (!value) throw new Error('--out 需要一个目录');
      options.outDir = path.resolve(process.cwd(), value);
    } else if (arg === '--serve') {
      options.serveMode = parseServeMode(argv[++index]);
    } else if (arg.startsWith('--serve=')) {
      options.serveMode = parseServeMode(arg.slice('--serve='.length));
    } else if (arg === '--no-serve') {
      options.serve = false;
    } else if (arg === '--help' || arg === '-h') {
      printHelp();
      process.exit(0);
    } else {
      throw new Error(`未知参数：${arg}`);
    }
  }
  return options;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function planSlug(planId: string): string {
  return planId
    .replace(/^plan_/, '')
    .replace(/[^a-z0-9]+/gi, '-')
    .replace(/^-+|-+$/g, '')
    .toLowerCase();
}

function fileArtifact(outDir: string, relative: string, mimeType: string) {
  const file = path.join(outDir, relative);
  return {
    file: relative,
    sha256: sha256File(file),
    byteSize: statSync(file).size,
    mimeType,
  };
}

function videoArtifact(outDir: string, relative: string, mimeType: string, probe: VideoProbe) {
  return {
    ...fileArtifact(outDir, relative, mimeType),
    width: probe.width,
    height: probe.height,
    fps: probe.fps,
    durationMs: probe.durationMs,
    codecName: probe.codecName,
  };
}

function adoptRawVideo(source: string, outDir: string): { relative: string; file: string } {
  const rawDir = path.join(outDir, 'raw');
  mkdirSync(rawDir, { recursive: true });
  const target = path.join(rawDir, 'capture.webm');
  try {
    renameSync(source, target);
  } catch {
    copyFileSync(source, target);
    rmSync(source, { force: true });
  }
  return { relative: 'raw/capture.webm', file: target };
}

function collectScreenshots(outDir: string, relativeFiles: string[]) {
  return relativeFiles
    .filter((relative) => existsSync(path.join(outDir, relative)))
    .map((relative) => fileArtifact(outDir, relative, 'image/png'));
}

function mapSteps(outcome: ExecutionOutcome | undefined) {
  return (outcome?.results ?? []).map((step) => ({
    id: step.id,
    action: step.action,
    status: step.status,
    startedAtMs: step.startedAtMs,
    durationMs: step.durationMs,
    ...(step.assertion
      ? {
          assertion: {
            kind: step.assertion.kind,
            ...(step.assertion.expected !== undefined
              ? { expected: step.assertion.expected }
              : {}),
            ...(step.assertion.actual !== undefined ? { actual: step.assertion.actual } : {}),
            passed: step.assertion.passed,
          },
        }
      : {}),
    ...(step.screenshot ? { screenshot: step.screenshot } : {}),
    ...(step.error ? { error: step.error } : {}),
  }));
}

function writeFailureReport({
  plan,
  parsed,
  outDir,
  outcome,
  error,
  failedStepId,
  raw,
  trace,
  createdAt,
}: {
  plan: DemoPlanV1;
  parsed: ParsedDemoPlan;
  outDir: string;
  outcome?: ExecutionOutcome;
  error: string;
  failedStepId?: string;
  raw?: ReturnType<typeof videoArtifact>;
  trace?: ReturnType<typeof fileArtifact>;
  createdAt: string;
}): { file: string; report: CaptureFailureV1 } {
  const report = captureFailureV1Schema.parse({
    schemaVersion: '1',
    kind: 'asvs.capture-failure',
    jobId: `job_capture_${planSlug(plan.id)}`,
    planId: plan.id,
    planFile: parsed.relativeFile,
    planDigest: parsed.digest,
    approvalId: plan.approval.approvalId,
    createdAt,
    ...(failedStepId ? { failedStepId } : {}),
    error,
    assertions: outcome?.assertions ?? { total: 0, passed: 0, failed: 0 },
    steps: mapSteps(outcome),
    artifacts: {
      ...(raw ? { rawVideo: raw } : {}),
      ...(trace ? { trace } : {}),
      screenshots: collectScreenshots(outDir, outcome?.screenshots ?? []),
    },
    blockedRequests: outcome?.blockedRequests ?? [],
  });
  const file = path.join(outDir, 'failure-report.json');
  writeFileSync(file, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  return { file, report };
}

function logSteps(outcome: ExecutionOutcome, log: (line: string) => void): void {
  for (const step of outcome.results) {
    const mark =
      step.status === 'passed' ? 'PASS' : step.status === 'failed' ? 'FAIL' : 'SKIP';
    const assertion = step.assertion
      ? ` · ${step.assertion.kind}${step.assertion.passed ? ' ✓' : ' ✗'}`
      : '';
    log(
      `  ${mark.padEnd(4)} ${step.id.padEnd(24)} ${String(step.durationMs).padStart(5)}ms${assertion}`,
    );
  }
}

/**
 * Executes one already-approved plan against an already-running base URL.
 * Writes a CaptureReceipt only when every assertion passed; failures produce a
 * separate `failure-report.json` plus screenshots/trace.
 */
export async function captureOnce({
  parsed,
  outDir,
  log,
}: {
  parsed: ParsedDemoPlan;
  outDir: string;
  log: (line: string) => void;
}): Promise<CaptureRunResult> {
  const startedAt = Date.now();
  const plan = parsed.plan;
  rmSync(outDir, { recursive: true, force: true });
  mkdirSync(outDir, { recursive: true });

  log(`\nDemoPlan  ${plan.id} · ${plan.name}`);
  log(`  审批   ${plan.approval.approvalId} · ${parsed.digest.slice(0, 16)}…`);
  log(`  目标   ${plan.baseUrl} · ${plan.viewport.width}×${plan.viewport.height}`);
  log('─'.repeat(72));

  const session = await launchCaptureBrowser(plan, path.join(outDir, 'raw'));
  const traceFile = path.join(outDir, 'trace.zip');
  let traceStarted = false;
  let outcome: ExecutionOutcome | undefined;
  let traceError: string | undefined;

  try {
    await session.context.tracing.start({ screenshots: true, snapshots: true, sources: false });
    traceStarted = true;
    outcome = await executeDemoPlan({
      plan,
      page: session.page,
      context: session.context,
      outDir,
      recordingStartedAt: session.recordingStartedAt,
      blockedRequests: session.blockedRequests,
    });
    logSteps(outcome, log);
  } catch (error) {
    outcome = {
      results: [],
      assertions: { total: 0, passed: 0, failed: 0 },
      screenshots: [],
      blockedRequests: session.blockedRequests,
      failure: { stepId: 'executor', error: errorMessage(error) },
    };
    log(`  FAIL 执行器异常：${errorMessage(error)}`);
  } finally {
    if (traceStarted) {
      try {
        await session.context.tracing.stop({ path: traceFile });
      } catch (error) {
        traceError = errorMessage(error);
      }
    }
  }

  const rawSource = await session.close();
  let raw: ReturnType<typeof videoArtifact> | undefined;
  let rawProbe: VideoProbe | undefined;

  if (rawSource && existsSync(rawSource)) {
    const adopted = adoptRawVideo(rawSource, outDir);
    try {
      rawProbe = probeVideo(adopted.file);
      raw = videoArtifact(outDir, adopted.relative, 'video/webm', rawProbe);
    } catch (error) {
      log(`  警告  无法读取录屏视频：${errorMessage(error)}`);
    }
  }

  const trace = existsSync(traceFile)
    ? fileArtifact(outDir, 'trace.zip', 'application/zip')
    : undefined;
  const createdAt = new Date().toISOString();
  const failureReason =
    traceError ??
    outcome.failure?.error ??
    (raw ? undefined : 'Playwright 未生成录屏文件') ??
    (trace ? undefined : '未生成 trace.zip');

  if (!outcome.failure && !traceError && raw && rawProbe && trace) {
    try {
      return await finishSuccess({
        parsed,
        outDir,
        outcome,
        raw,
        rawProbe,
        trace,
        createdAt,
        startedAt,
        log,
      });
    } catch (error) {
      return finishFailure({
        parsed,
        outDir,
        outcome,
        error: `录屏后处理失败：${errorMessage(error)}`,
        raw,
        trace,
        createdAt,
        startedAt,
        log,
      });
    }
  }

  return finishFailure({
    parsed,
    outDir,
    outcome,
    error: failureReason ?? '录屏失败',
    raw,
    trace,
    createdAt,
    startedAt,
    log,
  });
}

async function finishSuccess({
  parsed,
  outDir,
  outcome,
  raw,
  rawProbe,
  trace,
  createdAt,
  startedAt,
  log,
}: {
  parsed: ParsedDemoPlan;
  outDir: string;
  outcome: ExecutionOutcome;
  raw: ReturnType<typeof videoArtifact>;
  rawProbe: VideoProbe;
  trace: ReturnType<typeof fileArtifact>;
  createdAt: string;
  startedAt: number;
  log: (line: string) => void;
}): Promise<CaptureRunResult> {
  const plan = parsed.plan;
  if (
    rawProbe.width !== plan.capture.width ||
    rawProbe.height !== plan.capture.height
  ) {
    throw new Error(
      `Playwright 录屏尺寸 ${rawProbe.width}×${rawProbe.height} 与计划 ${plan.capture.width}×${plan.capture.height} 不一致`,
    );
  }

  const firstAssertion = outcome.firstAssertionAtMs;
  if (firstAssertion === undefined) {
    throw new Error('没有记录到首个断言的相对时间，无法裁剪片头');
  }

  const clipPlan = planClip({
    rawDurationMs: rawProbe.durationMs,
    firstMeaningfulAtMs: firstAssertion,
    clipDurationMs: plan.capture.clipDurationMs,
  });
  log(
    `\n裁剪真实片段：raw ${rawProbe.durationMs}ms → 从 ${clipPlan.startMs}ms 起 ${clipPlan.durationMs}ms`,
  );

  const slug = planSlug(plan.id);
  const clipRelative = `${slug}.mp4`;
  const clipFile = path.join(outDir, clipRelative);
  const clipProbe = transcodeClip({
    input: path.join(outDir, raw.file),
    output: clipFile,
    startMs: clipPlan.startMs,
    durationMs: clipPlan.durationMs,
    fps: plan.capture.fps,
    width: plan.capture.width,
    height: plan.capture.height,
  });
  assertDecodable(clipFile);
  assertClipLongEnough(clipProbe);
  const clipSha256 = sha256File(clipFile);
  const clip = videoArtifact(outDir, clipRelative, 'video/mp4', clipProbe);

  const receiptFile = path.join(outDir, 'capture-receipt.json');
  const asset = buildAsset({
    planId: plan.id,
    planDigest: parsed.digest,
    assetId: plan.asset.id,
    assetName: plan.asset.name,
    assetDescription: plan.asset.description,
    assetPalette: plan.asset.palette,
    clip: clipProbe,
    clipSha256,
    clipFile,
    receiptFile,
    createdAt,
  });

  const fixture = buildCaptureRenderFixture({
    planId: plan.id,
    planDigest: parsed.digest,
    assetId: plan.asset.id,
    assetName: plan.asset.name,
    assetDescription: plan.asset.description,
    assetPalette: plan.asset.palette,
    clip: clipProbe,
    clipSha256,
    clipFile,
    receiptFile,
    createdAt,
    asset,
    mediaSha256: clipSha256,
  });
  const written = writeCaptureRenderFixture(outDir, fixture);
  const fixtureSha256 = sha256File(written.file);

  const screenshots = collectScreenshots(outDir, outcome.screenshots);
  if (screenshots.length === 0) {
    throw new Error('没有生成任何断言截图，无法证明断言通过');
  }

  writeFileSync(
    path.join(outDir, 'asset.json'),
    `${JSON.stringify(
      {
        note: '真实录屏 Asset；media.sourceFile 是同一片段的工作区相对路径。',
        asset,
        media: {
          assetId: asset.id,
          sourceFile: storageRefFor(clipFile),
          sha256: clipSha256,
          mimeType: 'video/mp4',
          width: clipProbe.width,
          height: clipProbe.height,
          durationMs: clipProbe.durationMs,
        },
      },
      null,
      2,
    )}\n`,
    'utf8',
  );

  const receipt = captureReceiptV1Schema.parse({
    schemaVersion: '1',
    kind: 'asvs.capture-receipt',
    jobId: `job_capture_${slug}`,
    planId: plan.id,
    planFile: parsed.relativeFile,
    planDigest: parsed.digest,
    approvalId: plan.approval.approvalId,
    createdAt,
    environment: {
      baseUrl: plan.baseUrl,
      browser: 'Chromium',
      viewport: {
        width: plan.viewport.width,
        height: plan.viewport.height,
        deviceScaleFactor: plan.viewport.deviceScaleFactor,
      },
      locale: plan.locale,
      timezoneId: plan.timezoneId,
      colorScheme: plan.colorScheme,
      reducedMotion: plan.reducedMotion,
      ...(plan.clockTime ? { clockTime: plan.clockTime } : {}),
    },
    assertions: outcome.assertions,
    steps: mapSteps(outcome),
    rawVideo: raw,
    clip,
    trace,
    screenshots,
    asset,
    media: {
      assetId: asset.id,
      sourceFile: storageRefFor(clipFile),
      sha256: clipSha256,
      mimeType: 'video/mp4',
      width: clipProbe.width,
      height: clipProbe.height,
      durationMs: clipProbe.durationMs,
    },
    renderFixture: { file: written.relativeFile, sha256: fixtureSha256 },
  });

  writeFileSync(receiptFile, `${JSON.stringify(receipt, null, 2)}\n`, 'utf8');

  const durationMs = Date.now() - startedAt;
  log('\n录屏通过：全部断言成功，已写 CaptureReceipt');
  log('─'.repeat(72));
  log(`  断言     ${receipt.assertions.passed}/${receipt.assertions.total} 通过`);
  log(`  WebM     ${raw.file} · ${(raw.byteSize / 1024 / 1024).toFixed(2)} MiB`);
  log(`  MP4      ${clip.file} · ${clip.width}×${clip.height} · ${clip.fps}fps · ${clip.durationMs}ms`);
  log(`  SHA256   ${receipt.clip.sha256}`);
  log(`  截图     ${receipt.screenshots.length} 张 · trace ${(trace.byteSize / 1024).toFixed(0)} KiB`);
  log(`  回执     ${storageRefFor(receiptFile)}`);
  log(`  渲染输入 ${written.relativeFile}`);
  log(`  用时     ${(durationMs / 1000).toFixed(1)}s`);

  return {
    passed: true,
    planId: plan.id,
    planDigest: parsed.digest,
    outDir,
    receiptFile,
    assertions: outcome.assertions,
    durationMs,
  };
}

function finishFailure({
  parsed,
  outDir,
  outcome,
  error,
  raw,
  trace,
  createdAt,
  startedAt,
  log,
}: {
  parsed: ParsedDemoPlan;
  outDir: string;
  outcome?: ExecutionOutcome;
  error: string;
  raw?: ReturnType<typeof videoArtifact>;
  trace?: ReturnType<typeof fileArtifact>;
  createdAt: string;
  startedAt: number;
  log: (line: string) => void;
}): CaptureRunResult {
  const { file, report } = writeFailureReport({
    plan: parsed.plan,
    parsed,
    outDir,
    outcome,
    error,
    failedStepId: outcome?.failure?.stepId,
    raw,
    trace,
    createdAt,
  });
  const durationMs = Date.now() - startedAt;

  log('\n录屏失败：未写 CaptureReceipt');
  log('─'.repeat(72));
  log(`  原因     ${report.error}`);
  if (report.failedStepId) log(`  步骤     ${report.failedStepId}`);
  log(`  断言     ${report.assertions.passed}/${report.assertions.total} 通过`);
  log(`  截图     ${report.artifacts.screenshots.length} 张`);
  log(`  报告     ${storageRefFor(file)}`);
  log(`  用时     ${(durationMs / 1000).toFixed(1)}s`);

  return {
    passed: false,
    planId: parsed.plan.id,
    planDigest: parsed.digest,
    outDir,
    failureFile: file,
    error: report.error,
    failedStepId: report.failedStepId,
    assertions: report.assertions,
    durationMs,
  };
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const parsed = loadApprovedDemoPlan(options.plan);
  const log = (line: string) => console.log(line);

  const server = await ensureWebServer(parsed.plan.baseUrl, {
    serve: options.serve,
    mode: options.serveMode,
    log,
  });
  try {
    const result = await captureOnce({ parsed, outDir: options.outDir, log });
    process.exitCode = result.passed ? 0 : 1;
  } finally {
    await server.stop();
  }
}

main().catch((error: unknown) => {
  console.error('\n录屏无法开始：');
  console.error(errorMessage(error));
  process.exitCode = 1;
});
