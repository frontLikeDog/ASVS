import type { SpeechLanguage, SpeechVoiceProfile } from '@asvs/domain';
import type {
  SpeechPort,
  SpeechProviderError,
  SpeechRuntimeConfig,
  SpeechSynthesisRequest,
  SpeechSynthesisResult,
} from '@asvs/ports';
import { SpeechProviderError as SpeechProviderErrorCtor } from '@asvs/ports';
import { redactSecrets } from '../github/redact';

/**
 * OpenAI-compatible `/v1/audio/speech` adapter (docs/06 §5, fault test #4).
 *
 * Rules that must never regress:
 * - without an API key the adapter reports `isConfigured() === false`, so the
 *   orchestrator fails closed with 503 — it never degrades to a fake voice;
 * - 401/403 are `auth_failed` and are **never** retried;
 * - 429/5xx are retried with `Retry-After` (or exponential backoff + jitter),
 *   at most `maxRetries` times, then surface as a retryable error;
 * - the key never appears in an error message, a log, or a response body.
 */

export const SPEECH_PROVIDER_NAME = 'openai_compatible';
const RETRY_BASE_DELAY_MS = 500;
const MAX_RETRY_DELAY_MS = 8_000;
const DEFAULT_PATH = '/v1/audio/speech';

export interface OpenAiCompatibleSpeechOptions {
  config: SpeechRuntimeConfig;
  /** Injectable for tests; defaults to global fetch. */
  fetchImpl?: typeof fetch;
  /** Injectable for tests; defaults to real timers. */
  sleep?: (ms: number) => Promise<void>;
  /** Injectable for tests; defaults to Math.random. */
  random?: () => number;
  /** Structured diagnostics; never receives secrets. */
  onRetry?: (info: { attempt: number; delayMs: number; reason: string; httpStatus?: number }) => void;
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
  });
}

/** Parses `Retry-After` seconds or HTTP-date. Returns undefined when unusable. */
export function parseRetryAfterMs(value: string | null | undefined, nowMs = Date.now()): number | undefined {
  if (!value) return undefined;
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  if (/^\d+(\.\d+)?$/.test(trimmed)) {
    return Math.max(0, Math.round(Number(trimmed) * 1000));
  }
  const dateMs = Date.parse(trimmed);
  if (Number.isNaN(dateMs)) return undefined;
  return Math.max(0, dateMs - nowMs);
}

/** Exponential backoff with full jitter, capped so a CI run cannot stall. */
export function backoffDelayMs(attempt: number, random: () => number): number {
  const exponential = Math.min(MAX_RETRY_DELAY_MS, RETRY_BASE_DELAY_MS * 2 ** (attempt - 1));
  return Math.round(exponential * (0.5 + random() * 0.5));
}

export class OpenAiCompatibleSpeechAdapter implements SpeechPort {
  readonly providerName = SPEECH_PROVIDER_NAME;
  private readonly config: SpeechRuntimeConfig;
  private readonly fetchImpl: typeof fetch;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly random: () => number;
  private readonly onRetry?: OpenAiCompatibleSpeechOptions['onRetry'];

  constructor(options: OpenAiCompatibleSpeechOptions) {
    this.config = options.config;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.sleep = options.sleep ?? defaultSleep;
    this.random = options.random ?? Math.random;
    this.onRetry = options.onRetry;
  }

  isConfigured(): boolean {
    return Boolean(this.config.apiUrl && this.config.apiKey);
  }

  getDefaultVoice(language: SpeechLanguage): SpeechVoiceProfile {
    const voiceId =
      language === 'en-US' ? this.config.voiceEn : this.config.voiceZh;
    return {
      provider: this.providerName,
      model: this.config.model,
      voiceId: voiceId || 'alloy',
      language,
      speed: 1,
      license: this.config.license,
      synthetic: true,
    };
  }

  async synthesize(
    request: SpeechSynthesisRequest,
    signal?: AbortSignal,
  ): Promise<SpeechSynthesisResult> {
    if (!this.isConfigured()) {
      throw new SpeechProviderErrorCtor(
        'not_configured',
        '未配置 TTS 服务（ASVS_TTS_API_URL / ASVS_TTS_API_KEY），拒绝合成旁白。',
        false,
      );
    }

    const endpoint = this.endpoint();
    const body = JSON.stringify({
      model: this.config.model,
      input: request.text,
      voice: request.voiceId,
      response_format: 'wav',
      speed: request.speed,
    });

    const maxAttempts = this.config.maxRetries + 1;
    let lastError: SpeechProviderError | undefined;

    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      let response: Response;
      try {
        response = await this.post(endpoint, body, request, signal);
      } catch (error) {
        // Timeouts and network failures never produce a Response; they still
        // belong to the retry budget, otherwise a flaky link fails the run on
        // the first blip.
        const providerError =
          error instanceof SpeechProviderErrorCtor
            ? error
            : new SpeechProviderErrorCtor(
                'provider_error',
                `TTS 网络请求失败：${error instanceof Error ? redactSecrets(error.name) : 'Error'}`,
                true,
              );
        lastError = providerError;
        if (!providerError.retryable || attempt >= maxAttempts) throw providerError;
        const delayMs = providerError.retryAfterMs ?? backoffDelayMs(attempt, this.random);
        this.onRetry?.({
          attempt,
          delayMs,
          reason: providerError.code,
          httpStatus: providerError.httpStatus,
        });
        await this.sleep(delayMs);
        continue;
      }
      if (response.ok) {
        const audioBuffer = Buffer.from(await response.arrayBuffer());
        if (audioBuffer.byteLength === 0) {
          throw new SpeechProviderErrorCtor(
            'provider_error',
            'TTS 服务返回了空音频。',
            true,
            undefined,
            response.status,
          );
        }
        return {
          audioBuffer,
          inputFormat: 'wav',
          provider: this.providerName,
          model: this.config.model,
          voiceId: request.voiceId,
          license: this.config.license,
          synthetic: true,
          ...(response.headers.get('x-request-id')
            ? { requestId: response.headers.get('x-request-id')! }
            : {}),
        };
      }

      const error = await this.toError(response, attempt, maxAttempts);
      lastError = error;
      if (!error.retryable || attempt >= maxAttempts) throw error;

      const delayMs =
        error.retryAfterMs ?? backoffDelayMs(attempt, this.random);
      this.onRetry?.({
        attempt,
        delayMs,
        reason: error.code,
        httpStatus: error.httpStatus,
      });
      await this.sleep(delayMs);
    }

    throw (
      lastError ??
      new SpeechProviderErrorCtor('provider_error', 'TTS 合成失败。', true)
    );
  }

  private endpoint(): string {
    const base = this.config.apiUrl!.replace(/\/+$/, '');
    return base.endsWith('/audio/speech') ? base : `${base}${DEFAULT_PATH}`;
  }

  private async post(
    endpoint: string,
    body: string,
    request: SpeechSynthesisRequest,
    signal?: AbortSignal,
  ): Promise<Response> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.config.timeoutMs);
    timeout.unref?.();
    const onAbort = () => controller.abort();
    signal?.addEventListener('abort', onAbort, { once: true });
    try {
      return await this.fetchImpl(endpoint, {
        method: 'POST',
        headers: {
          // The key exists only in this header; it is never logged.
          Authorization: `Bearer ${this.config.apiKey}`,
          'content-type': 'application/json',
          accept: 'audio/wav, audio/mpeg, audio/ogg',
          'Idempotency-Key': request.idempotencyKey,
        },
        body,
        signal: controller.signal,
      });
    } catch (error) {
      const name = error instanceof Error ? error.name : 'Error';
      if (signal?.aborted) {
        // The orchestrator cancelled the run: retrying would fight the caller.
        throw new SpeechProviderErrorCtor(
          'provider_error',
          'TTS 请求被调用方取消。',
          false,
        );
      }
      if (controller.signal.aborted || name === 'AbortError' || name === 'TimeoutError') {
        throw new SpeechProviderErrorCtor(
          'timeout',
          `TTS 请求超时（${this.config.timeoutMs}ms）。`,
          true,
        );
      }
      // Network failures keep the message generic: a fetch error can embed the
      // URL, and vendor URLs sometimes carry tokens in the query string.
      throw new SpeechProviderErrorCtor(
        'provider_error',
        `TTS 网络请求失败：${redactSecrets(name)}`,
        true,
      );
    } finally {
      clearTimeout(timeout);
      signal?.removeEventListener('abort', onAbort);
    }
  }

  private async toError(
    response: Response,
    attempt: number,
    maxAttempts: number,
  ): Promise<SpeechProviderError> {
    const status = response.status;
    const retryAfterMs = parseRetryAfterMs(response.headers.get('retry-after'));
    // Only read a bounded amount: a proxy error page must not be echoed back.
    const detail = await this.safeBody(response);

    if (status === 401 || status === 403) {
      return new SpeechProviderErrorCtor(
        'auth_failed',
        `TTS 服务拒绝了凭证（HTTP ${status}）。请检查 ASVS_TTS_API_KEY 是否有效。`,
        false,
        undefined,
        status,
      );
    }
    if (status === 429) {
      return new SpeechProviderErrorCtor(
        'rate_limited',
        `TTS 服务限流（HTTP 429，第 ${attempt}/${maxAttempts} 次）。${detail}`,
        true,
        retryAfterMs,
        status,
      );
    }
    if (status >= 500) {
      return new SpeechProviderErrorCtor(
        'provider_error',
        `TTS 服务暂时不可用（HTTP ${status}，第 ${attempt}/${maxAttempts} 次）。${detail}`,
        true,
        retryAfterMs,
        status,
      );
    }
    return new SpeechProviderErrorCtor(
      'provider_error',
      `TTS 请求被拒绝（HTTP ${status}）。${detail}`,
      false,
      retryAfterMs,
      status,
    );
  }

  private async safeBody(response: Response): Promise<string> {
    try {
      const text = (await response.text()).slice(0, 300).trim();
      if (!text) return '';
      return redactSecrets(text).replace(/\s+/g, ' ');
    } catch {
      return '';
    }
  }
}
