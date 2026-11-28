import type { SpeechLanguage, SpeechVoiceProfile } from '@asvs/domain';
import type {
  SpeechPort,
  SpeechRuntimeConfig,
  SpeechSynthesisRequest,
  SpeechSynthesisResult,
} from '@asvs/ports';

/**
 * Offline, deterministic test voice (docs/06 §5, AC-10).
 *
 * This exists so the export pipeline can be exercised end-to-end without a paid
 * provider and without network access. It is **honestly labelled everywhere**:
 * `synthetic: true` and `license: 'internal-deterministic-test-only'`, and the
 * UI renders it as「测试合成音轨 · 非真人配音」. It must never be mistaken for a
 * real commercial voice, which is why the license string is not configurable.
 */

export const DETERMINISTIC_TEST_PROVIDER = 'deterministic_test';
export const DETERMINISTIC_TEST_LICENSE = 'internal-deterministic-test-only';
export const DETERMINISTIC_TEST_MODEL = 'tone-v1';
export const TEST_SAMPLE_RATE = 48_000;
export const TEST_CHANNELS = 1;

/** Rough reading speeds used only to size the clip, never to claim realism. */
const ZH_CHARS_PER_SECOND = 4.2;
const EN_WORDS_PER_SECOND = 2.5;
const MIN_DURATION_MS = 400;

/** Amplitude of the soft tone; low enough not to startle a reviewer. */
const TONE_AMPLITUDE = 0.18;
const BASE_FREQUENCY_HZ = 220;

/** Chinese text counts characters; English counts words. */
export function estimateSpeechDurationMs(text: string, language: SpeechLanguage): number {
  const normalized = text.replace(/\s+/g, ' ').trim();
  if (!normalized) return MIN_DURATION_MS;
  if (language === 'zh-CN') {
    // Punctuation shouldn't add speaking time; count CJK + alphanumerics only.
    const speakable = normalized.replace(/[\s，。！？、；：""''（）《》,.!?;:'"()\-—…]/g, '');
    const units = Math.max(1, speakable.length);
    return Math.max(MIN_DURATION_MS, Math.round((units / ZH_CHARS_PER_SECOND) * 1000));
  }
  const words = normalized.split(/\s+/).filter((word) => /[A-Za-z0-9]/.test(word));
  const units = Math.max(1, words.length);
  return Math.max(MIN_DURATION_MS, Math.round((units / EN_WORDS_PER_SECOND) * 1000));
}

/**
 * Synthesizes a 48 kHz / 16-bit mono PCM WAV of a soft sine tone whose length
 * follows the estimated speech duration. Same input ⇒ byte-identical output,
 * so the cache key and the golden digests are stable.
 */
export function synthesizeTestWav(text: string, language: SpeechLanguage): Buffer {
  const durationMs = estimateSpeechDurationMs(text, language);
  const totalSamples = Math.round((durationMs / 1000) * TEST_SAMPLE_RATE);
  const dataBytes = totalSamples * 2; // mono, 16-bit
  const buffer = Buffer.alloc(44 + dataBytes);

  buffer.write('RIFF', 0, 'ascii');
  buffer.writeUInt32LE(36 + dataBytes, 4);
  buffer.write('WAVE', 8, 'ascii');
  buffer.write('fmt ', 12, 'ascii');
  buffer.writeUInt32LE(16, 16); // PCM fmt chunk size
  buffer.writeUInt16LE(1, 20); // PCM
  buffer.writeUInt16LE(TEST_CHANNELS, 22);
  buffer.writeUInt32LE(TEST_SAMPLE_RATE, 24);
  buffer.writeUInt32LE(TEST_SAMPLE_RATE * TEST_CHANNELS * 2, 28); // byte rate
  buffer.writeUInt16LE(TEST_CHANNELS * 2, 32); // block align
  buffer.writeUInt16LE(16, 34); // bits per sample
  buffer.write('data', 36, 'ascii');
  buffer.writeUInt32LE(dataBytes, 40);

  // A gentle amplitude envelope avoids clicks at both ends while keeping the
  // mean volume well above the -90 dB silence gate.
  const fadeSamples = Math.min(Math.round(TEST_SAMPLE_RATE * 0.05), Math.floor(totalSamples / 2));
  for (let index = 0; index < totalSamples; index += 1) {
    const t = index / TEST_SAMPLE_RATE;
    const envelope =
      fadeSamples > 0
        ? Math.min(1, index / fadeSamples, (totalSamples - 1 - index) / fadeSamples)
        : 1;
    const sample = Math.sin(2 * Math.PI * BASE_FREQUENCY_HZ * t) * TONE_AMPLITUDE * envelope;
    buffer.writeInt16LE(Math.round(sample * 32_767), 44 + index * 2);
  }
  return buffer;
}

export class DeterministicTestSpeechAdapter implements SpeechPort {
  readonly providerName = DETERMINISTIC_TEST_PROVIDER;
  private readonly config: SpeechRuntimeConfig;

  constructor(config: SpeechRuntimeConfig) {
    this.config = config;
  }

  /** Always configured: it is the explicit, labelled test mode. */
  isConfigured(): boolean {
    return true;
  }

  getDefaultVoice(language: SpeechLanguage): SpeechVoiceProfile {
    return {
      provider: DETERMINISTIC_TEST_PROVIDER,
      model: DETERMINISTIC_TEST_MODEL,
      voiceId: language === 'en-US' ? 'test-voice-en' : 'test-voice-zh',
      language,
      speed: 1,
      license: DETERMINISTIC_TEST_LICENSE,
      synthetic: true,
    };
  }

  async synthesize(request: SpeechSynthesisRequest): Promise<SpeechSynthesisResult> {
    void this.config;
    return {
      audioBuffer: synthesizeTestWav(request.text, request.language),
      inputFormat: 'wav',
      provider: DETERMINISTIC_TEST_PROVIDER,
      model: DETERMINISTIC_TEST_MODEL,
      voiceId: request.voiceId,
      license: DETERMINISTIC_TEST_LICENSE,
      synthetic: true,
    };
  }
}
