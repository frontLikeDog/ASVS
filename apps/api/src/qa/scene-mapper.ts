import type { RenderInputV1 } from '@asvs/domain';

/**
 * Frozen storyboard ↔ film time mapping (docs/16 §5.5).
 *
 * QA findings must point at a *scene*, not just a millisecond. The frozen
 * `input.json` is the only authority for that mapping: the editor may have
 * changed `durationSec` since, and `synthesize_voice` may have extended scenes
 * to fit narration — those extensions are already baked into the frozen
 * `durationFrames`, which is exactly what the renderer used.
 */

export interface SceneTimelineWindow {
  sceneId: string;
  sceneOrder: number;
  sceneTitle: string;
  visualType: string;
  assetId?: string;
  startMs: number;
  endMs: number;
  startFrame: number;
  endFrame: number;
}

export interface FrozenInputFile {
  schemaVersion?: string;
  input: RenderInputV1;
  digest?: string;
  storyboardFrames?: number;
  durationMs?: number;
  frozenAt?: string;
  narrationAppliedAt?: string;
  capture?: {
    planId: string;
    planDigest: string;
    assetId: string;
    clipSha256: string;
    clipDurationMs: number;
    assertions?: { total: number; passed: number };
  };
}

export function buildSceneWindows(frozen: { input: RenderInputV1 }): SceneTimelineWindow[] {
  const { storyboard } = frozen.input;
  const fps = storyboard.fps;
  const scenes = [...storyboard.scenes].sort((left, right) => left.order - right.order);
  const windows: SceneTimelineWindow[] = [];
  let frameCursor = 0;
  for (const [index, scene] of scenes.entries()) {
    const startFrame = frameCursor;
    const endFrame = frameCursor + scene.durationFrames;
    frameCursor = endFrame;
    const visual = scene.visual as { type?: string; assetId?: string };
    // Same resolution as the renderer's `findRealCaptureAsset`: `assetIds`
    // first, the IR's `assetId` only as a fallback. A real_demo scene that was
    // persisted without the IR carries a bare `{type:'real_demo'}` visual, and
    // reading only the IR would leave every window asset-less — which breaks
    // `mapCaptureAssetToScenes` and the per-asset evidence grouping.
    const assetId = scene.assetIds[0] ?? visual.assetId;
    windows.push({
      sceneId: scene.id,
      sceneOrder: index,
      sceneTitle: scene.title || `第 ${index + 1} 镜`,
      visualType: visual.type ?? 'unknown',
      ...(assetId ? { assetId } : {}),
      startMs: Math.round((startFrame / fps) * 1000),
      endMs: Math.round((endFrame / fps) * 1000),
      startFrame,
      endFrame,
    });
  }
  return windows;
}

/** `startMs <= timestampMs < endMs`; the last frame clamps to the final scene. */
export function mapTimestampToScene(
  windows: SceneTimelineWindow[],
  timestampMs: number,
): SceneTimelineWindow | undefined {
  if (windows.length === 0) return undefined;
  const found = windows.find(
    (window) => timestampMs >= window.startMs && timestampMs < window.endMs,
  );
  if (found) return found;
  return windows[windows.length - 1];
}

/** Every `real_demo` scene that references a capture asset id. */
export function mapCaptureAssetToScenes(
  windows: SceneTimelineWindow[],
  assetId: string,
): SceneTimelineWindow[] {
  return windows.filter((window) => window.assetId === assetId);
}

/** Time ranges of `real_demo` scenes only — the sole input to freezedetect. */
export function realDemoRanges(windows: SceneTimelineWindow[]): Array<{ startMs: number; endMs: number }> {
  return windows
    .filter((window) => window.visualType === 'real_demo')
    .map((window) => ({ startMs: window.startMs, endMs: window.endMs }));
}

export function formatTimestamp(ms: number): string {
  const totalSeconds = Math.floor(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  const millis = Math.round(ms % 1000);
  return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}.${String(millis).padStart(3, '0')}`;
}
