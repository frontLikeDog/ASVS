import type { Scene, VideoProject } from './schemas';

export const MIN_SCENE_DURATION = 2.5;
export const MIN_VIDEO_DURATION = 10;

export function round1(value: number): number {
  return Math.round(value * 10) / 10;
}

export function orderedScenes(scenes: Scene[]): Scene[] {
  return [...scenes].sort((a, b) => a.order - b.order);
}

export function totalDuration(scenes: Pick<Scene, 'durationSec'>[]): number {
  return round1(scenes.reduce((sum, scene) => sum + Math.max(0, scene.durationSec), 0));
}

export function sceneStartTimes(scenes: Pick<Scene, 'durationSec'>[]): number[] {
  let cursor = 0;
  return scenes.map((scene) => {
    const start = cursor;
    cursor = round1(cursor + scene.durationSec);
    return start;
  });
}

export interface ActiveSceneInfo {
  scene: Scene;
  index: number;
  start: number;
  localTime: number;
  progress: number;
}

export function sceneAtTime(scenes: Scene[], time: number): ActiveSceneInfo | null {
  const ordered = orderedScenes(scenes).filter((scene) => scene.durationSec > 0);
  if (ordered.length === 0) return null;
  const total = totalDuration(ordered);
  const clamped = Math.min(Math.max(0, time), total);
  let cursor = 0;
  for (let index = 0; index < ordered.length; index += 1) {
    const scene = ordered[index]!;
    const end = round1(cursor + scene.durationSec);
    const isLast = index === ordered.length - 1;
    if (clamped < end || isLast) {
      const localTime = round1(Math.min(scene.durationSec, Math.max(0, clamped - cursor)));
      return {
        scene,
        index,
        start: cursor,
        localTime,
        progress: scene.durationSec > 0 ? Math.min(1, localTime / scene.durationSec) : 0,
      };
    }
    cursor = end;
  }
  return null;
}

export function sceneAtOrBefore(
  scenes: Scene[],
  time: number,
): { scene: Scene; start: number } | null {
  const info = sceneAtTime(scenes, time);
  return info ? { scene: info.scene, start: info.start } : null;
}

export function normalizeSceneOrder(scenes: Scene[]): Scene[] {
  return scenes.map((scene, index) => ({ ...scene, order: index }));
}

/**
 * Rescales every scene to reach a target total, preserving relative weight.
 * Never returns a scene below MIN_SCENE_DURATION and always lands exactly on target.
 */
export function redistributeDurations(scenes: Scene[], requestedTarget: number): number[] {
  const count = scenes.length;
  if (count === 0) return [];
  const minTotal = round1(MIN_SCENE_DURATION * count);
  const target = round1(Math.max(minTotal, Math.min(300, requestedTarget)));
  const currentTotal = scenes.reduce((sum, scene) => sum + Math.max(MIN_SCENE_DURATION, scene.durationSec), 0);
  let remaining = target;
  return scenes.map((scene, index) => {
    if (index === count - 1) return round1(Math.max(MIN_SCENE_DURATION, remaining));
    const weight = Math.max(MIN_SCENE_DURATION, scene.durationSec) / currentTotal;
    const raw = Math.max(MIN_SCENE_DURATION, round1(target * weight));
    const value = Math.min(raw, round1(remaining - MIN_SCENE_DURATION * (count - index - 1)));
    remaining = round1(remaining - value);
    return round1(Math.max(MIN_SCENE_DURATION, value));
  });
}

export function withTargetDuration(scenes: Scene[], target: number): Scene[] {
  const durations = redistributeDurations(scenes, target);
  return normalizeSceneOrder(scenes.map((scene, index) => ({ ...scene, durationSec: durations[index] ?? scene.durationSec })));
}

export function syncBriefDuration(video: VideoProject): VideoProject {
  return {
    ...video,
    brief: { ...video.brief, durationSec: totalDuration(video.scenes) },
  };
}

export function estimatedSceneCount(featureCount: number, mode: VideoProject['mode']): number {
  if (featureCount <= 0) return 2;
  if (mode === 'tutorial') return 1 + Math.min(3, Math.max(2, featureCount + 1)) + 1;
  return 2 + featureCount;
}

export interface ProductionReadiness {
  ok: boolean;
  reason?: string;
}

export function validateVideoForProduction(video: VideoProject): ProductionReadiness {
  const scenes = orderedScenes(video.scenes);
  if (video.brief.featureIds.length === 0) {
    return { ok: false, reason: '至少保留一个功能卖点才能开始生产。' };
  }
  if (scenes.length < 2) {
    return { ok: false, reason: '至少需要 2 个分镜才能生成视频。' };
  }
  if (totalDuration(scenes) < MIN_VIDEO_DURATION) {
    return { ok: false, reason: '视频总时长至少需要 10 秒。' };
  }
  if (scenes.every((scene) => scene.narration.trim().length === 0)) {
    return { ok: false, reason: '至少一个分镜需要有旁白文本。' };
  }
  return { ok: true };
}
