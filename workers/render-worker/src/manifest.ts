import { statSync } from 'node:fs';
import path from 'node:path';
import type {
  ArtifactReceiptV1,
  RenderInputV1,
  RenderManifestV1,
  RenderMediaAssetV1,
} from '@asvs/domain';
import {
  COMPOSITION_ID,
  artifactReceiptV1Schema,
  renderManifestV1Schema,
  storyboardDurationMs,
} from '@asvs/domain';
import { digestOf, sha256File } from './hash';
import type { ProbeResult } from './ffprobe';
import { workspaceRoot } from './paths';

export interface ArtifactInput {
  jobId: string;
  artifactId: string;
  input: RenderInputV1;
  file: string;
  storageRef: string;
  probe: ProbeResult;
  rendererVersion: string;
  createdAt: string;
  /** Real capture files actually copied into the render public dir. */
  media?: RenderMediaAssetV1[];
}

export interface ArtifactRecords {
  receipt: ArtifactReceiptV1;
  manifest: RenderManifestV1;
}

export function buildArtifactRecords({
  jobId,
  artifactId,
  input,
  file,
  storageRef,
  probe,
  rendererVersion,
  createdAt,
  media = [],
}: ArtifactInput): ArtifactRecords {
  const sha256 = sha256File(file);
  const byteSize = statSync(file).size;
  const fileName = path.basename(file);
  const storyboardDigest = digestOf(input.storyboard);
  const renderInputDigest = digestOf({
    compositionId: COMPOSITION_ID,
    rendererVersion,
    input,
  });

  const sceneDigests = input.storyboard.scenes.map((scene) => ({
    sceneId: scene.id,
    revision: scene.revision,
    sha256: digestOf(scene),
  }));
  const mediaById = new Map(media.map((entry) => [entry.assetId, entry]));
  const assetHashes = input.assets.map((asset) => {
    const entry = mediaById.get(asset.id);
    return {
      assetId: asset.id,
      sha256: digestOf(asset),
      mock: asset.mock,
      ...(entry
        ? {
            mediaSha256: entry.sha256,
            mediaSourceFile: entry.sourceFile,
            mediaMimeType: entry.mimeType,
          }
        : {}),
    };
  });

  const receipt = artifactReceiptV1Schema.parse({
    schemaVersion: '1',
    jobId,
    artifactId,
    sha256,
    mimeType: 'video/mp4',
    byteSize,
    storageRef,
    durationMs: storyboardDurationMs(input.storyboard),
    width: input.renderProfile.width,
    height: input.renderProfile.height,
    fps: input.storyboard.fps,
    rendererVersion,
    compositionId: COMPOSITION_ID,
    createdAt,
  });

  const manifest = renderManifestV1Schema.parse({
    schemaVersion: '1',
    jobId,
    artifactId,
    compositionId: COMPOSITION_ID,
    rendererVersion,
    renderInputDigest,
    storyboardDigest,
    sceneDigests,
    assetHashes,
    renderProfile: input.renderProfile,
    output: {
      fileName,
      mimeType: 'video/mp4',
      byteSize,
      sha256,
    },
    ffprobe: {
      codecName: probe.codecName,
      durationMs: probe.durationMs,
      width: probe.width,
      height: probe.height,
      fps: probe.fps,
      frameCount: probe.frameCount,
    },
    createdAt,
  });

  return { receipt, manifest };
}

export function storageRefFor(file: string): string {
  return path.relative(workspaceRoot, file).split(path.sep).join('/');
}
