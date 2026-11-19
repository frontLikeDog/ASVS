import { DEFAULT_RENDER_PROFILE } from '@asvs/domain';
import type { StoryboardProps } from './types';

/**
 * Pure metadata calculation shared by `Composition` and the worker's pre-render
 * check. Keeping it outside React makes the frame math unit-testable.
 */
export function calculateStoryboardMetadata({ props }: { props: StoryboardProps }) {
  const input = props.input;
  if (!input) {
    return {
      durationInFrames: 1,
      fps: 30,
      width: DEFAULT_RENDER_PROFILE.width,
      height: DEFAULT_RENDER_PROFILE.height,
    };
  }
  const durationInFrames = Math.max(
    1,
    input.storyboard.scenes.reduce((sum, scene) => sum + scene.durationFrames, 0),
  );
  return {
    durationInFrames,
    fps: input.storyboard.fps,
    width: input.renderProfile.width,
    height: input.renderProfile.height,
  };
}
