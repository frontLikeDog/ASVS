import { describe, expect, it } from 'vitest';
import type { Asset, Feature, Project, Scene, VideoProject } from './schemas';
import { sceneSchema, sceneVisualSchema } from './schemas';
import {
  artifactReceiptV1Schema,
  buildRenderInput,
  buildStoryboardV1,
  renderFixtureV1Schema,
  sceneDurationFrames,
  stableStringify,
  storyboardDurationMs,
  totalStoryboardFrames,
} from './render';

function scene(overrides: Partial<Scene> = {}): Scene {
  return {
    id: 'scene_1',
    order: 0,
    revision: 1,
    title: '两个人，同一块看板',
    intent: '展示协作',
    narration: '在 Lumen 2.8 里，团队成员可以同时打开同一块看板。',
    caption: '同一块看板，两个人一起改。',
    durationSec: 7,
    visualType: 'real_demo',
    templateId: 'tpl_signal',
    featureId: 'feat_collab',
    claimIds: ['claim_collab'],
    assetId: 'asset_cap_collab',
    status: 'approved',
    look: 'warm',
    brightness: 1.04,
    vignette: true,
    ...overrides,
  };
}

function video(overrides: Partial<VideoProject> = {}): VideoProject {
  return {
    id: 'vid_test',
    projectId: 'proj_test',
    title: '测试视频',
    mode: 'release_video',
    stage: 'storyboard_ready',
    fps: 30,
    brief: {
      objective: '测试',
      audience: '团队',
      featureIds: ['feat_collab'],
      durationSec: 30,
      aspect: '16:9',
      language: 'zh-CN',
      tone: 'confident',
      style: 'editorial',
      templateId: 'tpl_signal',
      useRealCapture: true,
      useGeneratedVisuals: false,
      cta: '开始使用',
      bannedPhrases: [],
    },
    scenes: [
      scene({ id: 'a', order: 0, durationSec: 5 }),
      scene({
        id: 'b',
        order: 1,
        durationSec: 7,
        visualType: 'motion',
        visual: { type: 'motion_graphics', templateId: 'tpl_signal', props: { density: 'high' } },
      }),
      scene({ id: 'c', order: 2, durationSec: 3, visualType: 'cta', visual: { type: 'cta' } }),
    ],
    directorMessages: [],
    scriptVersion: 2,
    createdAt: '2026-11-01T00:00:00.000Z',
    updatedAt: '2026-11-01T00:00:00.000Z',
    demo: true,
    ...overrides,
  };
}

const project: Project = {
  id: 'proj_test',
  name: 'Lumen Analytics',
  productName: 'Lumen Analytics',
  description: '测试项目',
  website: 'https://lumen.demo.invalid',
  stage: 'active',
  brand: {
    logoText: 'LUMEN',
    logoMark: 'orbit',
    primary: '#FF7A59',
    secondary: '#FFD5B8',
    fontPair: 'grotesk',
    style: 'editorial',
    intro: '让每个团队看见产品的真实脉搏',
    outro: '预约一次产品演示',
  },
  sources: [],
  defaultAspect: '16:9',
  defaultLanguage: 'zh-CN',
  templateId: 'tpl_signal',
  analysisCount: 0,
  createdAt: '2026-10-01T00:00:00.000Z',
  updatedAt: '2026-10-01T00:00:00.000Z',
  demo: true,
};

const feature: Feature = {
  id: 'feat_collab',
  projectId: 'proj_test',
  name: '实时协作看板',
  summary: '多名成员同时编辑',
  category: '协作',
  status: 'verified',
  confidence: 90,
  userConfirmed: true,
  sourceRefs: [],
  claimIds: ['claim_collab'],
  prIds: [],
  demoRoute: '/demo/boards',
  updatedAt: '2026-10-01T00:00:00.000Z',
  tags: [],
  demo: true,
};

const asset: Asset = {
  id: 'asset_cap_collab',
  projectId: 'proj_test',
  name: '双人协作录屏',
  kind: 'capture',
  durationSec: 16,
  description: '模拟素材',
  palette: ['#FF7A59', '#F5C9A8'],
  mock: true,
};

describe('sceneVisualSchema', () => {
  it('接受五种合法的判别联合', () => {
    for (const visual of [
      { type: 'title' },
      { type: 'cta' },
      { type: 'real_demo', assetId: 'asset_1' },
      { type: 'motion_graphics', templateId: 'tpl_signal', props: { density: 'low' } },
      { type: 'generated_visual' },
    ]) {
      expect(sceneVisualSchema.safeParse(visual).success).toBe(true);
    }
  });

  it('拒绝未知类型、缺失必需字段与多余字段', () => {
    expect(sceneVisualSchema.safeParse({ type: 'hologram' }).success).toBe(false);
    expect(sceneVisualSchema.safeParse({ type: 'motion_graphics', props: {} }).success).toBe(false);
    expect(
      sceneVisualSchema.safeParse({ type: 'real_demo', assetId: 'a', surprise: true }).success,
    ).toBe(false);
  });

  it('sceneSchema 通过 visual 拒绝非法联合', () => {
    expect(sceneSchema.safeParse(scene({ visual: { type: 'hologram' } as never })).success).toBe(
      false,
    );
  });
});

describe('buildStoryboardV1', () => {
  it('把旧版扁平 visualType 映射为渲染 IR，并冻结帧数', () => {
    const storyboard = buildStoryboardV1(video());

    expect(storyboard.schemaVersion).toBe('1');
    expect(storyboard.fps).toBe(30);
    expect(storyboard.briefRevisionId).toBe('vid_test_brief_v2');
    expect(storyboard.scenes.map((item) => item.durationFrames)).toEqual([150, 210, 90]);
    expect(totalStoryboardFrames(storyboard)).toBe(450);
    expect(storyboardDurationMs(storyboard)).toBe(15000);
    expect(storyboard.scenes[0]?.visual).toEqual({
      type: 'real_demo',
      assetId: 'asset_cap_collab',
    });
    expect(storyboard.scenes[1]?.visual).toEqual({
      type: 'motion_graphics',
      templateId: 'tpl_signal',
      props: { density: 'high' },
    });
    expect(storyboard.scenes[2]?.visual).toEqual({ type: 'cta' });
    expect(storyboard.scenes[0]?.onScreenText).toContain('同一块看板，两个人一起改。');
    expect(storyboard.scenes[0]?.assetIds).toEqual(['asset_cap_collab']);
  });

  it('重新排序后按 order 输出，并保留自定义 fps', () => {
    const shuffled = video({
      fps: 24,
      scenes: [
        scene({ id: 'late', order: 5, durationSec: 4 }),
        scene({ id: 'early', order: 1, durationSec: 2.5 }),
      ],
    });
    const storyboard = buildStoryboardV1(shuffled);

    expect(storyboard.fps).toBe(24);
    expect(storyboard.scenes.map((item) => item.id)).toEqual(['early', 'late']);
    expect(storyboard.scenes.map((item) => item.durationFrames)).toEqual([60, 96]);
  });

  it('拒绝没有任何合法帧的 storyboard', () => {
    const invalid = video({ scenes: [] });
    const storyboard = buildStoryboardV1(invalid);
    expect(storyboard.scenes).toEqual([]);
    expect(totalStoryboardFrames(storyboard)).toBe(0);
  });
});

describe('buildRenderInput', () => {
  it('组装并校验完整渲染输入，只保留被引用的素材', () => {
    const input = buildRenderInput({
      video: video(),
      project,
      features: [feature],
      assets: [asset, { ...asset, id: 'asset_unused' }],
    });

    expect(input.renderProfile).toEqual({ width: 1920, height: 1080, codec: 'h264', crf: 18 });
    expect(input.assets.map((item) => item.id)).toEqual(['asset_cap_collab']);
    expect(input.storyboard.videoProjectId).toBe('vid_test');
  });

  it('明确拒绝 9:16（竖屏需要独立布局，不是裁切）', () => {
    const portrait = video({ brief: { ...video().brief, aspect: '9:16' } });
    expect(() =>
      buildRenderInput({ video: portrait, project, features: [feature], assets: [asset] }),
    ).toThrow(/16:9/);
  });
});

describe('artifactReceiptV1Schema', () => {
  const receipt = {
    schemaVersion: '1' as const,
    jobId: 'job_fixture',
    artifactId: 'artifact_golden',
    sha256: 'a'.repeat(64),
    mimeType: 'video/mp4' as const,
    byteSize: 1024,
    storageRef: 'dist/render-worker/golden-30s/golden-30s.mp4',
    durationMs: 30000,
    width: 1920,
    height: 1080,
    fps: 30,
    rendererVersion: '4.0.545',
    compositionId: 'Storyboard',
    createdAt: '2026-11-20T00:00:00.000Z',
  };

  it('接受完整回执', () => {
    expect(artifactReceiptV1Schema.safeParse(receipt).success).toBe(true);
  });

  it('拒绝非法 SHA256 与缺失时长', () => {
    expect(artifactReceiptV1Schema.safeParse({ ...receipt, sha256: 'nope' }).success).toBe(false);
    expect(
      artifactReceiptV1Schema.safeParse({ ...receipt, durationMs: undefined }).success,
    ).toBe(false);
  });
});

describe('renderFixtureV1Schema', () => {
  it('拒绝错误 kind，避免把任意 JSON 当黄金输入', () => {
    expect(
      renderFixtureV1Schema.safeParse({
        schemaVersion: '1',
        kind: 'asvs.video-project',
        video: video(),
        project,
        features: [feature],
        assets: [asset],
      }).success,
    ).toBe(false);
  });
});

describe('stableStringify', () => {
  it('按 key 排序并丢弃 undefined，保证 digest 稳定', () => {
    expect(stableStringify({ b: 1, a: { d: undefined, c: [2, 1] } })).toBe(
      '{"a":{"c":[2,1]},"b":1}',
    );
  });
});

describe('sceneDurationFrames', () => {
  it('按 fps 四舍五入且至少 1 帧', () => {
    expect(sceneDurationFrames({ durationSec: 2.5 }, 30)).toBe(75);
    expect(sceneDurationFrames({ durationSec: 0.01 }, 30)).toBe(1);
  });
});
