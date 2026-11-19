import { describe, expect, it } from 'vitest';
import type { ProductionRun, Scene, VideoProject } from '@asvs/domain';
import {
  approveProductionRun,
  cancelProductionRun,
  createProductionRun,
  pauseProductionRun,
  productionProgress,
  resumeProductionRun,
  retryProductionRun,
  setProductionSpeed,
  tickProductionRun,
} from './production-engine';

function scene(id: string, order: number, durationSec: number): Scene {
  return {
    id,
    order,
    title: `镜头 ${order + 1}`,
    intent: '演示',
    narration: '旁白',
    caption: '字幕',
    durationSec,
    visualType: 'motion',
    templateId: 'tpl_grid',
    claimIds: [],
    status: 'draft',
    look: 'clean',
    brightness: 1,
    vignette: false,
  };
}

function makeVideo(): VideoProject {
  return {
    id: 'vid_run',
    projectId: 'proj_run',
    title: '生产测试视频',
    mode: 'release_video',
    stage: 'storyboard_ready',
    brief: {
      objective: '测试',
      audience: '测试团队',
      featureIds: ['feat_a'],
      durationSec: 16,
      aspect: '16:9',
      language: 'zh-CN',
      tone: 'confident',
      style: 'editorial',
      templateId: 'tpl_signal',
      useRealCapture: false,
      useGeneratedVisuals: false,
      cta: '开始',
      bannedPhrases: [],
    },
    scenes: [scene('a', 0, 8), scene('b', 1, 8)],
    directorMessages: [],
    scriptVersion: 1,
    createdAt: '2026-11-01T00:00:00.000Z',
    updatedAt: '2026-11-01T00:00:00.000Z',
    demo: true,
  };
}

function advanceUntil(
  run: ProductionRun,
  predicate: (current: ProductionRun) => boolean,
  maxTicks = 400,
): ProductionRun {
  let current = run;
  for (let index = 0; index < maxTicks; index += 1) {
    if (predicate(current)) return current;
    const next = tickProductionRun(current, 500);
    if (next === current) return next;
    current = next;
  }
  return current;
}

describe('createProductionRun', () => {
  it('生成 8 个确定性步骤并记录输入快照', () => {
    const run = createProductionRun({ video: makeVideo(), scenario: 'happy_path' });

    expect(run.status).toBe('running');
    expect(run.steps).toHaveLength(8);
    expect(run.steps.every((step) => step.status === 'pending')).toBe(true);
    expect(run.input).toEqual({
      sceneCount: 2,
      durationSec: 16,
      aspect: '16:9',
      claimCount: 0,
    });
    expect(run.logs[0]?.text).toContain('标准成功');
    expect(run.demo).toBe(true);
  });
});

describe('happy_path', () => {
  it('按依赖顺序完成全部步骤并结束为 succeeded', () => {
    const run = createProductionRun({ video: makeVideo(), scenario: 'happy_path' });
    const done = advanceUntil(run, (current) => current.status === 'succeeded');

    expect(done.status).toBe('succeeded');
    expect(done.steps.every((step) => step.status === 'succeeded')).toBe(true);
    expect(done.steps.map((step) => step.key)).toEqual([
      'knowledge',
      'claims',
      'script',
      'storyboard',
      'capture',
      'voice',
      'compose',
      'qa',
    ]);
    expect(done.finishedAt).toBeTruthy();
    expect(done.logs.some((entry) => entry.text.includes('模拟生产完成'))).toBe(true);
    expect(productionProgress(done)).toBe(100);
    // 模拟时间接近全部步骤总时长（29800ms；500ms 步进会带来几十毫秒误差）
    expect(done.elapsedMs).toBeGreaterThan(29000);
    expect(done.elapsedMs).toBeLessThan(32000);
  });
});

describe('approval_gate', () => {
  it('在录制步骤前暂停，批准后继续到完成', () => {
    const run = createProductionRun({ video: makeVideo(), scenario: 'approval_gate' });
    const gated = advanceUntil(run, (current) => current.status === 'awaiting_approval');

    expect(gated.status).toBe('awaiting_approval');
    expect(gated.approval?.status).toBe('pending');
    expect(gated.steps.find((step) => step.key === 'capture')?.status).toBe('awaiting_approval');
    expect(gated.steps.find((step) => step.key === 'compose')?.status).toBe('pending');

    const approved = approveProductionRun(gated);
    expect(approved.status).toBe('running');
    expect(approved.approval?.status).toBe('approved');

    const finished = advanceUntil(approved, (current) => current.status === 'succeeded');
    expect(finished.status).toBe('succeeded');
    expect(finished.steps.find((step) => step.key === 'capture')?.attempt).toBe(1);
  });

  it('未到 Gate 时批准无效', () => {
    const run = createProductionRun({ video: makeVideo(), scenario: 'happy_path' });
    expect(approveProductionRun(run)).toBe(run);
  });
});

describe('capture_retry', () => {
  it('录制第一步固定失败，重试后成功', () => {
    const run = createProductionRun({ video: makeVideo(), scenario: 'capture_retry' });
    const failed = advanceUntil(run, (current) => current.status === 'failed');

    expect(failed.status).toBe('failed');
    expect(failed.failure?.stepId).toBe('step_capture');
    expect(failed.failure?.message).toContain('staging');
    expect(failed.steps.find((step) => step.key === 'capture')).toMatchObject({
      status: 'failed',
      progress: 60,
      attempt: 1,
      error: '演示环境响应超时',
    });
    expect(failed.steps.find((step) => step.key === 'voice')?.status).toBe('pending');

    const retried = retryProductionRun(failed);
    expect(retried.status).toBe('running');
    expect(retried.failure).toBeUndefined();
    expect(retried.steps.find((step) => step.key === 'capture')?.status).toBe('pending');

    const finished = advanceUntil(retried, (current) => current.status === 'succeeded');
    expect(finished.status).toBe('succeeded');
    expect(finished.steps.find((step) => step.key === 'capture')).toMatchObject({
      status: 'succeeded',
      attempt: 2,
    });
    expect(finished.elapsedMs).toBeGreaterThan(failed.elapsedMs);
  });

  it('只有 failed 状态可以重试', () => {
    const run = createProductionRun({ video: makeVideo(), scenario: 'happy_path' });
    expect(retryProductionRun(run)).toBe(run);
  });
});

describe('pause / resume / cancel / speed', () => {
  it('暂停后 tick 不推进，继续后恢复', () => {
    const run = tickProductionRun(
      createProductionRun({ video: makeVideo(), scenario: 'happy_path' }),
      1500,
    );
    const paused = pauseProductionRun(run);
    expect(paused.status).toBe('paused');
    expect(tickProductionRun(paused, 1000)).toBe(paused);

    const resumed = resumeProductionRun(paused);
    const next = tickProductionRun(resumed, 500);
    expect(next.status).toBe('running');
    expect(next.elapsedMs).toBeGreaterThan(run.elapsedMs);
  });

  it('取消会把未完成步骤标记为 skipped 并停止计时', () => {
    const run = tickProductionRun(
      createProductionRun({ video: makeVideo(), scenario: 'happy_path' }),
      5000,
    );
    const cancelled = cancelProductionRun(run);

    expect(cancelled.status).toBe('cancelled');
    expect(cancelled.finishedAt).toBeTruthy();
    expect(
      cancelled.steps
        .filter((step) => ['running', 'pending', 'awaiting_approval'].includes(step.status)),
    ).toHaveLength(0);
    expect(cancelled.steps.some((step) => step.status === 'skipped')).toBe(true);
    expect(tickProductionRun(cancelled, 1000)).toBe(cancelled);
  });

  it('速度被限制在 0.5x - 4x', () => {
    const run = createProductionRun({ video: makeVideo(), scenario: 'happy_path' });
    expect(setProductionSpeed(run, 9).speed).toBe(4);
    expect(setProductionSpeed(run, 0.1).speed).toBe(0.5);
    expect(setProductionSpeed(run, 2).speed).toBe(2);
  });
});
