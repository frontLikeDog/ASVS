import { existsSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import type {
  ArtifactReceiptV1,
  RenderAudioAssetV1,
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
import { digestOf, sha256Buffer, sha256File } from './hash';
import type { ProbeResult } from './ffprobe';
import { workspaceRoot } from './paths';

export interface SubtitleBinding {
  file: string;
  /** Absolute timeline anchored to the frozen storyboard, for validation. */
  durationMs: number;
  cueCount: number;
}

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
  /** Narration WAV files copied into the public dir (5B). */
  audio?: RenderAudioAssetV1[];
  /** Mean volume measured with volumedetect; required with narration. */
  audioMeanVolumeDb?: number;
  /** Server-verified SRT bound to this render (5B). */
  subtitles?: SubtitleBinding;
  /** Scene duration adjustments applied when reconciling narration. */
  timingAdjustments?: Array<{
    sceneId: string;
    originalDurationFrames: number;
    effectiveDurationFrames: number;
    audioDurationMs: number;
    overflowMs: number;
  }>;
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
  audio = [],
  audioMeanVolumeDb,
  subtitles,
  timingAdjustments = [],
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

  const durationMs = storyboardDurationMs(input.storyboard);
  const receipt = artifactReceiptV1Schema.parse({
    schemaVersion: '1',
    jobId,
    artifactId,
    sha256,
    mimeType: 'video/mp4',
    byteSize,
    storageRef,
    durationMs,
    width: input.renderProfile.width,
    height: input.renderProfile.height,
    fps: input.storyboard.fps,
    rendererVersion,
    compositionId: COMPOSITION_ID,
    createdAt,
  });

  const narrationInput = input.narration;
  const fps = input.storyboard.fps;
  const sceneStarts = new Map<string, number>();
  let offsetFrames = 0;
  for (const scene of input.storyboard.scenes) {
    sceneStarts.set(scene.id, Math.round((offsetFrames / fps) * 1000));
    offsetFrames += scene.durationFrames;
  }
  const narration = narrationInput
    ? {
        provider: narrationInput.voice.provider,
        model: narrationInput.voice.model,
        voiceId: narrationInput.voice.voiceId,
        language: narrationInput.voice.language,
        license: narrationInput.voice.license,
        synthetic: narrationInput.voice.synthetic,
        timingPolicy: narrationInput.timingPolicy,
        adjustments: timingAdjustments,
        clips: narrationInput.clips.map((clip) => {
          const sceneStart = sceneStarts.get(clip.sceneId) ?? 0;
          const startMs = sceneStart + clip.startOffsetMs;
          return {
            sceneId: clip.sceneId,
            sha256: clip.sha256,
            durationMs: clip.durationMs,
            startMs,
            endMs: startMs + clip.durationMs,
          };
        }),
      }
    : undefined;

  let subtitlesRecord: RenderManifestV1['subtitles'];
  if (subtitles) {
    if (!existsSync(subtitles.file)) {
      throw new Error(`SRT 文件不存在：${subtitles.file}`);
    }
    const bytes = readFileSync(subtitles.file);
    subtitlesRecord = {
      fileName: path.basename(subtitles.file),
      mimeType: 'application/x-subrip',
      byteSize: bytes.byteLength,
      sha256: sha256Buffer(bytes),
      cueCount: subtitles.cueCount,
      durationMs: subtitles.durationMs,
    };
  }

  const audioProbe = probe.audio;
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
      ...(audioProbe
        ? {
            audio: {
              codecName: audioProbe.codecName,
              sampleRate: audioProbe.sampleRate,
              channels: audioProbe.channels,
              durationMs: audioProbe.durationMs,
              ...(audioMeanVolumeDb !== undefined ? { meanVolumeDb: audioMeanVolumeDb } : {}),
            },
          }
        : {}),
    },
    ...(narration ? { narration } : {}),
    ...(subtitlesRecord ? { subtitles: subtitlesRecord } : {}),
    createdAt,
  });

  return { receipt, manifest };
}

export function storageRefFor(file: string): string {
  return path.relative(workspaceRoot, file).split(path.sep).join('/');
}

/** True when the job carries narration and therefore must render an AAC track. */
export function jobExpectsAudio(input: RenderInputV1, audio: RenderAudioAssetV1[]): boolean {
  return (input.narration?.clips.length ?? 0) > 0 || audio.length > 0;
}
