import { describe, expect, it } from 'vitest';
import type { VideoProbe } from './media';
import {
  buildAsset,
  buildCaptureRenderFixture,
  type CaptureFixtureInput,
} from './render-fixture';

function clip(durationMs: number): VideoProbe {
  return {
    codecName: 'h264',
    width: 1920,
    height: 1080,
    fps: 30,
    durationMs,
    frameCount: Math.round((durationMs / 1000) * 30),
  };
}

function makeFixture(durationMs: number) {
  const input: CaptureFixtureInput = {
    planId: 'plan_test',
    planDigest: 'a'.repeat(64),
    assetId: 'asset_test',
    assetName: '测试录屏',
    assetDescription: '测试用真实录屏',
    assetPalette: ['#000000', '#FFFFFF'],
    clip: clip(durationMs),
    clipSha256: 'b'.repeat(64),
    clipFile: 'dist/browser-worker/test/clip.mp4',
    receiptFile: 'dist/browser-worker/test/capture-receipt.json',
    createdAt: '2026-11-26T12:00:00.000Z',
  };
  const asset = buildAsset(input);
  return buildCaptureRenderFixture({ ...input, asset, mediaSha256: input.clipSha256 });
}

describe('captured render fixture timing', () => {
  it('把约 18 秒的巡览完整放进 real_demo，成片仍为 30 秒', () => {
    const fixture = makeFixture(17_967);
    const scenes = fixture.video.scenes;
    expect(scenes.map((scene) => scene.durationSec)).toEqual([3, 18, 4, 3, 2]);
    expect(scenes.map((scene) => scene.durationFrames)).toEqual([90, 540, 120, 90, 60]);
    expect(scenes.reduce((sum, scene) => sum + scene.durationSec, 0)).toBe(30);
  });

  it('拒绝超过 real_demo 时长分配的片段（否则巡览尾部会被截断）', () => {
    expect(() => makeFixture(18_034)).toThrow(/超过 real_demo/);
  });
});
