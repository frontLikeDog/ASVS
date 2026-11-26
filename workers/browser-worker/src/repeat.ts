import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { captureRepeatReportV1Schema } from '@asvs/domain';
import { ensureWebServer, type WebServerMode } from './browser';
import { captureOnce, planSlug, type CaptureRunResult } from './capture';
import { loadApprovedDemoPlan } from './plan';
import { defaultPlan, repeatOutDir, storageRefFor } from './paths';

interface CliOptions {
  runs: number;
  threshold: number;
  plan: string;
  outDir: string;
  serve: boolean;
  serveMode: WebServerMode;
}

function parseArgs(argv: string[]): CliOptions {
  const options: CliOptions = {
    runs: 3,
    threshold: 0.8,
    plan: defaultPlan,
    outDir: repeatOutDir,
    serve: true,
    serveMode: 'preview',
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--runs') {
      const value = Number(argv[++index]);
      if (!Number.isInteger(value) || value < 1 || value > 20) {
        throw new Error('--runs 需要 1–20 的整数');
      }
      options.runs = value;
    } else if (arg === '--threshold') {
      const value = Number(argv[++index]);
      if (!Number.isFinite(value) || value < 0 || value > 1) {
        throw new Error('--threshold 需要 0–1 之间的小数');
      }
      options.threshold = value;
    } else if (arg === '--plan') {
      const value = argv[++index];
      if (!value) throw new Error('--plan 需要一个路径');
      options.plan = path.resolve(process.cwd(), value);
    } else if (arg === '--out') {
      const value = argv[++index];
      if (!value) throw new Error('--out 需要一个目录');
      options.outDir = path.resolve(process.cwd(), value);
    } else if (arg === '--serve') {
      const value = argv[++index];
      if (value !== 'dev' && value !== 'preview') throw new Error('--serve 只支持 dev 或 preview');
      options.serveMode = value;
    } else if (arg.startsWith('--serve=')) {
      const value = arg.slice('--serve='.length);
      if (value !== 'dev' && value !== 'preview') throw new Error('--serve 只支持 dev 或 preview');
      options.serveMode = value;
    } else if (arg === '--no-serve') {
      options.serve = false;
    } else if (arg === '--help' || arg === '-h') {
      console.log(`用法：tsx src/repeat.ts [--runs 3] [--threshold 0.8] [--plan <path>] [--serve=preview|dev] [--no-serve]

连续执行同一份已批准 DemoPlan，记录通过率与失败原因。`);
      process.exit(0);
    } else {
      throw new Error(`未知参数：${arg}`);
    }
  }
  return options;
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const parsed = loadApprovedDemoPlan(options.plan);
  const log = (line: string) => console.log(line);
  const slug = planSlug(parsed.plan.id);
  const batchDir = path.join(options.outDir, `${slug}-${new Date().toISOString().replace(/[:.]/g, '-')}`);
  mkdirSync(batchDir, { recursive: true });

  const server = await ensureWebServer(parsed.plan.baseUrl, {
    serve: options.serve,
    mode: options.serveMode,
    log,
  });
  const results: CaptureRunResult[] = [];
  try {
    for (let run = 1; run <= options.runs; run += 1) {
      log(`\n═══ 重复执行 ${run}/${options.runs} ═══`);
      const outDir = path.join(batchDir, `run-${run}`);
      try {
        results.push(await captureOnce({ parsed, outDir, log }));
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        log(`  运行 ${run} 崩溃：${message}`);
        results.push({
          passed: false,
          planId: parsed.plan.id,
          planDigest: parsed.digest,
          outDir,
          error: message,
          assertions: { total: 0, passed: 0, failed: 0 },
          durationMs: 0,
        });
      }
    }
  } finally {
    await server.stop();
  }

  const passed = results.filter((result) => result.passed).length;
  const failed = results.length - passed;
  const passRate = results.length > 0 ? passed / results.length : 0;
  const createdAt = new Date().toISOString();
  const report = captureRepeatReportV1Schema.parse({
    schemaVersion: '1',
    kind: 'asvs.capture-repeat',
    planId: parsed.plan.id,
    planDigest: parsed.digest,
    createdAt,
    threshold: options.threshold,
    runs: results.map((result, index) => ({
      run: index + 1,
      passed: result.passed,
      durationMs: result.durationMs,
      ...(result.receiptFile ? { receiptFile: storageRefFor(result.receiptFile) } : {}),
      ...(result.failureFile ? { failureFile: storageRefFor(result.failureFile) } : {}),
      ...(result.failedStepId ? { failedStepId: result.failedStepId } : {}),
      assertionFailures: result.assertions.failed,
      ...(result.error ? { error: result.error } : {}),
    })),
    passed,
    failed,
    passRate,
  });
  const reportFile = path.join(batchDir, 'repeat-report.json');
  writeFileSync(reportFile, `${JSON.stringify(report, null, 2)}\n`, 'utf8');

  const reasons = new Map<string, number>();
  for (const result of results) {
    if (result.passed) continue;
    const reason = result.failedStepId
      ? `${result.failedStepId}: ${result.error ?? '未知错误'}`
      : (result.error ?? '未知错误');
    reasons.set(reason, (reasons.get(reason) ?? 0) + 1);
  }

  console.log('\n重复执行结果');
  console.log('═'.repeat(72));
  for (const [index, result] of results.entries()) {
    console.log(
      `  ${result.passed ? 'PASS' : 'FAIL'}  run ${index + 1}  ${(result.durationMs / 1000).toFixed(1)}s  ${
        result.passed ? `${result.assertions.passed}/${result.assertions.total} 断言` : (result.error ?? '')
      }`,
    );
  }
  console.log('─'.repeat(72));
  console.log(`  通过率   ${passed}/${results.length} = ${(passRate * 100).toFixed(0)}%（门槛 ${(options.threshold * 100).toFixed(0)}%）`);
  if (reasons.size > 0) {
    console.log('  失败分布');
    for (const [reason, count] of reasons) console.log(`    ${count}× ${reason}`);
  }
  console.log(`  报告     ${storageRefFor(reportFile)}`);
  console.log('═'.repeat(72));

  process.exitCode = passRate >= options.threshold ? 0 : 1;
}

main().catch((error: unknown) => {
  console.error('\n重复执行无法开始：');
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
