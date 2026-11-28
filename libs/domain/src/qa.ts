import { z } from 'zod';
import { idSchema, isoDateSchema } from './schemas';

/**
 * Step 5D · independent QA + AC-07 privacy gate contracts.
 *
 * This module is deliberately **not** imported by `orchestration.ts`: the run
 * row only carries the ~10-line `qaRunSummaryV1Schema` declared there. Keeping
 * the full report schema out of the run schema (and therefore out of the
 * browser's static import closure) is what protects the 230 kB initial bundle
 * budget — see docs/16 §2.2 red line 1.
 *
 * Everything here is pure Zod + plain data: no Node built-ins, no filesystem,
 * no regex engine beyond the JS standard library, so the same schemas parse
 * reports on the API, in the HTTP adapter and in tests.
 */

export const QA_SCHEMA_VERSION = '1' as const;
export const QA_POLICY_VERSION = 'qa-v1' as const;

export const QA_STAGES = ['capture', 'final'] as const;
export const qaStageSchema = z.enum(QA_STAGES);
export type QaStage = z.infer<typeof qaStageSchema>;

export const QA_VERDICTS = ['pass', 'pass_with_warnings', 'fail'] as const;
export const qaVerdictSchema = z.enum(QA_VERDICTS);
export type QaVerdict = z.infer<typeof qaVerdictSchema>;

export const QA_CATEGORIES = ['privacy', 'technical', 'fact', 'content'] as const;
export const qaCategorySchema = z.enum(QA_CATEGORIES);
export type QaCategory = z.infer<typeof qaCategorySchema>;

export const QA_SEVERITIES = ['blocker', 'warning', 'info'] as const;
export const qaSeveritySchema = z.enum(QA_SEVERITIES);
export type QaSeverity = z.infer<typeof qaSeveritySchema>;

export const QA_SOURCE_KINDS = [
  'capture_frame',
  'capture_screenshot',
  'capture_trace',
  'render_frame',
  'subtitle_srt',
  'scene_text',
  'demo_plan',
  'video_stream',
  'audio_stream',
  'claim_record',
  'capture_receipt',
] as const;
export const qaSourceKindSchema = z.enum(QA_SOURCE_KINDS);
export type QaSourceKind = z.infer<typeof qaSourceKindSchema>;

export const QA_REMEDIATION_ACTIONS = ['editor', 'production', 'knowledge', 'none'] as const;
export const qaRemediationActionSchema = z.enum(QA_REMEDIATION_ACTIONS);
export type QaRemediationAction = z.infer<typeof qaRemediationActionSchema>;

export const QA_CHECK_STATUSES = ['pass', 'warn', 'fail'] as const;
export const qaCheckStatusSchema = z.enum(QA_CHECK_STATUSES);
export type QaCheckStatus = z.infer<typeof qaCheckStatusSchema>;

export const QA_OCR_PROVIDERS = ['tesseract_cli', 'deterministic_test', 'unconfigured'] as const;
export const qaOcrProviderSchema = z.enum(QA_OCR_PROVIDERS);
export type QaOcrProvider = z.infer<typeof qaOcrProviderSchema>;

const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/, '需要 64 位小写十六进制 SHA256');

/**
 * Where a finding lives. Every field is optional except `scope`: a capture
 * screenshot may only be locatable by step id before it is mapped to a scene,
 * and an audio finding is global. The UI renders whatever is present.
 */
export const qaLocationV1Schema = z.object({
  scope: z.enum(['scene', 'global']),
  sceneId: idSchema.optional(),
  /** 0-based; the UI renders `第 {sceneOrder + 1} 镜`. */
  sceneOrder: z.number().int().min(0).optional(),
  sceneTitle: z.string().optional(),
  /** Position inside the referenced video/clip, in milliseconds. */
  timestampMs: z.number().int().min(0).optional(),
  /** How long the anomaly lasted (black/freeze spans), in milliseconds. */
  durationMs: z.number().int().min(0).optional(),
  frameIndex: z.number().int().min(0).optional(),
  stepId: idSchema.optional(),
  claimId: idSchema.optional(),
  featureId: idSchema.optional(),
  assetId: idSchema.optional(),
  /** Source artifact id (screenshot / trace / srt / mp4 / receipt). */
  artifactId: idSchema.optional(),
  /** e.g. `trace.network#42 (request.headers.authorization)`. */
  traceEntryPath: z.string().min(1).optional(),
  /** Registered `qa_evidence_frame` artifact for inline preview. */
  evidenceFrameArtifactId: idSchema.optional(),
});
export type QaLocationV1 = z.infer<typeof qaLocationV1Schema>;

export const qaFindingV1Schema = z.object({
  id: idSchema,
  /** Stable machine code, e.g. `privacy.github_token`, `technical.black_frame`. */
  ruleId: z.string().min(1).max(80),
  category: qaCategorySchema,
  severity: qaSeveritySchema,
  sourceKind: qaSourceKindSchema,
  title: z.string().min(1).max(200),
  /** Never contains the raw sensitive value; see `matchRedacted`. */
  message: z.string().min(1).max(1200),
  remediation: z.string().min(1).max(800),
  remediationAction: qaRemediationActionSchema,
  location: qaLocationV1Schema,
  /** Masked sample, e.g. `ghp_****9a2f`. Never the raw match. */
  matchRedacted: z.string().max(120).optional(),
  /** SHA256 of the raw match: audit + dedupe, not reversible. */
  matchSha256: sha256Schema.optional(),
  metrics: z.record(z.union([z.number(), z.string(), z.boolean()])).optional(),
});
export type QaFindingV1 = z.infer<typeof qaFindingV1Schema>;

export const qaCheckSummaryV1Schema = z.object({
  category: qaCategorySchema,
  status: qaCheckStatusSchema,
  blockerCount: z.number().int().min(0),
  warningCount: z.number().int().min(0),
  infoCount: z.number().int().min(0),
  summary: z.string().min(1).max(400),
});
export type QaCheckSummaryV1 = z.infer<typeof qaCheckSummaryV1Schema>;

export const qaCoverageV1Schema = z.object({
  scannedCaptureFrames: z.number().int().min(0),
  scannedRenderFrames: z.number().int().min(0),
  scannedScreenshots: z.number().int().min(0),
  scannedTraceEntries: z.number().int().min(0),
  /** JS/CSS/font/wasm response bodies deliberately not scanned. */
  skippedTraceStaticEntries: z.number().int().min(0),
  scannedScenes: z.number().int().min(0),
  scannedSrtCues: z.number().int().min(0),
  ocrProvider: qaOcrProviderSchema,
  ocrExecuted: z.boolean(),
  /** True for the deterministic test OCR; the UI must label it honestly. */
  ocrSynthetic: z.boolean(),
  allowlistedDomains: z.array(z.string()).default([]),
});
export type QaCoverageV1 = z.infer<typeof qaCoverageV1Schema>;

/**
 * Digests binding the report to the exact bytes it judged. An export that
 * finds a different MP4/SRT/manifest hash refuses with `export_qa_stale`, so a
 * passing report can never launder a later render.
 */
export const qaSubjectDigestsV1Schema = z.object({
  inputDigest: sha256Schema,
  scriptVersion: z.number().int().min(1),
  capturePlanDigest: sha256Schema.optional(),
  captureClipSha256: sha256Schema.optional(),
  captureTraceSha256: sha256Schema.optional(),
  mp4Sha256: sha256Schema.optional(),
  srtSha256: sha256Schema.optional(),
  manifestSha256: sha256Schema.optional(),
});
export type QaSubjectDigestsV1 = z.infer<typeof qaSubjectDigestsV1Schema>;

const qaSummaryV1Schema = z.object({
  totalFindings: z.number().int().min(0),
  blockerCount: z.number().int().min(0),
  warningCount: z.number().int().min(0),
  infoCount: z.number().int().min(0),
  privacyBlockerCount: z.number().int().min(0),
  technicalBlockerCount: z.number().int().min(0),
  factBlockerCount: z.number().int().min(0),
  contentBlockerCount: z.number().int().min(0),
});

export const QA_FINDING_ID_PREFIX = 'qaf_' as const;
export const QA_REPORT_ID_PREFIX = 'qarep_' as const;

/**
 * The report as written to `qa/qa-{stage}-report.json`, returned by the QA
 * routes and stored in `qa_reports.payload`. `superRefine` makes forgery
 * structurally impossible: a `pass` verdict with a blocker, or a summary whose
 * counts disagree with `findings`, fails to parse anywhere.
 */
export const qaReportV1Schema = z
  .object({
    schemaVersion: z.literal(QA_SCHEMA_VERSION),
    kind: z.literal('asvs.qa-report'),
    reportId: idSchema,
    runId: idSchema,
    workspaceId: idSchema,
    projectId: idSchema,
    videoId: idSchema,
    stage: qaStageSchema,
    policyVersion: z.string().min(1).max(40),
    verdict: qaVerdictSchema,
    summary: qaSummaryV1Schema,
    checks: z.array(qaCheckSummaryV1Schema),
    findings: z.array(qaFindingV1Schema),
    coverage: qaCoverageV1Schema,
    subject: qaSubjectDigestsV1Schema,
    durationMs: z.number().int().min(0),
    createdAt: isoDateSchema,
  })
  .superRefine((report, ctx) => {
    const issue = (message: string, path: (string | number)[] = []) =>
      ctx.addIssue({ code: z.ZodIssueCode.custom, message, path });

    const expected = {
      totalFindings: report.findings.length,
      blockerCount: report.findings.filter((finding) => finding.severity === 'blocker').length,
      warningCount: report.findings.filter((finding) => finding.severity === 'warning').length,
      infoCount: report.findings.filter((finding) => finding.severity === 'info').length,
      privacyBlockerCount: report.findings.filter(
        (finding) => finding.severity === 'blocker' && finding.category === 'privacy',
      ).length,
      technicalBlockerCount: report.findings.filter(
        (finding) => finding.severity === 'blocker' && finding.category === 'technical',
      ).length,
      factBlockerCount: report.findings.filter(
        (finding) => finding.severity === 'blocker' && finding.category === 'fact',
      ).length,
      contentBlockerCount: report.findings.filter(
        (finding) => finding.severity === 'blocker' && finding.category === 'content',
      ).length,
    };
    for (const [key, value] of Object.entries(expected)) {
      if (report.summary[key as keyof typeof expected] !== value) {
        issue(`summary.${key} 与 findings 实际计数不一致`, ['summary', key]);
      }
    }

    const verdict =
      expected.blockerCount > 0
        ? 'fail'
        : expected.warningCount > 0
          ? 'pass_with_warnings'
          : 'pass';
    if (report.verdict !== verdict) {
      issue(`verdict 必须为 ${verdict}（阻断 ${expected.blockerCount} / 提醒 ${expected.warningCount}）`, [
        'verdict',
      ]);
    }

    // Exactly one check card per category: the Gate 3 UI renders four fixed
    // dimensions, and a missing one would silently hide a whole class of risk.
    for (const category of QA_CATEGORIES) {
      const checks = report.checks.filter((check) => check.category === category);
      if (checks.length !== 1) {
        issue(`checks 必须包含且只包含一条 ${category} 维度`, ['checks']);
        continue;
      }
      const check = checks[0]!;
      const categoryFindings = report.findings.filter((finding) => finding.category === category);
      const blockers = categoryFindings.filter((finding) => finding.severity === 'blocker').length;
      const warnings = categoryFindings.filter((finding) => finding.severity === 'warning').length;
      const infos = categoryFindings.filter((finding) => finding.severity === 'info').length;
      if (
        check.blockerCount !== blockers ||
        check.warningCount !== warnings ||
        check.infoCount !== infos
      ) {
        issue(`checks.${category} 的计数与 findings 不一致`, ['checks']);
      }
      const status = blockers > 0 ? 'fail' : warnings > 0 ? 'warn' : 'pass';
      if (check.status !== status) {
        issue(`checks.${category}.status 必须为 ${status}`, ['checks']);
      }
    }
  });
export type QaReportV1 = z.infer<typeof qaReportV1Schema>;

/** Evidence file produced by the runner and registered by the orchestrator. */
export const qaEvidenceFrameV1Schema = z.object({
  findingId: idSchema,
  fileName: z.string().regex(/^[A-Za-z0-9._-]+\.png$/, '证据帧必须是安全的 .png'),
  mimeType: z.literal('image/png'),
  byteSize: z.number().int().positive(),
  sha256: sha256Schema,
  /** True when a privacy hit was blurred before being exposed. */
  redacted: z.boolean(),
});
export type QaEvidenceFrameV1 = z.infer<typeof qaEvidenceFrameV1Schema>;

/** Response envelope of both QA read routes. */
export const qaReportEnvelopeV1Schema = z.object({
  run: z.unknown(),
  report: qaReportV1Schema,
  reportArtifact: z.unknown(),
  evidenceArtifacts: z.array(z.unknown()),
});
export type QaReportEnvelopeV1 = z.infer<typeof qaReportEnvelopeV1Schema>;

export function qaVerdictLabel(verdict: QaVerdict): string {
  if (verdict === 'pass') return '通过';
  if (verdict === 'pass_with_warnings') return '通过 · 有提醒';
  return '已阻断';
}

export function qaCategoryLabel(category: QaCategory): string {
  switch (category) {
    case 'privacy':
      return '隐私守门（AC-07）';
    case 'technical':
      return '技术 QA';
    case 'fact':
      return '事实与声明';
    case 'content':
      return '内容与品牌';
  }
}

export function qaSourceKindLabel(kind: QaSourceKind): string {
  switch (kind) {
    case 'capture_frame':
      return '录屏帧';
    case 'capture_screenshot':
      return '断言截图';
    case 'capture_trace':
      return 'Playwright Trace';
    case 'render_frame':
      return '成片帧';
    case 'subtitle_srt':
      return 'SRT 字幕';
    case 'scene_text':
      return '镜头文案';
    case 'demo_plan':
      return '演示计划';
    case 'video_stream':
      return '视频流';
    case 'audio_stream':
      return '音频流';
    case 'claim_record':
      return '声明记录';
    case 'capture_receipt':
      return '录屏回执';
  }
}
