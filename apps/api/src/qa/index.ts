import type { ImageOcrPort, QaRuntimeConfig, QaRunnerPort } from '@asvs/ports';
import { IndependentQaRunner } from './independent-qa-runner';
import {
  DeterministicTestOcrAdapter,
  TesseractCliOcrAdapter,
  UnconfiguredOcrAdapter,
} from './ocr-adapters';

/**
 * Step 5D QA module entry point (docs/16 §5).
 *
 * `createOcrAdapter` is the single place that maps the configured provider to
 * an adapter, so `buildApp` and the test doubles cannot disagree about what
 * `ASVS_QA_OCR_PROVIDER=unconfigured` means: it always fails closed.
 */
export function createOcrAdapter(config: QaRuntimeConfig, fixtures?: Record<string, string>): ImageOcrPort {
  switch (config.ocrProvider) {
    case 'deterministic_test':
      return new DeterministicTestOcrAdapter(fixtures ? { fixtures } : {});
    case 'unconfigured':
      return new UnconfiguredOcrAdapter();
    case 'tesseract_cli':
    default:
      return new TesseractCliOcrAdapter({
        bin: config.tesseractBin,
        language: config.ocrLanguage,
        timeoutMs: config.ocrTimeoutMs,
      });
  }
}

export interface CreateQaRunnerOptions {
  config: QaRuntimeConfig;
  ocr?: ImageOcrPort;
  logger?: { warn(message: string): void; info?(message: string): void };
}

export function createQaRunner(options: CreateQaRunnerOptions): QaRunnerPort {
  const ocr = options.ocr ?? createOcrAdapter(options.config);
  return new IndependentQaRunner({
    config: options.config,
    ocr,
    ...(options.logger ? { logger: options.logger } : {}),
  });
}

export { IndependentQaRunner } from './independent-qa-runner';
export {
  DeterministicTestOcrAdapter,
  TesseractCliOcrAdapter,
  UnconfiguredOcrAdapter,
} from './ocr-adapters';
export { PRIVACY_RULE_META, scanText } from './privacy-scanner';
export { buildSceneWindows, mapTimestampToScene } from './scene-mapper';
