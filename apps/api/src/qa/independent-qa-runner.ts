import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import {
  QA_POLICY_VERSION,
  QA_SCHEMA_VERSION,
  captureReceiptV1Schema,
  parseAndValidateSrt,
  qaReportV1Schema,
  renderManifestV1Schema,
  type QaCategory,
  type QaCheckSummaryV1,
  type QaCoverageV1,
  type QaFindingV1,
  type QaLocationV1,
  type QaReportV1,
  type QaSeverity,
  type QaSourceKind,
  type QaSubjectDigestsV1,
  type QaVerdict,
} from '@asvs/domain';
import type {
  ImageOcrPort,
  QaCaptureInput,
  QaEvidenceFrameResult,
  QaFinalInput,
  QaHealth,
  QaRunOutcome,
  QaRunnerCallbacks,
  QaRunnerPort,
  QaRuntimeConfig,
} from '@asvs/ports';
import { QaOcrUnavailableError } from '@asvs/ports';
import {
  collectBannedPhraseFindings,
  collectBrandKitFindings,
  collectCaptureProvenanceFindings,
  collectClaimEligibilityFindings,
  collectNarrationContentFindings,
  collectSyntheticVoiceNotice,
  type FactContentFindingDraft,
} from './fact-content-qa';
import {
  extractFrameAt,
  planClipFrameTimes,
  planSceneFrameTimes,
  readPngTextChunks,
  renderAnnotatedEvidence,
  renderRedactedEvidence,
} from './frame-extractor';
import {
  assertDecodable,
  audioSyncDriftMs,
  coverageOfWindow,
  detectBlackSpans,
  detectFreezeSpans,
  measureVolume,
  probeMedia,
  type MediaProbe,
  type MediaTools,
} from './media-qa';
import { PRIVACY_RULE_META, scanJsonStrings, scanText, type PrivacyMatch } from './privacy-scanner';
import { buildSceneWindows, formatTimestamp, mapCaptureAssetToScenes, mapTimestampToScene, realDemoRanges, type FrozenInputFile, type SceneTimelineWindow } from './scene-mapper';
import { scanPlaywrightTrace } from './trace-scanner';

/**
 * `IndependentQaRunner` — the real `QaRunnerPort` (docs/16 §5).
 *
 * It re-derives every judgement from the bytes on disk (ffprobe/ffmpeg, the
 * ZIP reader, OCR) instead of trusting the capture/render workers. Two
 * invariants shape the code:
 *
 * - **It always answers with a report.** A check that cannot run becomes a
 *   blocker finding (`privacy.ocr_unavailable`, `technical.execution_error`),
 *   never a silent pass; only report-file I/O failures reject, because an
 *   unwritten report means "QA never happened".
 * - **It never echoes a secret.** Privacy hits are reduced to
 *   `matchRedacted` + `matchSha256` at the scanner boundary; evidence frames
 *   for privacy findings are blurred before they leave `qa/frames-tmp/`.
 */

export interface IndependentQaRunnerOptions {
  config: QaRuntimeConfig;
  ocr: ImageOcrPort;
  logger?: { warn(message: string): void; info?(message: string): void };
}

interface RawFinding {
  ruleId: string;
  category: QaCategory;
  severity: QaSeverity;
  sourceKind: QaSourceKind;
  title: string;
  message: string;
  remediation: string;
  remediationAction: QaFindingV1['remediationAction'];
  location: QaLocationV1;
  matchRedacted?: string;
  matchSha256?: string;
  metrics?: Record<string, number | string | boolean>;
  /** Source image inside `qa/frames-tmp`; only ever used for evidence. */
  sourceImage?: string;
  /** True when the source image contains a privacy hit → blur evidence. */
  privacyImage?: boolean;
  /** Millisecond position the evidence frame should be captured at. */
  evidenceTimestampMs?: number;
}

interface StageScan {
  findings: RawFinding[];
  coverage: QaCoverageV1;
  subject: QaSubjectDigestsV1;
  executionErrors: string[];
}

/** Fact/content checks speak in scene locations; adapt them to raw findings. */
function fromFactContent(draft: FactContentFindingDraft): RawFinding {
  return {
    ruleId: draft.ruleId,
    category: draft.category,
    severity: draft.severity,
    sourceKind: draft.sourceKind,
    title: draft.title,
    message: draft.message,
    remediation: draft.remediation,
    remediationAction: draft.remediationAction,
    location: {
      scope: draft.sceneId ? 'scene' : 'global',
      ...(draft.sceneId ? { sceneId: draft.sceneId } : {}),
      ...(draft.sceneOrder !== undefined ? { sceneOrder: draft.sceneOrder } : {}),
      ...(draft.sceneTitle ? { sceneTitle: draft.sceneTitle } : {}),
      ...(draft.claimId ? { claimId: draft.claimId } : {}),
      ...(draft.featureId ? { featureId: draft.featureId } : {}),
      ...(draft.assetId ? { assetId: draft.assetId } : {}),
    },
    ...(draft.metrics ? { metrics: draft.metrics } : {}),
  };
}

const MAX_SCENE_TEXT_LENGTH = 20_000;
const MAX_DEMO_PLAN_SCAN_BYTES = 2 * 1024 * 1024;

function sha256OfBuffer(buffer: Buffer): string {
  return createHash('sha256').update(buffer).digest('hex');
}

function sha256OfFile(file: string): string {
  return sha256OfBuffer(readFileSync(file));
}

function safeFileSize(file: string): number {
  try {
    return statSync(file).size;
  } catch {
    return 0;
  }
}

function privacyFinding(match: PrivacyMatch, sourceKind: QaSourceKind, location: QaLocationV1, sourceImage?: string): RawFinding {
  const meta = PRIVACY_RULE_META[match.ruleId];
  return {
    ruleId: match.ruleId,
    category: 'privacy',
    severity: 'blocker',
    sourceKind,
    title: meta.title,
    message: `在${
      sourceKind === 'capture_trace'
        ? '录屏 Trace'
        : sourceKind === 'capture_screenshot'
          ? '断言截图'
          : sourceKind === 'capture_frame'
            ? '录屏帧'
            : sourceKind === 'render_frame'
              ? '成片帧'
              : sourceKind === 'subtitle_srt'
                ? '字幕'
                : sourceKind === 'demo_plan'
                  ? '演示计划'
                  : '镜头文案'
    }中检测到敏感信息（${match.ruleId}）。命中原文已丢弃，仅保留掩码与不可逆哈希。`,
    remediation: meta.remediation,
    remediationAction: 'production',
    location,
    matchRedacted: match.matchRedacted,
    matchSha256: match.matchSha256,
    ...(sourceImage ? { sourceImage, privacyImage: true } : {}),
  };
}

/** SRT cue parser for locating subtitle hits to a timestamp. */
function scanSrtCues(content: string): { findings: RawFinding[]; cueCount: number } {
  const normalized = content.replace(/\r\n/g, '\n').replace(/^\u{FEFF}/u, '');
  const blocks = normalized.split(/\n{2,}/);
  const findings: RawFinding[] = [];
  let cueCount = 0;
  for (const [index, block] of blocks.entries()) {
    const lines = block.split('\n');
    if (lines.length < 3) continue;
    const timing = lines[1]?.match(/^(\d{2}):(\d{2}):(\d{2}),(\d{3})\s+-->/);
    if (!timing) continue;
    cueCount += 1;
    const startMs =
      Number(timing[1]) * 3_600_000 +
      Number(timing[2]) * 60_000 +
      Number(timing[3]) * 1_000 +
      Number(timing[4]);
    const text = lines.slice(2).join('\n');
    for (const match of scanText(text)) {
      findings.push({
        ...privacyFinding(match, 'subtitle_srt', { scope: 'global', timestampMs: startMs }),
        remediationAction: 'editor',
        metrics: { cueIndex: index + 1, cueStartMs: startMs },
      });
    }
  }
  return { findings, cueCount };
}

/**
 * Collapse repeated privacy hits of the same value:
 * trace hits collapse per (ruleId, sha) with an occurrence count and the first
 * entry path (a token in every request header is one finding, not 200);
 * image hits stay per (ruleId, sha, frame) because the frame locates them;
 * scene/SRT hits stay per (ruleId, sha, scene/timestamp).
 */
function dedupePrivacy(findings: RawFinding[]): RawFinding[] {
  const output: RawFinding[] = [];
  const traceIndex = new Map<string, RawFinding>();
  const seen = new Set<string>();
  for (const finding of findings) {
    if (finding.category !== 'privacy' || !finding.matchSha256) {
      output.push(finding);
      continue;
    }
    if (finding.sourceKind === 'capture_trace') {
      const key = `${finding.ruleId}:${finding.matchSha256}`;
      const existing = traceIndex.get(key);
      if (existing) {
        const count = Number(existing.metrics?.occurrences ?? 1) + 1;
        existing.metrics = { ...existing.metrics, occurrences: count };
        continue;
      }
      const copy: RawFinding = { ...finding, metrics: { ...finding.metrics, occurrences: 1 } };
      traceIndex.set(key, copy);
      output.push(copy);
      continue;
    }
    const key = [
      finding.ruleId,
      finding.matchSha256,
      finding.sourceKind,
      finding.location.sceneId ?? '',
      finding.location.frameIndex ?? '',
      finding.location.timestampMs ?? '',
    ].join('|');
    if (seen.has(key)) continue;
    seen.add(key);
    output.push(finding);
  }
  return output;
}

const SEVERITY_ORDER: Record<QaSeverity, number> = { blocker: 0, warning: 1, info: 2 };

function sortFindings(findings: RawFinding[]): RawFinding[] {
  return [...findings].sort((left, right) => {
    const severity = SEVERITY_ORDER[left.severity] - SEVERITY_ORDER[right.severity];
    if (severity !== 0) return severity;
    const scene = (left.location.sceneOrder ?? Number.MAX_SAFE_INTEGER) -
      (right.location.sceneOrder ?? Number.MAX_SAFE_INTEGER);
    if (scene !== 0) return scene;
    const time = (left.location.timestampMs ?? Number.MAX_SAFE_INTEGER) -
      (right.location.timestampMs ?? Number.MAX_SAFE_INTEGER);
    if (time !== 0) return time;
    return left.ruleId.localeCompare(right.ruleId);
  });
}

function buildChecks(findings: QaFindingV1[]): QaCheckSummaryV1[] {
  const labels: Record<QaCategory, string> = {
    privacy: 'AC-07 隐私守门',
    technical: '技术 QA',
    fact: '事实与声明',
    content: '内容与品牌',
  };
  return (['privacy', 'technical', 'fact', 'content'] as const).map((category) => {
    const categoryFindings = findings.filter((finding) => finding.category === category);
    const blockers = categoryFindings.filter((finding) => finding.severity === 'blocker').length;
    const warnings = categoryFindings.filter((finding) => finding.severity === 'warning').length;
    const infos = categoryFindings.filter((finding) => finding.severity === 'info').length;
    return {
      category,
      status: blockers > 0 ? 'fail' : warnings > 0 ? 'warn' : 'pass',
      blockerCount: blockers,
      warningCount: warnings,
      infoCount: infos,
      summary:
        categoryFindings.length === 0
          ? `${labels[category]}：未发现问题`
          : `${labels[category]}：${blockers} 项阻断 / ${warnings} 项提醒 / ${infos} 项提示`,
    } satisfies QaCheckSummaryV1;
  });
}

function verdictOf(findings: QaFindingV1[]): QaVerdict {
  if (findings.some((finding) => finding.severity === 'blocker')) return 'fail';
  if (findings.some((finding) => finding.severity === 'warning')) return 'pass_with_warnings';
  return 'pass';
}

function summarizeChecks(findings: RawFinding[]) {
  const blockers = findings.filter((finding) => finding.severity === 'blocker');
  return {
    totalFindings: findings.length,
    blockerCount: blockers.length,
    warningCount: findings.filter((finding) => finding.severity === 'warning').length,
    infoCount: findings.filter((finding) => finding.severity === 'info').length,
    privacyBlockerCount: blockers.filter((finding) => finding.category === 'privacy').length,
    technicalBlockerCount: blockers.filter((finding) => finding.category === 'technical').length,
    factBlockerCount: blockers.filter((finding) => finding.category === 'fact').length,
    contentBlockerCount: blockers.filter((finding) => finding.category === 'content').length,
  };
}

function healthOf(config: QaRuntimeConfig, ocr: ImageOcrPort): QaHealth {
  return {
    enabled: config.enabled,
    ocrProvider: ocr.provider,
    ocrConfigured: ocr.isConfigured(),
    policyVersion: QA_POLICY_VERSION,
  };
}

/** Frame-level image check shared by screenshots, clip frames and film frames. */
interface ImageScanContext {
  ocr: ImageOcrPort;
  allowlistedDomains: string[];
  signal?: AbortSignal;
  timeoutMs: number;
}

interface ImageScanResult {
  findings: RawFinding[];
  ocrExecuted: boolean;
  ocrUnavailable?: string;
}

async function scanImage(
  file: string,
  sourceKind: QaSourceKind,
  location: QaLocationV1,
  context: ImageScanContext,
): Promise<ImageScanResult> {
  const findings: RawFinding[] = [];
  if (!existsSync(file)) return { findings, ocrExecuted: false };

  // 1 · PNG ancillary text chunks can smuggle data no OCR would ever read.
  const buffer = readFileSync(file);
  for (const chunk of readPngTextChunks(buffer)) {
    for (const match of scanText(`${chunk.keyword}: ${chunk.text}`, {
      allowlistedDomains: context.allowlistedDomains,
    })) {
      findings.push({
        ...privacyFinding(match, sourceKind, location, file),
        metrics: { pngChunk: chunk.keyword },
      });
    }
  }

  // 2 · OCR. Fail closed: an unread image is not a checked image.
  if (!context.ocr.isConfigured()) {
    return {
      findings,
      ocrExecuted: false,
      ocrUnavailable: 'OCR 未配置（ASVS_QA_OCR_PROVIDER=unconfigured）',
    };
  }
  try {
    const result = await context.ocr.extractText(file, {
      ...(context.signal ? { signal: context.signal } : {}),
      timeoutMs: context.timeoutMs,
    });
    for (const match of scanText(result.text, { allowlistedDomains: context.allowlistedDomains })) {
      findings.push(privacyFinding(match, sourceKind, location, file));
    }
    return { findings, ocrExecuted: true };
  } catch (error) {
    if (error instanceof QaOcrUnavailableError) {
      return { findings, ocrExecuted: false, ocrUnavailable: error.message };
    }
    return {
      findings,
      ocrExecuted: false,
      ocrUnavailable: error instanceof Error ? error.message : String(error),
    };
  }
}

function ocrUnavailableFinding(message: string): RawFinding {
  return {
    ruleId: 'privacy.ocr_unavailable',
    category: 'privacy',
    severity: 'blocker',
    sourceKind: 'capture_frame',
    title: PRIVACY_RULE_META['privacy.ocr_unavailable'].title,
    message: `存在需要扫描的真实帧/截图，但 OCR 未能执行：${message}。按 fail-closed 阻断，绝不宣称图像已通过隐私检查。`,
    remediation: PRIVACY_RULE_META['privacy.ocr_unavailable'].remediation,
    remediationAction: 'production',
    location: { scope: 'global' },
  };
}

function executionErrorFinding(message: string, sourceKind: QaSourceKind = 'video_stream'): RawFinding {
  return {
    ruleId: 'technical.execution_error',
    category: 'technical',
    severity: 'blocker',
    sourceKind,
    title: 'QA 检查执行失败',
    message: `独立 QA 未能完成检查：${message}`,
    remediation: '确认 ffmpeg / ffprobe 已正确安装，然后重新运行；如持续失败请查看服务端日志。',
    remediationAction: 'production',
    location: { scope: 'global' },
  };
}

export class IndependentQaRunner implements QaRunnerPort {
  private readonly config: QaRuntimeConfig;
  private readonly ocr: ImageOcrPort;
  private readonly logger?: IndependentQaRunnerOptions['logger'];
  private readonly tools: MediaTools;
  private controller: AbortController | null = null;
  private running = false;

  constructor(options: IndependentQaRunnerOptions) {
    this.config = options.config;
    this.ocr = options.ocr;
    this.logger = options.logger;
    this.tools = { ffmpegBin: options.config.ffmpegBin, ffprobeBin: options.config.ffprobeBin };
  }

  health(): QaHealth {
    return healthOf(this.config, this.ocr);
  }

  abort(): void {
    this.controller?.abort();
  }

  isRunning(): boolean {
    return this.running;
  }

  async runCaptureQa(input: QaCaptureInput, callbacks?: QaRunnerCallbacks): Promise<QaRunOutcome> {
    return this.withRun(async (signal) => {
      const scan = await this.scanCaptureStage(input, signal, callbacks);
      return this.finalizeStage('capture', input, scan, callbacks);
    });
  }

  async runFinalQa(input: QaFinalInput, callbacks?: QaRunnerCallbacks): Promise<QaRunOutcome> {
    return this.withRun(async (signal) => {
      const scan = await this.scanFinalStage(input, signal, callbacks);
      return this.finalizeStage('final', input, scan, callbacks);
    });
  }

  private async withRun(
    body: (signal: AbortSignal) => Promise<QaRunOutcome>,
  ): Promise<QaRunOutcome> {
    const controller = new AbortController();
    this.controller = controller;
    this.running = true;
    try {
      return await body(controller.signal);
    } finally {
      this.running = false;
      this.controller = null;
    }
  }

  private emptyCoverage(): QaCoverageV1 {
    return {
      scannedCaptureFrames: 0,
      scannedRenderFrames: 0,
      scannedScreenshots: 0,
      scannedTraceEntries: 0,
      skippedTraceStaticEntries: 0,
      scannedScenes: 0,
      scannedSrtCues: 0,
      ocrProvider: this.ocr.provider,
      ocrExecuted: false,
      ocrSynthetic: this.ocr.synthetic,
      allowlistedDomains: this.config.allowlistedDomains,
    };
  }

  private readFrozen(input: QaCaptureInput | QaFinalInput): FrozenInputFile {
    return JSON.parse(readFileSync(input.frozenInputFile, 'utf8')) as FrozenInputFile;
  }

  private scanSceneText(
    frozen: FrozenInputFile,
    windows: SceneTimelineWindow[],
  ): RawFinding[] {
    const findings: RawFinding[] = [];
    for (const scene of frozen.input.storyboard.scenes) {
      const window = windows.find((entry) => entry.sceneId === scene.id);
      const text = [scene.title, scene.narration, scene.caption, ...scene.onScreenText]
        .join('\n')
        .slice(0, MAX_SCENE_TEXT_LENGTH);
      for (const match of scanText(text, { allowlistedDomains: this.config.allowlistedDomains })) {
        findings.push(
          privacyFinding(match, 'scene_text', {
            scope: 'scene',
            ...(window
              ? { sceneId: scene.id, sceneOrder: window.sceneOrder, sceneTitle: window.sceneTitle }
              : {}),
          }),
        );
      }
    }
    return findings;
  }

  private scanDemoPlan(file: string | undefined): RawFinding[] {
    if (!file || !existsSync(file)) return [];
    const raw = readFileSync(file);
    const text = raw.subarray(0, MAX_DEMO_PLAN_SCAN_BYTES).toString('utf8');
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = text;
    }
    const findings: RawFinding[] = [];
    if (typeof parsed === 'string') {
      for (const match of scanText(parsed, { allowlistedDomains: this.config.allowlistedDomains })) {
        findings.push(privacyFinding(match, 'demo_plan', { scope: 'global' }));
      }
      return findings;
    }
    for (const hit of scanJsonStrings(parsed, { allowlistedDomains: this.config.allowlistedDomains })) {
      findings.push(
        privacyFinding(hit, 'demo_plan', { scope: 'global', traceEntryPath: hit.path }),
      );
    }
    return findings;
  }

  private async scanCaptureEvidence(
    capture: QaCaptureInput,
    frozen: FrozenInputFile,
    windows: SceneTimelineWindow[],
    signal: AbortSignal,
    coverage: QaCoverageV1,
    executionErrors: string[],
    tempDir: string,
    callbacks?: QaRunnerCallbacks,
  ): Promise<RawFinding[]> {
    const findings: RawFinding[] = [];
    const imageContext: ImageScanContext = {
      ocr: this.ocr,
      allowlistedDomains: this.config.allowlistedDomains,
      signal,
      timeoutMs: this.config.ocrTimeoutMs,
    };
    const ocrFailures: string[] = [];
    let ocrExecuted = false;

    // Screenshots: all of them, every time.
    const receipt = this.readReceipt(capture.captureReceiptFile);
    const stepByScreenshot = new Map<string, { stepId: string; startedAtMs: number }>();
    for (const step of receipt?.steps ?? []) {
      if (step.screenshot) {
        stepByScreenshot.set(path.basename(step.screenshot), {
          stepId: step.id,
          startedAtMs: step.startedAtMs,
        });
      }
    }
    const assetId = receipt?.asset.id ?? capture.clips[0]?.assetId;
    const referencingScenes = assetId ? mapCaptureAssetToScenes(windows, assetId) : [];
    const sceneLocation = referencingScenes[0];

    for (const screenshot of capture.screenshots) {
      if (!existsSync(screenshot.file)) continue;
      coverage.scannedScreenshots += 1;
      const meta = stepByScreenshot.get(path.basename(screenshot.file));
      const stepId = screenshot.stepId ?? meta?.stepId;
      const startedAtMs = screenshot.startedAtMs ?? meta?.startedAtMs;
      const result = await scanImage(
        screenshot.file,
        'capture_screenshot',
        {
          scope: sceneLocation ? 'scene' : 'global',
          ...(sceneLocation
            ? {
                sceneId: sceneLocation.sceneId,
                sceneOrder: sceneLocation.sceneOrder,
                sceneTitle: sceneLocation.sceneTitle,
                assetId: assetId!,
              }
            : {}),
          ...(stepId ? { stepId } : {}),
          ...(startedAtMs !== undefined ? { timestampMs: startedAtMs } : {}),
        },
        imageContext,
      );
      findings.push(...result.findings);
      ocrExecuted = ocrExecuted || result.ocrExecuted;
      if (result.ocrUnavailable) ocrFailures.push(result.ocrUnavailable);
    }

    // Clip frames: 1 fps + first/last, capped, deduped by SHA256.
    for (const clip of capture.clips) {
      if (!existsSync(clip.file)) {
        executionErrors.push(`录屏片段不存在：${path.basename(clip.file)}`);
        continue;
      }
      const probe = await this.safeProbe(clip.file, executionErrors);
      const durationMs = clip.durationMs ?? probe?.durationMs ?? 0;
      const points = planClipFrameTimes(durationMs, this.config.maxFrames, 1).map((timestampMs) => ({
        timestampMs,
      }));
      const seen = new Set<string>();
      for (const [index, point] of points.entries()) {
        if (signal.aborted) break;
        const frameFile = path.join(tempDir, `capture-${index}.png`);
        try {
          const sha = await extractFrameAt(clip.file, point.timestampMs, frameFile, this.tools, { signal });
          if (seen.has(sha)) {
            rmSync(frameFile, { force: true });
            continue;
          }
          seen.add(sha);
        } catch (error) {
          executionErrors.push(
            `录屏抽帧失败：${error instanceof Error ? error.message : String(error)}`,
          );
          break;
        }
        coverage.scannedCaptureFrames += 1;
        const window = mapTimestampToScene(
          referencingScenes.length > 0 ? referencingScenes : [],
          point.timestampMs,
        );
        const result = await scanImage(
          frameFile,
          'capture_frame',
          {
            scope: window ? 'scene' : 'global',
            ...(window
              ? {
                  sceneId: window.sceneId,
                  sceneOrder: window.sceneOrder,
                  sceneTitle: window.sceneTitle,
                }
              : {}),
            ...(assetId ? { assetId } : {}),
            timestampMs: point.timestampMs,
            frameIndex: index,
          },
          imageContext,
        );
        findings.push(...result.findings);
        ocrExecuted = ocrExecuted || result.ocrExecuted;
        if (result.ocrUnavailable) ocrFailures.push(result.ocrUnavailable);
        if (!result.findings.some((finding) => finding.sourceImage === frameFile)) {
          rmSync(frameFile, { force: true });
        }
      }
    }

    // Trace: dedicated NDJSON/network scan + OCR of deduped screencast frames.
    if (capture.captureTraceFile && existsSync(capture.captureTraceFile)) {
      try {
        const stepWindows = (receipt?.steps ?? []).map((step) => ({
          stepId: step.id,
          startMs: step.startedAtMs,
          endMs: step.startedAtMs + step.durationMs,
        }));
        const trace = scanPlaywrightTrace(readFileSync(capture.captureTraceFile), {
          allowlistedDomains: this.config.allowlistedDomains,
          maxTraceFrames: this.config.maxTraceFrames,
          stepWindows,
        });
        coverage.scannedTraceEntries += trace.scannedEntries;
        coverage.skippedTraceStaticEntries += trace.skippedStaticEntries;
        for (const finding of trace.findings) {
          const meta = PRIVACY_RULE_META[finding.ruleId];
          const scene = referencingScenes[0];
          findings.push({
            ruleId: finding.ruleId,
            category: 'privacy',
            severity: 'blocker',
            sourceKind: 'capture_trace',
            title: meta.title,
            message: `在 Playwright Trace 条目 ${finding.traceEntryPath} 中检测到敏感信息（${finding.ruleId}）。命中原文已丢弃。`,
            remediation: meta.remediation,
            remediationAction: 'production',
            location: {
              scope: scene ? 'scene' : 'global',
              ...(scene
                ? { sceneId: scene.sceneId, sceneOrder: scene.sceneOrder, sceneTitle: scene.sceneTitle }
                : {}),
              traceEntryPath: finding.traceEntryPath,
              ...(finding.stepId ? { stepId: finding.stepId } : {}),
              ...(finding.timestampMs !== undefined ? { timestampMs: finding.timestampMs } : {}),
              ...(assetId ? { assetId } : {}),
            },
            matchRedacted: finding.matchRedacted,
            matchSha256: finding.matchSha256,
          });
        }
        for (const frame of trace.screencastFrames) {
          if (signal.aborted) break;
          const frameFile = path.join(tempDir, `trace-${frame.sha1}.jpeg`);
          writeFileSync(frameFile, frame.bytes);
          coverage.scannedCaptureFrames += 1;
          const result = await scanImage(
            frameFile,
            'capture_trace',
            {
              scope: 'global',
              traceEntryPath: frame.traceEntryPath,
              ...(frame.timestampMs !== undefined ? { timestampMs: frame.timestampMs } : {}),
              ...(assetId ? { assetId } : {}),
            },
            imageContext,
          );
          findings.push(
            ...result.findings.map((finding) => ({
              ...finding,
              location: { ...finding.location, traceEntryPath: frame.traceEntryPath },
            })),
          );
          ocrExecuted = ocrExecuted || result.ocrExecuted;
          if (result.ocrUnavailable) ocrFailures.push(result.ocrUnavailable);
          if (!result.findings.some((finding) => finding.sourceImage === frameFile)) {
            rmSync(frameFile, { force: true });
          }
        }
      } catch (error) {
        executionErrors.push(
          `Trace 解析失败：${error instanceof Error ? error.message : String(error)}`,
        );
        callbacks?.onLog?.('error', 'Trace 解析失败');
      }
    }

    coverage.ocrExecuted = coverage.ocrExecuted || ocrExecuted;
    if (ocrFailures.length > 0) {
      // One blocker explains the whole stage; repeating it per frame would be
      // noise, and the report must not pretend the images were checked.
      findings.push(ocrUnavailableFinding(ocrFailures[0]!));
    }
    return findings;
  }

  private readReceipt(file: string | undefined) {
    if (!file || !existsSync(file)) return null;
    try {
      return captureReceiptV1Schema.parse(JSON.parse(readFileSync(file, 'utf8')));
    } catch (error) {
      this.logger?.warn(`QA 无法解析 capture-receipt：${error instanceof Error ? error.message : error}`);
      return null;
    }
  }

  private async safeProbe(file: string, executionErrors: string[]): Promise<MediaProbe | null> {
    try {
      return await probeMedia(file, this.tools, { signal: this.controller?.signal });
    } catch (error) {
      executionErrors.push(error instanceof Error ? error.message : String(error));
      return null;
    }
  }

  private async scanCaptureStage(
    input: QaCaptureInput,
    signal: AbortSignal,
    callbacks?: QaRunnerCallbacks,
  ): Promise<StageScan> {
    const coverage = this.emptyCoverage();
    const findings: RawFinding[] = [];
    const executionErrors: string[] = [];
    const frozen = this.readFrozen(input);
    const windows = buildSceneWindows(frozen);
    const tempDir = path.join(input.runDir, 'qa', 'frames-tmp');

    callbacks?.onCheckpoint?.('qa_media_checked', { stage: 'capture', clips: input.clips.length });

    findings.push(...this.scanSceneText(frozen, windows));
    coverage.scannedScenes = frozen.input.storyboard.scenes.length;
    findings.push(...this.scanDemoPlan(input.demoPlanFile));

    const receipt = this.readReceipt(input.captureReceiptFile);
    const clip = input.clips[0];
    const clipSha = clip && existsSync(clip.file) ? sha256OfFile(clip.file) : clip?.sha256;

    // Technical QA on the clip itself.
    if (clip && existsSync(clip.file)) {
      const decode = await this.safeDecode(clip.file, executionErrors);
      if (decode && !decode.ok) {
        findings.push({
          ruleId: 'technical.video_decodable',
          category: 'technical',
          severity: 'blocker',
          sourceKind: 'video_stream',
          title: '录屏片段无法完整解码',
          message: `ffmpeg 解码录屏片段时报告错误：${decode.stderr.slice(0, 300)}`,
          remediation: '重新执行 Gate 2 录屏；如反复失败，检查浏览器录制是否在写入时被中断。',
          remediationAction: 'production',
          location: { scope: 'global', ...(clip.assetId ? { assetId: clip.assetId } : {}) },
        });
      }
      const probe = await this.safeProbe(clip.file, executionErrors);
      if (probe && receipt) {
        const mismatches: string[] = [];
        if (probe.video?.width !== receipt.clip.width || probe.video?.height !== receipt.clip.height) {
          mismatches.push(`尺寸 ${probe.video?.width}×${probe.video?.height} ≠ 回执 ${receipt.clip.width}×${receipt.clip.height}`);
        }
        if (probe.video?.fps && Math.abs(probe.video.fps - receipt.clip.fps) > 0.05) {
          mismatches.push(`帧率 ${probe.video.fps.toFixed(2)} ≠ 回执 ${receipt.clip.fps}`);
        }
        if (probe.durationMs > 0 && Math.abs(probe.durationMs - receipt.clip.durationMs) > 250) {
          mismatches.push(`时长 ${probe.durationMs}ms ≠ 回执 ${receipt.clip.durationMs}ms`);
        }
        if (clipSha && clipSha !== receipt.clip.sha256) {
          mismatches.push('磁盘片段 SHA256 与回执不一致');
        }
        if (mismatches.length > 0) {
          findings.push({
            ruleId: 'technical.probe_mismatch',
            category: 'technical',
            severity: 'blocker',
            sourceKind: 'video_stream',
            title: '录屏片段与回执不一致',
            message: mismatches.join('；'),
            remediation: '重新执行 Gate 2 录屏并确保回执与磁盘文件一致。',
            remediationAction: 'production',
            location: { scope: 'global', ...(clip.assetId ? { assetId: clip.assetId } : {}) },
          });
        }
      }
      const blackSpans = await this.safeBlackSpans(clip.file, executionErrors);
      const blackBlockMs = this.config.blackBlockMs;
      for (const span of blackSpans) {
        if (span.durationMs < 300) continue;
        const isBlocker = span.durationMs >= blackBlockMs;
        findings.push({
          ruleId: 'technical.black_frame',
          category: 'technical',
          severity: isBlocker ? 'blocker' : 'warning',
          sourceKind: 'capture_frame',
          title: isBlocker ? '录屏片段存在长时间黑屏' : '录屏片段存在短时黑屏',
          message: `录屏片段在 ${formatTimestamp(span.startMs)} 起持续黑屏 ${(span.durationMs / 1000).toFixed(2)}s。`,
          remediation: '检查演示页面在录制时是否崩溃/未渲染；修复后重新录屏。',
          remediationAction: 'production',
          location: {
            scope: 'global',
            timestampMs: Math.round((span.startMs + span.endMs) / 2),
            durationMs: span.durationMs,
            ...(clip.assetId ? { assetId: clip.assetId } : {}),
          },
          metrics: { blackDurationMs: span.durationMs },
          evidenceTimestampMs: Math.round((span.startMs + span.endMs) / 2),
        });
      }
      const freezeSpans = await this.safeFreezeSpans(clip.file, executionErrors);
      const clipLength = probe?.durationMs ?? clip.durationMs ?? 0;
      for (const span of freezeSpans) {
        if (span.durationMs < 3000) continue;
        const dominatesClip = clipLength > 0 && span.durationMs / clipLength >= 0.8;
        const isBlocker = span.durationMs >= this.config.freezeBlockMs || dominatesClip;
        findings.push({
          ruleId: 'technical.freeze_frame',
          category: 'technical',
          severity: isBlocker ? 'blocker' : 'warning',
          sourceKind: 'capture_frame',
          title: isBlocker ? '录屏片段长时间静止' : '录屏片段存在短时静止',
          message: `录屏片段在 ${formatTimestamp(span.startMs)} 起静止 ${(span.durationMs / 1000).toFixed(2)}s，画面没有更新。`,
          remediation: '确认录制时页面确实在推进（动画/滚动/点击）；调整演示步骤后重新录屏。',
          remediationAction: 'production',
          location: {
            scope: 'global',
            timestampMs: Math.round((span.startMs + span.endMs) / 2),
            durationMs: span.durationMs,
            ...(clip.assetId ? { assetId: clip.assetId } : {}),
          },
          metrics: { freezeDurationMs: span.durationMs },
          evidenceTimestampMs: Math.round((span.startMs + span.endMs) / 2),
        });
      }
    }

    callbacks?.onCheckpoint?.('qa_privacy_scanned', { stage: 'capture' });
    findings.push(
      ...(await this.scanCaptureEvidence(
        input,
        frozen,
        windows,
        signal,
        coverage,
        executionErrors,
        tempDir,
        callbacks,
      )),
    );

    // Fact / content checks reuse the live snapshot conventions; the capture
    // stage only needs provenance and claim eligibility (copy issues that make
    // it into the film are re-checked in qa_final).
    findings.push(
      ...collectCaptureProvenanceFindings(
        frozen,
        {
          ...(receipt
            ? { receipt: { assertions: receipt.assertions, clip: { sha256: receipt.clip.sha256 } } }
            : {}),
          ...(clipSha ? { clipSha256: clipSha } : {}),
          ...(frozen.capture?.planDigest ? { approvedPlanDigest: frozen.capture.planDigest } : {}),
        },
        windows,
      ).map(fromFactContent),
    );

    for (const message of executionErrors) {
      findings.push(executionErrorFinding(message));
    }

    return {
      findings,
      coverage,
      subject: {
        inputDigest: input.inputDigest,
        scriptVersion: input.scriptVersion,
        ...(frozen.capture?.planDigest ? { capturePlanDigest: frozen.capture.planDigest } : {}),
        ...(clipSha ? { captureClipSha256: clipSha } : {}),
        ...(input.captureTraceFile && existsSync(input.captureTraceFile)
          ? { captureTraceSha256: sha256OfFile(input.captureTraceFile) }
          : {}),
      },
      executionErrors,
    };
  }

  private async safeDecode(file: string, executionErrors: string[]) {
    try {
      return await assertDecodable(file, this.tools, { signal: this.controller?.signal });
    } catch (error) {
      executionErrors.push(error instanceof Error ? error.message : String(error));
      return null;
    }
  }

  private async safeBlackSpans(file: string, executionErrors: string[]) {
    try {
      return await detectBlackSpans(file, this.tools, { signal: this.controller?.signal });
    } catch (error) {
      executionErrors.push(error instanceof Error ? error.message : String(error));
      return [];
    }
  }

  private async safeFreezeSpans(file: string, executionErrors: string[], range?: { startMs: number; endMs: number }) {
    try {
      return await detectFreezeSpans(file, this.tools, {
        signal: this.controller?.signal,
        ...(range ? { startMs: range.startMs, endMs: range.endMs } : {}),
      });
    } catch (error) {
      executionErrors.push(error instanceof Error ? error.message : String(error));
      return [];
    }
  }

  private async scanFinalStage(
    input: QaFinalInput,
    signal: AbortSignal,
    callbacks?: QaRunnerCallbacks,
  ): Promise<StageScan> {
    const coverage = this.emptyCoverage();
    const findings: RawFinding[] = [];
    const executionErrors: string[] = [];
    const frozen = this.readFrozen(input);
    const windows = buildSceneWindows(frozen);
    const tempDir = path.join(input.runDir, 'qa', 'frames-tmp');

    callbacks?.onCheckpoint?.('qa_media_checked', { stage: 'final' });

    findings.push(...this.scanSceneText(frozen, windows));
    coverage.scannedScenes = frozen.input.storyboard.scenes.length;

    // Reuse-of-capture: when this run did not capture, its real assets still
    // need their screenshots/trace scanned (docs/16 §5.3 step 2).
    if (input.capture && input.capture.clips.length + input.capture.screenshots.length > 0) {
      findings.push(
        ...(await this.scanCaptureEvidence(
          input.capture,
          frozen,
          windows,
          signal,
          coverage,
          executionErrors,
          tempDir,
          callbacks,
        )),
      );
    }

    const manifest = this.readManifest(input.manifestFile);
    const narrationEnabled = Boolean(manifest?.narration) || Boolean(frozen.input.narration);
    let videoProbe: MediaProbe | null = null;
    let mp4Sha: string | undefined;

    if (existsSync(input.videoFile)) {
      mp4Sha = sha256OfFile(input.videoFile);
      const decode = await this.safeDecode(input.videoFile, executionErrors);
      if (decode && !decode.ok) {
        findings.push({
          ruleId: 'technical.video_decodable',
          category: 'technical',
          severity: 'blocker',
          sourceKind: 'video_stream',
          title: '成片无法完整解码',
          message: `ffmpeg 解码成片时报告错误：${decode.stderr.slice(0, 300)}`,
          remediation: '重新运行渲染；如反复失败，检查渲染 worker 输出是否被截断。',
          remediationAction: 'production',
          location: { scope: 'global' },
        });
      }
      videoProbe = await this.safeProbe(input.videoFile, executionErrors);
      if (videoProbe && manifest) {
        const mismatches: string[] = [];
        if (manifest.output.sha256 !== mp4Sha) mismatches.push('磁盘 MP4 SHA256 与渲染清单不一致');
        if (videoProbe.video?.codecName && videoProbe.video.codecName !== 'h264') {
          mismatches.push(`编码 ${videoProbe.video.codecName} ≠ h264`);
        }
        if (
          videoProbe.video?.width !== manifest.ffprobe.width ||
          videoProbe.video?.height !== manifest.ffprobe.height
        ) {
          mismatches.push(
            `尺寸 ${videoProbe.video?.width}×${videoProbe.video?.height} ≠ 清单 ${manifest.ffprobe.width}×${manifest.ffprobe.height}`,
          );
        }
        if (videoProbe.video?.fps && Math.abs(videoProbe.video.fps - manifest.ffprobe.fps) > 0.05) {
          mismatches.push(`帧率 ${videoProbe.video.fps.toFixed(2)} ≠ 清单 ${manifest.ffprobe.fps}`);
        }
        if (Math.abs(videoProbe.durationMs - manifest.ffprobe.durationMs) > 250) {
          mismatches.push(`时长 ${videoProbe.durationMs}ms ≠ 清单 ${manifest.ffprobe.durationMs}ms`);
        }
        if (mismatches.length > 0) {
          findings.push({
            ruleId: 'technical.probe_mismatch',
            category: 'technical',
            severity: 'blocker',
            sourceKind: 'video_stream',
            title: '成片与渲染清单不一致',
            message: mismatches.join('；'),
            remediation: '重新渲染；若问题持续，说明磁盘产物在渲染后被修改。',
            remediationAction: 'production',
            location: { scope: 'global' },
          });
        }
      }

      // Black frames, located to the scene they fall in.
      const blackSpans = await this.safeBlackSpans(input.videoFile, executionErrors);
      for (const span of blackSpans) {
        if (span.durationMs < 300) continue;
        const overlapping = windows.filter(
          (window) => span.startMs < window.endMs && span.endMs > window.startMs,
        );
        const primary = overlapping[0];
        const dominates = primary ? coverageOfWindow([span], primary) >= 0.5 : false;
        const isBlocker = span.durationMs >= this.config.blackBlockMs || dominates;
        findings.push({
          ruleId: 'technical.black_frame',
          category: 'technical',
          severity: isBlocker ? 'blocker' : 'warning',
          sourceKind: 'render_frame',
          title: isBlocker ? '成片存在长时间黑屏' : '成片存在短时黑屏',
          message: `成片在 ${formatTimestamp(span.startMs)} 起黑屏 ${(span.durationMs / 1000).toFixed(2)}s${
            primary ? `（第 ${primary.sceneOrder + 1} 镜）` : ''
          }。`,
          remediation: '检查该镜头的素材与动效是否成功加载；修复后重新运行渲染。',
          remediationAction: 'editor',
          location: {
            scope: primary ? 'scene' : 'global',
            ...(primary
              ? { sceneId: primary.sceneId, sceneOrder: primary.sceneOrder, sceneTitle: primary.sceneTitle }
              : {}),
            timestampMs: Math.round((span.startMs + span.endMs) / 2),
            durationMs: span.durationMs,
          },
          metrics: { blackDurationMs: span.durationMs },
          evidenceTimestampMs: Math.round((span.startMs + span.endMs) / 2),
        });
      }

      // Freeze detection only over `real_demo` ranges — a title/CTA card is
      // motionless by design (docs/16 §10).
      for (const range of realDemoRanges(windows)) {
        if (range.endMs - range.startMs < 3000) continue;
        const spans = await this.safeFreezeSpans(input.videoFile, executionErrors, range);
        for (const span of spans) {
          if (span.durationMs < 3000) continue;
          const scene = windows.find(
            (window) => span.startMs >= window.startMs && span.startMs < window.endMs,
          );
          const dominates = (range.endMs - range.startMs) > 0 &&
            span.durationMs / (range.endMs - range.startMs) >= 0.8;
          const isBlocker = span.durationMs >= this.config.freezeBlockMs || dominates;
          findings.push({
            ruleId: 'technical.freeze_frame',
            category: 'technical',
            severity: isBlocker ? 'blocker' : 'warning',
            sourceKind: 'render_frame',
            title: isBlocker ? '真实录屏镜头长时间静止' : '真实录屏镜头存在短时静止',
            message: `成片在 ${formatTimestamp(span.startMs)} 起静止 ${(span.durationMs / 1000).toFixed(2)}s${
              scene ? `（第 ${scene.sceneOrder + 1} 镜）` : ''
            }。`,
            remediation: '确认录屏素材本身在推进；如素材静止，重新录制演示后替换。',
            remediationAction: 'production',
            location: {
              scope: scene ? 'scene' : 'global',
              ...(scene
                ? { sceneId: scene.sceneId, sceneOrder: scene.sceneOrder, sceneTitle: scene.sceneTitle }
                : {}),
              timestampMs: Math.round((span.startMs + span.endMs) / 2),
              durationMs: span.durationMs,
            },
            metrics: { freezeDurationMs: span.durationMs },
            evidenceTimestampMs: Math.round((span.startMs + span.endMs) / 2),
          });
        }
      }

      // Audio (only when narration is part of this film).
      if (narrationEnabled) {
        const probe = videoProbe;
        if (probe && !probe.audio) {
          findings.push({
            ruleId: 'technical.audio_sync_and_level',
            category: 'technical',
            severity: 'blocker',
            sourceKind: 'audio_stream',
            title: '成片缺少音轨',
            message: '运行启用了旁白，但成片没有音频流。',
            remediation: '重新运行渲染；确认旁白步骤成功并绑定了音轨。',
            remediationAction: 'production',
            location: { scope: 'global' },
          });
        } else if (probe?.audio) {
          const drift = audioSyncDriftMs(probe);
          if (drift !== null && drift > 500) {
            findings.push({
              ruleId: 'technical.audio_sync_and_level',
              category: 'technical',
              severity: 'blocker',
              sourceKind: 'audio_stream',
              title: '音画时长不一致',
              message: `音频 ${probe.audio.durationMs}ms 与视频 ${probe.video?.durationMs}ms 相差 ${drift}ms，超过 500ms 容差。`,
              remediation: '重新运行渲染；如持续出现，检查旁白片段与镜头时间轴的绑定。',
              remediationAction: 'production',
              location: { scope: 'global' },
            });
          }
          if ((probe.audio.sampleRate ?? 0) < 22_050) {
            findings.push({
              ruleId: 'technical.audio_sync_and_level',
              category: 'technical',
              severity: 'warning',
              sourceKind: 'audio_stream',
              title: '音轨采样率偏低',
              message: `音轨采样率 ${probe.audio.sampleRate}Hz，低于 22050Hz。`,
              remediation: '使用 48kHz 旁白重新渲染。',
              remediationAction: 'production',
              location: { scope: 'global' },
            });
          }
          const volume = await this.safeVolume(input.videoFile, executionErrors);
          if (volume) {
            if (!(volume.meanVolumeDb > -90)) {
              findings.push({
                ruleId: 'technical.audio_sync_and_level',
                category: 'technical',
                severity: 'blocker',
                sourceKind: 'audio_stream',
                title: '成片音轨疑似静音',
                message: `volumedetect mean_volume ${volume.meanVolumeDb.toFixed(1)}dB，低于 -90dB。`,
                remediation: '检查旁白合成是否为空；重新合成旁白并渲染。',
                remediationAction: 'production',
                location: { scope: 'global' },
                metrics: { meanVolumeDb: Number.isFinite(volume.meanVolumeDb) ? volume.meanVolumeDb : -999 },
              });
            } else if (volume.maxVolumeDb >= -0.1) {
              findings.push({
                ruleId: 'technical.audio_sync_and_level',
                category: 'technical',
                severity: 'warning',
                sourceKind: 'audio_stream',
                title: '音轨存在削波风险',
                message: `volumedetect max_volume ${volume.maxVolumeDb.toFixed(2)}dB 接近 0dB，可能出现削波。`,
                remediation: '降低旁白增益后重新渲染。',
                remediationAction: 'production',
                location: { scope: 'global' },
              });
            }
          }
        }
      }

      // Film frames: three probes per static scene, one per second in demos.
      const points = planSceneFrameTimes(windows, this.config.maxFrames);
      const imageContext: ImageScanContext = {
        ocr: this.ocr,
        allowlistedDomains: this.config.allowlistedDomains,
        signal,
        timeoutMs: this.config.ocrTimeoutMs,
      };
      const seen = new Set<string>();
      const ocrFailures: string[] = [];
      let ocrExecuted = false;
      for (const [index, point] of points.entries()) {
        if (signal.aborted) break;
        const frameFile = path.join(tempDir, `final-${index}.png`);
        try {
          const sha = await extractFrameAt(input.videoFile, point.timestampMs, frameFile, this.tools, { signal });
          if (seen.has(sha)) {
            rmSync(frameFile, { force: true });
            continue;
          }
          seen.add(sha);
        } catch (error) {
          executionErrors.push(`成片抽帧失败：${error instanceof Error ? error.message : String(error)}`);
          break;
        }
        coverage.scannedRenderFrames += 1;
        const window = mapTimestampToScene(windows, point.timestampMs);
        const result = await scanImage(
          frameFile,
          'render_frame',
          {
            scope: window ? 'scene' : 'global',
            ...(window
              ? { sceneId: window.sceneId, sceneOrder: window.sceneOrder, sceneTitle: window.sceneTitle }
              : {}),
            timestampMs: point.timestampMs,
            frameIndex: index,
          },
          imageContext,
        );
        findings.push(...result.findings);
        ocrExecuted = ocrExecuted || result.ocrExecuted;
        if (result.ocrUnavailable) ocrFailures.push(result.ocrUnavailable);
        if (!result.findings.some((finding) => finding.sourceImage === frameFile)) {
          rmSync(frameFile, { force: true });
        }
      }
      coverage.ocrExecuted = coverage.ocrExecuted || ocrExecuted;
      if (ocrFailures.length > 0) findings.push(ocrUnavailableFinding(ocrFailures[0]!));
    } else {
      executionErrors.push('成片 MP4 不存在，无法执行媒体与隐私检查');
    }

    // Subtitles: hash binding, structural validity, and a privacy scan.
    const srtSha = input.subtitlesFile && existsSync(input.subtitlesFile)
      ? sha256OfFile(input.subtitlesFile)
      : undefined;
    if (input.subtitlesFile && existsSync(input.subtitlesFile)) {
      const content = readFileSync(input.subtitlesFile, 'utf8');
      if (manifest?.subtitles && srtSha !== manifest.subtitles.sha256) {
        findings.push({
          ruleId: 'technical.subtitle_valid',
          category: 'technical',
          severity: 'blocker',
          sourceKind: 'subtitle_srt',
          title: 'SRT 与渲染清单哈希不一致',
          message: '磁盘字幕文件的 SHA256 与渲染清单记录不一致，字幕可能在渲染后被修改。',
          remediation: '重新运行字幕生成与渲染步骤。',
          remediationAction: 'production',
          location: { scope: 'global' },
        });
      }
      const totalDurationMs = videoProbe?.durationMs ?? manifest?.ffprobe.durationMs;
      if (totalDurationMs) {
        const validation = parseAndValidateSrt(content, { totalDurationMs });
        if (!validation.ok) {
          findings.push({
            ruleId: 'technical.subtitle_valid',
            category: 'technical',
            severity: 'blocker',
            sourceKind: 'subtitle_srt',
            title: 'SRT 结构校验失败',
            message: validation.issues.slice(0, 5).join('；'),
            remediation: '重新生成字幕；若问题持续，检查镜头时间轴与旁白片段。',
            remediationAction: 'production',
            location: { scope: 'global' },
          });
        }
      }
      const srtScan = scanSrtCues(content);
      coverage.scannedSrtCues = srtScan.cueCount;
      findings.push(
        ...srtScan.findings.map((finding) => {
          const window =
            finding.location.timestampMs !== undefined
              ? mapTimestampToScene(windows, finding.location.timestampMs)
              : undefined;
          return {
            ...finding,
            location: {
              ...finding.location,
              ...(window
                ? { scope: 'scene' as const, sceneId: window.sceneId, sceneOrder: window.sceneOrder, sceneTitle: window.sceneTitle }
                : {}),
            },
          };
        }),
      );
    }

    // Fact / content.
    findings.push(
      ...collectClaimEligibilityFindings(
        frozen,
        input.workspace,
        new Map(
          windows.map((window) => [window.sceneId, { order: window.sceneOrder, title: window.sceneTitle }]),
        ),
      ).map(fromFactContent),
    );
    findings.push(
      ...collectCaptureProvenanceFindings(
        frozen,
        {
          ...(manifest
            ? {
                manifestAssetHashes: manifest.assetHashes.map((entry) => ({
                  assetId: entry.assetId,
                  sha256: entry.sha256,
                  mock: entry.mock,
                  ...(entry.mediaSha256 ? { mediaSha256: entry.mediaSha256 } : {}),
                })),
              }
            : {}),
        },
        windows,
      ).map(fromFactContent),
    );
    findings.push(
      ...collectBannedPhraseFindings(
        frozen,
        input.workspace.videos.find((video) => video.id === input.videoId)?.brief.bannedPhrases ?? [],
        windows,
      ).map(fromFactContent),
    );
    findings.push(
      ...collectNarrationContentFindings(
        frozen,
        { narrationEnabled, subtitleCueCount: coverage.scannedSrtCues },
        windows,
      ).map(fromFactContent),
    );
    findings.push(...collectSyntheticVoiceNotice(manifest).map(fromFactContent));
    findings.push(...collectBrandKitFindings(frozen).map(fromFactContent));

    for (const message of executionErrors) {
      findings.push(executionErrorFinding(message));
    }

    return {
      findings,
      coverage,
      subject: {
        inputDigest: input.inputDigest,
        scriptVersion: input.scriptVersion,
        ...(mp4Sha ? { mp4Sha256: mp4Sha } : {}),
        ...(srtSha ? { srtSha256: srtSha } : {}),
        ...(existsSync(input.manifestFile) ? { manifestSha256: sha256OfFile(input.manifestFile) } : {}),
        ...(frozen.capture?.planDigest ? { capturePlanDigest: frozen.capture.planDigest } : {}),
        ...(frozen.capture?.clipSha256 ? { captureClipSha256: frozen.capture.clipSha256 } : {}),
        ...(input.capture?.captureTraceFile && existsSync(input.capture.captureTraceFile)
          ? { captureTraceSha256: sha256OfFile(input.capture.captureTraceFile) }
          : {}),
      },
      executionErrors,
    };
  }

  private async safeVolume(file: string, executionErrors: string[]) {
    try {
      return await measureVolume(file, this.tools, { signal: this.controller?.signal });
    } catch (error) {
      executionErrors.push(error instanceof Error ? error.message : String(error));
      return null;
    }
  }

  private readManifest(file: string) {
    if (!existsSync(file)) return null;
    try {
      return renderManifestV1Schema.parse(JSON.parse(readFileSync(file, 'utf8')));
    } catch (error) {
      this.logger?.warn(`QA 无法解析渲染清单：${error instanceof Error ? error.message : error}`);
      return null;
    }
  }

  /** Convert drafts to `QaFindingV1` (ids, locations) + write evidence PNGs. */
  private async finalizeStage(
    stage: 'capture' | 'final',
    input: QaCaptureInput | QaFinalInput,
    scan: StageScan,
    callbacks?: QaRunnerCallbacks,
  ): Promise<QaRunOutcome> {
    const startedAt = Date.now();
    const qaDir = path.join(input.runDir, 'qa');
    const evidenceDir = path.join(qaDir, 'evidence');
    const tempDir = path.join(qaDir, 'frames-tmp');
    mkdirSync(evidenceDir, { recursive: true });

    const rawFindings = sortFindings(dedupePrivacy(scan.findings));
    const findings: QaFindingV1[] = [];
    const evidenceFrames: QaEvidenceFrameResult[] = [];

    try {
      for (const [index, raw] of rawFindings.entries()) {
        const findingId = `qaf_${String(index + 1).padStart(2, '0')}`;
        let evidenceTarget: string | undefined;

        if (raw.privacyImage && raw.sourceImage && existsSync(raw.sourceImage)) {
          // Privacy evidence: blur first, never expose the original.
          evidenceTarget = path.join(evidenceDir, `${findingId}.png`);
          try {
            await renderRedactedEvidence(raw.sourceImage, evidenceTarget, {
              signal: this.controller?.signal,
            });
          } catch {
            evidenceTarget = undefined;
          }
        } else if (stage === 'final' && existsSync((input as QaFinalInput).videoFile)) {
          const evidenceTimestamp = raw.evidenceTimestampMs;
          const technicalFrame =
            raw.category === 'technical' &&
            (raw.ruleId === 'technical.black_frame' || raw.ruleId === 'technical.freeze_frame') &&
            evidenceTimestamp !== undefined;
          if (technicalFrame) {
            evidenceTarget = path.join(evidenceDir, `${findingId}.png`);
            const tempFrame = path.join(tempDir, `evidence-${findingId}.png`);
            try {
              await extractFrameAt(
                (input as QaFinalInput).videoFile,
                evidenceTimestamp!,
                tempFrame,
                this.tools,
                { signal: this.controller?.signal },
              );
              await renderAnnotatedEvidence(tempFrame, evidenceTarget, {
                signal: this.controller?.signal,
              });
            } catch {
              evidenceTarget = undefined;
            } finally {
              rmSync(tempFrame, { force: true });
            }
          }
        }

        if (evidenceTarget && existsSync(evidenceTarget)) {
          evidenceFrames.push({
            findingId,
            file: evidenceTarget,
            sha256: sha256OfFile(evidenceTarget),
            byteSize: safeFileSize(evidenceTarget),
            redacted: raw.category === 'privacy',
          });
        }

        const {
          sourceImage: _sourceImage,
          privacyImage: _privacyImage,
          evidenceTimestampMs: _evidence,
          ...rest
        } = raw;
        findings.push({
          id: findingId,
          ruleId: rest.ruleId,
          category: rest.category,
          severity: rest.severity,
          sourceKind: rest.sourceKind,
          title: rest.title,
          message: rest.message,
          remediation: rest.remediation,
          remediationAction: rest.remediationAction,
          location: rest.location,
          ...(rest.matchRedacted ? { matchRedacted: rest.matchRedacted } : {}),
          ...(rest.matchSha256 ? { matchSha256: rest.matchSha256 } : {}),
          ...(rest.metrics ? { metrics: rest.metrics } : {}),
        });
      }
    } finally {
      // Temporary frames never outlive the stage (docs/16 §10).
      rmSync(tempDir, { recursive: true, force: true });
    }

    const now = new Date().toISOString();
    const checks = buildChecks(findings);
    const summary = summarizeChecks(rawFindings);
    const report: QaReportV1 = qaReportV1Schema.parse({
      schemaVersion: QA_SCHEMA_VERSION,
      kind: 'asvs.qa-report',
      reportId: `qarep_${stage}_${input.runId.replace(/^orchrun_/, '')}`,
      runId: input.runId,
      workspaceId: input.workspaceId,
      projectId: input.projectId,
      videoId: input.videoId,
      stage,
      policyVersion: QA_POLICY_VERSION,
      verdict: verdictOf(findings),
      summary: {
        totalFindings: summary.totalFindings,
        blockerCount: summary.blockerCount,
        warningCount: summary.warningCount,
        infoCount: summary.infoCount,
        privacyBlockerCount: summary.privacyBlockerCount,
        technicalBlockerCount: summary.technicalBlockerCount,
        factBlockerCount: summary.factBlockerCount,
        contentBlockerCount: summary.contentBlockerCount,
      },
      checks,
      findings,
      coverage: scan.coverage,
      subject: scan.subject,
      durationMs: Date.now() - startedAt,
      createdAt: now,
    });

    const reportFile = path.join(qaDir, `qa-${stage}-report.json`);
    mkdirSync(qaDir, { recursive: true });
    writeFileSync(reportFile, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
    const reportSha256 = sha256OfFile(reportFile);

    callbacks?.onCheckpoint?.('qa_report_written', {
      stage,
      verdict: report.verdict,
      blockerCount: report.summary.blockerCount,
      reportSha256,
    });
    return {
      report,
      reportFile,
      reportSha256,
      evidenceFrames,
      ...(scan.executionErrors.length > 0 ? { executionError: scan.executionErrors[0] } : {}),
    };
  }
}
