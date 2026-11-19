import { Composition } from 'remotion';
import { COMPOSITION_ID } from '@asvs/domain';
import { calculateStoryboardMetadata } from './metadata';
import { StoryboardComposition } from './storyboard-composition';
import type { StoryboardProps } from './types';

const defaultProps: StoryboardProps = {};

export function RemotionRoot() {
  return (
    <Composition
      id={COMPOSITION_ID}
      component={StoryboardComposition}
      defaultProps={defaultProps}
      calculateMetadata={calculateStoryboardMetadata}
    />
  );
}
