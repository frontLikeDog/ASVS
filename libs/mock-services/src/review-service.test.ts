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
});
