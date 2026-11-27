import { describe, expect, it } from 'vitest';
import type {
  Claim,
  Evidence,
  Feature,
  ProductionRun,
  Project,
  Scene,
  VideoProject,
} from '@asvs/domain';
import { buildReviewBundle } from './review-service';

function scene(id: string, order: number, durationSec: number, extra: Partial<Scene> = {}): Scene {
  return {
    id,
    order,
    title: `镜头 ${order + 1}`,
    intent: '演示',
    narration: '旁白内容',
    caption: '字幕内容',
    durationSec,
    visualType: 'motion',
    templateId: 'tpl_grid',
    claimIds: ['claim_a'],
    status: 'approved',
    look: 'clean',
    brightness: 1,
    vignette: false,
    ...extra,
    revision: extra.revision ?? 1,
  };
}

const project: Project = {
  id: 'proj_review',
  name: '测试项目',
  productName: 'Atlas',
  description: '',
  website: '',
  stage: 'active',
  brand: {
    logoText: 'ATLAS',
    logoMark: 'orbit',
    primary: '#D7F36A',
    secondary: '#F4F2EC',
    fontPair: 'grotesk',
    style: 'editorial',
    intro: '',
    outro: '',
  },
  sources: [],
  defaultAspect: '16:9',
  defaultLanguage: 'zh-CN',
  templateId: 'tpl_signal',
  analysisCount: 1,
  createdAt: '2026-11-01T00:00:00.000Z',
  updatedAt: '2026-11-01T00:00:00.000Z',
  demo: true,
};

const feature: Feature = {
  id: 'feat_a',
  projectId: project.id,
  name: '自动规则',
  summary: '',
  category: '',
  status: 'verified',
  confidence: 90,
  userConfirmed: true,
  sourceRefs: [],
  claimIds: ['claim_a'],
  prIds: [],
  demoRoute: '',
  updatedAt: '2026-11-01T00:00:00.000Z',
  tags: [],
  demo: true,
};

const claim: Claim = {
  id: 'claim_a',
  projectId: project.id,
  featureId: feature.id,
  statement: '规则可以自动执行动作。',
  audience: '',
  status: 'verified',
  evidenceIds: ['ev_a'],
  demo: true,
};

const evidence: Evidence = {
  id: 'ev_a',
  projectId: project.id,
  featureId: feature.id,
  claimId: claim.id,
  kind: 'test',
  title: '端到端测试',
  detail: '',
  ref: 'tests/a.spec.ts',
  status: 'valid',
  capturedAt: '2026-11-01T00:00:00.000Z',
  demo: true,
};

function makeVideo(extra: Partial<VideoProject> = {}): VideoProject {
  return {
    id: 'vid_review',
    projectId: project.id,
    title: '待审核视频',
    mode: 'release_video',
    stage: 'review',
    fps: 30,
    brief: {
      objective: '测试',
      audience: '团队',
      featureIds: [feature.id],
      durationSec: 16,
      aspect: '16:9',
      language: 'zh-CN',
      tone: 'confident',
      style: 'editorial',
      templateId: 'tpl_signal',
      useRealCapture: false,
      useGeneratedVisuals: false,
      cta: '立即开始',
      bannedPhrases: ['行业最强'],
    },
    scenes: [scene('a', 0, 8), scene('b', 1, 8)],
    directorMessages: [],
    scriptVersion: 1,
    createdAt: '2026-11-01T00:00:00.000Z',
    updatedAt: '2026-11-01T00:00:00.000Z',
    demo: true,
    ...extra,
  };
}

function successRun(videoId: string): ProductionRun {
  return {
    id: 'run_ok',
    projectId: project.id,
    videoId,
    scenario: 'happy_path',
    status: 'succeeded',
    steps: [],
    logs: [],
    elapsedMs: 29800,
    startedAt: '2026-11-02T00:00:00.000Z',
    finishedAt: '2026-11-02T00:00:30.000Z',
    speed: 1,
    input: { sceneCount: 2, durationSec: 16, aspect: '16:9', claimCount: 1 },
    demo: true,
  };
}

function bundle(video: VideoProject, runs: ProductionRun[] = [successRun(video.id)]) {
  return buildReviewBundle({
    video,
    project,
    features: [feature],
    claims: [claim],
    evidence: [evidence],
    runs,
  });
}

describe('buildReviewBundle', () => {
  it('完整工程通过全部 8 项检查', () => {
    const result = bundle(makeVideo());

    expect(result.checks.map((check) => check.id)).toEqual([
      'composition',
      'production',
      'claims',
      'narration',
      'captions',
      'privacy',
      'banned',
      'brand',
    ]);
    expect(result.failCount).toBe(0);
    expect(result.canApprove).toBe(true);
    expect(result.checks.every((check) => check.status === 'pass')).toBe(true);
  });

  it('没有成功生产运行会阻止审核', () => {
    const result = bundle(makeVideo(), []);
    const production = result.checks.find((check) => check.id === 'production')!;

    expect(production.status).toBe('fail');
    expect(production.detail).toContain('还没有完成');
    expect(result.canApprove).toBe(false);
    expect(result.failCount).toBeGreaterThan(0);
  });

  it('生产完成后又修改工程会阻止审核', () => {
    const video = makeVideo({ updatedAt: '2026-11-03T00:00:00.000Z' });
    const production = bundle(video).checks.find((check) => check.id === 'production')!;

    expect(production.status).toBe('fail');
    expect(production.detail).toContain('又被修改');
  });

  it('缺少 CTA 只提示品牌风险，不阻止审核', () => {
    const video = makeVideo({
      brief: { ...makeVideo().brief, cta: '' },
    });
    const brand = bundle(video).checks.find((check) => check.id === 'brand')!;

    expect(brand.status).toBe('warn');
    expect(brand.detail).toContain('CTA');
    expect(bundle(video).canApprove).toBe(true);
  });

  it('敏感信息与禁用表述会阻止审核', () => {
    const video = makeVideo({
      scenes: [
        scene('a', 0, 8, { caption: '联系 alice@example.com 获取账号' }),
        scene('b', 1, 8, { narration: '这是行业最强的工具' }),
      ],
    });
    const result = bundle(video);

    expect(result.checks.find((check) => check.id === 'privacy')?.status).toBe('fail');
    expect(result.checks.find((check) => check.id === 'banned')?.status).toBe('fail');
    expect(result.canApprove).toBe(false);
  });

  it('审核通过后工程被修改会附加审核版本失效检查', () => {
    const video = makeVideo({
      review: {
        status: 'approved',
        decidedAt: '2026-11-01T00:00:00.000Z',
      },
      updatedAt: '2026-11-02T00:00:00.000Z',
      stage: 'approved',
    });
    const result = bundle(video);
    const freshness = result.checks.find((check) => check.id === 'approval-freshness')!;

    expect(freshness.status).toBe('fail');
    expect(freshness.action).toBe('editor');
    expect(result.canApprove).toBe(false);
  });

  describe('4C Claim eligibility 审核守门', () => {
    function bundleWithClaim(nextClaim: Claim, nextScenes?: Scene[]) {
      const video = makeVideo(nextScenes ? { scenes: nextScenes } : {});
      return buildReviewBundle({
        video,
        project,
        features: [feature],
        claims: [nextClaim],
        evidence: [evidence],
        runs: [successRun(video.id)],
      });
    }

    it('blocked_unverified（含 production_runtime_pending_approval）即使字幕有限定词也必须阻断', () => {
      const pendingApproval: Claim = {
        ...claim,
        status: 'supported',
        eligibility: 'blocked_unverified',
        blockers: ['缺少人工批准（docs/08 §5 要求公开发布必须人工明确批准）。'],
      };
      const result = bundleWithClaim(pendingApproval, [
        scene('a', 0, 8, { caption: '支持规则自动执行（预发布）' }),
        scene('b', 1, 8, { caption: '确认结果（预发布）' }),
      ]);
      const claimCheck = result.checks.find((check) => check.id === 'claims')!;
      expect(claimCheck.status).toBe('fail');
      expect(claimCheck.detail).toContain('AC-03');
      expect(result.canApprove).toBe(false);
    });

    it('needs_qualification 禁止宣称「已上线」，保留限定词时降为 warn 允许审核', () => {
      const stagingClaim: Claim = {
        ...claim,
        status: 'supported',
        eligibility: 'needs_qualification',
        guidance: '文案必须标注「仅 staging 环境」',
      };

      const overclaimed = bundleWithClaim(stagingClaim, [
        scene('a', 0, 8, { caption: '新能力已上线（仅 staging 环境）' }),
        scene('b', 1, 8),
      ]);
      expect(overclaimed.checks.find((c) => c.id === 'claims')?.status).toBe('fail');
      expect(overclaimed.canApprove).toBe(false);

      const missingQual = bundleWithClaim(stagingClaim, [
        scene('a', 0, 8, { caption: '支持自动执行规则' }),
        scene('b', 1, 8),
      ]);
      expect(missingQual.checks.find((c) => c.id === 'claims')?.status).toBe('fail');
      expect(missingQual.canApprove).toBe(false);

      const qualified = bundleWithClaim(stagingClaim, [
        scene('a', 0, 8, { caption: '支持自动执行规则（仅 staging 环境）' }),
        scene('b', 1, 8),
      ]);
      expect(qualified.checks.find((c) => c.id === 'claims')?.status).toBe('warn');
      expect(qualified.canApprove).toBe(true);
    });

    it('blocked_stale 与 blocked_rejected 阻断审核，publishable + verified 通过', () => {
      const stale = bundleWithClaim({
        ...claim,
        status: 'stale',
        eligibility: 'blocked_stale',
        blockers: ['源文件已修改'],
      });
      expect(stale.checks.find((c) => c.id === 'claims')?.status).toBe('fail');
      expect(stale.canApprove).toBe(false);

      const rejected = bundleWithClaim({
        ...claim,
        status: 'rejected',
        eligibility: 'blocked_rejected',
        blockers: ['人工驳回'],
      });
      expect(rejected.checks.find((c) => c.id === 'claims')?.status).toBe('fail');
      expect(rejected.canApprove).toBe(false);

      const publishable = bundleWithClaim({
        ...claim,
        status: 'verified',
        eligibility: 'publishable',
        blockers: [],
      });
      expect(publishable.checks.find((c) => c.id === 'claims')?.status).toBe('pass');
      expect(publishable.canApprove).toBe(true);
    });
  });
});
