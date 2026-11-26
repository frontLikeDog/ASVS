import { describe, expect, it } from 'vitest';
import { capturePassed, summarizeAssertions, type OutcomeStep } from './outcome';

function passedAssertion(): OutcomeStep {
  return { status: 'passed', assertion: { passed: true } };
}

describe('断言优先的成功判定', () => {
  it('脚本正常结束但没有任何断言 → 失败', () => {
    const steps: OutcomeStep[] = [
      { status: 'passed' },
      { status: 'passed' },
    ];
    expect(summarizeAssertions(steps)).toEqual({ total: 0, passed: 0, failed: 0 });
    expect(capturePassed(steps)).toBe(false);
  });

  it('断言全部通过且步骤无失败 → 成功', () => {
    expect(capturePassed([passedAssertion(), { status: 'passed' }])).toBe(true);
  });

  it('有一个断言失败 → 失败', () => {
    const steps: OutcomeStep[] = [
      passedAssertion(),
      { status: 'passed', assertion: { passed: false } },
    ];
    expect(summarizeAssertions(steps)).toEqual({ total: 2, passed: 1, failed: 1 });
    expect(capturePassed(steps)).toBe(false);
  });

  it('断言通过但有步骤失败 → 失败', () => {
    expect(capturePassed([passedAssertion(), { status: 'failed' }])).toBe(false);
  });
});
