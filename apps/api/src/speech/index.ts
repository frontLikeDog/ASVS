import path from 'node:path';
import type { SpeechLanguage } from '@asvs/domain';
import type { SpeechHealth, SpeechPort, SpeechRuntimeConfig } from '@asvs/ports';
import { DeterministicTestSpeechAdapter, DETERMINISTIC_TEST_LICENSE } from './deterministic-test-adapter';
import { OpenAiCompatibleSpeechAdapter, SPEECH_PROVIDER_NAME } from './openai-compatible-adapter';

export * from './deterministic-test-adapter';
export * from './normalize-audio';
export * from './openai-compatible-adapter';
export * from './speech-cache-store';
export * from './speech-service';

/**
 * Builds the speech adapter from config. `unconfigured` deliberately returns a
 * port that reports `isConfigured() === false` instead of a stub voice, so the
 * orchestrator fails closed (503) rather than shipping fake narration.
 */
export function createSpeechPort(config: SpeechRuntimeConfig): SpeechPort {
  if (config.provider === 'deterministic_test') {
    return new DeterministicTestSpeechAdapter(config);
  }
  if (config.provider === 'openai_compatible') {
    return new OpenAiCompatibleSpeechAdapter({ config });
  }
  return new UnconfiguredSpeechAdapter(config);
}

export class UnconfiguredSpeechAdapter implements SpeechPort {
  readonly providerName = 'unconfigured';

  constructor(private readonly config: SpeechRuntimeConfig) {}

  isConfigured(): boolean {
    return false;
  }

  getDefaultVoice(language: SpeechLanguage) {
    return {
      provider: 'unconfigured',
      model: this.config.model,
      voiceId: 'none',
      language,
      speed: 1,
      license: 'none',
      synthetic: false,
    };
  }

  async synthesize(): Promise<never> {
    const { SpeechProviderError } = await import('@asvs/ports');
    throw new SpeechProviderError(
      'not_configured',
      '未配置 TTS 服务（ASVS_TTS_PROVIDER），无法合成旁白。',
      false,
    );
  }
}

export function speechHealth(config: SpeechRuntimeConfig, port: SpeechPort): SpeechHealth {
  return {
    configured: port.isConfigured(),
    provider: port.providerName,
    model: config.model,
    synthetic: config.provider === 'deterministic_test',
    license:
      config.provider === 'deterministic_test'
        ? DETERMINISTIC_TEST_LICENSE
        : config.license,
  };
}

/** `data/artifacts/tts` next to the render artifacts by default. */
export function speechAudioRoot(artifactDir: string): string {
  return path.join(artifactDir, 'tts');
}

export const OPENAI_COMPATIBLE_PROVIDER = SPEECH_PROVIDER_NAME;
