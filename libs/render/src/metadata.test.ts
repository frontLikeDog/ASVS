import { describe, expect, it } from 'vitest';
import type { RenderInputV1, StoryboardSceneV1 } from '@asvs/domain';
import { calculateStoryboardMetadata } from './metadata';

function scene(id: string, durationFrames: number): StoryboardSceneV1 {
  return {
    id,
    revision: 1,
    order: 0,
    durationFrames,
    intent: '',
    narration: '',
    onScreenText: [],
    claimIds: [],
    assetIds: [],
    visual: { type: 'title' },
    title: id,
    caption: '',
    templateId: 'tpl_signal',
    look: 'clean',
    brightness: 1,
    vignette: false,
  };
}

function input(durationFrames: number[], fps = 30): RenderInputV1 {
  return {
    schemaVersion: '1',
    storyboard: {
      schemaVersion: '1',
      videoProjectId: 'vid_test',
      briefRevisionId: 'vid_test_brief_v1',
      knowledgeSnapshotId: 'ksnap_test',
      fps,
      scenes: durationFrames.map((frames, index) => ({
        ...scene(`s${index}`, frames),
        order: index,
      })),
    },
    renderProfile: { width: 1280, height: 720, codec: 'h264', crf: 18 },
  } as RenderInputV1;
}

describe('calculateStoryboardMetadata', () => {
  it('没有输入时退化为 1 帧，保证 Studio 能打开 composition', () => {
    expect(calculateStoryboardMetadata({ props: {} })).toEqual({
      durationInFrames: 1,
      fps: 30,
      width: 1920,
      height: 1080,
    });
  });

  it('总帧数等于所有分镜帧数之和，并采用 storyboard 的 fps/尺寸', () => {
    expect(calculateStoryboardMetadata({ props: { input: input([150, 195, 180], 24) } })).toEqual({
      durationInFrames: 525,
      fps: 24,
      width: 1280,
      height: 720,
    });
  });

  it('空分镜不会产生 0 帧 composition', () => {
    expect(calculateStoryboardMetadata({ props: { input: input([]) } }).durationInFrames).toBe(1);
  });
});
