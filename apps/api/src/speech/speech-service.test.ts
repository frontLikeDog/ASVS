import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type {
  SpeechPort,
  SpeechRuntimeConfig,
  SpeechSynthesisRequest,
  SpeechSynthesisResult,
} from '@asvs/ports';
import { SpeechProviderError } from '@asvs/ports';
import { migrateDatabase } from '../db/database';
import { DeterministicTestSpeechAdapter, synthesizeTestWav } from './deterministic-test-adapter';
import { SpeechCacheStore } from './speech-cache-store';
import { SpeechService, SpeechServiceError, speechCacheKey } from './speech-service';

const config: SpeechRuntimeConfig = {
  provider: 'deterministic_test',
  model: 'tone-v1',
  voiceZh: 'test-voice-zh',
  voiceEn: 'test-voice-en',
  license: 'internal-deterministic-test-only',
  timeoutMs: 5_000,
  maxRetries: 3,
};

class CountingPort implements SpeechPort {
  readonly providerName = 'counting';
  calls = 0;
  failNext?: SpeechProviderError;
  constructor(private readonly base: SpeechPort) {}
  isConfigured() {
    return true;
  }
  getDefaultVoice(language: 'zh-CN' | 'en-US') {
    return this.base.getDefaultVoice(language);
  }
  async synthesize(request: SpeechSynthesisRequest): Promise<SpeechSynthesisResult> {
    if (this.failNext) {
      const error = this.failNext;
      this.failNext = undefined;
      throw error;
    }
    this.calls += 1;
    const result = await this.base.synthesize(request);
    return { ...result, provider: this.providerName };
  }
}

describe('SpeechService · 内容寻址缓存（AC-10 不重复计费）', () => {
  let dir: string;
  let db: DatabaseSync;
  let port: CountingPort;

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'asvs-speech-'));
    db = new DatabaseSync(':memory:');
    migrateDatabase(db);
    port = new CountingPort(new DeterministicTestSpeechAdapter(config));
  });

  afterEach(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  function service(): SpeechService {
    return new SpeechService({
      port,
      cache: new SpeechCacheStore(db),
      audioRoot: path.join(dir, 'tts'),
    });
  }

  const scenes = [
    { sceneId: 'scene_1', sceneRevision: 1, text: '第一镜的旁白。', language: 'zh-CN' as const, voiceId: 'test-voice-zh', speed: 1 },
    { sceneId: 'scene_2', sceneRevision: 1, text: 'Second scene narration.', language: 'en-US' as const, voiceId: 'test-voice-en', speed: 1 },
  ];

  it('首次合成调用 provider，且产物为 48kHz 单声道 WAV', async () => {
    const report = await service().synthesizeNarration(scenes);
    expect(port.calls).toBe(2);
    expect(report.cacheHits).toBe(0);
    expect(report.providerCalls).toBe(2);
    expect(report.synthetic).toBe(true);
    expect(report.license).toBe('internal-deterministic-test-only');
    expect(report.clips).toHaveLength(2);
    for (const clip of report.clips) {
      expect(clip.sampleRate).toBe(48_000);
      expect(clip.channels).toBe(1);
      expect(clip.src).toMatch(/^audio\/scene_\d\.wav$/);
      expect(clip.synthetic).toBe(true);
    }
    for (const asset of report.audio) {
      const bytes = readFileSync(asset.sourceFile);
      expect(bytes.subarray(0, 4).toString('ascii')).toBe('RIFF');
    }
  });

  it('相同输入第二次运行 0 次外部调用（缓存命中），并记录 hit_count', async () => {
    await service().synthesizeNarration(scenes);
    expect(port.calls).toBe(2);
    const second = await service().synthesizeNarration(scenes);
    expect(port.calls).toBe(2);
    expect(second.cacheHits).toBe(2);
    expect(second.providerCalls).toBe(0);
    const rows = db.prepare('SELECT hit_count FROM speech_cache').all() as Array<{ hit_count: number }>;
    expect(rows.map((row) => row.hit_count)).toEqual([1, 1]);
  });

  it('文本、音色或语速变化都会 miss（缓存键包含全部字段）', async () => {
    await service().synthesizeNarration(scenes);
    const changed = [{ ...scenes[0]!, text: '改过的旁白。' }];
    await service().synthesizeNarration(changed);
    const slower = [{ ...scenes[0]!, speed: 1.1 }];
    await service().synthesizeNarration(slower);
    expect(port.calls).toBe(4);
  });

  it('缓存文件被篡改时驱逐并重新合成，绝不渲染哈希不符的字节', async () => {
    const first = await service().synthesizeNarration(scenes);
    const target = path.join(dir, 'tts', `${first.clips[0]!.cacheKey}.wav`);
    writeFileSync(target, Buffer.alloc(1024, 0));
    const second = await service().synthesizeNarration(scenes);
    expect(port.calls).toBe(3); // scene_1 re-synthesized, scene_2 still cached
    expect(second.cacheHits).toBe(1);
    expect(second.clips[0]!.sha256).toBe(first.clips[0]!.sha256);
  });

  it('缓存文件丢失时重新合成', async () => {
    const first = await service().synthesizeNarration(scenes);
    rmSync(path.join(dir, 'tts', `${first.clips[0]!.cacheKey}.wav`), { force: true });
    const second = await service().synthesizeNarration(scenes);
    expect(second.cacheHits).toBe(1);
    expect(port.calls).toBe(3);
  });

  it('并发相同请求只调用一次 provider', async () => {
    const shared = service();
    const [a, b] = await Promise.all([
      shared.synthesizeNarration([scenes[0]!]),
      shared.synthesizeNarration([scenes[0]!]),
    ]);
    expect(port.calls).toBe(1);
    expect(a.clips[0]!.sha256).toBe(b.clips[0]!.sha256);
  });

  it('未配置 provider 时 fail-closed（tts_not_configured），不产生任何文件', async () => {
    const unconfigured: SpeechPort = {
      providerName: 'none',
      isConfigured: () => false,
      getDefaultVoice: (language) => ({
        provider: 'none',
        model: 'none',
        voiceId: 'none',
        language,
        speed: 1,
        license: 'none',
        synthetic: false,
      }),
      synthesize: async () => {
        throw new SpeechProviderError('not_configured', '未配置', false);
      },
    };
    const svc = new SpeechService({
      port: unconfigured,
      cache: new SpeechCacheStore(db),
      audioRoot: path.join(dir, 'tts'),
    });
    await expect(svc.synthesizeNarration(scenes)).rejects.toMatchObject({
      code: 'tts_not_configured',
    });
  });

  it('provider 可重试错误上抛为可重试的 tts_failed，且不写缓存', async () => {
    port.failNext = new SpeechProviderError('rate_limited', '限流', true, 1000, 429);
    await expect(service().synthesizeNarration([scenes[0]!])).rejects.toMatchObject({
      code: 'tts_failed',
      retryable: true,
    });
    const count = db.prepare('SELECT COUNT(*) AS n FROM speech_cache').get() as { n: number };
    expect(count.n).toBe(0);
    // Manual retry after the provider recovers hits the provider again and succeeds.
    const retried = await service().synthesizeNarration([scenes[0]!]);
    expect(retried.providerCalls).toBe(1);
  });

  it('错误对象不是 SpeechProviderError 时同样收敛为 tts_failed', async () => {
    const broken: SpeechPort = {
      providerName: 'broken',
      isConfigured: () => true,
      getDefaultVoice: (language) => ({
        provider: 'broken',
        model: 'x',
        voiceId: 'x',
        language,
        speed: 1,
        license: 'internal',
        synthetic: true,
      }),
      synthesize: async () => {
        throw new Error('boom');
      },
    };
    const svc = new SpeechService({
      port: broken,
      cache: new SpeechCacheStore(db),
      audioRoot: path.join(dir, 'tts'),
    });
    const error = await svc.synthesizeNarration([scenes[0]!]).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(SpeechServiceError);
    expect((error as SpeechServiceError).code).toBe('tts_failed');
    expect((error as SpeechServiceError).message).toContain('boom');
  });

  it('缓存键对 provider/model/voice/language/speed/text 敏感且与文本首尾空白无关', () => {
    const base = { provider: 'p', model: 'm', voiceId: 'v', language: 'zh-CN', speed: 1, text: '你好' };
    expect(speechCacheKey(base)).toBe(speechCacheKey({ ...base, text: '  你好  ' }));
    expect(speechCacheKey(base)).not.toBe(speechCacheKey({ ...base, speed: 1.05 }));
    expect(speechCacheKey(base)).not.toBe(speechCacheKey({ ...base, voiceId: 'other' }));
    expect(speechCacheKey(base)).toMatch(/^[a-f0-9]{64}$/);
  });

  it('离线测试音轨诚实标注：synthetic=true 且许可固定', async () => {
    const report = await service().synthesizeNarration([scenes[0]!]);
    expect(report.synthetic).toBe(true);
    expect(report.license).toBe('internal-deterministic-test-only');
    expect(report.clips[0]!.synthetic).toBe(true);
  });
});

describe('DeterministicTestSpeechAdapter · 离线 WAV', () => {
  it('WAV 头合法（RIFF/WAVE/fmt/data，48kHz 16bit 单声道）', () => {
    const wav = synthesizeTestWav('测试一段话。', 'zh-CN');
    expect(wav.subarray(0, 4).toString('ascii')).toBe('RIFF');
    expect(wav.subarray(8, 12).toString('ascii')).toBe('WAVE');
    expect(wav.readUInt16LE(20)).toBe(1); // PCM
    expect(wav.readUInt16LE(22)).toBe(1); // mono
    expect(wav.readUInt32LE(24)).toBe(48_000);
    expect(wav.readUInt16LE(34)).toBe(16);
    expect(wav.byteLength).toBeGreaterThan(44);
  });

  it('相同输入逐字节一致（确定性）', () => {
    const a = synthesizeTestWav('同一段文本', 'zh-CN');
    const b = synthesizeTestWav('同一段文本', 'zh-CN');
    expect(a.equals(b)).toBe(true);
  });

  it('时长随文本长度增长', async () => {
    const adapter = new DeterministicTestSpeechAdapter(config);
    const short = await adapter.synthesize({
      text: '短句。',
      language: 'zh-CN',
      voiceId: 'test-voice-zh',
      speed: 1,
      idempotencyKey: 'x',
    });
    const long = await adapter.synthesize({
      text: '这是一个明显更长更长的句子，用来验证时长会随文本一起增长。',
      language: 'zh-CN',
      voiceId: 'test-voice-zh',
      speed: 1,
      idempotencyKey: 'y',
    });
    expect(long.audioBuffer.byteLength).toBeGreaterThan(short.audioBuffer.byteLength);
    expect(long.synthetic).toBe(true);
    expect(long.license).toBe('internal-deterministic-test-only');
  });
});
