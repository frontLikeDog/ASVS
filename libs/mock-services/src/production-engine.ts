import type {
  ProductionLog,
  ProductionRun,
  ProductionStep,
  RunScenario,
  VideoProject,
} from '@asvs/domain';
import {
  SCENARIO_DESCRIPTIONS,
  createProductionSteps,
  productionRunSchema,
  totalDuration,
} from '@asvs/domain';
import { newId, nowIso } from './id';

const SCENARIO_LABEL: Record<RunScenario, string> = {
  happy_path: '标准成功',
  capture_retry: '录屏失败后重试',
  approval_gate: '等待人工审批',
};

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function log(
  run: ProductionRun,
  level: ProductionLog['level'],
  text: string,
  stepId?: string,
): void {
  run.logs.push({
    id: newId('log'),
    atMs: Math.round(run.elapsedMs),
    level,
    text,
    stepId,
  });
}

function successText(step: ProductionStep, run: ProductionRun): string {
  switch (step.key) {
    case 'knowledge':
      return `产品知识已对齐 · ${run.input.sceneCount} 个镜头 / ${run.input.durationSec}s`;
    case 'claims':
      return `功能声明检查完成 · ${run.input.claimCount} 条声明已建立追溯`;
    case 'script':
      return '解说脚本已生成 · 旁白与字幕写入工程';
    case 'storyboard':
      return `分镜节奏规划完成 · ${run.input.sceneCount} 个镜头`;
    case 'capture':
      return '模拟录屏完成 · 界面断言通过，素材已标记为演示';
    case 'voice':
      return '配音轨道已生成 · 字幕时间轴对齐（模拟）';
    case 'compose':
      return '画面、字幕与品牌动效合成完成';
    case 'qa':
      return '质量检查通过 · 可以进入人工审核';
    default:
      return `${step.name}完成`;
  }
}

function finishRun(run: ProductionRun): void {
  run.status = 'succeeded';
  run.finishedAt = nowIso();
  log(run, 'success', '模拟生产完成 · 视频工程已准备好进入审核');
}

function failCapture(run: ProductionRun, step: ProductionStep): void {
  step.progress = 60;
  step.status = 'failed';
  step.finishedAtMs = Math.round(run.elapsedMs);
  step.error = '演示环境响应超时';
  run.status = 'failed';
  run.failure = {
    stepId: step.id,
    message: '录制在“打开 Atlas 看板”步骤超时：staging 页面 15 秒未响应。',
    hint: '检查演示环境是否可访问，或重置 fixture 后重试该步骤。',
  };
  log(run, 'error', '录制失败：staging 页面 15 秒未响应。运行已停止，可重试此步骤。', step.id);
}

export function createProductionRun(input: {
  video: VideoProject;
  scenario: RunScenario;
}): ProductionRun {
  const { video, scenario } = input;
  const run: ProductionRun = {
    id: newId('run'),
    projectId: video.projectId,
    videoId: video.id,
    scenario,
    status: 'running',
    steps: createProductionSteps(),
    logs: [],
    elapsedMs: 0,
    startedAt: nowIso(),
    speed: 1,
    input: {
      sceneCount: video.scenes.length,
      durationSec: totalDuration(video.scenes),
      aspect: video.brief.aspect,
      claimCount: new Set(video.scenes.flatMap((scene) => scene.claimIds)).size,
    },
    demo: true,
  };
  log(
    run,
    'info',
    `模拟生产已启动 · 场景：${SCENARIO_LABEL[scenario]}。${SCENARIO_DESCRIPTIONS[scenario]}`,
  );
  return productionRunSchema.parse(run);
}

/**
 * Advances a run by simulated wall time. Pure and deterministic: only elapsed
 * time, scenario and step state affect the outcome.
 */
export function tickProductionRun(run: ProductionRun, deltaMs: number): ProductionRun {
  if (run.status !== 'running' || deltaMs <= 0) return run;
  const next = clone(run);
  let remaining = Math.min(deltaMs, 2000) * next.speed;
  let guard = 0;

  while (remaining > 0.001 && next.status === 'running' && guard < 80) {
    guard += 1;
    let step = next.steps.find((item) => item.status === 'running');

    if (!step) {
      const pending = next.steps.find((item) => item.status === 'pending');
      if (!pending) {
        finishRun(next);
        break;
      }

      if (next.scenario === 'approval_gate' && pending.key === 'capture' && next.approval?.status !== 'approved') {
        next.status = 'awaiting_approval';
        pending.status = 'awaiting_approval';
        next.approval = {
          stepId: pending.id,
          status: 'pending',
          requestedAtMs: Math.round(next.elapsedMs),
        };
        log(next, 'warn', '已到达 Gate 2 · 录屏开始前等待人工批准。', pending.id);
        break;
      }

      pending.status = 'running';
      pending.progress = 0;
      pending.startedAtMs = Math.round(next.elapsedMs);
      pending.attempt += 1;
      step = pending;
      log(next, 'info', `开始：${pending.name}`, pending.id);
    }

    if (
      next.scenario === 'capture_retry' &&
      step.key === 'capture' &&
      step.attempt === 1 &&
      step.progress < 60
    ) {
      const timeToFailure = ((60 - step.progress) / 100) * step.durationMs;
      if (remaining >= timeToFailure) {
        next.elapsedMs = Math.round((next.elapsedMs + timeToFailure) * 10) / 10;
        remaining -= timeToFailure;
        failCapture(next, step);
        break;
      }
    }

    const remainingStepMs = step.durationMs * (1 - step.progress / 100);
    const consume = Math.max(0, Math.min(remaining, remainingStepMs));
    next.elapsedMs = Math.round((next.elapsedMs + consume) * 10) / 10;
    remaining -= consume;

    if (step.durationMs > 0) {
      step.progress = Math.min(100, Math.round((step.progress + (consume / step.durationMs) * 100) * 10) / 10);
    } else {
      step.progress = 100;
    }

    if (step.progress >= 99.9) {
      step.progress = 100;
      step.status = 'succeeded';
      step.finishedAtMs = Math.round(next.elapsedMs);
      log(next, 'success', successText(step, next), step.id);
    }
  }

  if (next.status === 'running' && next.steps.every((step) => step.status === 'succeeded')) {
    finishRun(next);
  }

  return next;
}

export function pauseProductionRun(run: ProductionRun): ProductionRun {
  if (run.status !== 'running') return run;
  const next = clone(run);
  next.status = 'paused';
  log(next, 'warn', '运行已暂停。模拟运行只在生产监控页打开时计时。');
  return next;
}

export function resumeProductionRun(run: ProductionRun): ProductionRun {
  if (run.status !== 'paused') return run;
  const next = clone(run);
  next.status = 'running';
  log(next, 'info', '运行已继续。');
  return next;
}

export function cancelProductionRun(run: ProductionRun): ProductionRun {
  if (['succeeded', 'cancelled', 'failed'].includes(run.status)) return run;
  const next = clone(run);
  next.steps = next.steps.map((step) =>
    ['running', 'pending', 'awaiting_approval'].includes(step.status)
      ? { ...step, status: 'skipped' as const }
      : step,
  );
  next.status = 'cancelled';
  next.failure = undefined;
  next.finishedAt = nowIso();
  log(next, 'warn', '运行已取消 · 后续步骤不会执行。');
  return next;
}

export function retryProductionRun(run: ProductionRun): ProductionRun {
  if (run.status !== 'failed') return run;
  const next = clone(run);
  const failed = next.steps.find((step) => step.status === 'failed');
  if (!failed) return run;
  failed.status = 'pending';
  failed.progress = 0;
  failed.error = undefined;
  failed.startedAtMs = undefined;
  failed.finishedAtMs = undefined;
  next.status = 'running';
  next.failure = undefined;
  next.finishedAt = undefined;
  log(next, 'info', `重试步骤：${failed.name}（下一次尝试将计为第 ${failed.attempt + 1} 次）`, failed.id);
  return next;
}

export function approveProductionRun(run: ProductionRun): ProductionRun {
  if (run.status !== 'awaiting_approval' || !run.approval) return run;
  const next = clone(run);
  const approval = next.approval!;
  approval.status = 'approved';
  approval.approvedAtMs = Math.round(next.elapsedMs);
  const step = next.steps.find((item) => item.id === approval.stepId);
  if (step) {
    step.status = 'pending';
    step.progress = 0;
    step.startedAtMs = undefined;
    step.error = undefined;
  }
  next.status = 'running';
  log(next, 'success', '人工审批已记录 · 继续执行录制步骤。', approval.stepId);
  return next;
}

export function setProductionSpeed(run: ProductionRun, speed: number): ProductionRun {
  if (run.status !== 'running' && run.status !== 'paused') return run;
  const next = clone(run);
  next.speed = Math.min(4, Math.max(0.5, speed));
  return next;
}

export function currentProductionStep(run: ProductionRun): ProductionStep | undefined {
  return (
    run.steps.find((step) => step.status === 'running') ??
    run.steps.find((step) => step.status === 'awaiting_approval') ??
    run.steps.find((step) => step.status === 'failed') ??
    run.steps.find((step) => step.status === 'pending')
  );
}

export function productionProgress(run: ProductionRun): number {
  if (run.status === 'succeeded') return 100;
  if (run.steps.length === 0) return 0;
  return Math.round(
    (run.steps.reduce((sum, step) => sum + (step.status === 'succeeded' ? 100 : step.progress), 0) /
      run.steps.length) *
      10,
  ) / 10;
}
