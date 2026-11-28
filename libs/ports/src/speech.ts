import type { SpeechLanguage, SpeechVoiceProfile } from '@asvs/domain';

/**
 * Text-to-speech boundary (docs/07 §7, docs/06 §5 fault test #4).
 *
 * Implementations return the raw provider bytes plus the provenance needed for
 * licensing; normalization to WAV, hashing and caching happen above this port
 * in `SpeechService`. Adapters must never log or throw the API key.
 */
export interface SpeechSynthesisRequest {
  text: string;
  language: SpeechLanguage;
  voiceId: string;
  speed: number;
  idempotencyKey: string;
}

export interface SpeechSynthesisResult {
  audioBuffer: Buffer;
  inputFormat: 'mp3' | 'wav' | 'opus' | 'pcm';
  provider: string;
  model: string;
  voiceId: string;
  license: string;
  synthetic: boolean;
  requestId?: string;
}

export type SpeechProviderErrorCode =
  | 'rate_limited'
  | 'timeout'
  | 'auth_failed'
  | 'not_configured'
  | 'provider_error';

export class SpeechProviderError extends Error {
  constructor(
    readonly code: SpeechProviderErrorCode,
    message: string,
    readonly retryable: boolean,
    readonly retryAfterMs?: number,
    readonly httpStatus?: number,
  ) {
    super(message);
    this.name = 'SpeechProviderError';
  }
}

export interface SpeechPort {
  readonly providerName: string;
  /** False means fail closed: never synthesize a fake voice silently. */
  isConfigured(): boolean;
  getDefaultVoice(language: SpeechLanguage): SpeechVoiceProfile;
  synthesize(
    request: SpeechSynthesisRequest,
    signal?: AbortSignal,
  ): Promise<SpeechSynthesisResult>;
}

/** Environment-derived TTS configuration shared by the API and scripts. */
export interface SpeechRuntimeConfig {
  provider: 'unconfigured' | 'openai_compatible' | 'deterministic_test';
  apiUrl?: string;
  apiKey?: string;
  model: string;
  voiceZh: string;
  voiceEn: string;
  license: string;
  timeoutMs: number;
  maxRetries: number;
}

export interface SpeechHealth {
  configured: boolean;
  provider: string;
  model: string;
  synthetic: boolean;
  license: string;
}
