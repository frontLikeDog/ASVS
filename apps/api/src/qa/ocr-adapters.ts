import { existsSync, readFileSync } from 'node:fs';
import type {
  ImageOcrPort,
  OcrExtractionResult,
  QaOcrHealth,
  QaOcrUnavailableError as QaOcrUnavailableErrorType,
} from '@asvs/ports';
import { QaOcrUnavailableError } from '@asvs/ports';
import { runQaProcess } from './process-runner';

/**
 * `ImageOcrPort` implementations (docs/16 §3.3).
 *
 * The OCR provider choice is a *policy* decision, not an implementation
 * detail: AC-07 says an image that was never read must never be reported as
 * "privacy checked". So there are exactly three adapters and each is honest
 * about what it is:
 *
 * - `TesseractCliOcrAdapter` — the production reader (local binary, no npm
 *   dependency, no network, ~150–350 ms per 1080p frame).
 * - `DeterministicTestOcrAdapter` — offline tests/CI: reads `<image>.ocr.txt`
 *   sidecars or an injected map, and marks every result `synthetic: true` so
 *   the report coverage says "测试 OCR" rather than pretending.
 * - `UnconfiguredOcrAdapter` — fails closed with `QaOcrUnavailableError`,
 *   which the runner turns into a `privacy.ocr_unavailable` blocker.
 */

export interface TesseractOcrOptions {
  bin?: string;
  language?: string;
  timeoutMs?: number;
}

export class TesseractCliOcrAdapter implements ImageOcrPort {
  readonly provider = 'tesseract_cli' as const;
  readonly synthetic = false;
  private readonly bin: string;
  private readonly language: string;
  private readonly timeoutMs: number;

  constructor(options: TesseractOcrOptions = {}) {
    this.bin = options.bin?.trim() || 'tesseract';
    this.language = options.language?.trim() || 'eng';
    this.timeoutMs = options.timeoutMs ?? 15_000;
  }

  isConfigured(): boolean {
    // Existence is proven by the first real invocation; a missing binary
    // surfaces as `QaOcrUnavailableError` during `extractText`, which is the
    // fail-closed path (never a silent pass).
    return true;
  }

  health(): QaOcrHealth {
    return { provider: this.provider, configured: this.isConfigured(), language: this.language };
  }

  async extractText(
    imagePath: string,
    options: { signal?: AbortSignal; timeoutMs?: number } = {},
  ): Promise<OcrExtractionResult> {
    const startedAt = Date.now();
    const result = await runQaProcess(
      this.bin,
      [imagePath, 'stdout', '-l', this.language, '--psm', '6'],
      {
        timeoutMs: options.timeoutMs ?? this.timeoutMs,
        ...(options.signal ? { signal: options.signal } : {}),
      },
    );
    if (result.spawnError) {
      throw new QaOcrUnavailableError(
        `OCR 不可用：无法启动 ${this.bin}（${result.spawnError.message}）。请安装 Tesseract 或设置 ASVS_QA_TESSERACT_BIN。`,
      );
    }
    if (result.timedOut) {
      throw new QaOcrUnavailableError(`OCR 超时（${options.timeoutMs ?? this.timeoutMs}ms）：${imagePath}`);
    }
    if (result.code !== 0) {
      throw new QaOcrUnavailableError(
        `OCR 进程退出码 ${result.code}：${result.stderr.trim().slice(0, 300)}`,
      );
    }
    return {
      text: result.stdout.replace(/\r\n/g, '\n').trim(),
      synthetic: false,
      durationMs: Date.now() - startedAt,
    };
  }
}

export interface DeterministicTestOcrOptions {
  /** Explicit `imagePath → text` map; wins over sidecar files. */
  fixtures?: Record<string, string> | Map<string, string>;
}

/**
 * Offline OCR double. Deterministic by construction: the same image path and
 * fixtures always yield the same text, and nothing is ever inferred from the
 * pixels — hence `synthetic: true`.
 */
export class DeterministicTestOcrAdapter implements ImageOcrPort {
  readonly provider = 'deterministic_test' as const;
  readonly synthetic = true;
  private readonly fixtures: Map<string, string>;

  constructor(options: DeterministicTestOcrOptions = {}) {
    const entries =
      options.fixtures instanceof Map
        ? [...options.fixtures.entries()]
        : Object.entries(options.fixtures ?? {});
    this.fixtures = new Map(entries);
  }

  isConfigured(): boolean {
    return true;
  }

  health(): QaOcrHealth {
    return { provider: this.provider, configured: true, language: 'test-fixture' };
  }

  async extractText(
    imagePath: string,
    options: { signal?: AbortSignal; timeoutMs?: number } = {},
  ): Promise<OcrExtractionResult> {
    const startedAt = Date.now();
    if (options.signal?.aborted) {
      throw new QaOcrUnavailableError('OCR 已中止（运行被取消）');
    }
    const fixture = this.fixtures.get(imagePath);
    if (fixture !== undefined) {
      return { text: fixture, synthetic: true, durationMs: Date.now() - startedAt };
    }
    const sidecar = `${imagePath}.ocr.txt`;
    if (existsSync(sidecar)) {
      return {
        text: readFileSync(sidecar, 'utf8').replace(/\r\n/g, '\n').trim(),
        synthetic: true,
        durationMs: Date.now() - startedAt,
      };
    }
    // No fixture and no sidecar means "the test never said what this image
    // contains" — an empty read, not an error, so whole-suite runs stay green.
    return { text: '', synthetic: true, durationMs: Date.now() - startedAt };
  }
}

export class UnconfiguredOcrAdapter implements ImageOcrPort {
  readonly provider = 'unconfigured' as const;
  readonly synthetic = false;

  isConfigured(): boolean {
    return false;
  }

  health(): QaOcrHealth {
    return { provider: this.provider, configured: false, language: 'none' };
  }

  async extractText(): Promise<OcrExtractionResult> {
    throw new QaOcrUnavailableError(
      'OCR 未配置（ASVS_QA_OCR_PROVIDER=unconfigured）：存在需要扫描的真实帧/截图，按 fail-closed 阻断。',
    );
  }
}

export type { QaOcrUnavailableErrorType };
