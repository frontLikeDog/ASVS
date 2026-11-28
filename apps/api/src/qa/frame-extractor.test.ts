import { describe, expect, it } from 'vitest';
import { planClipFrameTimes, planSceneFrameTimes } from './frame-extractor';

/**
 * Sampling plans decide *which* real frames QA ever looks at, so an off-by-one
 * here silently changes what privacy scanning covers. The end-of-clip case is
 * not cosmetic: seeking to the container duration makes ffmpeg emit no frame,
 * which the runner turns into a `technical.execution_error` blocker.
 */
describe('planClipFrameTimes', () => {
  it('最后取样点严格早于容器时长（否则 ffmpeg 一帧都不产出）', () => {
    const times = planClipFrameTimes(8000, 12, 1);
    expect(Math.max(...times)).toBeLessThan(8000);
    expect(times[0]).toBe(0);
  });

  it('30fps 素材的末帧取样仍落在最后一帧上', () => {
    // 8000 ms @30fps → last PTS 7966.7 ms; the 100 ms margin still decodes it.
    const times = planClipFrameTimes(8000, 40, 30);
    expect(times).toContain(7900);
    expect(times.length).toBeLessThanOrEqual(40);
  });

  it('不超过上限，且首尾两个取样点不会被稀释掉', () => {
    const times = planClipFrameTimes(60_000, 6, 1);
    expect(times.length).toBeLessThanOrEqual(6);
    expect(times[0]).toBe(0);
    expect(Math.max(...times)).toBe(59_900);
  });

  it('时长极短时退回单个取样点而不是负数', () => {
    expect(planClipFrameTimes(10, 5, 1)).toEqual([0]);
    expect(planClipFrameTimes(0, 5, 1)).toEqual([0]);
  });
});

describe('planSceneFrameTimes', () => {
  it('real_demo 镜头按秒取样，其余镜头取 15/50/85%', () => {
    const points = planSceneFrameTimes(
      [
        {
          sceneId: 'scene_a',
          sceneOrder: 0,
          sceneTitle: 'A',
          startMs: 0,
          endMs: 4000,
          startFrame: 0,
          endFrame: 120,
          visualType: 'real_demo',
        },
        {
          sceneId: 'scene_b',
          sceneOrder: 1,
          sceneTitle: 'B',
          startMs: 4000,
          endMs: 8000,
          startFrame: 120,
          endFrame: 240,
          visualType: 'title',
        },
      ],
      40,
    );
    expect(points.filter((point) => point.sceneId === 'scene_a')).toHaveLength(4);
    expect(points.filter((point) => point.sceneId === 'scene_b')).toHaveLength(3);
    // Every probe stays inside its own scene window.
    for (const point of points) {
      if (point.sceneId === 'scene_a') expect(point.timestampMs).toBeLessThan(4000);
      if (point.sceneId === 'scene_b') expect(point.timestampMs).toBeGreaterThanOrEqual(4000);
    }
  });
});
