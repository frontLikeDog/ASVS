import { describe, expect, it } from 'vitest';
import type {
  Asset,
  Claim,
  DirectorContext,
  Evidence,
  Feature,
  Project,
  VideoBrief,
  VideoProject,
} from '@asvs/domain';
import { totalDuration } from '@asvs/domain';
import { createVideoPlan, interpretDirectorCommand } from './director-service';

const project: Project = {
  id: 'proj_director',
  name: 'Atlas',
  productName: 'Atlas',
  description: '自动化工作平台',
  website: 'https://atlas.demo.invalid',
  stage: 'active',
  brand: {
    logoText: 'ATLAS',
    logoMark: 'orbit',
    primary: '#D7F36A',
    secondary: '#F4F2EC',
    fontPair: 'grotesk',
    style: 'editorial',
    intro: '让工作向前',
    outro: 'atlas.demo.invalid',
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

function feature(id: string, name: string): Feature {
  return {
    id,
    projectId: project.id,
    name,
    summary: `${name}的产品说明`,
    category: '协作',
    status: 'verified',
    confidence: 90,
    userConfirmed: true,
    sourceRefs: [],
    claimIds: [`claim_${id}`],
    prIds: [],
    demoRoute: '/demo',
    updatedAt: '2026-11-01T00:00:00.000Z',
    tags: [],
    demo: true,
  };
}

const features = [feature('feat_board', '数据看板'), feature('feat_rules', '自动化规则')];

const claims: Claim[] = features.map((item) => ({
  id: `claim_${item.id}`,
  projectId: project.id,
  featureId: item.id,
  statement: `${item.name}可以完成一项具体工作。`,
  audience: '运营团队',
  status: 'verified',
  evidenceIds: [`ev_${item.id}`],
  demo: true,
}));

const evidence: Evidence[] = features.map((item) => ({
  id: `ev_${item.id}`,
  projectId: project.id,
  featureId: item.id,
  claimId: `claim_${item.id}`,
  kind: 'test',
  title: `${item.name}端到端测试`,
  detail: '通过',
  ref: 'tests/demo.spec.ts',
  status: 'valid',
  capturedAt: '2026-11-01T00:00:00.000Z',
  demo: true,
}));

const context: DirectorContext = {
  features,
  claims,
  evidence,
  assets: [] as Asset[],
};

const brief: VideoBrief = {
  objective: '介绍自动化能力',
  audience: '运营团队',
  featureIds: features.map((item) => item.id),
  durationSec: 30,
  aspect: '16:9',
  language: 'zh-CN',
  tone: 'confident',
  style: 'editorial',
  templateId: 'tpl_signal',
  useRealCapture: false,
  useGeneratedVisuals: false,
  cta: '创建第一条自动化规则',
  bannedPhrases: ['行业最强'],
};

function makeVideo(): VideoProject {
  return createVideoPlan({
    project,
    videoTitle: 'Atlas 自动化发布',
    brief,
    mode: 'release_video',
    features,
    claims,
    assets: [],
  });
}

describe('interpretDirectorCommand', () => {
  it('空输入与帮助命令不修改工程', () => {
    const video = makeVideo();
    const empty = interpretDirectorCommand({ command: '   ', video, context });
    expect(empty.intent).toBe('empty');
    expect(empty.video).toBe(video);

    const help = interpretDirectorCommand({ command: '你能做什么？', video, context });
    expect(help.intent).toBe('help');
    expect(help.recognized).toBe(true);
    expect(help.reply).toContain('模拟 AI 导演');
    expect(help.video).toBe(video);
  });

  it('无法识别的请求会诚实说明，不伪造执行结果', () => {
    const video = makeVideo();
    const result = interpretDirectorCommand({ command: '换成真人出镜', video, context });

    expect(result.recognized).toBe(false);
    expect(result.intent).toBe('unknown');
    expect(result.changes).toEqual([]);
    expect(result.video).toBe(video);
    expect(result.reply).toContain('确定性模拟导演');
    expect(result.reply).toContain('无法');
  });

  it('缩短到指定时长会真实重排所有镜头', () => {
    const video = makeVideo();
    expect(totalDuration(video.scenes)).toBeGreaterThan(20);

    const result = interpretDirectorCommand({
      command: '把视频缩短到 20 秒',
      video,
      context,
    });

    expect(result.recognized).toBe(true);
    expect(result.intent).toBe('duration');
    expect(totalDuration(result.video.scenes)).toBeCloseTo(20, 5);
    expect(result.video.brief.durationSec).toBeCloseTo(20, 5);
    expect(result.changes.map((change) => change.field)).toContain('brief.durationSec');
    expect(result.video.scenes.every((scene) => scene.durationSec >= 2.5)).toBe(true);
  });

  it('调整语气会同步改写 Brief、开场与 CTA', () => {
    const video = makeVideo();
    const result = interpretDirectorCommand({
      command: '把语气调得更轻松',
      video,
      context,
    });

    expect(result.intent).toBe('tone');
    expect(result.video.brief.tone).toBe('warm');
    expect(result.changes.some((change) => change.field === 'brief.tone')).toBe(true);
    expect(result.video.scenes[0]?.narration).not.toBe(video.scenes[0]?.narration);
  });

  it('调整受众会写入 Brief 并改写开场旁白', () => {
    const video = makeVideo();
    const result = interpretDirectorCommand({
      command: '把受众改成开发者',
      video,
      context,
    });

    expect(result.intent).toBe('audience');
    expect(result.video.brief.audience).toContain('开发者');
    expect(result.video.scenes[0]?.narration).toContain('开发者');
  });

  it('删除卖点会同时移除 Brief 条目与关联镜头', () => {
    const video = makeVideo();
    const before = video.scenes.length;
    const result = interpretDirectorCommand({
      command: '删除「数据看板」卖点',
      video,
      context,
    });

    expect(result.intent).toBe('delete_feature');
    expect(result.video.brief.featureIds).not.toContain('feat_board');
    expect(result.video.scenes.some((scene) => scene.featureId === 'feat_board')).toBe(false);
    expect(result.video.scenes.length).toBeLessThan(before);
    expect(totalDuration(result.video.scenes)).toBeLessThan(totalDuration(video.scenes));
  });

  it('重新生成指定分镜会改写文案并保留时长', () => {
    const video = makeVideo();
    const target = [...video.scenes].sort((a, b) => a.order - b.order)[1]!;
    const result = interpretDirectorCommand({
      command: '重新生成第 2 个分镜',
      video,
      context,
    });

    expect(result.recognized).toBe(true);
    expect(result.intent).toBe('regenerate_scene');
    expect(result.changes.length).toBeGreaterThan(0);
    const nextTarget = result.video.scenes.find((scene) => scene.id === target.id)!;
    expect(nextTarget.durationSec).toBe(target.durationSec);
    expect(nextTarget.status).toBe('draft');
  });
});
