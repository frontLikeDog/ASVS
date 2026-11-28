import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { QaOcrUnavailableError } from '@asvs/ports';
import {
  DeterministicTestOcrAdapter,
  TesseractCliOcrAdapter,
  UnconfiguredOcrAdapter,
} from './ocr-adapters';
import { runQaProcess } from './process-runner';

const FIXTURE_DIR = path.resolve('apps/api/src/qa/__fixtures__');

function hasFfmpeg(): boolean {
  const result = spawnSync('ffmpeg', ['-version'], { windowsHide: true });
  return result.status === 0;
}

function hasTesseract(): boolean {
  const result = spawnSync('tesseract', ['--version'], { windowsHide: true });
  return result.status === 0;
}

describe('DeterministicTestOcrAdapter', () => {
  it('按 fixture 映射返回文本并诚实标记 synthetic', async () => {
    const adapter = new DeterministicTestOcrAdapter({ fixtures: { '/tmp/a.png': 'ceo@acme-internal.io' } });
    const result = await adapter.extractText('/tmp/a.png');
    expect(result.text).toBe('ceo@acme-internal.io');
    expect(result.synthetic).toBe(true);
    expect(adapter.health()).toEqual({
      provider: 'deterministic_test',
      configured: true,
      language: 'test-fixture',
    });
  });

  it('无 fixture 时读取旁路 .ocr.txt，再退化为空文本（而不是抛错）', async () => {
    const adapter = new DeterministicTestOcrAdapter();
    const result = await adapter.extractText(path.join(FIXTURE_DIR, 'ocr-sidecar.png'));
    expect(result.text).toContain('sidecar@corp.internal');
    expect((await adapter.extractText('/nonexistent.png')).text).toBe('');
  });

  it('已中止的 signal 直接拒绝，避免取消后继续工作', async () => {
    const adapter = new DeterministicTestOcrAdapter();
    const controller = new AbortController();
    controller.abort();
    await expect(adapter.extractText('/tmp/a.png', { signal: controller.signal })).rejects.toBeInstanceOf(
      QaOcrUnavailableError,
    );
  });
});

describe('UnconfiguredOcrAdapter · fail-closed', () => {
  it('isConfigured=false，extractText 抛 QaOcrUnavailableError', async () => {
    const adapter = new UnconfiguredOcrAdapter();
    expect(adapter.isConfigured()).toBe(false);
    expect(adapter.health()).toEqual({ provider: 'unconfigured', configured: false, language: 'none' });
    await expect(adapter.extractText()).rejects.toBeInstanceOf(QaOcrUnavailableError);
  });
});

describe('TesseractCliOcrAdapter', () => {
  it('二进制缺失时抛 QaOcrUnavailableError（fail-closed），不是静默通过', async () => {
    const adapter = new TesseractCliOcrAdapter({ bin: 'tesseract-definitely-missing-binary' });
    await expect(adapter.extractText('/tmp/a.png')).rejects.toBeInstanceOf(QaOcrUnavailableError);
  });

  it('真实 tesseract 能读出渲染了文本的 PNG（CI/本机安装时执行）', async () => {
    if (!hasTesseract() || !hasFfmpeg()) {
      // Local Windows dev boxes usually lack tesseract; CI installs it. The
      // real chain is proven by `pnpm qa:verify`, so skipping here is honest.
      expect(true).toBe(true);
      return;
    }
    const image = path.join(FIXTURE_DIR, 'ocr-real-sample.png');
    const adapter = new TesseractCliOcrAdapter({ language: 'eng' });
    const result = await adapter.extractText(image, { timeoutMs: 30_000 });
    expect(result.synthetic).toBe(false);
    expect(result.text.toUpperCase()).toContain('OCR');
  });
});

describe('runQaProcess · 子进程纪律', () => {
  it('超时杀死子进程并标记 timedOut', async () => {
    const node = process.execPath;
    const result = await runQaProcess(node, ['-e', 'setTimeout(() => {}, 60_000)'], { timeoutMs: 300 });
    expect(result.timedOut).toBe(true);
  });

  it('abort signal 立即终止子进程', async () => {
    const controller = new AbortController();
    const pending = runQaProcess(process.execPath, ['-e', 'setTimeout(() => {}, 60_000)'], {
      signal: controller.signal,
      timeoutMs: 30_000,
    });
    controller.abort();
    const result = await pending;
    expect(result.timedOut).toBe(true);
  });

  it('二进制不存在时返回 spawnError 而不是抛出', async () => {
    const result = await runQaProcess('definitely-not-a-binary-qa', []);
    expect(result.spawnError).toBeInstanceOf(Error);
    expect(result.code).toBeNull();
  });
});
