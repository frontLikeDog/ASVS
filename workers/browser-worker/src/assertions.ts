import type { Page } from '@playwright/test';
import type { DemoAssertion } from '@asvs/domain';
import { parseSelector } from './selector';

export interface AssertionResult {
  kind: DemoAssertion['kind'];
  expected?: string;
  actual?: string;
  passed: boolean;
}

export class DemoAssertionError extends Error {
  override name = 'DemoAssertionError';
  readonly assertion: AssertionResult;

  constructor(message: string, assertion: AssertionResult) {
    super(message);
    this.assertion = assertion;
  }
}

const POLL_INTERVAL_MS = 100;
const MAX_ACTUAL_LENGTH = 400;

function display(value: unknown): string {
  if (typeof value === 'string') return value;
  return JSON.stringify(value);
}

function truncate(value: string): string {
  return value.replace(/\s+/g, ' ').trim().slice(0, MAX_ACTUAL_LENGTH);
}

function matches(expected: string | number | boolean, actual: string, match: DemoAssertion['match']): boolean {
  const wanted = display(expected);
  if (match === 'exact') return actual === wanted;
  if (match === 'regex') return new RegExp(wanted).test(actual);
  return actual.includes(wanted);
}

async function readText(locator: ReturnType<typeof parseSelector>): Promise<string> {
  const count = await locator.count();
  if (count === 0) return '';
  const texts = await locator.allTextContents();
  return truncate(texts.join(' | '));
}

async function readValue(locator: ReturnType<typeof parseSelector>): Promise<string> {
  if ((await locator.count()) === 0) return '';
  try {
    return truncate(await locator.first().inputValue());
  } catch {
    return '';
  }
}

async function readAttribute(
  locator: ReturnType<typeof parseSelector>,
  attribute: string,
): Promise<string> {
  if ((await locator.count()) === 0) return '';
  try {
    return truncate((await locator.first().getAttribute(attribute)) ?? '');
  } catch {
    return '';
  }
}

async function poll<T>(
  timeoutMs: number,
  read: () => Promise<T>,
  isDone: (value: T) => boolean,
): Promise<{ value: T; done: boolean }> {
  const deadline = Date.now() + timeoutMs;
  let value = await read();
  while (!isDone(value)) {
    if (Date.now() >= deadline) return { value, done: false };
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
    value = await read();
  }
  return { value, done: true };
}

/**
 * Runs one assertion with a hard timeout. `visible` / `hidden` use Playwright's
 * retrying wait; value/URL/text/count/attribute assertions poll until the
 * expected state appears or the deadline passes. Never resolves with a failed
 * assertion: a failure throws `DemoAssertionError`, which the executor records
 * and turns into a failed run.
 */
export async function runAssertion(
  page: Page,
  target: string | undefined,
  assertion: DemoAssertion,
  timeoutMs: number,
): Promise<AssertionResult> {
  const expected = assertion.expected !== undefined ? display(assertion.expected) : undefined;

  if (assertion.kind === 'visible' || assertion.kind === 'hidden') {
    if (!target) throw new DemoAssertionError('visible/hidden 断言缺少 target', {
      kind: assertion.kind,
      expected,
      passed: false,
    });
    const locator = parseSelector(page, target);
    try {
      await locator.first().waitFor({ state: assertion.kind, timeout: timeoutMs });
    } catch {
      const actual = assertion.kind === 'hidden' ? '仍可见' : '超时仍不可见';
      throw new DemoAssertionError(
        `断言失败 [${assertion.kind}] ${target}：${actual}（${timeoutMs}ms）`,
        { kind: assertion.kind, expected, actual, passed: false },
      );
    }
    const actual =
      assertion.kind === 'hidden' ? 'hidden' : truncate((await locator.first().textContent()) ?? '');
    return { kind: assertion.kind, expected, actual, passed: true };
  }

  if (assertion.kind === 'url') {
    const { value, done } = await poll(
      timeoutMs,
      async () => page.url(),
      (url) => matches(assertion.expected as string | number | boolean, url, assertion.match),
    );
    if (!done) {
      throw new DemoAssertionError(
        `断言失败 [url] 期望 ${expected}，实际 ${value}`,
        { kind: 'url', expected, actual: truncate(value), passed: false },
      );
    }
    return { kind: 'url', expected, actual: truncate(value), passed: true };
  }

  if (!target) {
    throw new DemoAssertionError(`${assertion.kind} 断言缺少 target`, {
      kind: assertion.kind,
      expected,
      passed: false,
    });
  }
  const locator = parseSelector(page, target);

  if (assertion.kind === 'count') {
    const wanted = Number(assertion.expected);
    const { value, done } = await poll(timeoutMs, () => locator.count(), (count) => count === wanted);
    if (!done) {
      throw new DemoAssertionError(
        `断言失败 [count] ${target} 期望 ${wanted} 个，实际 ${value} 个`,
        { kind: 'count', expected: String(wanted), actual: String(value), passed: false },
      );
    }
    return { kind: 'count', expected: String(wanted), actual: String(value), passed: true };
  }

  if (assertion.kind === 'value' || assertion.kind === 'attribute' || assertion.kind === 'text') {
    const read =
      assertion.kind === 'value'
        ? () => readValue(locator)
        : assertion.kind === 'attribute'
          ? () => readAttribute(locator, assertion.attribute as string)
          : () => readText(locator);
    const { value, done } = await poll(
      timeoutMs,
      read,
      (actual) => matches(assertion.expected as string | number | boolean, actual, assertion.match),
    );
    if (!done) {
      throw new DemoAssertionError(
        `断言失败 [${assertion.kind}] ${target} 期望 ${expected}，实际 ${value || '(空)'}`,
        {
          kind: assertion.kind,
          expected,
          actual: value || '(空)',
          passed: false,
        },
      );
    }
    return { kind: assertion.kind, expected, actual: value, passed: true };
  }

  throw new DemoAssertionError(`未知断言类型 ${String(assertion.kind)}`, {
    kind: assertion.kind,
    expected,
    passed: false,
  });
}

export async function waitForState(
  page: Page,
  target: string,
  state: 'visible' | 'hidden' | 'attached',
  timeoutMs: number,
): Promise<void> {
  const locator = parseSelector(page, target);
  await locator.first().waitFor({ state, timeout: timeoutMs });
}
