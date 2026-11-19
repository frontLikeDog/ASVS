import { describe, expect, it } from 'vitest';
import type { Scene, VideoProject } from './schemas';
import { sceneSchema, videoProjectSchema } from './schemas';
import {
  MIN_SCENE_DURATION,
  estimatedSceneCount,
  normalizeSceneOrder,
  orderedScenes,
  redistributeDurations,
  sceneAtTime,
  sceneStartTimes,
  syncBriefDuration,
  totalDuration,
  validateVideoForProduction,
  withTargetDuration,
} from './timeline';

function scene(id: string, order: number, durationSec: number, extra: Partial<Scene> = {}): Scene {
  return {
    id,
    order,
    title: id,
    intent: '演示',
    narration: `旁白 ${id}`,
    caption: `字幕 ${id}`,
    durationSec,
    visualType: 'motion',
    templateId: 'tpl_grid',
    claimIds: [],
    status: 'draft',
    look: 'clean',
    brightness: 1,
    vignette: false,
    ...extra,
    revision: extra.revision ?? 1,
  };
}

function video(
  scenes: Scene[],
  brief: Partial<VideoProject['brief']> = {},
): VideoProject {
  return {
    id: 'vid_test',
    projectId: 'proj_test',
    title: '测试视频',
    mode: 'release_video',
    stage: 'storyboard_ready',
    fps: 30,
    brief: {
      objective: '测试',
      audience: '测试团队',
      featureIds: ['feat_a'],
      durationSec: totalDuration(scenes),
      aspect: '16:9',
      language: 'zh-CN',
      tone: 'confident',
      style: 'editorial',
      templateId: 'tpl_signal',
      useRealCapture: false,
      useGeneratedVisuals: false,
      cta: '开始使用',
      bannedPhrases: [],
      ...brief,
    },
    scenes,
    directorMessages: [],
    scriptVersion: 1,
    createdAt: '2026-11-01T00:00:00.000Z',
    updatedAt: '2026-11-01T00:00:00.000Z',
    demo: true,
  };
}

describe('normalizeSceneOrder', () => {
  it('按传入数组的顺序重新编号，而不是按旧 order 排序', () => {
    const a = scene('a', 0, 4);
    const b = scene('b', 1, 5);
    const c = scene('c', 2, 6);

    // 模拟上移/拖拽之后传入的新顺序：b, a, c
    const normalized = normalizeSceneOrder([b, a, c]);

    expect(normalized.map((item) => item.id)).toEqual(['b', 'a', 'c']);
    expect(normalized.map((item) => item.order)).toEqual([0, 1, 2]);
  });

  it('不修改原数组', () => {
    const scenes = [scene('a', 3, 4), scene('b', 7, 5)];
    normalizeSceneOrder(scenes);
    expect(scenes.map((item) => item.order)).toEqual([3, 7]);
  });
});

describe('timeline math', () => {
  it('总计时长保留一位小数', () => {
    expect(totalDuration([scene('a', 0, 4.04), scene('b', 1, 3.06)])).toBe(7.1);
  });

  it('起始时间按顺序累加', () => {
    expect(sceneStartTimes([scene('a', 0, 4), scene('b', 1, 3.5), scene('c', 2, 6)])).toEqual([
      0, 4, 7.5,
    ]);
  });

  it('按 order 查找当前镜头与局部进度', () => {
    const scenes = [scene('b', 1, 6), scene('a', 0, 4)];
    const info = sceneAtTime(scenes, 6);
    expect(info?.scene.id).toBe('b');
    expect(info?.start).toBe(4);
    expect(info?.localTime).toBe(2);
    expect(info?.progress).toBeCloseTo(1 / 3);
  });

  it('时间越界时夹到首尾镜头', () => {
    const scenes = [scene('a', 0, 4), scene('b', 1, 6)];
    expect(sceneAtTime(scenes, -3)?.scene.id).toBe('a');
    expect(sceneAtTime(scenes, 999)?.scene.id).toBe('b');
    expect(sceneAtTime([], 1)).toBeNull();
  });
});

describe('duration redistribution', () => {
  it('按权重缩放到目标总时长并保持最小单镜时长', () => {
    const scenes = [scene('a', 0, 8), scene('b', 1, 4), scene('c', 2, 4)];
    const durations = redistributeDurations(scenes, 20);

    expect(durations).toHaveLength(3);
    expect(durations.reduce((sum, value) => sum + value, 0)).toBeCloseTo(20, 5);
    expect(durations.every((value) => value >= MIN_SCENE_DURATION)).toBe(true);
    // 原始权重 2:1:1，第一镜仍应最长
    expect(durations[0]).toBeGreaterThan(durations[1]!);
  });

  it('目标时长低于最小时长总和时退回最小值', () => {
    const scenes = [scene('a', 0, 8), scene('b', 1, 4)];
    const durations = redistributeDurations(scenes, 1);
    expect(durations).toEqual([MIN_SCENE_DURATION, MIN_SCENE_DURATION]);
  });

  it('withTargetDuration 落地目标时长并重排 order', () => {
    const next = withTargetDuration(
      [scene('b', 1, 6), scene('a', 0, 6), scene('c', 2, 6)],
      30,
    );
    expect(totalDuration(next)).toBeCloseTo(30, 5);
    expect(next.map((item) => item.id)).toEqual(['b', 'a', 'c']);
    expect(next.map((item) => item.order)).toEqual([0, 1, 2]);
  });
});

describe('brief 与生产校验', () => {
  it('syncBriefDuration 同步 Brief 总时长', () => {
    const source = video([scene('a', 0, 4), scene('b', 1, 6)]);
    expect(syncBriefDuration(source).brief.durationSec).toBe(10);
  });

  it('教程模式镜头数在 4-6 之间', () => {
    expect(estimatedSceneCount(0, 'tutorial')).toBe(2);
    expect(estimatedSceneCount(1, 'tutorial')).toBe(4);
    expect(estimatedSceneCount(5, 'tutorial')).toBe(5);
    expect(estimatedSceneCount(3, 'release_video')).toBe(5);
  });

  it('生产前置条件逐项生效', () => {
    expect(validateVideoForProduction(video([], { featureIds: [] }))).toEqual({
      ok: false,
      reason: '至少保留一个功能卖点才能开始生产。',
    });

    expect(validateVideoForProduction(video([scene('a', 0, 12)]))).toEqual({
      ok: false,
      reason: '至少需要 2 个分镜才能生成视频。',
    });

    expect(
      validateVideoForProduction(video([scene('a', 0, 3), scene('b', 1, 3)])),
    ).toEqual({ ok: false, reason: '视频总时长至少需要 10 秒。' });

    expect(
      validateVideoForProduction(
        video([
          scene('a', 0, 5, { narration: ' ' }),
          scene('b', 1, 6, { narration: '' }),
        ]),
      ),
    ).toEqual({ ok: false, reason: '至少一个分镜需要有旁白文本。' });

    expect(
      validateVideoForProduction(video([scene('a', 0, 5), scene('b', 1, 6)])),
    ).toEqual({ ok: true });
  });

  it('orderedScenes 不改变原数组', () => {
    const scenes = [scene('b', 1, 4), scene('a', 0, 4)];
    expect(orderedScenes(scenes).map((item) => item.id)).toEqual(['a', 'b']);
    expect(scenes.map((item) => item.id)).toEqual(['b', 'a']);
  });
});

describe('Zod Schema 校验', () => {
  it('镜头 Schema 拒绝过短时长与越界亮度', () => {
    expect(sceneSchema.safeParse(scene('a', 0, 4)).success).toBe(true);
    expect(sceneSchema.safeParse({ ...scene('a', 0, 4), durationSec: 1 }).success).toBe(false);
    expect(sceneSchema.safeParse({ ...scene('a', 0, 4), brightness: 2 }).success).toBe(false);
    expect(
      sceneSchema.safeParse({ ...scene('a', 0, 4), visualType: 'hologram' }).success,
    ).toBe(false);
  });

  it('视频工程 Schema 接受完整工程并拒绝未知阶段', () => {
    const valid = video([scene('a', 0, 5), scene('b', 1, 6)]);
    expect(videoProjectSchema.safeParse(valid).success).toBe(true);
    expect(videoProjectSchema.safeParse({ ...valid, stage: 'bogus' }).success).toBe(false);
  });
});
