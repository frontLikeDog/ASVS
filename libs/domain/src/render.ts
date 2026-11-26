import { z } from 'zod';
import {
  ASSET_MEDIA_MIME_TYPES,
  DEFAULT_VIDEO_FPS,
  assetSchema,
  featureSchema,
  idSchema,
  isoDateSchema,
  projectSchema,
  sceneLookSchema,
  sceneVisualSchema,
  videoProjectSchema,
  type Asset,
  type Feature,
  type Project,
  type Scene,
  type SceneVisual,
  type VideoProject,
} from './schemas';
import { orderedScenes } from './timeline';

/** Version of the frozen render IR. Bump only with a migration. */
export const RENDER_SCHEMA_VERSION = '1' as const;
export const COMPOSITION_ID = 'Storyboard';

export const renderProfileSchema = z.object({
  width: z.number().int().min(320).max(4096).default(1920),
  height: z.number().int().min(180).max(4096).default(1080),
  codec: z.literal('h264').default('h264'),
  crf: z.number().int().min(0).max(51).default(18),
});
export type RenderProfile = z.infer<typeof renderProfileSchema>;
export const DEFAULT_RENDER_PROFILE: RenderProfile = renderProfileSchema.parse({});

const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/, '需要 64 位小写十六进制 SHA256');

/**
 * A real file backing an `Asset.media` entry. The fixture keeps the source
 * outside the render bundle (dist is disposable); the render worker hashes it,
 * copies it into a temporary public dir and serves it through `staticFile`.
 */
export const renderMediaAssetV1Schema = z.object({
  assetId: idSchema,
  /** Workspace-relative path to the immutable capture artifact. */
  sourceFile: z.string().min(1),
  sha256: sha256Schema,
  mimeType: z.enum(ASSET_MEDIA_MIME_TYPES),
  width: z.number().int().positive(),
  height: z.number().int().positive(),
  durationMs: z.number().int().positive(),
});
export type RenderMediaAssetV1 = z.infer<typeof renderMediaAssetV1Schema>;

/**
 * A scene as the renderer sees it. This is docs/05 `VideoSceneV1` plus the
 * presentation fields the editor already stores (title/caption/look/...).
 * Everything here is frozen: later edits create a new revision.
 */
export const storyboardSceneV1Schema = z.object({
  id: idSchema,
  revision: z.number().int().min(1),
  order: z.number().int().min(0),
  durationFrames: z.number().int().min(1),
  intent: z.string(),
  narration: z.string(),
  onScreenText: z.array(z.string()),
  claimIds: z.array(idSchema),
  assetIds: z.array(idSchema),
  featureId: idSchema.optional(),
  visual: sceneVisualSchema,
  title: z.string(),
  caption: z.string(),
  templateId: idSchema,
  look: sceneLookSchema,
  brightness: z.number().min(0.6).max(1.4),
  vignette: z.boolean(),
});
export type StoryboardSceneV1 = z.infer<typeof storyboardSceneV1Schema>;

export const storyboardV1Schema = z.object({
  schemaVersion: z.literal('1'),
  videoProjectId: idSchema,
  briefRevisionId: idSchema,
  knowledgeSnapshotId: idSchema,
  fps: z.number().int().min(1).max(60),
  scenes: z.array(storyboardSceneV1Schema),
});
export type StoryboardV1 = z.infer<typeof storyboardV1Schema>;

export const renderInputV1Schema = z.object({
  schemaVersion: z.literal('1'),
  storyboard: storyboardV1Schema,
  project: projectSchema,
  features: z.array(featureSchema),
  assets: z.array(assetSchema),
  renderProfile: renderProfileSchema,
});
export type RenderInputV1 = z.infer<typeof renderInputV1Schema>;

/** Fixed input for the golden render fixture (S1-7). */
export const renderFixtureV1Schema = z.object({
  schemaVersion: z.literal('1'),
  kind: z.literal('asvs.render-fixture'),
  note: z.string().optional(),
  generatedFrom: z.string().optional(),
  video: videoProjectSchema,
  project: projectSchema,
  features: z.array(featureSchema),
  assets: z.array(assetSchema),
  /** Real files referenced by `Asset.media`; empty for the Step 1 fixture. */
  media: z.array(renderMediaAssetV1Schema).default([]),
});
export type RenderFixtureV1 = z.infer<typeof renderFixtureV1Schema>;

/** docs/05 §4 `ArtifactReceiptV1` with the fields docs/03/07 require. */
export const artifactReceiptV1Schema = z.object({
  schemaVersion: z.literal('1'),
  jobId: idSchema,
  artifactId: idSchema,
  sha256: sha256Schema,
  mimeType: z.literal('video/mp4'),
  byteSize: z.number().int().positive(),
  storageRef: z.string().min(1),
  durationMs: z.number().int().nonnegative(),
  width: z.number().int().positive(),
  height: z.number().int().positive(),
  fps: z.number().positive(),
  rendererVersion: z.string().min(1),
  compositionId: idSchema,
  createdAt: isoDateSchema,
});
export type ArtifactReceiptV1 = z.infer<typeof artifactReceiptV1Schema>;

export const sceneDigestSchema = z.object({
  sceneId: idSchema,
  revision: z.number().int().min(1),
  sha256: sha256Schema,
});
export const assetHashSchema = z.object({
  assetId: idSchema,
  /** Digest of the Asset JSON (as in Step 1). */
  sha256: sha256Schema,
  mock: z.boolean(),
  /** File-level hash for real captures, plus the path used to re-verify it. */
  mediaSha256: sha256Schema.optional(),
  mediaSourceFile: z.string().min(1).optional(),
  mediaMimeType: z.enum(ASSET_MEDIA_MIME_TYPES).optional(),
});

/** Manifest fields from docs/07 §4: compositionId, sceneDigests, assetHashes, rendererVersion. */
export const renderManifestV1Schema = z.object({
  schemaVersion: z.literal('1'),
  jobId: idSchema,
  artifactId: idSchema,
  compositionId: idSchema,
  rendererVersion: z.string().min(1),
  renderInputDigest: sha256Schema,
  storyboardDigest: sha256Schema,
  sceneDigests: z.array(sceneDigestSchema),
  assetHashes: z.array(assetHashSchema),
  renderProfile: renderProfileSchema,
  output: z.object({
    fileName: z.string().min(1),
    mimeType: z.literal('video/mp4'),
    byteSize: z.number().int().positive(),
    sha256: sha256Schema,
  }),
  ffprobe: z.object({
    codecName: z.string(),
    durationMs: z.number().int().nonnegative(),
    width: z.number().int().positive(),
    height: z.number().int().positive(),
    fps: z.number().positive(),
    frameCount: z.number().int().nonnegative().optional(),
  }),
  createdAt: isoDateSchema,
});
export type RenderManifestV1 = z.infer<typeof renderManifestV1Schema>;

/**
 * Maps a legacy flat `visualType` scene onto the discriminated render IR.
 * Used by the v1→v2 persistence migration and by `buildStoryboardV1` for
 * scenes created before the IR existed.
 */
export function deriveSceneVisual(
  scene: Pick<Scene, 'visualType' | 'templateId' | 'assetId'>,
): SceneVisual {
  switch (scene.visualType) {
    case 'title':
      return { type: 'title' };
    case 'cta':
      return { type: 'cta' };
    case 'real_demo':
      return scene.assetId
        ? { type: 'real_demo', assetId: scene.assetId }
        : { type: 'real_demo' };
    case 'motion':
      return { type: 'motion_graphics', templateId: scene.templateId, props: {} };
    case 'generated':
      return scene.assetId
        ? { type: 'generated_visual', assetId: scene.assetId }
        : { type: 'generated_visual' };
  }
}

/**
 * Frames are derived from `durationSec` at freeze time. The stored
 * `Scene.durationFrames` cache is intentionally not trusted: the editor still
 * edits seconds, so a stale cache would silently change the output timeline.
 */
export function sceneDurationFrames(scene: Pick<Scene, 'durationSec'>, fps: number): number {
  return Math.max(1, Math.round(scene.durationSec * fps));
}

export interface StoryboardBuildOptions {
  fps?: number;
  knowledgeSnapshotId?: string;
}

export function buildStoryboardV1(
  video: VideoProject,
  options: StoryboardBuildOptions = {},
): StoryboardV1 {
  const fps = options.fps ?? video.fps ?? DEFAULT_VIDEO_FPS;
  const scenes = orderedScenes(video.scenes).map((scene, index) => {
    const caption = (scene.caption || scene.narration || scene.title).trim();
    const onScreenText = Array.from(
      new Set([scene.title, caption].map((text) => text.trim()).filter(Boolean)),
    );
    return {
      id: scene.id,
      revision: scene.revision,
      order: index,
      durationFrames: sceneDurationFrames(scene, fps),
      intent: scene.intent,
      narration: scene.narration,
      onScreenText,
      claimIds: scene.claimIds,
      assetIds: scene.assetId ? [scene.assetId] : [],
      featureId: scene.featureId,
      visual: scene.visual ?? deriveSceneVisual(scene),
      title: scene.title,
      caption,
      templateId: scene.templateId,
      look: scene.look,
      brightness: scene.brightness,
      vignette: scene.vignette,
    };
  });

  return storyboardV1Schema.parse({
    schemaVersion: RENDER_SCHEMA_VERSION,
    videoProjectId: video.id,
    briefRevisionId: `${video.id}_brief_v${video.scriptVersion}`,
    knowledgeSnapshotId: options.knowledgeSnapshotId ?? 'ksnap_local_seed',
    fps,
    scenes,
  });
}

export interface RenderInputSource {
  video: VideoProject;
  project: Project;
  features: Feature[];
  assets: Asset[];
  renderProfile?: Partial<RenderProfile>;
  knowledgeSnapshotId?: string;
}

/**
 * Builds the complete, validated input for the Remotion composition. Only
 * 16:9 is supported in Step 1: portrait is a separate layout, not a crop.
 */
export function buildRenderInput(source: RenderInputSource): RenderInputV1 {
  if (source.video.brief.aspect !== '16:9') {
    throw new Error(
      `Step 1 只支持 16:9 渲染，收到 ${source.video.brief.aspect}。竖屏/方屏需要独立布局，不做裁切。`,
    );
  }
  const renderProfile = renderProfileSchema.parse(source.renderProfile ?? {});
  const storyboard = buildStoryboardV1(source.video, {
    knowledgeSnapshotId: source.knowledgeSnapshotId,
  });
  const referenced = new Set(storyboard.scenes.flatMap((scene) => scene.assetIds));
  const assets = source.assets.filter((asset) => referenced.has(asset.id));

  return renderInputV1Schema.parse({
    schemaVersion: RENDER_SCHEMA_VERSION,
    storyboard,
    project: source.project,
    features: source.features,
    assets,
    renderProfile,
  });
}

/**
 * A real capture is only real when the asset says so AND carries the media
 * metadata. The placeholder must stay in place for `mock: true` or media-less
 * assets, even if a `src` string was persisted by mistake.
 */
export type RealCaptureAsset = Asset & {
  media: NonNullable<Asset['media']>;
  mock: false;
};

export function isRealCaptureAsset(asset: Asset | undefined): asset is RealCaptureAsset {
  return Boolean(asset && asset.mock === false && asset.media);
}

export function findRealCaptureAsset(
  scene: Pick<StoryboardSceneV1, 'assetIds'>,
  assets: Asset[],
): RealCaptureAsset | undefined {
  return scene.assetIds
    .map((assetId) => assets.find((asset) => asset.id === assetId))
    .find((asset): asset is RealCaptureAsset => isRealCaptureAsset(asset));
}

export function totalStoryboardFrames(storyboard: StoryboardV1): number {
  return storyboard.scenes.reduce((sum, scene) => sum + scene.durationFrames, 0);
}

export function storyboardDurationMs(storyboard: StoryboardV1): number {
  return Math.round((totalStoryboardFrames(storyboard) / storyboard.fps) * 1000);
}

function normalizeForStableJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(normalizeForStableJson);
  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, entry]) => entry !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return Object.fromEntries(entries.map(([key, entry]) => [key, normalizeForStableJson(entry)]));
  }
  return value;
}

/** Deterministic JSON used for input/scene digests. */
export function stableStringify(value: unknown): string {
  return JSON.stringify(normalizeForStableJson(value));
}
