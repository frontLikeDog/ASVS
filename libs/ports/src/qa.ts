import type {
  QaCategory,
  QaCheckStatus,
  QaCheckSummaryV1,
  QaFindingV1,
  QaReportEnvelopeV1,
  QaRemediationAction,
  QaSeverity,
  QaSourceKind,
  QaStage,
  QaVerdict,
} from '@asvs/domain';

/**
 * Step 5D · independent QA boundary (docs/16 §3.3).
 *
 * The orchestrator never talks to ffmpeg/tesseract/zip internals directly: it
 * hands the runner a description of the exact files to judge, and the runner
 * returns a fully-formed `QaReportV1` plus the evidence frames it produced.
 * That indirection is what lets the 5A/5B/5C unit tests and the E2E fixture
 * inject a deterministic double instead of feeding fake MP4 bytes to ffprobe
 * (docs/16 red line 4).
 */

/** One screenshot the capture worker produced for a plan step. */
export interface QaCaptureScreenshotInput {
  file: string;
  stepId?: string;
  startedAtMs?: number;
}

/** A real capture clip bound into the render input. */
export interface QaCaptureClipInput {
  assetId?: string;
  file: string;
  sha256: string;
  durationMs?: number;
}

export interface QaCaptureInput {
  runId: string;
  workspaceId: string;
  projectId: string;
  videoId: string;
  scriptVersion: number;
  inputDigest: string;
  /** `<runDir>`; the runner writes `<runDir>/qa/**` and nothing else. */
  runDir: string;
  /** `<runDir>/input.json` (frozen `RenderInputV1` + `capture` provenance). */
  frozenInputFile: string;
  captureReceiptFile?: string;
  captureTraceFile?: string;
  clips: QaCaptureClipInput[];
  screenshots: QaCaptureScreenshotInput[];
  /** The Gate 2 draft, so plan text is scanned for leaks as well. */
  demoPlanFile?: string;
}

export interface QaFinalInput {
  runId: string;
  workspaceId: string;
  projectId: string;
  videoId: string;
  scriptVersion: number;
  inputDigest: string;
  runDir: string;
  frozenInputFile: string;
  videoFile: string;
  manifestFile: string;
  receiptFile: string;
  subtitlesFile?: string;
  /** Present when this run captured for real; its evidence is scanned again. */
  capture?: QaCaptureInput;
  /** Current workspace snapshot used for claim / banned-phrase rechecks. */
  workspace: import('@asvs/domain').StudioSnapshot;
}

export interface QaEvidenceFrameResult {
  findingId: string;
  file: string;
  sha256: string;
  byteSize: number;
  redacted: boolean;
}

export interface QaRunnerCallbacks {
  onCheckpoint?(phase: string, payload: Record<string, unknown>): void;
  onLog?(level: 'info' | 'warn' | 'error', message: string): void;
}

/**
 * Outcome of one QA stage. A report is always produced — even on an internal
 * executor error the runner still emits a `fail` report with a blocker finding,
 * so the Gate 3 page can explain what happened instead of showing nothing.
 */
export interface QaRunOutcome {
  report: import('@asvs/domain').QaReportV1;
  /** Absolute path of the written `qa-{stage}-report.json`. */
  reportFile: string;
  reportSha256: string;
  evidenceFrames: QaEvidenceFrameResult[];
  /** Non-null only for a runner-internal crash (maps to `qa_execution_failed`). */
  executionError?: string;
}

export interface QaOcrHealth {
  provider: 'tesseract_cli' | 'deterministic_test' | 'unconfigured';
  configured: boolean;
  language: string;
}

export interface OcrExtractionResult {
  text: string;
  /** True for the deterministic test adapter; surfaced in report coverage. */
  synthetic: boolean;
  durationMs: number;
}

export class QaOcrUnavailableError extends Error {
  readonly code = 'qa_ocr_unavailable';

  constructor(message: string) {
    super(message);
    this.name = 'QaOcrUnavailableError';
  }
}

/** Single-image text extraction (AC-07: images must be read, not guessed). */
export interface ImageOcrPort {
  readonly provider: QaOcrHealth['provider'];
  readonly synthetic: boolean;
  isConfigured(): boolean;
  health(): QaOcrHealth;
  extractText(
    imagePath: string,
    options?: { signal?: AbortSignal; timeoutMs?: number },
  ): Promise<OcrExtractionResult>;
}

/**
 * `/v1/health` QA block. Never contains paths, binary names or credentials —
 * only whether the gate is active and which OCR provider backs it, so the UI
 * can warn honestly when image scanning would fail closed.
 */
export interface QaHealth {
  enabled: boolean;
  ocrProvider: QaOcrHealth['provider'];
  ocrConfigured: boolean;
  policyVersion: string;
}

export interface QaRuntimeConfig {
  enabled: boolean;
  ocrProvider: QaOcrHealth['provider'];
  tesseractBin: string;
  ocrLanguage: string;
  ocrTimeoutMs: number;
  maxFrames: number;
  blackBlockMs: number;
  freezeBlockMs: number;
  allowlistedDomains: string[];
  ffmpegBin: string;
  ffprobeBin: string;
  /** Hard cap on `trace.zip` frames fed to OCR per stage. */
  maxTraceFrames: number;
}

/**
 * The QA executor. Implementations must resolve (never reject) with a report;
 * `abort()` kills any in-flight ffmpeg/ffprobe/tesseract child so a cancelled
 * run does not leave a decoder running.
 */
export interface QaRunnerPort {
  runCaptureQa(input: QaCaptureInput, callbacks?: QaRunnerCallbacks): Promise<QaRunOutcome>;
  runFinalQa(input: QaFinalInput, callbacks?: QaRunnerCallbacks): Promise<QaRunOutcome>;
  health(): QaHealth;
  abort(): void;
  isRunning(): boolean;
}

export type { QaCategory, QaCheckStatus, QaCheckSummaryV1, QaFindingV1, QaRemediationAction, QaSeverity, QaSourceKind, QaStage, QaVerdict };

/** Report envelope both QA read routes return (`docs/16 §6.2`). */
export type { QaReportEnvelopeV1 };

/** Client shape returned by `getRunQaReport` / `getLatestQaReport`. */
export interface QaReportResponse {
  run: import('@asvs/domain').OrchestrationRunV1;
  report: import('@asvs/domain').QaReportV1;
  reportArtifact: import('@asvs/domain').OrchestrationArtifactV1;
  evidenceArtifacts: import('@asvs/domain').OrchestrationArtifactV1[];
}
