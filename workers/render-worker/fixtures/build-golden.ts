import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  LUMEN_ASSETS,
  LUMEN_FEATURES,
  LUMEN_PROJECT,
  LUMEN_VIDEOS,
} from '@asvs/mock-data';
import {
  deriveSceneVisual,
  renderFixtureV1Schema,
  videoProjectSchema,
  type VideoProject,
} from '@asvs/domain';

/**
 * Builds the fixed 30-second golden input from the Lumen release video.
 * Durations are pinned here so the fixture never drifts when seed copy changes.
 * Re-run with `pnpm nx run render-worker:build-fixture` and commit the JSON.
 */
const FPS = 30;
const SCENE_DURATIONS_SEC = [5, 6.5, 6, 5, 5, 2.5];

const source = LUMEN_VIDEOS.find((video) => video.id === 'vid_lumen_release');
if (!source) throw new Error('种子数据中缺少 vid_lumen_release');
if (source.scenes.length !== SCENE_DURATIONS_SEC.length) {
  throw new Error(
    `黄金样片需要 ${SCENE_DURATIONS_SEC.length} 个分镜，种子里有 ${source.scenes.length} 个`,
  );
}

const video: VideoProject = videoProjectSchema.parse({
  ...source,
  fps: FPS,
  brief: {
    ...source.brief,
    durationSec: SCENE_DURATIONS_SEC.reduce((sum, value) => sum + value, 0),
  },
  scenes: source.scenes.map((scene, index) => {
    const durationSec = SCENE_DURATIONS_SEC[index]!;
    return {
      ...scene,
      revision: 1,
      durationSec,
      durationFrames: Math.round(durationSec * FPS),
      visual: scene.visual ?? deriveSceneVisual(scene),
    };
  }),
});

const fixture = renderFixtureV1Schema.parse({
  schemaVersion: '1',
  kind: 'asvs.render-fixture',
  note: '固定 30 秒黄金输入。分镜时长在 build-golden.ts 中钉死，避免种子文案变化影响基线。',
  generatedFrom: 'libs/mock-data/src/lumen.ts · vid_lumen_release',
  video,
  project: LUMEN_PROJECT,
  features: LUMEN_FEATURES,
  assets: LUMEN_ASSETS,
});

const outputFile = path.join(path.dirname(fileURLToPath(import.meta.url)), 'golden-30s.json');
writeFileSync(outputFile, `${JSON.stringify(fixture, null, 2)}\n`, 'utf8');

const totalFrames = video.scenes.reduce((sum, scene) => sum + (scene.durationFrames ?? 0), 0);
console.log(`已写入 ${path.relative(process.cwd(), outputFile)}`);
console.log(
  `分镜 ${video.scenes.length} 个 · ${totalFrames} 帧 · ${totalFrames / FPS}s · ${FPS}fps`,
);
