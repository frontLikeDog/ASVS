import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { DemoPlanError, demoPlanDigest, loadApprovedDemoPlan, parseDemoPlanFile } from './plan';
import { defaultPlan, workerRoot } from './paths';

const tourPlan = path.join(workerRoot, 'plans', 'web-studio-tour.yaml');
const blockedPlan = path.join(workerRoot, 'plans', 'blocked-origin.yaml');

describe('DemoPlan approval', () => {
  it('真实计划已批准，摘要匹配', () => {
    const parsed = loadApprovedDemoPlan(tourPlan);
    expect(parsed.plan.id).toBe('plan_web_studio_tour');
    expect(parsed.plan.steps.length).toBeGreaterThan(10);
    expect(parsed.plan.approval.approvedPlanDigest).toBe(parsed.digest);
    expect(parsed.digest).toMatch(/^[a-f0-9]{64}$/);
  });

  it('blocked-origin 探针也是已批准计划', () => {
    const parsed = loadApprovedDemoPlan(blockedPlan);
    expect(parsed.plan.steps[0]?.action).toBe('navigate');
    expect(parsed.plan.steps[0]?.target).toContain('example.invalid');
  });

  it('修改任意步骤会改变摘要，并让旧审批失效', () => {
    const original = parseDemoPlanFile(tourPlan);
    const changed = structuredClone(original.plan);
    changed.steps[1]!.dwellMs = 999;
    expect(demoPlanDigest(changed)).not.toBe(original.digest);

    const dir = mkdtempSync(path.join(tmpdir(), 'asvs-plan-'));
    const file = path.join(dir, 'changed.yaml');
    const text = readFileSync(tourPlan, 'utf8').replace(
      'dwellMs: 1800',
      'dwellMs: 1',
    );
    writeFileSync(file, text, 'utf8');
    expect(() => loadApprovedDemoPlan(file)).toThrow(DemoPlanError);
    expect(() => loadApprovedDemoPlan(file)).toThrow(/审批摘要不匹配/);
  });

  it('默认计划路径指向 web-studio-tour', () => {
    expect(defaultPlan).toBe(tourPlan);
  });
});
