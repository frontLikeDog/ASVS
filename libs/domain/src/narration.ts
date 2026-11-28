import { z } from 'zod';
import { idSchema, languageSchema } from './schemas';
import { storyboardV1Schema, type StoryboardV1 } from './render';

/**
 * Step 5B narration contracts (docs/07 §7).
 *
 * Pure data only: the renderer must stay deterministic, so every clip points
 * at a file the API has already produced and hashed. `src` is a Remotion
 * public-relative path (`audio/<sceneId>.wav`), never a URL.
 */
export const SPEECH_LANGUAGES = ['zh-CN', 'en-US'] as const;
export const speechLanguageSchema = z.enum(SPEECH_LANGUAGES);
export type SpeechLanguage = z.infer<typeof speechLanguageSchema>;

export const MIN_SPEECH_SPEED = 0.75;
export const MAX_SPEECH_SPEED = 1.35;

export const speechVoiceProfileSchema = z.object({
  provider: z.string().min(1),
  model: z.string().min(1),
  voiceId: z.string().min(1),
  language: languageSchema,
  speed: z.number().min(MIN_SPEECH_SPEED).max(MAX_SPEECH_SPEED).default(1),
  /** Commercial/usage licence of the voice. Required, never inferred. */
  license: z.string().min(1),
  /** True for offline test synthesis; the UI and manifest must say so. */
  synthetic: z.boolean(),
});
export type SpeechVoiceProfile = z.infer<typeof speechVoiceProfileSchema>;

export const narrationTimingPolicies = ['extend_scene', 'fail_on_overflow'] as const;
export const narrationTimingPolicySchema = z.enum(narrationTimingPolicies);
export type NarrationTimingPolicy = z.infer<typeof narrationTimingPolicySchema>;
export const DEFAULT_NARRATION_TIMING_POLICY: NarrationTimingPolicy = 'extend_scene';

const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/, '需要 64 位小写十六进制 SHA256');

export const DEFAULT_NARRATION_START_OFFSET_MS = 150;
export const DEFAULT_NARRATION_TAIL_PAD_MS = 200;

/**
 * One synthesized narration file bound to a frozen scene revision.
 * `cacheKey` is the content hash of (provider, model, voice, language, speed,
 * text); a re-run with identical inputs never calls the provider again.
 */
export const narrationClipV1Schema = z.object({
  sceneId: idSchema,
  sceneRevision: z.number().int().min(1),
  text: z.string().min(1),
  cacheKey: sha256Schema,
  /** Remotion public-relative path, e.g. `audio/scene_1.wav`. */
  src: z.string().min(1),
  mimeType: z.literal('audio/wav'),
  sha256: sha256Schema,
  byteSize: z.number().int().positive(),
  durationMs: z.number().int().positive(),
  sampleRate: z.number().int().positive(),
  channels: z.number().int().min(1).max(2),
  /** Leading silence inside the scene so speech never clips the cut. */
  startOffsetMs: z.number().int().min(0).default(DEFAULT_NARRATION_START_OFFSET_MS),
  provider: z.string().min(1),
  voiceId: z.string().min(1),
  language: languageSchema,
  license: z.string().min(1),
  synthetic: z.boolean(),
});
export type NarrationClipV1 = z.infer<typeof narrationClipV1Schema>;

export const narrationInputV1Schema = z.object({
  voice: speechVoiceProfileSchema,
  clips: z.array(narrationClipV1Schema),
  timingPolicy: narrationTimingPolicySchema.default(DEFAULT_NARRATION_TIMING_POLICY),
});
export type NarrationInputV1 = z.infer<typeof narrationInputV1Schema>;

export const subtitleCueV1Schema = z.object({
  index: z.number().int().min(1),
  sceneId: idSchema,
  startMs: z.number().int().min(0),
  endMs: z.number().int().min(0),
  text: z.string().min(1),
});
export type SubtitleCueV1 = z.infer<typeof subtitleCueV1Schema>;

// ── Timing reconciliation ───────────────────────────────────────────────────

export const narrationTimingAdjustmentSchema = z.object({
  sceneId: idSchema,
  originalDurationFrames: z.number().int().min(1),
  effectiveDurationFrames: z.number().int().min(1),
  audioDurationMs: z.number().int().min(1),
  overflowMs: z.number().int().min(0),
});
export type NarrationTimingAdjustment = z.infer<typeof narrationTimingAdjustmentSchema>;

/** Structured rejection for `fail_on_overflow`; never truncates speech. */
export class NarrationOverflowError extends Error {
  readonly code = 'narration_overflow';

  constructor(
    readonly sceneId: string,
    readonly overflowMs: number,
    readonly requiredFrames: number,
    readonly durationFrames: number,
  ) {
    super(
      `镜头 ${sceneId} 的旁白超出可用时长 ${overflowMs}ms（需要 ${requiredFrames} 帧，当前 ${durationFrames} 帧）。请缩短文案或提高语速。`,
    );
    this.name = 'NarrationOverflowError';
  }
}

export interface ReconcileNarrationOptions {
  policy?: NarrationTimingPolicy;
  /** Extra breathing room after speech, in milliseconds. */
  tailPadMs?: number;
}

export interface ReconcileNarrationResult {
  /** Frozen storyboard with scene durations extended where required. */
  storyboard: StoryboardV1;
  adjustments: NarrationTimingAdjustment[];
  /** Audio start offset inside each scene, in milliseconds. */
  clips: NarrationClipV1[];
}

export function narrationClipFrames(
  clip: Pick<NarrationClipV1, 'startOffsetMs' | 'durationMs'>,
  fps: number,
  tailPadMs: number = DEFAULT_NARRATION_TAIL_PAD_MS,
): number {
  return Math.ceil(((clip.startOffsetMs + clip.durationMs + tailPadMs) / 1000) * fps);
}

/**
 * Aligns scene durations with synthesized narration.
 *
 * - A scene without a clip keeps its frozen duration (pure visual beat).
 * - A clip that fits keeps the scene untouched.
 * - A clip that does not fit either extends the scene (`extend_scene`) or
 *   fails with `NarrationOverflowError` (`fail_on_overflow`). Speech is never
 *   cut, and the extra time is bounded by the tail pad.
 */
export function reconcileStoryboardWithNarration(
  storyboard: StoryboardV1,
  clips: NarrationClipV1[],
  options: ReconcileNarrationOptions = {},
): ReconcileNarrationResult {
  const policy = options.policy ?? DEFAULT_NARRATION_TIMING_POLICY;
  const tailPadMs = options.tailPadMs ?? DEFAULT_NARRATION_TAIL_PAD_MS;
  const sceneIds = new Set(storyboard.scenes.map((scene) => scene.id));
  const byScene = new Map<string, NarrationClipV1>();
  for (const clip of clips) {
    if (!sceneIds.has(clip.sceneId)) {
      throw new Error(`旁白片段引用了不存在的镜头：${clip.sceneId}`);
    }
    if (byScene.has(clip.sceneId)) {
      throw new Error(`镜头 ${clip.sceneId} 存在多个旁白片段`);
    }
    byScene.set(clip.sceneId, clip);
  }

  const adjustments: NarrationTimingAdjustment[] = [];
  const scenes = storyboard.scenes.map((scene) => {
    const clip = byScene.get(scene.id);
    if (!clip || clip.text.trim().length === 0) return scene;
    const requiredFrames = narrationClipFrames(clip, storyboard.fps, tailPadMs);
    if (requiredFrames <= scene.durationFrames) return scene;

    const overflowMs = Math.ceil(
      ((requiredFrames - scene.durationFrames) / storyboard.fps) * 1000,
    );
    if (policy === 'fail_on_overflow') {
      throw new NarrationOverflowError(
        scene.id,
        overflowMs,
        requiredFrames,
        scene.durationFrames,
      );
    }
    adjustments.push({
      sceneId: scene.id,
      originalDurationFrames: scene.durationFrames,
      effectiveDurationFrames: requiredFrames,
      audioDurationMs: clip.durationMs,
      overflowMs,
    });
    return { ...scene, durationFrames: requiredFrames };
  });

  return {
    storyboard: storyboardV1Schema.parse({ ...storyboard, scenes }),
    adjustments,
    clips,
  };
}

/** Frames of leading silence before speech starts inside a scene. */
export function narrationStartOffsetFrames(
  clip: Pick<NarrationClipV1, 'startOffsetMs'>,
  fps: number,
): number {
  return Math.max(0, Math.round((clip.startOffsetMs / 1000) * fps));
}
