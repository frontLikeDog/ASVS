import { describe, expect, it, vi } from 'vitest';
import type { SpeechRuntimeConfig } from '@asvs/ports';
import { SpeechProviderError } from '@asvs/ports';
import {
  OpenAiCompatibleSpeechAdapter,
  backoffDelayMs,
  parseRetryAfterMs,
} from './openai-compatible-adapter';

const API_KEY = 'sk-test-SECRET-DO-NOT-LEAK-1234567890';

function config(overrides: Partial<SpeechRuntimeConfig> = {}): SpeechRuntimeConfig {
  return {
    provider: 'openai_compatible',
    apiUrl: 'https://tts.example.com',
    apiKey: API_KEY,
    model: 'tts-1',
    voiceZh: 'alloy',
    voiceEn: 'alloy',
    license: 'provider-terms',
    timeoutMs: 5_000,
    maxRetries: 3,
    ...overrides,
  };
}

const request = {
  text: '你好，世界。',
  language: 'zh-CN' as const,
  voiceId: 'alloy',
  speed: 1,
  idempotencyKey: 'a'.repeat(64),
};

function wavResponse(body = 'RIFF....WAVE'): Response {
  return new Response(body, {
    status: 200,
    headers: { 'content-type': 'audio/wav', 'x-request-id': 'req_1' },
  });
}

function errorResponse(status: number, retryAfter?: string): Response {
  return new Response(`upstream error ${status}`, {
    status,
    headers: retryAfter ? { 'retry-after': retryAfter } : {},
  });
}

describe('OpenAiCompatibleSpeechAdapter · 故障注入', () => {
  it('未配置 key 时 isConfigured() 为 false，合成直接失败（绝不降级为假音色）', async () => {
    const fetchImpl = vi.fn();
    const adapter = new OpenAiCompatibleSpeechAdapter({
      config: config({ apiKey: undefined }),
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(adapter.isConfigured()).toBe(false);
    await expect(adapter.synthesize(request)).rejects.toMatchObject({
      code: 'not_configured',
      retryable: false,
    });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('429 带 Retry-After 后重试成功，且请求头带 Bearer', async () => {
    const sleep = vi.fn(async () => undefined);
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(errorResponse(429, '2'))
      .mockResolvedValueOnce(wavResponse());
    const onRetry = vi.fn();
    const adapter = new OpenAiCompatibleSpeechAdapter({
      config: config(),
      fetchImpl: fetchImpl as unknown as typeof fetch,
      sleep,
      onRetry,
    });

    const result = await adapter.synthesize(request);
    expect(result.provider).toBe('openai_compatible');
    expect(result.synthetic).toBe(true);
    expect(result.requestId).toBe('req_1');
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledWith(2000);
    expect(onRetry).toHaveBeenCalledWith(
      expect.objectContaining({ attempt: 1, delayMs: 2000, reason: 'rate_limited', httpStatus: 429 }),
    );
    const init = fetchImpl.mock.calls[0]![1] as RequestInit;
    expect((init.headers as Record<string, string>).Authorization).toBe(`Bearer ${API_KEY}`);
  });

  it('可重试错误耗尽后抛出 retryable 错误，重试次数受 maxRetries 约束', async () => {
    const sleep = vi.fn(async () => undefined);
    const fetchImpl = vi.fn(async () => errorResponse(503));
    const adapter = new OpenAiCompatibleSpeechAdapter({
      config: config({ maxRetries: 2 }),
      fetchImpl: fetchImpl as unknown as typeof fetch,
      sleep,
      random: () => 0,
    });
    await expect(adapter.synthesize(request)).rejects.toMatchObject({
      code: 'provider_error',
      retryable: true,
      httpStatus: 503,
    });
    expect(fetchImpl).toHaveBeenCalledTimes(3);
    expect(sleep).toHaveBeenCalledTimes(2);
  });

  it('401 不重试，错误文案不含 API key', async () => {
    const sleep = vi.fn(async () => undefined);
    const fetchImpl = vi.fn(async () => errorResponse(401));
    const adapter = new OpenAiCompatibleSpeechAdapter({
      config: config(),
      fetchImpl: fetchImpl as unknown as typeof fetch,
      sleep,
    });
    const error = await adapter.synthesize(request).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(SpeechProviderError);
    const providerError = error as SpeechProviderError;
    expect(providerError.code).toBe('auth_failed');
    expect(providerError.retryable).toBe(false);
    expect(providerError.httpStatus).toBe(401);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
    expect(providerError.message).not.toContain(API_KEY);
    expect(JSON.stringify(providerError)).not.toContain(API_KEY);
  });

  it('上游错误体中的密钥片段也会被脱敏', async () => {
    const fetchImpl = vi.fn(async () => {
      return new Response(`bad key Bearer ${API_KEY}`, { status: 500 });
    });
    const adapter = new OpenAiCompatibleSpeechAdapter({
      config: config({ maxRetries: 0 }),
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    const error = (await adapter.synthesize(request).catch((caught: unknown) => caught)) as Error;
    expect(error.message).not.toContain(API_KEY);
    expect(error.message).toContain('[REDACTED]');
  });

  it('4xx（非 401/429）不重试', async () => {
    const fetchImpl = vi.fn(async () => errorResponse(400));
    const adapter = new OpenAiCompatibleSpeechAdapter({
      config: config(),
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    await expect(adapter.synthesize(request)).rejects.toMatchObject({
      code: 'provider_error',
      retryable: false,
      httpStatus: 400,
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('网络异常归类为可重试的 provider_error', async () => {
    const sleep = vi.fn(async () => undefined);
    const fetchImpl = vi.fn(async () => {
      throw new TypeError('fetch failed');
    });
    const adapter = new OpenAiCompatibleSpeechAdapter({
      config: config({ maxRetries: 1 }),
      fetchImpl: fetchImpl as unknown as typeof fetch,
      sleep,
      random: () => 0,
    });
    await expect(adapter.synthesize(request)).rejects.toMatchObject({
      code: 'provider_error',
      retryable: true,
    });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('超时归类为 timeout 且可重试', async () => {
    const sleep = vi.fn(async () => undefined);
    const fetchImpl = vi.fn(
      (_url: string, init: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init.signal?.addEventListener('abort', () => {
            const error = new Error('aborted');
            error.name = 'AbortError';
            reject(error);
          });
        }),
    );
    const adapter = new OpenAiCompatibleSpeechAdapter({
      config: config({ timeoutMs: 10, maxRetries: 0 }),
      fetchImpl: fetchImpl as unknown as typeof fetch,
      sleep,
    });
    await expect(adapter.synthesize(request)).rejects.toMatchObject({
      code: 'timeout',
      retryable: true,
    });
  });

  it('空音频体视为可重试的服务故障', async () => {
    const fetchImpl = vi.fn(async () => new Response(new Uint8Array(), { status: 200 }));
    const adapter = new OpenAiCompatibleSpeechAdapter({
      config: config({ maxRetries: 0 }),
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    await expect(adapter.synthesize(request)).rejects.toMatchObject({
      code: 'provider_error',
      retryable: true,
    });
  });
});

describe('Retry-After 与退避', () => {
  it('解析秒数与 HTTP 日期', () => {
    expect(parseRetryAfterMs('2')).toBe(2000);
    expect(parseRetryAfterMs('0.5')).toBe(500);
    const now = Date.parse('2026-01-01T00:00:00Z');
    expect(parseRetryAfterMs('Thu, 01 Jan 2026 00:00:03 GMT', now)).toBe(3000);
    expect(parseRetryAfterMs('nonsense')).toBeUndefined();
    expect(parseRetryAfterMs(null)).toBeUndefined();
  });

  it('指数退避有上限且始终带抖动', () => {
    expect(backoffDelayMs(1, () => 0)).toBe(250);
    expect(backoffDelayMs(1, () => 1)).toBe(500);
    expect(backoffDelayMs(10, () => 1)).toBeLessThanOrEqual(8000);
  });
});
