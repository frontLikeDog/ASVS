import { describe, expect, it } from 'vitest';
import type { Claim, Evidence, Feature, Project, Scene, VideoProject } from './schemas';
import {
  buildExportFileName,
  buildProjectExport,
  buildSrt,
  exportFileBase,
} from './serialization';
import { totalDuration } from './timeline';

function scene(id: string, order: number, durationSec: number, extra: Partial<Scene> = {}): Scene {
  return {
    id,
    order,
    title: `镜头 ${order + 1}`,
    intent: '演示',
    narration: `旁白 ${order + 1}`,
    caption: `字幕 ${order + 1}`,
    durationSec,
    visualType: 'motion',
    templateId: 'tpl_grid',
    claimIds: [],
    status: 'draft',
    look: 'clean',
    brightness: 1,
    vignette: false,
    ...extra,
  };
}

const project: Project = {
  id: 'proj_test',
  name: '测试项目',
  productName: 'Atlas',
  description: '测试项目描述',
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

const feature: Feature = {
  id: 'feat_a',
  projectId: 'proj_test',
  name: '自动化规则',
  summary: '把重复任务交给规则执行',
  category: '自动化',
  status: 'verified',
  confidence: 92,
  userConfirmed: true,
  sourceRefs: [],
  claimIds: ['claim_a'],
  prIds: [],
  demoRoute: '/rules',
  updatedAt: '2026-11-01T00:00:00.000Z',
  tags: ['自动化'],
  demo: true,
};

const claim: Claim = {
  id: 'claim_a',
  projectId: 'proj_test',
  featureId: 'feat_a',
  statement: '规则可以在条件满足时自动执行动作。',
  audience: '运营团队',
  status: 'verified',
  evidenceIds: ['ev_a'],
  demo: true,
};

const evidence: Evidence = {
  id: 'ev_a',
  projectId: 'proj_test',
  featureId: 'feat_a',
  claimId: 'claim_a',
  kind: 'test',
  title: '规则执行端到端测试',
  detail: '3 条用例通过',
  ref: 'tests/rules.spec.ts',
  status: 'valid',
  capturedAt: '2026-11-01T00:00:00.000Z',
  demo: true,
};

function makeVideo(scenes: Scene[]): VideoProject {
  return {
    id: 'vid_test',
    projectId: 'proj_test',
    title: 'Atlas 自动化更新',
    mode: 'release_video',
    stage: 'review',
    brief: {
      objective: '介绍自动化规则',
      audience: '运营团队',
      featureIds: ['feat_a'],
      durationSec: totalDuration(scenes),
      aspect: '16:9',
      language: 'zh-CN',
      tone: 'confident',
      style: 'editorial',
      templateId: 'tpl_signal',
      useRealCapture: false,
      useGeneratedVisuals: false,
      cta: '创建第一条规则',
      bannedPhrases: ['行业最强'],
    },
    scenes,
    directorMessages: [],
    scriptVersion: 2,
    createdAt: '2026-11-01T00:00:00.000Z',
    updatedAt: '2026-11-02T00:00:00.000Z',
    demo: true,
  };
}

describe('buildSrt', () => {
  it('按镜头时长生成合法 SRT 时间轴', () => {
    const srt = buildSrt(
      makeVideo([
        scene('b', 1, 6.5, { caption: '第二段字幕' }),
        scene('a', 0, 4, { caption: '第一段字幕' }),
      ]),
    );

    expect(srt).toContain('1\n00:00:00,000 --> 00:00:04,000\n第一段字幕');
    expect(srt).toContain('2\n00:00:04,000 --> 00:00:10,500\n第二段字幕');
  });

  it('字幕为空时回退到旁白，再回退到标题', () => {
    const srt = buildSrt(
      makeVideo([
        scene('a', 0, 4, { caption: '', narration: '旁白兜底' }),
        scene('b', 1, 4, { caption: '', narration: '', title: '标题兜底' }),
      ]),
    );
    expect(srt).toContain('旁白兜底');
    expect(srt).toContain('标题兜底');
  });
});

describe('buildProjectExport', () => {
  it('导出可重建的工程 JSON，并只包含相关知识与证据', () => {
    const video = makeVideo([scene('a', 0, 4), scene('b', 1, 6, { claimIds: ['claim_a'] })]);
    const raw = buildProjectExport({
      video,
      project,
      features: [feature],
      claims: [claim],
      evidence: [evidence],
      exportedAt: '2026-11-15T00:00:00.000Z',
    });
    const parsed = JSON.parse(raw);

    expect(parsed.kind).toBe('asvs.video-project');
    expect(parsed.schemaVersion).toBe('1');
    expect(parsed.exportedAt).toBe('2026-11-15T00:00:00.000Z');
    expect(parsed.product.name).toBe('测试项目');
    expect(parsed.video.title).toBe('Atlas 自动化更新');
    expect(parsed.video.totalDurationSec).toBe(10);
    expect(parsed.video.scenes.map((item: Scene) => item.id)).toEqual(['a', 'b']);
    expect(parsed.knowledgeSnapshot.features).toHaveLength(1);
    expect(parsed.knowledgeSnapshot.claims).toHaveLength(1);
    expect(parsed.knowledgeSnapshot.evidence).toHaveLength(1);
    expect(parsed.notice).toContain('不包含真实渲染媒体');
    expect(parsed.production.note).toContain('确定性模拟');
    expect(parsed).not.toHaveProperty('media');
    expect(parsed).not.toHaveProperty('mp4');
  });

  it('排序后的场景写入导出，且不混入无关证据', () => {
    const unrelatedEvidence: Evidence = { ...evidence, id: 'ev_other', claimId: 'claim_other' };
    const unrelatedClaim: Claim = { ...claim, id: 'claim_other', featureId: 'feat_other' };
    const parsed = JSON.parse(
      buildProjectExport({
        video: makeVideo([scene('b', 1, 4), scene('a', 0, 4)]),
        project,
        features: [feature],
        claims: [claim, unrelatedClaim],
        evidence: [evidence, unrelatedEvidence],
      }),
    );

    expect(parsed.video.scenes.map((item: Scene) => item.id)).toEqual(['a', 'b']);
    expect(parsed.knowledgeSnapshot.claims.map((item: Claim) => item.id)).toEqual(['claim_a']);
    expect(parsed.knowledgeSnapshot.evidence.map((item: Evidence) => item.id)).toEqual(['ev_a']);
  });

  it('导出文件名包含视频 ID 与总时长', () => {
    const video = makeVideo([scene('a', 0, 10)]);
    expect(exportFileBase(video)).toBe('asvs-vid_test-00m10s');
    expect(buildExportFileName(video, 'json')).toBe('asvs-vid_test-00m10s.json');
    expect(buildExportFileName(video, 'srt')).toBe('asvs-vid_test-00m10s.srt');
  });
});
