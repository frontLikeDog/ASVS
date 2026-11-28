import { describe, expect, it } from 'vitest';
import type { OrchestrationJobV1, OrchestrationRunV1 } from '@asvs/domain';
import {
  DEFAULT_CAPTURE_OPTIONS,
  buildServerStepViews,
  checkpointLabel,
  isActiveServerRun,
} from './server-orchestration';

const ISO = '2026-11-28T10:00:00.000Z';

function run(overrides: Partial<OrchestrationRunV1> = {}): OrchestrationRunV1 {
  return {
    schemaVersion: '1',
    id: 'orchrun_0123456789abcdef01234567',
    workspaceId: 'ws_demo',
    projectId: 'proj_lumen',
    videoId: 'vid_lumen_release',
    idempotencyKey: 'idem-0001',
    status: 'queued',
    renderProfile: { width: 1920, height: 1080, codec: 'h264', crf: 18 },
    inputDigest: null,
    currentStepKey: null,
    steps: [],
    input: { sceneCount: 1, durationSec: 14, aspect: '16:9', claimCount: 0 },
    createdAt: ISO,
    updatedAt: ISO,
    ...overrides,
  };
}

describe('buildServerStepViews · 5D 十一步 DAG', () => {
  it('即使运行还没有步骤，也渲染完整十一步且顺序固定', () => {
    const views = buildServerStepViews(null);
    expect(views.map((view) => view.stepKey)).toEqual([
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
    expect(views.every((view) => view.status === 'pending')).toBe(true);
  });

  it('未启用录屏时 plan_demo / capture_demo / qa_capture 显示为 skipped，qa_final 仍待执行', () => {
    const views = buildServerStepViews(
      run({
        status: 'running',
        steps: [
          { stepKey: 'freeze_input', status: 'succeeded', attempt: 1, checkpointPhases: [] },
          { stepKey: 'verify_claims', status: 'succeeded', attempt: 1, checkpointPhases: [] },
          { stepKey: 'plan_demo', status: 'skipped', attempt: 0, checkpointPhases: [] },
          { stepKey: 'capture_demo', status: 'skipped', attempt: 0, checkpointPhases: [] },
          { stepKey: 'qa_capture', status: 'skipped', attempt: 0, checkpointPhases: [] },
          { stepKey: 'prepare_media', status: 'running', attempt: 1, checkpointPhases: [] },
        ],
      }),
    );
    const byKey = new Map(views.map((view) => [view.stepKey, view.status]));
    expect(byKey.get('plan_demo')).toBe('skipped');
    expect(byKey.get('capture_demo')).toBe('skipped');
    expect(byKey.get('qa_capture')).toBe('skipped');
    expect(byKey.get('prepare_media')).toBe('running');
    expect(byKey.get('render_video')).toBe('pending');
    expect(byKey.get('qa_final')).toBe('pending');
  });

  it('Gate 2 暂停时 capture_demo 显示 awaiting_approval，并带上审批产生的 checkpoint', () => {
    const views = buildServerStepViews(
      run({
        status: 'awaiting_approval',
        steps: [
          { stepKey: 'freeze_input', status: 'succeeded', attempt: 1, checkpointPhases: [] },
          { stepKey: 'verify_claims', status: 'succeeded', attempt: 1, checkpointPhases: [] },
          {
            stepKey: 'plan_demo',
            status: 'succeeded',
            attempt: 1,
            checkpointPhases: ['plan_ready'],
          },
          {
            stepKey: 'capture_demo',
            status: 'awaiting_approval',
            attempt: 0,
            checkpointPhases: [],
          },
        ],
      }),
    );
    const plan = views.find((view) => view.stepKey === 'plan_demo');
    const capture = views.find((view) => view.stepKey === 'capture_demo');
    expect(plan?.status).toBe('succeeded');
    expect(plan?.checkpointPhases).toEqual(['plan_ready']);
    expect(capture?.status).toBe('awaiting_approval');
  });

  it('作业的尝试次数在没有步骤状态时兜底展示', () => {
    const jobs: OrchestrationJobV1[] = [
      {
        schemaVersion: '1',
        jobId: 'orchjob_capture',
        runId: 'orchrun_0123456789abcdef01234567',
        workspaceId: 'ws_demo',
        stepKey: 'capture_demo',
        type: 'capture',
        status: 'running',
        idempotencyKey: 'capture-1',
        inputDigest: 'a'.repeat(64),
        attempt: 2,
        maxAttempts: 3,
        leaseOwner: null,
        leaseExpiresAt: null,
        heartbeatAt: null,
        workerPid: null,
        deadlineAt: null,
        lastCheckpointPhase: null,
        errorCode: null,
        errorMessage: null,
        createdAt: ISO,
        updatedAt: ISO,
      },
    ];
    const views = buildServerStepViews(run(), jobs);
    expect(views.find((view) => view.stepKey === 'capture_demo')?.attempt).toBe(2);
    expect(views.find((view) => view.stepKey === 'capture_demo')?.status).toBe('pending');
  });
});

describe('checkpointLabel · 5C/5D 新阶段', () => {
  it('已知阶段使用中文标签，未知阶段原样回显', () => {
    expect(checkpointLabel('plan_ready')).toBe('计划已生成');
    expect(checkpointLabel('plan_verified')).toBe('计划摘要已复检');
    expect(checkpointLabel('capture_started')).toBe('浏览器已启动');
    expect(checkpointLabel('capture_recorded')).toBe('录屏已录制');
    expect(checkpointLabel('clip_transcoded')).toBe('片段已转码');
    expect(checkpointLabel('qa_capture_checked')).toBe('录屏 QA 已复核');
    expect(checkpointLabel('qa_privacy_scanned')).toBe('隐私扫描完成');
    expect(checkpointLabel('qa_report_written')).toBe('QA 报告已落盘');
    expect(checkpointLabel('something_new')).toBe('something_new');
  });
});

describe('CaptureOptions 默认值 · 零回归', () => {
  it('默认关闭真实录屏，模板默认走 4D 知识与声明验证', () => {
    expect(DEFAULT_CAPTURE_OPTIONS).toEqual({
      enabled: false,
      template: 'web_studio_knowledge_claim',
      baseUrl: '',
      resetStrategy: 'fixture',
    });
  });
});

describe('isActiveServerRun', () => {
  it('awaiting_approval 视为活动运行（需要继续轮询而不是当作终态）', () => {
    expect(isActiveServerRun(run({ status: 'awaiting_approval' }))).toBe(true);
    expect(isActiveServerRun(run({ status: 'queued' }))).toBe(true);
    expect(isActiveServerRun(run({ status: 'succeeded' }))).toBe(false);
    expect(isActiveServerRun(run({ status: 'failed' }))).toBe(false);
    expect(isActiveServerRun(null)).toBe(false);
  });
});
