/**
 * Assertion-first success rule (S2-4).
 *
 * A run passes only when:
 *  - at least one UI assertion was recorded (a plan with zero assertions is
 *    never "successful", even if every step ran without throwing);
 *  - every assertion passed;
 *  - no step failed.
 *
 * Script exit code 0 is not part of the rule.
 */
export interface OutcomeStep {
  status: 'passed' | 'failed' | 'skipped';
  assertion?: { passed: boolean };
}

export interface AssertionCounts {
  total: number;
  passed: number;
  failed: number;
}

export function summarizeAssertions(steps: readonly OutcomeStep[]): AssertionCounts {
  let total = 0;
  let passed = 0;
  for (const step of steps) {
    if (!step.assertion) continue;
    total += 1;
    if (step.assertion.passed) passed += 1;
  }
  return { total, passed, failed: total - passed };
}

export function capturePassed(steps: readonly OutcomeStep[]): boolean {
  const assertions = summarizeAssertions(steps);
  return (
    assertions.total > 0 &&
    assertions.failed === 0 &&
    steps.every((step) => step.status === 'passed')
  );
}
