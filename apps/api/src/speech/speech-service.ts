import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import {
  DEFAULT_NARRATION_START_OFFSET_MS,
  narrationClipV1Schema,
  stableJson,
  type NarrationClipV1,
  type RenderAudioAssetV1,
  type SpeechLanguage,
} from '@asvs/domain';
import {
  SpeechProviderError,
  type SpeechHealth,
  type SpeechPort,
  type SpeechSynthesisRequest,
} from '@asvs/ports';
import type { SpeechCacheStore } from './speech-cache-store';
import {
  normalizeAudioToWav,
  probeNormalizedAudio,
  NORMALIZED_CHANNELS,
  NORMALIZED_SAMPLE_RATE,
} from './normalize-audio';

/**
 * Narration synthesis with a content-addressed cache (docs/06 §5, AC-10).
 *
 * The cache key is `sha256(stableJson({provider, model, voiceId, language,
 * speed, text.trim()}))`, so a re-run of the same script hits the cache and
 * makes **zero** provider calls (no re-billing). A hit re-reads the WAV from
 * disk and re-verifies its SHA256; a damaged or missing file is evicted and
 * re-synthesized rather than trusted.
 */

export interface SpeechServiceOptions {
  port: SpeechPort;
  cache: SpeechCacheStore;
  /** Directory that holds `<cacheKey>.wav`; `data/artifacts/tts` by default. */
  audioRoot: string;
  /** Temp dir for raw provider bytes; defaults under `audioRoot/.tmp`. */
  tempRoot?: string;
}

export interface SynthesizeNarrationInput {
  sceneId: string;
  sceneRevision: number;
  text: string;
  language: SpeechLanguage;
  voiceId: string;
  speed: number;
  startOffsetMs?: number;
}

export interface NarrationSynthesisReport {
  clips: NarrationClipV1[];
  audio: RenderAudioAssetV1[];
  cacheHits: number;
  providerCalls: number;
  synthetic: boolean;
  provider: string;
  model: string;
  voiceId: string;
  language: SpeechLanguage;
  license: string;
}

export class SpeechServiceError extends Error {
  constructor(
    readonly code: 'tts_not_configured' | 'tts_failed',
    message: string,
    readonly retryable = false,
  ) {
    super(message);
    this.name = 'SpeechServiceError';
  }
}

/** The canonical cache key; exported so tests and receipts can reproduce it. */
export function speechCacheKey(input: {
  provider: string;
  model: string;
  voiceId: string;
  language: string;
  speed: number;
  text: string;
}): string {
  const canonical = stableJson({
    provider: input.provider,
    model: input.model,
    voiceId: input.voiceId,
    language: input.language,
    speed: input.speed,
    text: input.text.trim(),
  });
  return createHash('sha256').update(canonical).digest('hex');
}

function sha256Buffer(buffer: Buffer): string {
  return createHash('sha256').update(buffer).digest('hex');
}

function sha256File(file: string): string {
  return sha256Buffer(readFileSync(file));
}

export class SpeechService {
  private readonly port: SpeechPort;
  private readonly cache: SpeechCacheStore;
  private readonly audioRoot: string;
  private readonly tempRoot: string;
  /** Dedupes concurrent identical requests inside one process. */
  private readonly inFlight = new Map<string, Promise<NarrationClipV1>>();

  constructor(options: SpeechServiceOptions) {
    this.port = options.port;
    this.cache = options.cache;
    this.audioRoot = options.audioRoot;
    this.tempRoot = options.tempRoot ?? path.join(options.audioRoot, '.tmp');
  }

  isConfigured(): boolean {
    return this.port.isConfigured();
  }

  providerName(): string {
    return this.port.providerName;
  }

  /** Voice profile the adapter would use for a language (server default). */
  defaultVoice(language: SpeechLanguage) {
    return this.port.getDefaultVoice(language);
  }

  /** `/v1/health` projection; credentials never appear here. */
  health(): SpeechHealth {
    const voice = this.port.getDefaultVoice('zh-CN');
    return {
      configured: this.port.isConfigured(),
      provider: this.port.providerName,
      model: voice.model,
      synthetic: voice.synthetic,
      license: voice.license,
    };
  }

  /**
   * Synthesizes every scene, failing closed when the provider is not
   * configured. Never silently substitutes a fake voice: the deterministic
   * adapter is only used when `ASVS_TTS_PROVIDER=deterministic_test` was set
   * explicitly, and it labels itself `synthetic: true`.
   */
  async synthesizeNarration(
    scenes: SynthesizeNarrationInput[],
    signal?: AbortSignal,
  ): Promise<NarrationSynthesisReport> {
    if (!this.isConfigured()) {
      throw new SpeechServiceError(
        'tts_not_configured',
        '未配置 TTS 服务（ASVS_TTS_PROVIDER / ASVS_TTS_API_URL / ASVS_TTS_API_KEY），已拒绝合成旁白。',
        false,
      );
    }
    mkdirSync(this.audioRoot, { recursive: true });

    let cacheHits = 0;
    let providerCalls = 0;
    const clips: NarrationClipV1[] = [];
    let firstVoice: { provider: string; model: string; voiceId: string; language: SpeechLanguage; license: string; synthetic: boolean } | undefined;

    for (const scene of scenes) {
      const result = await this.synthesizeClip(scene, signal);
      cacheHits += result.cacheHit ? 1 : 0;
      providerCalls += result.cacheHit ? 0 : 1;
      clips.push(result.clip);
      firstVoice ??= {
        provider: result.clip.provider,
        model: this.port.getDefaultVoice(result.clip.language).model,
        voiceId: result.clip.voiceId,
        language: result.clip.language,
        license: result.clip.license,
        synthetic: result.clip.synthetic,
      };
    }

    if (!firstVoice) {
      throw new SpeechServiceError('tts_failed', '没有可合成的旁白文本。', false);
    }

    const audio: RenderAudioAssetV1[] = clips.map((clip) => ({
      sceneId: clip.sceneId,
      sourceFile: path.join(this.audioRoot, `${clip.cacheKey}.wav`),
      src: clip.src,
      sha256: clip.sha256,
      mimeType: 'audio/wav',
      durationMs: clip.durationMs,
      sampleRate: clip.sampleRate,
      channels: clip.channels,
    }));

    return {
      clips,
      audio,
      cacheHits,
      providerCalls,
      synthetic: firstVoice.synthetic,
      provider: firstVoice.provider,
      model: firstVoice.model,
      voiceId: firstVoice.voiceId,
      language: firstVoice.language,
      license: firstVoice.license,
    };
  }

  private async synthesizeClip(
    scene: SynthesizeNarrationInput,
    signal?: AbortSignal,
  ): Promise<{ clip: NarrationClipV1; cacheHit: boolean }> {
    const model = this.port.getDefaultVoice(scene.language).model;
    const cacheKey = speechCacheKey({
      provider: this.port.providerName,
      model,
      voiceId: scene.voiceId,
      language: scene.language,
      speed: scene.speed,
      text: scene.text,
    });

    const cached = this.readCache(cacheKey, scene);
    if (cached) return { clip: cached, cacheHit: true };

    const pending = this.inFlight.get(cacheKey);
    if (pending) {
      const clip = await pending;
      return {
        clip: this.materializeForScene(clip, scene),
        cacheHit: true,
      };
    }

    const task = this.synthesizeAndStore(scene, cacheKey, signal);
    this.inFlight.set(cacheKey, task);
    try {
      const clip = await task;
      return { clip, cacheHit: false };
    } finally {
      this.inFlight.delete(cacheKey);
    }
  }

  /** Cache hit path: re-hash the WAV, refuse to trust a damaged file. */
  private readCache(cacheKey: string, scene: SynthesizeNarrationInput): NarrationClipV1 | null {
    const entry = this.cache.get(cacheKey);
    if (!entry) return null;
    if (!existsSync(entry.filePath)) {
      this.cache.delete(cacheKey);
      return null;
    }
    const actual = sha256File(entry.filePath);
    if (actual !== entry.sha256 || statSync(entry.filePath).size !== entry.byteSize) {
      // Corrupted cache entry: evict, then synthesize again. Never render bytes
      // that do not match the hash recorded in the receipt.
      this.cache.delete(cacheKey);
      rmSync(entry.filePath, { force: true });
      return null;
    }
    this.cache.recordHit(cacheKey, new Date().toISOString());
    const clip = narrationClipV1Schema.parse({
      sceneId: scene.sceneId,
      sceneRevision: scene.sceneRevision,
      text: scene.text.trim(),
      cacheKey,
      src: `audio/${scene.sceneId}.wav`,
      mimeType: 'audio/wav',
      sha256: entry.sha256,
      byteSize: entry.byteSize,
      durationMs: entry.durationMs,
      sampleRate: entry.sampleRate,
      channels: entry.channels,
      startOffsetMs: scene.startOffsetMs ?? DEFAULT_NARRATION_START_OFFSET_MS,
      provider: entry.provider,
      model: entry.model,
      voiceId: entry.voiceId,
      language: scene.language,
      license: entry.license,
      synthetic: entry.synthetic,
    });
    return clip;
  }

  /**
   * Two scenes with identical text share a cache entry but must have distinct
   * `sceneId`/`src`, so the clip is re-materialized for the asking scene.
   */
  private materializeForScene(base: NarrationClipV1, scene: SynthesizeNarrationInput): NarrationClipV1 {
    return {
      ...base,
      sceneId: scene.sceneId,
      sceneRevision: scene.sceneRevision,
      src: `audio/${scene.sceneId}.wav`,
      startOffsetMs: scene.startOffsetMs ?? DEFAULT_NARRATION_START_OFFSET_MS,
      language: scene.language,
    };
  }

  private async synthesizeAndStore(
    scene: SynthesizeNarrationInput,
    cacheKey: string,
    signal?: AbortSignal,
  ): Promise<NarrationClipV1> {
    const target = path.join(this.audioRoot, `${cacheKey}.wav`);
    mkdirSync(this.tempRoot, { recursive: true });
    const rawFile = path.join(this.tempRoot, `${cacheKey}.raw`);
    const partialFile = path.join(this.tempRoot, `${cacheKey}.partial.wav`);

    const request: SpeechSynthesisRequest = {
      text: scene.text.trim(),
      language: scene.language,
      voiceId: scene.voiceId,
      speed: scene.speed,
      idempotencyKey: cacheKey,
    };

    let result;
    try {
      result = await this.port.synthesize(request, signal);
    } catch (error) {
      if (error instanceof SpeechProviderError) {
        throw new SpeechServiceError(
          error.code === 'not_configured' ? 'tts_not_configured' : 'tts_failed',
          error.message,
          error.retryable,
        );
      }
      const message = error instanceof Error ? error.message : String(error);
      throw new SpeechServiceError('tts_failed', `TTS 合成失败：${message}`, true);
    }

    try {
      writeFileSync(rawFile, result.audioBuffer);
      normalizeAudioToWav(rawFile, partialFile);
      const probe = probeNormalizedAudio(partialFile);
      if (
        probe.sampleRate !== NORMALIZED_SAMPLE_RATE ||
        probe.channels !== NORMALIZED_CHANNELS ||
        probe.codecName !== 'pcm_s16le'
      ) {
        throw new SpeechServiceError(
          'tts_failed',
          `归一化音频不符合契约（${probe.codecName}/${probe.sampleRate}Hz/${probe.channels}ch）`,
        );
      }
      const buffer = readFileSync(partialFile);
      const sha256 = sha256Buffer(buffer);
      if (!(existsSync(target) && sha256File(target) === sha256)) {
        // Write-then-rename so a crash never leaves a half-written cache file
        // that a later hit would read.
        const staging = `${target}.${process.pid}.tmp`;
        writeFileSync(staging, buffer);
        renameSync(staging, target);
      }
      const byteSize = statSync(target).size;
      const now = new Date().toISOString();
      this.cache.put({
        cacheKey,
        provider: result.provider,
        model: result.model,
        voiceId: result.voiceId,
        language: scene.language,
        speed: scene.speed,
        textSha256: createHash('sha256').update(scene.text.trim()).digest('hex'),
        textLength: scene.text.trim().length,
        filePath: target,
        sha256,
        byteSize,
        durationMs: probe.durationMs,
        sampleRate: probe.sampleRate,
        channels: probe.channels,
        license: result.license,
        synthetic: result.synthetic,
        createdAt: now,
        lastUsedAt: now,
        hitCount: 0,
      });
      return narrationClipV1Schema.parse({
        sceneId: scene.sceneId,
        sceneRevision: scene.sceneRevision,
        text: scene.text.trim(),
        cacheKey,
        src: `audio/${scene.sceneId}.wav`,
        mimeType: 'audio/wav',
        sha256,
        byteSize,
        durationMs: probe.durationMs,
        sampleRate: probe.sampleRate,
        channels: probe.channels,
        startOffsetMs: scene.startOffsetMs ?? DEFAULT_NARRATION_START_OFFSET_MS,
        provider: result.provider,
        model: result.model,
        voiceId: result.voiceId,
        language: scene.language,
        license: result.license,
        synthetic: result.synthetic,
      });
    } finally {
      rmSync(rawFile, { force: true });
      rmSync(partialFile, { force: true });
    }
  }
}
