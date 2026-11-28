// @vitest-environment node
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  buildDemoPlanDraft,
  canonicalDemoPlanJson,
  computeDemoPlanDigest,
  demoPlanV1Schema,
  stableStringify,
  withDemoPlanApproval,
  type DemoPlanV1,
  type Feature,
  type Claim,
  type VideoProject,
} from '@asvs/domain';
import { classifyFailure, parseArgs, workerPlanDigest } from './capture-job';

const ISO = '2026-11-28T10:00:00.000Z';

function plan(): DemoPlanV1 {
  const feature: Feature = {
    id: 'feat_collab',
    projectId: 'proj_x',
    name: '实时协作看板',
    summary: '多人同时编辑',
    category: '协作',
    status: 'verified',
    confidence: 90,
    userConfirmed: true,
    sourceRefs: [],
    claimIds: ['claim_collab'],
    prIds: [],
    demoRoute: '/demo/boards/atlas',
    updatedAt: ISO,
    tags: [],
    demo: true,
  };
  const claim: Claim = {
    id: 'claim_collab',
    projectId: 'proj_x',
    featureId: 'feat_collab',
    statement: '团队可以同时编辑同一个看板。',
    audience: '团队',
    status: 'verified',
    eligibility: 'publishable',
    evidenceIds: [],
    demo: true,
  };
  const video = {
    id: 'vid_x',
    projectId: 'proj_x',
    title: '演示',
    mode: 'release_video',
    stage: 'review',
    fps: 30,
    brief: {
      objective: 'o',
      audience: 'a',
      featureIds: ['feat_collab'],
      durationSec: 30,
      aspect: '16:9',
      language: 'zh-CN',
      tone: 'confident',
      style: 'editorial',
      templateId: 'tpl_signal',
      useRealCapture: true,
      useGeneratedVisuals: false,
      cta: '',
      bannedPhrases: [],
    },
    scenes: [],
    directorMessages: [],
    scriptVersion: 1,
    createdAt: ISO,
    updatedAt: ISO,
    demo: true,
  } as unknown as VideoProject;
  const draft = buildDemoPlanDraft({
    workspaceId: 'ws_x',
    video,
    features: [{ feature, claims: [claim], sceneIds: [] }],
    routes: [{ featureId: 'feat_collab', route: '/demo/boards/atlas' }],
    template: 'web_studio_knowledge_claim',
    baseUrl: 'http://localhost:4200',
    allowedOrigins: ['http://localhost:4200'],
  });
  if (!draft.ok) throw new Error(draft.message);
  return withDemoPlanApproval(draft.draft, {
    approvalId: 'appr_x',
    approvedPlanDigest: '0'.repeat(64),
  });
}

describe('capture-job · 计划摘要复检（第三层防篡改）', () => {
  it('worker 的摘要算法与领域层逐字节一致', async () => {
    const sample = plan();
    const workerDigest = workerPlanDigest(sample);
    expect(workerDigest).toBe(await computeDemoPlanDigest(sample));
    // And both equal a raw node:crypto hash of the canonical JSON.
    const raw = createHash('sha256').update(canonicalDemoPlanJson(sample), 'utf8').digest('hex');
    expect(workerDigest).toBe(raw);
    // stableStringify and stableJson are the same function under two names.
    const { approval: _approval, ...rest } = sample;
    void _approval;
    expect(stableStringify(rest)).toBe(canonicalDemoPlanJson(sample));
  });

  it('任何字段被改动都会改变摘要（包括新增字段）', async () => {
    const sample = plan();
    const base = workerPlanDigest(sample);
    expect(workerPlanDigest({ ...sample, baseUrl: 'http://localhost:4300' })).not.toBe(base);
    expect(
      workerPlanDigest({ ...sample, allowedOrigins: ['http://localhost:4200', 'http://evil.test'] }),
    ).not.toBe(base);
    const tamperedStep = {
      ...sample,
      steps: [{ ...sample.steps[0]!, target: 'text=被替换的页面' }, ...sample.steps.slice(1)],
    };
    expect(workerPlanDigest(tamperedStep)).not.toBe(base);
    // Only the approval block itself is excluded from the digest.
    expect(
      workerPlanDigest({ ...sample, approval: { ...sample.approval, approvalId: 'appr_other' } }),
    ).toBe(base);
  });

  it('approvedPlanDigest 写回真实值后通过 demoPlanV1Schema', async () => {
    const sample = plan();
    const digest = workerPlanDigest(sample);
    const approved = demoPlanV1Schema.parse({
      ...sample,
      approval: { ...sample.approval, approvedPlanDigest: digest },
    });
    expect(approved.approval.approvedPlanDigest).toBe(digest);
    expect(workerPlanDigest(approved)).toBe(digest);
  });
});

describe('capture-job · 参数与失败分类', () => {
  it('缺少必填参数时拒绝启动', () => {
    expect(() => parseArgs(['--input', 'a.json'])).toThrow(/--out/);
    expect(() =>
      parseArgs(['--input', 'a.json', '--out', 'out', '--checkpoint', 'c.json']),
    ).toThrow(/storage-ref-base/);
    const parsed = parseArgs([
      '--input',
      'a.json',
      '--out',
      'out',
      '--checkpoint',
      'c.json',
      '--storage-ref-base',
      '.',
      '--serve=dev',
    ]);
    expect(parsed.serve).toBe(true);
    expect(parsed.serveMode).toBe('dev');
  });

  it('错误信息映射到固定的失败码', () => {
    expect(classifyFailure({ error: '请求被 allowlist 阻断' })).toBe('capture_origin_blocked');
    expect(classifyFailure({ error: '目标环境未启动：http://localhost:4200' })).toBe(
      'capture_target_unreachable',
    );
    expect(classifyFailure({ error: 'Timeout 30000ms exceeded' })).toBe('capture_timeout');
    expect(classifyFailure({ error: '断言失败 [visible]', failedStepId: 's1' })).toBe(
      'capture_assertion_failed',
    );
    // A failed step wins over a timeout-shaped message: "超时仍不可见" is an
    // assertion rejection, and reporting it as `capture_timeout` would hide
    // which landmark refused the page.
    expect(
      classifyFailure({
        error: '断言失败 [visible] text=不存在：超时仍不可见（4000ms）',
        failedStepId: 'impossible-assertion',
      }),
    ).toBe('capture_assertion_failed');
    expect(classifyFailure({ error: '片段 SHA256 与回执不一致' })).toBe('capture_artifact_mismatch');
    expect(classifyFailure({ error: '未知异常' })).toBe('capture_worker_crashed');
  });
});
