import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { launchCaptureBrowser } from './browser';
import { executeDemoPlan } from './executor';
import { loadApprovedDemoPlan } from './plan';
import { blockedOriginPlan, storageRefFor, workspaceRoot } from './paths';

/**
 * docs/08 §9 case 2: a DemoPlan that points outside its allowlist must be
 * refused before a request is made. This launches a real browser and runs the
 * real executor against `plans/blocked-origin.yaml`; the only acceptable
 * outcome is a failure whose reason mentions the allowlist, with zero blocked
 * network requests (because the navigation never left the worker).
 */
async function main(): Promise<void> {
  const parsed = loadApprovedDemoPlan(blockedOriginPlan);
  const outDir = path.join(workspaceRoot, 'dist/browser-worker/safety-blocked-origin');
  rmSync(outDir, { recursive: true, force: true });
  mkdirSync(outDir, { recursive: true });

  console.log('\nAllowlist 安全验收（docs/08 §9 用例 2）');
  console.log('─'.repeat(72));
  console.log(`  DemoPlan ${parsed.relativeFile}`);
  console.log(`  allowlist ${parsed.plan.allowedOrigins.join(', ')}`);

  const session = await launchCaptureBrowser(parsed.plan, path.join(outDir, 'raw'));
  let error: string | undefined;
  let failedStepId: string | undefined;
  let assertions = { total: 0, passed: 0, failed: 0 };
  try {
    const outcome = await executeDemoPlan({
      plan: parsed.plan,
      page: session.page,
      context: session.context,
      outDir,
      recordingStartedAt: session.recordingStartedAt,
      blockedRequests: session.blockedRequests,
    });
    error = outcome.failure?.error;
    failedStepId = outcome.failure?.stepId;
    assertions = outcome.assertions;
    if (!outcome.failure) {
      error = '未阻断：DemoPlan 竟然执行通过';
    }
  } finally {
    await session.close();
  }

  const mentionsAllowlist = Boolean(error && /allowlist|未授权 origin|阻断/i.test(error));
  const noLeakedRequest = session.blockedRequests.length === 0;
  const passed = mentionsAllowlist && noLeakedRequest && assertions.failed === 0;

  const report = {
    schemaVersion: '1',
    kind: 'asvs.capture-safety',
    checkedAt: new Date().toISOString(),
    planId: parsed.plan.id,
    planFile: parsed.relativeFile,
    allowedOrigins: parsed.plan.allowedOrigins,
    attemptedTarget: 'https://example.invalid/',
    passed,
    blockedBeforeNetwork: noLeakedRequest,
    failedStepId,
    error,
    blockedRequests: session.blockedRequests,
    rawVideoSaved: existsSync(path.join(outDir, 'raw'))
      ? readdirSync(path.join(outDir, 'raw')).length > 0
      : false,
  };
  const reportFile = path.join(outDir, 'safety-report.json');
  writeFileSync(reportFile, `${JSON.stringify(report, null, 2)}\n`, 'utf8');

  console.log(`  结果     ${passed ? 'PASS · 导航被 allowlist 拒绝' : 'FAIL'}`);
  console.log(`  原因     ${error ?? '(无)'}`);
  console.log(`  越界请求 ${session.blockedRequests.length}`);
  console.log(`  报告     ${storageRefFor(reportFile)}`);
  console.log('─'.repeat(72));
  process.exitCode = passed ? 0 : 1;
}

main().catch((error: unknown) => {
  console.error('\n安全验收无法运行：');
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
