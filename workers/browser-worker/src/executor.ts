import { mkdirSync } from 'node:fs';
import path from 'node:path';
import type { BrowserContext, Locator, Page } from '@playwright/test';
import type { DemoPlanV1, DemoStep } from '@asvs/domain';
import { DemoAssertionError, runAssertion, waitForState } from './assertions';
import { assertFinalUrlAllowed, resolveNavigationUrl } from './allowlist';
import { capturePassed, summarizeAssertions, type AssertionCounts } from './outcome';
import { DemoPlanError } from './plan';
import { parseSelector } from './selector';

export interface ExecutionStepResult {
  id: string;
  action: DemoStep['action'];
  status: 'passed' | 'failed' | 'skipped';
  startedAtMs: number;
  durationMs: number;
  assertion?: {
    kind: string;
    expected?: string;
    actual?: string;
    passed: boolean;
  };
  screenshot?: string;
  error?: string;
}

export interface ExecutionOutcome {
  results: ExecutionStepResult[];
  assertions: AssertionCounts;
  screenshots: string[];
  blockedRequests: string[];
  firstAssertionAtMs?: number;
  failure?: {
    stepId: string;
    error: string;
    screenshot?: string;
  };
}

export interface ExecuteOptions {
  plan: DemoPlanV1;
  page: Page;
  context: BrowserContext;
  outDir: string;
  /** `performance.now()` captured immediately after the recording context existed. */
  recordingStartedAt: number;
  /** Filled by the network guard installed in `browser.ts`. */
  blockedRequests: string[];
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

function safeStepName(index: number, stepId: string): string {
  const safe = stepId.replace(/[^a-zA-Z0-9_-]/g, '-').slice(0, 60);
  return `${String(index + 1).padStart(2, '0')}-${safe}`;
}

async function applyClock(page: Page, plan: DemoPlanV1): Promise<void> {
  if (!plan.clockTime) return;
  await page.clock.setFixedTime(new Date(plan.clockTime));
}

async function resetFixture(page: Page, plan: DemoPlanV1): Promise<void> {
  if (plan.resetStrategy !== 'fixture') return;
  const timeout = plan.steps[0]?.timeoutMs ?? 30_000;
  await page.goto(plan.baseUrl, { waitUntil: 'domcontentloaded', timeout });
  await applyClock(page, plan);
  await page.evaluate(() => {
    window.localStorage.clear();
    window.sessionStorage.clear();
  });
  await page.reload({ waitUntil: 'domcontentloaded', timeout });
  await applyClock(page, plan);
}

function targetLocator(page: Page, step: DemoStep): Locator {
  if (!step.target) {
    throw new DemoPlanError(`步骤 ${step.id}（${step.action}）缺少 target`);
  }
  return parseSelector(page, step.target);
}

function resolveValue(plan: DemoPlanV1, step: DemoStep): string {
  if (step.valueRef !== undefined) {
    const value = plan.fixtures[step.valueRef];
    if (value === undefined) {
      throw new DemoPlanError(`valueRef "${step.valueRef}" 在 fixtures 中不存在`);
    }
    return value;
  }
  if (step.value !== undefined) return step.value;
  throw new DemoPlanError(`步骤 ${step.id} 缺少 value/valueRef`);
}

export async function executeDemoPlan({
  plan,
  page,
  context,
  outDir,
  recordingStartedAt,
  blockedRequests,
}: ExecuteOptions): Promise<ExecutionOutcome> {
  const screenshotsDir = path.join(outDir, 'screenshots');
  mkdirSync(screenshotsDir, { recursive: true });

  const screenshots: string[] = [];
  const results: ExecutionStepResult[] = [];
  let firstAssertionAtMs: number | undefined;

  const takeScreenshot = async (
    index: number,
    step: DemoStep,
    suffix = '',
  ): Promise<string> => {
    const relative = `screenshots/${safeStepName(index, step.id)}${suffix}.png`;
    // Let the last paint settle so the still matches the assertion that passed.
    await page.waitForTimeout(120);
    await page.screenshot({ path: path.join(outDir, relative) });
    screenshots.push(relative);
    return relative;
  };

  try {
    await resetFixture(page, plan);

    for (const [index, step] of plan.steps.entries()) {
      const startedAtMs = Math.max(0, Math.round(performance.now() - recordingStartedAt));
      const started = Date.now();
      let assertionResult: ExecutionStepResult['assertion'];

      try {
        switch (step.action) {
          case 'navigate': {
            const url = resolveNavigationUrl(plan, step.target ?? '/');
            await page.goto(url.href, {
              waitUntil: 'domcontentloaded',
              timeout: step.timeoutMs,
            });
            assertFinalUrlAllowed(plan, page.url());
            await applyClock(page, plan);
            break;
          }
          case 'click': {
            const locator = targetLocator(page, step);
            try {
              await locator.click({ timeout: step.timeoutMs });
            } catch (error) {
              throw new DemoPlanError(
                `步骤 ${step.id} 点击失败（target 必须唯一）：${errorMessage(error)}`,
              );
            }
            break;
          }
          case 'fill': {
            const locator = targetLocator(page, step);
            try {
              await locator.fill(resolveValue(plan, step), { timeout: step.timeoutMs });
            } catch (error) {
              throw new DemoPlanError(
                `步骤 ${step.id} 填写失败（target 必须唯一）：${errorMessage(error)}`,
              );
            }
            break;
          }
          case 'press': {
            const locator = targetLocator(page, step);
            const key = step.key ?? step.value;
            if (!key) throw new DemoPlanError(`步骤 ${step.id} 缺少按键`);
            try {
              await locator.press(key, { timeout: step.timeoutMs });
            } catch (error) {
              throw new DemoPlanError(
                `步骤 ${step.id} 按键失败（target 必须唯一）：${errorMessage(error)}`,
              );
            }
            break;
          }
          case 'wait_for': {
            if (!step.target) throw new DemoPlanError(`步骤 ${step.id} 缺少 target`);
            await waitForState(page, step.target, step.state, step.timeoutMs);
            break;
          }
          case 'assert': {
            if (!step.assertion) throw new DemoPlanError(`步骤 ${step.id} 缺少 assertion`);
            const result = await runAssertion(
              page,
              step.target,
              step.assertion,
              step.timeoutMs,
            );
            assertionResult = result;
            if (firstAssertionAtMs === undefined) firstAssertionAtMs = startedAtMs;
            break;
          }
          case 'capture': {
            if (step.target) {
              const locator = parseSelector(page, step.target);
              await locator.first().waitFor({ state: 'visible', timeout: step.timeoutMs });
              const relative = `screenshots/${safeStepName(index, step.id)}.png`;
              await page.waitForTimeout(120);
              await locator.first().screenshot({ path: path.join(outDir, relative) });
              screenshots.push(relative);
              assertionResult = undefined;
              const result: ExecutionStepResult = {
                id: step.id,
                action: step.action,
                status: 'passed',
                startedAtMs,
                durationMs: Date.now() - started,
                screenshot: relative,
              };
              results.push(result);
              if (step.dwellMs > 0) await page.waitForTimeout(step.dwellMs);
              continue;
            }
            break;
          }
        }

        const result: ExecutionStepResult = {
          id: step.id,
          action: step.action,
          status: 'passed',
          startedAtMs,
          durationMs: Date.now() - started,
          ...(assertionResult ? { assertion: assertionResult } : {}),
        };

        if (step.dwellMs > 0) await page.waitForTimeout(step.dwellMs);

        if (step.action === 'assert' || step.action === 'capture') {
          result.screenshot = await takeScreenshot(index, step);
        }
        results.push(result);
      } catch (error) {
        const assertion =
          error instanceof DemoAssertionError ? error.assertion : assertionResult;
        let failureScreenshot: string | undefined;
        try {
          failureScreenshot = await takeScreenshot(index, step, '-FAILED');
        } catch {
          // A crashed page may not be screenshotable; the trace still exists.
        }
        results.push({
          id: step.id,
          action: step.action,
          status: 'failed',
          startedAtMs,
          durationMs: Date.now() - started,
          ...(assertion ? { assertion } : {}),
          ...(failureScreenshot ? { screenshot: failureScreenshot } : {}),
          error: errorMessage(error),
        });
        for (const skipped of plan.steps.slice(index + 1)) {
          results.push({
            id: skipped.id,
            action: skipped.action,
            status: 'skipped',
            startedAtMs: Math.max(0, Math.round(performance.now() - recordingStartedAt)),
            durationMs: 0,
          });
        }
        return {
          results,
          assertions: summarizeAssertions(results),
          screenshots,
          blockedRequests,
          firstAssertionAtMs,
          failure: {
            stepId: step.id,
            error: errorMessage(error),
            ...(failureScreenshot ? { screenshot: failureScreenshot } : {}),
          },
        };
      }
    }

    // `context` is part of the signature so a future guard registry can be
    // read here; the current guard writes into `blockedRequests` by reference.
    void context;

    if (!capturePassed(results)) {
      return {
        results,
        assertions: summarizeAssertions(results),
        screenshots,
        blockedRequests,
        firstAssertionAtMs,
        failure: {
          stepId: results.at(-1)?.id ?? 'unknown',
          error:
            summarizeAssertions(results).total === 0
              ? 'DemoPlan 没有记录到任何 UI 断言，按断言优先规则判失败'
              : '存在失败的断言或步骤，按断言优先规则判失败',
        },
      };
    }

    if (blockedRequests.length > 0) {
      return {
        results,
        assertions: summarizeAssertions(results),
        screenshots,
        blockedRequests,
        firstAssertionAtMs,
        failure: {
          stepId: results.at(-1)?.id ?? 'unknown',
          error: `存在 ${blockedRequests.length} 个被 allowlist 阻断的请求：${blockedRequests
            .slice(0, 3)
            .join(', ')}`,
        },
      };
    }

    return {
      results,
      assertions: summarizeAssertions(results),
      screenshots,
      blockedRequests,
      firstAssertionAtMs,
    };
  } finally {
    // Trace/video finalization is owned by the caller.
  }
}
