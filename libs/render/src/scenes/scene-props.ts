import type { Feature, RenderInputV1, StoryboardSceneV1 } from '@asvs/domain';
import type { Unit } from '../chrome';
import type { SceneTheme } from '../theme';

export interface SceneProps {
  scene: StoryboardSceneV1;
  input: RenderInputV1;
  index: number;
  total: number;
  theme: SceneTheme;
  u: Unit;
}

export function featureForScene(
  input: RenderInputV1,
  scene: StoryboardSceneV1,
): Feature | undefined {
  return scene.featureId
    ? input.features.find((feature) => feature.id === scene.featureId)
    : undefined;
}
