import { describe, expect, it } from 'vitest';
import {
  ALLOWED_JOB_TRANSITIONS,
  ALLOWED_RUN_TRANSITIONS,
  ORCHESTRATION_STEPS,
  OrchestrationTransitionError,
  assertJobTransition,
  assertRunTransition,
  buildInitialRunSteps,
  canTransitionJob,
  canTransitionRun,
  evaluateClaimGate,
  isActiveRunStatus,
  isSafeRelativePath,
  isTerminalRunStatus,
  parseWorkerEventLine,
  encodeWorkerEvent,
  renderJobDigest,
  runProgressPercent,
  sha256Hex,
  stableJson,
  workerEventSchema,
} from './orchestration';
import type { Claim } from './schemas';

function claim(partial: Partial<Claim>): Claim {
  return {
    id: 'claim_x',
    projectId: 'proj_x',
    featureId: 'feat_x',
    statement: '示例声明',
    audience: '团队',
    status: 'verified',
    evidenceIds: [],
    demo: false,
    ...partial,
  };
}

describe('编排状态机 · Run', () => {
  it('覆盖 11 个固定步骤且顺序固定（5D 在 capture 后与 render 后各插入一个 QA 步骤）', () => {
    expect(ORCHESTRATION_STEPS.map((step) => step.stepKey)).toEqual([
      'freeze_input',
      'verify_claims',
      'plan_demo',
      'capture_demo',
      'qa_capture',
      'prepare_media',
      'synthesize_voice',
      'generate_subtitles',
      'render_video',
      'qa_final',
      'register_artifacts',
    ]);
    expect(buildInitialRunSteps()).toHaveLength(11);
    expect(buildInitialRunSteps().every((step) => step.status === 'pending')).toBe(true);
  });

  it('capture 步骤使用独立的 capture 执行器，plan/QA 步骤在进程内执行', () => {
    const byKey = new Map(ORCHESTRATION_STEPS.map((step) => [step.stepKey, step]));
    expect(byKey.get('plan_demo')?.executor).toBe('inline');
    expect(byKey.get('capture_demo')?.executor).toBe('capture');
    expect(byKey.get('qa_capture')?.executor).toBe('inline');
    expect(byKey.get('qa_final')?.executor).toBe('inline');
    expect(byKey.get('render_video')?.executor).toBe('worker');
    // Capture QA sits between the clip and the media prep that resolves it;
    // final QA sits between the render and the artifact registration it gates.
    const keys = ORCHESTRATION_STEPS.map((step) => step.stepKey);
    expect(keys.indexOf('qa_capture')).toBe(keys.indexOf('capture_demo') + 1);
    expect(keys.indexOf('qa_capture')).toBe(keys.indexOf('prepare_media') - 1);
    expect(keys.indexOf('qa_final')).toBe(keys.indexOf('render_video') + 1);
    expect(keys.indexOf('qa_final')).toBe(keys.indexOf('register_artifacts') - 1);
  });

  it('合法迁移通过，非法迁移抛错', () => {
    expect(canTransitionRun('queued', 'running')).toBe(true);
    expect(canTransitionRun('running', 'succeeded')).toBe(true);
    expect(canTransitionRun('running', 'cancelled')).toBe(true);
    expect(canTransitionRun('failed', 'queued')).toBe(true);

    expect(canTransitionRun('succeeded', 'running')).toBe(false);
    expect(canTransitionRun('cancelled', 'queued')).toBe(false);
    expect(canTransitionRun('queued', 'succeeded')).toBe(false);

    expect(() => assertRunTransition('succeeded', 'failed')).toThrow(OrchestrationTransitionError);
    expect(() => assertRunTransition('running', 'queued')).toThrow(/非法/);
  });

  it('终态与活动态判定', () => {
    expect(isTerminalRunStatus('succeeded')).toBe(true);
    expect(isTerminalRunStatus('failed')).toBe(true);
    expect(isTerminalRunStatus('cancelled')).toBe(true);
    expect(isTerminalRunStatus('running')).toBe(false);
    expect(isActiveRunStatus('queued')).toBe(true);
    expect(isActiveRunStatus('awaiting_approval')).toBe(true);
    expect(isActiveRunStatus('failed')).toBe(false);
  });

  it('每个状态都有显式迁移表（新增状态必须显式声明）', () => {
    expect(Object.keys(ALLOWED_RUN_TRANSITIONS).sort()).toEqual(
      ['awaiting_approval', 'cancelled', 'failed', 'queued', 'running', 'succeeded'].sort(),
    );
    expect(Object.keys(ALLOWED_JOB_TRANSITIONS).sort()).toEqual(
      ['cancelled', 'failed', 'leased', 'queued', 'retryable', 'running', 'succeeded'].sort(),
    );
  });
});

describe('编排状态机 · Job', () => {
  it('lease / retry / crash 路径合法', () => {
    expect(canTransitionJob('queued', 'leased')).toBe(true);
    expect(canTransitionJob('leased', 'running')).toBe(true);
    expect(canTransitionJob('running', 'retryable')).toBe(true);
    expect(canTransitionJob('retryable', 'queued')).toBe(true);
    expect(canTransitionJob('running', 'succeeded')).toBe(true);
    expect(canTransitionJob('succeeded', 'retryable')).toBe(false);
    expect(() => assertJobTransition('cancelled', 'leased')).toThrow(OrchestrationTransitionError);
  });
});

describe('进度计算', () => {
  it('成功完成返回 100，未完成按完成步骤比例（skipped 也计入）', () => {
    const steps = buildInitialRunSteps();
    steps[0]!.status = 'succeeded';
    steps[1]!.status = 'succeeded';
    // 2 of 11 steps → 18%.
    expect(runProgressPercent({ status: 'running', steps })).toBe(18);
    steps[2]!.status = 'skipped';
    steps[3]!.status = 'skipped';
    // Skipped steps are complete by definition: 4 of 11 → 36%.
    expect(runProgressPercent({ status: 'running', steps })).toBe(36);
    expect(runProgressPercent({ status: 'succeeded', steps })).toBe(100);
    expect(runProgressPercent({ status: 'failed', steps })).toBe(36);
  });
});

describe('Claim 门禁', () => {
  it('blocked_* 阻断，needs_qualification 只警告', () => {
    const result = evaluateClaimGate([
      claim({ id: 'c1', status: 'verified' }),
      claim({ id: 'c2', status: 'stale' }),
      claim({ id: 'c3', status: 'supported' }),
      claim({ id: 'c4', status: 'proposed' }),
    ]);
    expect(result.blocked.map((item) => item.claimId).sort()).toEqual(['c2', 'c4']);
    expect(result.blocked.find((item) => item.claimId === 'c2')?.eligibility).toBe('blocked_stale');
    expect(result.blocked.find((item) => item.claimId === 'c4')?.eligibility).toBe(
      'blocked_unverified',
    );
    expect(result.warnings.map((item) => item.claimId)).toEqual(['c3']);
  });

  it('显式 eligibility 优先于 status 推断', () => {
    const result = evaluateClaimGate([
      claim({ id: 'c5', status: 'verified', eligibility: 'blocked_rejected' }),
    ]);
    expect(result.blocked[0]?.eligibility).toBe('blocked_rejected');
  });

  it('所有引用声明可发布时不产生阻断', () => {
    const result = evaluateClaimGate([
      claim({ id: 'c6', status: 'verified', eligibility: 'publishable' }),
    ]);
    expect(result.blocked).toHaveLength(0);
    expect(result.warnings).toHaveLength(0);
  });
});

describe('安全路径', () => {
  it('拒绝路径穿越与绝对路径', () => {
    expect(isSafeRelativePath('runs/run_1/output.mp4')).toBe(true);
    expect(isSafeRelativePath('runs\\run_1\\output.mp4')).toBe(true);
    expect(isSafeRelativePath('../etc/passwd')).toBe(false);
    expect(isSafeRelativePath('runs/../../etc')).toBe(false);
    expect(isSafeRelativePath('/etc/passwd')).toBe(false);
    expect(isSafeRelativePath('C:\\Windows\\system32')).toBe(false);
    expect(isSafeRelativePath('')).toBe(false);
    expect(isSafeRelativePath('./a')).toBe(false);
  });
});

describe('Worker 事件协议', () => {
  it('只解析 ASVS_EVENT 前缀的行', () => {
    const event = { type: 'progress' as const, phase: 'render', percent: 42 };
    const line = encodeWorkerEvent(event);
    expect(parseWorkerEventLine(line)).toMatchObject(event);
    expect(parseWorkerEventLine('Webpack compiled successfully')).toBeNull();
    expect(parseWorkerEventLine('ASVS_EVENT {not json')).toBeNull();
    expect(parseWorkerEventLine('ASVS_EVENT {"type":"unknown"}')).toBeNull();
  });

  it('schema 拒绝非法进度值', () => {
    expect(workerEventSchema.safeParse({ type: 'progress', phase: 'x', percent: 101 }).success).toBe(
      false,
    );
    expect(workerEventSchema.safeParse({ type: 'heartbeat', pid: 1, at: 'now' }).success).toBe(true);
    expect(workerEventSchema.safeParse({ type: 'completed' }).success).toBe(false);
  });
});

describe('摘要工具', () => {
  it('stableJson 与键顺序无关', () => {
    expect(stableJson({ b: 1, a: 2 })).toBe(stableJson({ a: 2, b: 1 }));
    expect(stableJson({ a: undefined, b: 1 })).toBe('{"b":1}');
  });

  it('renderJobDigest 稳定且能区分输入', async () => {
    const base = { jobId: 'job_1', artifactId: 'art_1', renderInput: { a: 1 }, media: [] };
    const first = await renderJobDigest(base);
    const second = await renderJobDigest({ ...base, renderInput: { a: 1, b: 2 } });
    expect(first).toMatch(/^[a-f0-9]{64}$/);
    expect(first).not.toBe(second);
    expect(await sha256Hex('abc')).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    );
  });
});
