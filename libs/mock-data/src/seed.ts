import type { StudioSnapshot } from '@asvs/domain';
import { studioSnapshotSchema } from '@asvs/domain';
import { LUMEN_ASSETS, PULSE_ASSETS } from './assets';
import {
  LUMEN_ACTIVITY,
  LUMEN_CLAIMS,
  LUMEN_EVIDENCE,
  LUMEN_FEATURES,
  LUMEN_PROJECT,
  LUMEN_PULL_REQUESTS,
  LUMEN_RELEASES,
  LUMEN_RUNS,
  LUMEN_SUGGESTIONS,
  LUMEN_VIDEOS,
} from './lumen';
import { PULSE_ACTIVITY, PULSE_CLAIMS, PULSE_EVIDENCE, PULSE_FEATURES, PULSE_PROJECT } from './pulse';
import { VIDEO_TEMPLATES } from './templates';

export const SEED_VERSION = 1;

/**
 * The only place the demo workspace is assembled. The snapshot is validated by
 * the same Zod schema used for persisted state, so a broken fixture fails fast.
 */
export function createSeedSnapshot(): StudioSnapshot {
  const snapshot = {
    projects: [LUMEN_PROJECT, PULSE_PROJECT],
    features: [...LUMEN_FEATURES, ...PULSE_FEATURES],
    claims: [...LUMEN_CLAIMS, ...PULSE_CLAIMS],
    evidence: [...LUMEN_EVIDENCE, ...PULSE_EVIDENCE],
    pullRequests: LUMEN_PULL_REQUESTS,
    releases: LUMEN_RELEASES,
    suggestions: LUMEN_SUGGESTIONS,
    assets: [...LUMEN_ASSETS, ...PULSE_ASSETS],
    templates: VIDEO_TEMPLATES,
    videos: LUMEN_VIDEOS,
    runs: LUMEN_RUNS,
    exports: [],
    activity: [...LUMEN_ACTIVITY, ...PULSE_ACTIVITY].sort(
      (a, b) => new Date(b.at).getTime() - new Date(a.at).getTime(),
    ),
  };

  return studioSnapshotSchema.parse(snapshot);
}

export function createEmptyActivity(): StudioSnapshot['activity'] {
  return [];
}
