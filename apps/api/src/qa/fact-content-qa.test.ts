// @vitest-environment node
import { describe, expect, it } from 'vitest';
import type { Asset, Project, Scene, VideoProject } from '@asvs/domain';
import { buildRenderInput } from '@asvs/domain';
import { collectCaptureProvenanceFindings } from './fact-content-qa';

/**
 * `fact.capture_provenance` must bind the real clip through the **scene**,
 * not only through `visual.assetId`.
 *
 * `buildStoryboardV1` puts the asset in `assetIds` (derived from `scene.assetId`)
 * and leaves `visual` as a bare `{ type: 'real_demo' }` whenever the persisted
 * scene has no IR yet — which is exactly what the backfill produces. The
 * renderer has always resolved the clip with `findRealCaptureAsset(scene…)`
 * (i.e. `assetIds`); QA used to read only `visual.assetId`, so every genuine
 * Gate 2 capture was reported as "缺少素材绑定" — a false warning on the happy
 * path, which is worse than no check at all: it teaches reviewers to ignore
 * provenance findings.
 */

const SHA = (seed: string): string => seed.repeat(64).slice(0, 64);
const ISO = '2026-11-29T00:00:00.000Z';

const PROJECT: Project = {
  id: 'proj_provenance',
  name: 'Provenance',
  productName: 'Provenance',
  description: '事实 QA 溯源单测',
  website: 'https://provenance.demo.invalid',
  stage: 'active',
  brand: {
    logoText: 'PV',
    logoMark: 'orbit',
    primary: '#E8A44C',
    secondary: '#23262D',
    fontPair: 'grotesk',
    style: 'editorial',
    intro: '',
    outro: '',
  },
  sources: [],
  defaultAspect: '16:9',
  defaultLanguage: 'zh-CN',
  templateId: 'tpl_signal',
  analysisCount: 0,
  createdAt: ISO,
  updatedAt: ISO,
  demo: true,
};

function demoScene(options: { assetId?: string; visualAssetId?: string; bareVisual?: boolean }): Scene {
  return {
    id: 'scene_demo',
    order: 1,
    revision: 1,
    title: '真实界面',
    intent: '真实录屏',
    narration: '下面这段画面来自真实浏览器录制。',
    caption: '真实录屏',
    durationSec: 10,
    visualType: 'real_demo',
    ...(options.visualAssetId
      ? { visual: { type: 'real_demo' as const, assetId: options.visualAssetId } }
      : options.bareVisual
        ? // Persisted scenes (and the Gate 2 backfill) carry the IR *without*
          // an asset id; only `scene.assetId` names the clip.
          { visual: { type: 'real_demo' as const } }
        : {}),
    templateId: 'tpl_signal',
    claimIds: [],
    status: 'approved',
    look: 'cinematic',
    brightness: 1,
    vignette: true,
    ...(options.assetId ? { assetId: options.assetId } : {}),
  };
}

function video(scenes: Scene[]): VideoProject {
  return {
    id: 'vid_provenance',
    projectId: PROJECT.id,
    title: '溯源单测',
    mode: 'release_video',
    stage: 'review',
    fps: 30,
    brief: {
      objective: '溯源',
      audience: '工程团队',
      featureIds: [],
      durationSec: scenes.reduce((sum, scene) => sum + scene.durationSec, 0),
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
        ...demoScene({}),
        id: 'scene_intro',
        order: 0,
        title: '开场',
        caption: '开场',
        durationSec: 2,
        visualType: 'title',
      },
      ...scenes,
    ],
    directorMessages: [],
    scriptVersion: 1,
    createdAt: ISO,
    updatedAt: ISO,
    demo: false,
  };
}

function realAsset(): Asset {
  return {
    id: 'asset_capture_provenance',
    projectId: PROJECT.id,
    name: '真实录屏',
    kind: 'capture',
    durationSec: 18,
    description: 'Gate 2 真实录屏',
    palette: ['#E8A44C', '#23262D'],
    mock: false,
    media: {
      // The render dir is what the asset persists; the provenance checker
      // must not care about it (the receipt is the source of truth).
      src: 'captures/asset_capture_provenance.mp4',
      sha256: SHA('a'),
      mimeType: 'video/mp4',
      width: 1920,
      height: 1080,
      durationMs: 18_000,
    },
  };
}

const RECEIPT_OK = { assertions: { total: 9, passed: 9, failed: 0 }, clip: { sha256: SHA('a') } };
const WINDOWS = [
  { sceneId: 'scene_intro', sceneOrder: 0, sceneTitle: '开场', visualType: 'title', startMs: 0, endMs: 2000, startFrame: 0, endFrame: 60 },
  { sceneId: 'scene_demo', sceneOrder: 1, sceneTitle: '真实界面', visualType: 'real_demo', assetId: 'asset_capture_provenance', startMs: 2000, endMs: 12_000, startFrame: 60, endFrame: 360 },
];

function findingsFor(scene: Scene, asset: Asset | undefined = realAsset()) {
  const input = buildRenderInput({
    video: video([scene]),
    project: PROJECT,
    features: [],
    assets: asset ? [asset] : [],
  });
  return collectCaptureProvenanceFindings({ input }, { receipt: RECEIPT_OK }, WINDOWS);
}

describe('collectCaptureProvenanceFindings', () => {
  it('通过 scene.assetId 解析真实素材：没有 visual.assetId 也不是“缺少绑定”', () => {
    const findings = findingsFor(
      demoScene({ assetId: 'asset_capture_provenance', bareVisual: true }),
    );
    expect(findings).toEqual([]);
  });

  it('IR 未带 assetId 时仍按 assetIds 命中，不会被误报为缺少绑定', () => {
    // Exactly the frozen `input.json` of a Gate 2 run: `visual` is a bare
    // `{type:'real_demo'}`, `assetIds` holds the clip.
    const scene = demoScene({ assetId: 'asset_capture_provenance', bareVisual: true });
    const input = buildRenderInput({
      video: video([scene]),
      project: PROJECT,
      features: [],
      assets: [realAsset()],
    });
    const demo = input.storyboard.scenes.find((item) => item.id === 'scene_demo');
    expect(demo?.visual).toEqual({ type: 'real_demo' });
    expect(demo?.assetIds).toEqual(['asset_capture_provenance']);
    expect(collectCaptureProvenanceFindings({ input }, { receipt: RECEIPT_OK }, WINDOWS)).toEqual([]);
  });

  it('visual.assetId 与 scene.assetId 同时存在且一致时同样通过', () => {
    const findings = findingsFor(
      demoScene({
        assetId: 'asset_capture_provenance',
        visualAssetId: 'asset_capture_provenance',
      }),
    );
    expect(findings).toEqual([]);
  });

  it('两者都缺失 → warning（诚实提示，不是 blocker）', () => {
    const findings = findingsFor(demoScene({ bareVisual: true }));
    expect(findings).toHaveLength(1);
    expect(findings[0]?.ruleId).toBe('fact.capture_provenance');
    expect(findings[0]?.severity).toBe('warning');
    expect(findings[0]?.title).toBe('真实录屏镜头缺少素材绑定');
  });

  it('绑定到不存在的素材 → warning', () => {
    const findings = findingsFor(demoScene({ assetId: 'asset_missing' }));
    expect(findings).toHaveLength(1);
    expect(findings[0]?.title).toBe('真实录屏镜头缺少素材绑定');
  });

  it('占位素材 → warning，并且即使在 qa_final 也保持 warning', () => {
    const placeholder = { ...realAsset(), mock: true, media: undefined };
    // `buildRenderInput` only keeps referenced assets, so the placeholder must
    // be referenced by the scene to reach the checker at all.
    const findings = findingsFor(
      demoScene({ assetId: 'asset_capture_provenance' }),
      placeholder as Asset,
    );
    expect(findings).toHaveLength(1);
    expect(findings[0]?.severity).toBe('warning');
    expect(findings[0]?.title).toBe('真实录屏镜头仍在使用占位素材');
  });

  it('回执断言未全部通过 → blocker', () => {
    const scene = demoScene({ assetId: 'asset_capture_provenance' });
    const input = buildRenderInput({
      video: video([scene]),
      project: PROJECT,
      features: [],
      assets: [realAsset()],
    });
    const findings = collectCaptureProvenanceFindings(
      { input },
      { receipt: { assertions: { total: 9, passed: 8, failed: 1 }, clip: { sha256: SHA('a') } } },
      WINDOWS,
    );
    expect(findings).toHaveLength(1);
    expect(findings[0]?.severity).toBe('blocker');
    expect(findings[0]?.message).toContain('未通过的断言');
  });

  it('磁盘片段哈希与回执不一致 → blocker', () => {
    const scene = demoScene({ assetId: 'asset_capture_provenance' });
    const input = buildRenderInput({
      video: video([scene]),
      project: PROJECT,
      features: [],
      assets: [realAsset()],
    });
    const findings = collectCaptureProvenanceFindings(
      { input },
      { receipt: RECEIPT_OK, clipSha256: SHA('b') },
      WINDOWS,
    );
    expect(findings).toHaveLength(1);
    expect(findings[0]?.severity).toBe('blocker');
    expect(findings[0]?.message).toContain('SHA256');
  });

  it('定位到正确的镜头序号（第 2 镜）', () => {
    const findings = findingsFor(demoScene({}));
    expect(findings[0]?.sceneOrder).toBe(1);
    expect(findings[0]?.sceneTitle).toBe('真实界面');
  });
});
