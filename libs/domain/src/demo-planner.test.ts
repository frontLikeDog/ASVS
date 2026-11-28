import { describe, expect, it } from 'vitest';
import {
  DEMO_PLAN_TEMPLATE_IDS,
  assessDemoPlanRisk,
  canonicalDemoPlanJson,
  captureJobInputV1Schema,
  computeDemoPlanDigest,
  demoPlanDraftV1Schema,
  demoPlanV1Schema,
  isRetryableCaptureCode,
  withDemoPlanApproval,
  type DemoPlanDraftV1,
} from './capture';
import {
  buildDemoPlanDraft,
  demoPlanIdFor,
  eligiblePlannerFeatures,
  type DemoPlannerInput,
} from './demo-planner';
import type { Claim, Feature, VideoProject } from './schemas';

const ISO = '2026-11-28T08:00:00.000Z';

function feature(partial: Partial<Feature> & { id: string }): Feature {
  return {
    projectId: 'proj_lumen',
    name: '实时协作看板',
    summary: '多人同时编辑同一块看板',
    category: '实时协作',
    status: 'verified',
    confidence: 90,
    userConfirmed: true,
    sourceRefs: [],
    claimIds: [],
    prIds: [],
    demoRoute: '/demo/boards/atlas',
    updatedAt: ISO,
    tags: [],
    demo: true,
    ...partial,
  };
}

function claim(partial: Partial<Claim> & { id: string; featureId: string }): Claim {
  return {
    projectId: 'proj_lumen',
    statement: '团队可以同时编辑同一个看板，并实时看到彼此的光标与改动。',
    audience: '产品团队',
    status: 'verified',
    eligibility: 'publishable',
    evidenceIds: [],
    demo: true,
    ...partial,
  };
}

function video(partial: Partial<VideoProject> = {}): VideoProject {
  return {
    id: 'vid_lumen_release',
    projectId: 'proj_lumen',
    title: 'Lumen 2.8 发布',
    mode: 'release_video',
    stage: 'review',
    fps: 30,
    brief: {
      objective: '发布 Lumen 2.8',
      audience: '产品团队',
      featureIds: ['feat_lumen_collab'],
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
    scenes: [
      {
        id: 'scene_demo',
        order: 1,
        revision: 1,
        title: '真实操作',
        intent: '展示真实操作',
        narration: '这是一次真实操作。',
        caption: '真实操作',
        durationSec: 12,
        visualType: 'real_demo',
        visual: { type: 'real_demo', assetId: 'asset_demo' },
        templateId: 'tpl_signal',
        claimIds: [],
        assetId: 'asset_demo',
        status: 'approved',
        look: 'clean',
        brightness: 1,
        vignette: false,
      },
    ],
    directorMessages: [],
    scriptVersion: 1,
    createdAt: ISO,
    updatedAt: ISO,
    demo: true,
    ...partial,
  };
}

function plannerInput(overrides: Partial<DemoPlannerInput> = {}): DemoPlannerInput {
  const collab = feature({ id: 'feat_lumen_collab', claimIds: ['claim_lumen_collab'], demoRoute: '/demo/boards/atlas' });
  const anomaly = feature({
    id: 'feat_lumen_anomaly',
    name: 'AI 异常检测',
    status: 'implemented',
    demoRoute: '/demo/insights/anomaly',
    claimIds: ['claim_lumen_anomaly'],
  });
  return {
    workspaceId: 'ws_lumen',
    video: video(),
    features: [
      {
        feature: collab,
        claims: [claim({ id: 'claim_lumen_collab', featureId: collab.id })],
        sceneIds: ['scene_demo'],
      },
      {
        feature: anomaly,
        claims: [
          claim({
            id: 'claim_lumen_anomaly',
            featureId: anomaly.id,
            status: 'supported',
            eligibility: 'needs_qualification',
          }),
        ],
        sceneIds: [],
      },
    ],
    routes: [
      { featureId: 'feat_lumen_collab', route: '/demo/boards/atlas' },
      { featureId: 'feat_lumen_anomaly', route: '/demo/insights/anomaly' },
    ],
    template: 'web_studio_knowledge_claim',
    baseUrl: 'http://localhost:4200',
    allowedOrigins: ['http://localhost:4200'],
    ...overrides,
  };
}

describe('Demo Planner · 确定性', () => {
  it('同一输入生成逐字节相同的计划与 digest', async () => {
    const a = buildDemoPlanDraft(plannerInput());
    const b = buildDemoPlanDraft(plannerInput());
    expect(a.ok).toBe(true);
    expect(b.ok).toBe(true);
    if (!a.ok || !b.ok) return;
    expect(canonicalDemoPlanJson(a.draft)).toBe(canonicalDemoPlanJson(b.draft));
    expect(await computeDemoPlanDigest(a.draft)).toBe(await computeDemoPlanDigest(b.draft));
  });

  it('计划 id 对同一 (video, template) 稳定，不同模板不同', () => {
    expect(demoPlanIdFor('vid_lumen_release', 'web_studio_tour')).toBe(
      demoPlanIdFor('vid_lumen_release', 'web_studio_tour'),
    );
    expect(demoPlanIdFor('vid_lumen_release', 'web_studio_tour')).not.toBe(
      demoPlanIdFor('vid_lumen_release', 'web_studio_route_focus'),
    );
  });

  it('每个模板都生成至少一个 assert 且通过 schema', () => {
    for (const template of DEMO_PLAN_TEMPLATE_IDS) {
      if (template === 'custom') continue;
      const result = buildDemoPlanDraft(plannerInput({ template }));
      expect(result.ok, template).toBe(true);
      if (!result.ok) continue;
      const parsed = demoPlanDraftV1Schema.parse(result.draft);
      expect(parsed.steps.filter((step) => step.action === 'assert').length).toBeGreaterThanOrEqual(1);
      expect(parsed.steps.some((step) => step.action === 'fill')).toBe(
        template === 'web_studio_tour',
      );
    }
  });
});

describe('Demo Planner · 规则与安全边界', () => {
  it('只有 4D 可发布（verified + publishable）的功能进入计划', () => {
    const input = plannerInput();
    const eligible = eligiblePlannerFeatures(input);
    expect(eligible.map((entry) => entry.feature.id)).toEqual(['feat_lumen_collab']);
  });

  it('知识/声明模板断言的是已核验声明的原文', () => {
    const result = buildDemoPlanDraft(plannerInput());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const claimStep = result.draft.steps.find((step) => step.id === 'claim-visible');
    expect(claimStep?.target).toBe(
      'text=团队可以同时编辑同一个看板，并实时看到彼此的光标与改动。',
    );
    expect(claimStep?.assertion?.kind).toBe('visible');
  });

  it('baseUrl 不在服务端 allowlist 时拒绝（SSRF 防护）', () => {
    const result = buildDemoPlanDraft(
      plannerInput({ baseUrl: 'http://evil.internal:8080', allowedOrigins: ['http://localhost:4200'] }),
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe('invalid_plan');
    expect(result.message).toContain('allowlist');
  });

  it('custom 模板没有步骤时拒绝', () => {
    const result = buildDemoPlanDraft(plannerInput({ template: 'custom' }));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('invalid_plan');
  });

  it('非 16:9 viewport 的自定义参数会被 schema 拒绝', () => {
    const result = buildDemoPlanDraft(
      plannerInput({ template: 'web_studio_tour', viewport: { width: 1080, height: 1920 } }),
    );
    expect(result.ok).toBe(false);
  });

  it('任意输入都不会生成凭证类 fixture', () => {
    for (const template of DEMO_PLAN_TEMPLATE_IDS) {
      if (template === 'custom') continue;
      const result = buildDemoPlanDraft(plannerInput({ template }));
      if (!result.ok) continue;
      expect(Object.keys(result.draft.fixtures)).toEqual(['searchTerm']);
    }
  });
});

describe('Demo Planner · 风险评估', () => {
  it('巡览模板因包含表单输入与多条断言被判为可解释的风险等级', () => {
    const result = buildDemoPlanDraft(plannerInput({ template: 'web_studio_tour' }));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const risk = assessDemoPlanRisk(result.draft);
    expect(risk.findings.map((finding) => finding.code)).toContain('form_input');
    expect(risk.assertionCount).toBeGreaterThanOrEqual(2);
    expect(risk.level).not.toBe('low');
    expect(risk.writeScope).toBe('local_ui_state');
  });

  it('写操作步骤被判为 high', () => {
    const draft: DemoPlanDraftV1 = {
      schemaVersion: '1',
      id: 'plan_risk',
      projectId: 'proj_x',
      name: '风险计划',
      environmentId: 'local',
      baseUrl: 'http://localhost:4200',
      allowedOrigins: ['http://localhost:4200'],
      resetStrategy: 'fixture',
      viewport: { width: 1920, height: 1080, deviceScaleFactor: 1 },
      locale: 'zh-CN',
      timezoneId: 'Asia/Shanghai',
      colorScheme: 'dark',
      reducedMotion: 'no-preference',
      fixtures: {},
      capture: { width: 1920, height: 1080, fps: 30, clipDurationMs: 10_000 },
      asset: { id: 'asset_x', name: 'x', description: 'x', palette: ['#000000', '#FFFFFF'] },
      steps: [
        { id: 's1', action: 'click', target: 'role=button,name=删除视频', timeoutMs: 1000, dwellMs: 0, state: 'visible' },
        { id: 's2', action: 'assert', target: 'heading=完成', assertion: { kind: 'visible', match: 'contains' }, timeoutMs: 1000, dwellMs: 0, state: 'visible' },
      ],
    };
    const risk = assessDemoPlanRisk(draft);
    expect(risk.level).toBe('high');
    expect(risk.findings.some((finding) => finding.code === 'mutating_action')).toBe(true);
  });

  it('最差的风险等级决定 summary.level', () => {
    const result = buildDemoPlanDraft(plannerInput({ template: 'web_studio_tour' }));
    if (!result.ok) throw new Error('planner failed');
    const risk = assessDemoPlanRisk(result.draft);
    const order = { low: 0, medium: 1, high: 2 } as const;
    let worst: keyof typeof order = 'low';
    for (const finding of risk.findings) {
      if (order[finding.level] > order[worst]) worst = finding.level;
    }
    expect(risk.level).toBe(worst);
  });
});

describe('Demo Plan · digest 与审批绑定', () => {
  it('审批块的任何变化都不改变 digest，计划内容的变化一定改变 digest', async () => {
    const result = buildDemoPlanDraft(plannerInput());
    if (!result.ok) throw new Error('planner failed');
    const digest = await computeDemoPlanDigest(result.draft);
    const approved = withDemoPlanApproval(result.draft, {
      approvalId: 'appr_1',
      approvedPlanDigest: digest,
      approvedAt: ISO,
    });
    expect(demoPlanV1Schema.parse(approved)).toBeTruthy();
    expect(await computeDemoPlanDigest(approved)).toBe(digest);

    const edited = { ...result.draft, baseUrl: 'http://localhost:4300' };
    expect(await computeDemoPlanDigest(edited)).not.toBe(digest);
  });

  it('digest 与 browser-worker 的 stableStringify 算法一致（已知向量）', async () => {
    // Mirrors `workers/browser-worker/src/plan.ts#demoPlanDigest`:
    // sha256 over JSON with sorted keys, `approval` removed.
    const { createHash } = await import('node:crypto');
    const result = buildDemoPlanDraft(plannerInput({ template: 'web_studio_route_focus' }));
    if (!result.ok) throw new Error('planner failed');
    const canonical = canonicalDemoPlanJson(result.draft);
    const nodeDigest = createHash('sha256').update(canonical, 'utf8').digest('hex');
    expect(await computeDemoPlanDigest(result.draft)).toBe(nodeDigest);
    // The canonical bytes are the draft itself: no `approval` key is present.
    const parsed = JSON.parse(canonical) as Record<string, unknown>;
    expect(parsed.approval).toBeUndefined();
    expect(parsed.id).toBe(result.draft.id);
  });
});

describe('Capture job 协议', () => {
  it('服务端 allowlist 必须是计划 origin 的超集', async () => {
    const result = buildDemoPlanDraft(plannerInput());
    if (!result.ok) throw new Error('planner failed');
    const digest = await computeDemoPlanDigest(result.draft);
    const plan = withDemoPlanApproval(result.draft, {
      approvalId: 'appr_1',
      approvedPlanDigest: digest,
    });
    const base = {
      schemaVersion: '1',
      kind: 'asvs.capture-job',
      jobId: 'orchjob_1',
      runId: 'orchrun_1',
      workspaceId: 'ws_1',
      outDir: 'C:/tmp/out',
      checkpointFile: 'C:/tmp/out/checkpoints.json',
      storageRefBase: 'C:/repo',
      plan,
      planDigest: digest,
      policyVersion: 'gate2-v1',
      jobDigest: 'a'.repeat(64),
      createdAt: ISO,
    } as const;
    expect(captureJobInputV1Schema.safeParse({ ...base, allowedOrigins: ['http://localhost:4200'] }).success).toBe(true);
    expect(captureJobInputV1Schema.safeParse({ ...base, allowedOrigins: ['http://localhost:4300'] }).success).toBe(false);
  });

  it('失败码的重试策略：输入/篡改类永不重试', () => {
    expect(isRetryableCaptureCode('capture_assertion_failed')).toBe(true);
    expect(isRetryableCaptureCode('capture_timeout')).toBe(true);
    expect(isRetryableCaptureCode('capture_plane_tampered')).toBe(false);
    expect(isRetryableCaptureCode('capture_plan_tampered')).toBe(false);
    expect(isRetryableCaptureCode('capture_origin_blocked')).toBe(false);
    expect(isRetryableCaptureCode('capture_invalid_input')).toBe(false);
  });
});
