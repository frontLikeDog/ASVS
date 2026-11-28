import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type {
  QaCaptureInput,
  QaFinalInput,
  QaHealth,
  QaOcrHealth,
  QaRunOutcome,
  QaRunnerCallbacks,
  QaRunnerPort,
} from '@asvs/ports';
import type {
  QaCheckSummaryV1,
  QaCoverageV1,
  QaCategory,
  QaFindingV1,
  QaReportV1,
  QaStage,
  QaSubjectDigestsV1,
  QaVerdict,
} from '@asvs/domain';

/**
 * Deterministic `QaRunnerPort` double for unit tests and scripted verification
 * (Step 5D red line 4).
 *
 * The old 5A/5B/5C tests write fake MP4 bytes, which real ffprobe/OCR could
 * never judge. This double proves *orchestrator wiring* — step order, report
 * persistence, the export gate, failure codes — while `pnpm qa:verify` proves
 * the real scanning pipeline against real media. It never claims to have done
 * more than it did: `ocrExecuted` is false and the provider is `unconfigured`,
 * so nothing here could ever be mistaken for a real privacy pass.
 */
export interface DeterministicQaFindingSpec {
  category: QaCategory;
  severity: 'blocker' | 'warning' | 'info';
  ruleId: string;
  title?: string;
  sourceKind?: QaFindingV1['sourceKind'];
  sceneId?: string;
  sceneOrder?: number;
  timestampMs?: number;
  matchRedacted?: string;
}

export interface DeterministicQaScript {
  /** Verdict to report per stage; default `pass`. */
  verdict?: Partial<Record<QaStage, QaVerdict>>;
  findings?: Partial<Record<QaStage, DeterministicQaFindingSpec[]>>;
  /** Set to simulate a runner-internal crash instead of a report. */
  throwOn?: Partial<Record<QaStage, string>>;
  /** Optional PNG bytes written for every blocker (blurred is the caller's call). */
  evidenceFor?: DeterministicQaFindingSpec[];
  /**
   * Keeps the stage "running" for this long before producing its report, so a
   * test can cancel a live QA step (the abort wiring needs a window).
   */
  delayMs?: number;
}

const POLICY_VERSION = 'qa-v1-test';
const CATEGORIES: QaCategory[] = ['privacy', 'technical', 'fact', 'content'];

function sha256(text: string | Buffer): string {
  return createHash('sha256').update(text).digest('hex');
}

function emptyCoverage(): QaCoverageV1 {
  return {
    scannedCaptureFrames: 0,
    scannedRenderFrames: 0,
    scannedScreenshots: 0,
    scannedTraceEntries: 0,
    skippedTraceStaticEntries: 0,
    scannedScenes: 0,
    scannedSrtCues: 0,
    ocrProvider: 'unconfigured',
    ocrExecuted: false,
    ocrSynthetic: false,
    allowlistedDomains: [],
  };
}

export class DeterministicQaRunner implements QaRunnerPort {
  calls: Array<{ stage: QaStage; input: QaCaptureInput | QaFinalInput }> = [];
  aborted = false;
  running = false;
  private script: DeterministicQaScript;

  constructor(script: DeterministicQaScript = {}) {
    this.script = script;
  }

  setScript(script: DeterministicQaScript): void {
    this.script = script;
  }

  health(): QaHealth {
    return {
      enabled: true,
      policyVersion: POLICY_VERSION,
      ocrProvider: 'unconfigured',
      ocrConfigured: false,
    };
  }

  /** Honest OCR descriptor for health assertions. */
  ocrHealth(): QaOcrHealth {
    return { provider: 'unconfigured', configured: false, language: 'eng' };
  }

  abort(): void {
    this.aborted = true;
  }

  isRunning(): boolean {
    return this.running;
  }

  async runCaptureQa(input: QaCaptureInput, callbacks?: QaRunnerCallbacks): Promise<QaRunOutcome> {
    return this.run('capture', input, callbacks);
  }

  async runFinalQa(input: QaFinalInput, callbacks?: QaRunnerCallbacks): Promise<QaRunOutcome> {
    return this.run('final', input, callbacks);
  }

  private async run(
    stage: QaStage,
    input: QaCaptureInput | QaFinalInput,
    callbacks?: QaRunnerCallbacks,
  ): Promise<QaRunOutcome> {
    this.calls.push({ stage, input });
    this.running = true;
    try {
      const crash = this.script.throwOn?.[stage];
      if (crash) throw new Error(crash);
      if (this.script.delayMs) {
        await new Promise((resolve) => setTimeout(resolve, this.script.delayMs));
      }

      callbacks?.onCheckpoint?.(stage === 'capture' ? 'qa_media_checked' : 'qa_media_checked', {
        stage,
      });
      callbacks?.onCheckpoint?.('qa_privacy_scanned', { stage });

      const specs = this.script.findings?.[stage] ?? [];
      const findings: QaFindingV1[] = specs.map((spec, index) => ({
        id: `qaf_${stage}_${String(index + 1).padStart(2, '0')}`,
        ruleId: spec.ruleId,
        category: spec.category,
        severity: spec.severity,
        sourceKind: spec.sourceKind ?? 'capture_screenshot',
        title: spec.title ?? `测试发现 ${index + 1}`,
        message: '由确定性测试 QA 执行器注入的发现；不包含任何敏感原文。',
        remediation: '修复后重新运行。',
        remediationAction: 'production',
        location: {
          scope: spec.sceneId ? 'scene' : 'global',
          ...(spec.sceneId ? { sceneId: spec.sceneId } : {}),
          ...(spec.sceneOrder !== undefined ? { sceneOrder: spec.sceneOrder } : {}),
          ...(spec.timestampMs !== undefined ? { timestampMs: spec.timestampMs } : {}),
        },
        ...(spec.matchRedacted ? { matchRedacted: spec.matchRedacted } : {}),
      }));

      const checks: QaCheckSummaryV1[] = CATEGORIES.map((category) => {
        const inCategory = findings.filter((finding) => finding.category === category);
        const blockers = inCategory.filter((finding) => finding.severity === 'blocker').length;
        const warnings = inCategory.filter((finding) => finding.severity === 'warning').length;
        return {
          category,
          status: blockers > 0 ? 'fail' : warnings > 0 ? 'warn' : 'pass',
          blockerCount: blockers,
          warningCount: warnings,
          infoCount: inCategory.filter((finding) => finding.severity === 'info').length,
          summary: blockers > 0 ? `阻断 ${blockers} 项` : warnings > 0 ? `提醒 ${warnings} 项` : '无问题',
        };
      });
      const blockerCount = findings.filter((finding) => finding.severity === 'blocker').length;
      const warningCount = findings.filter((finding) => finding.severity === 'warning').length;
      const verdict: QaVerdict =
        this.script.verdict?.[stage] ?? (blockerCount > 0 ? 'fail' : warningCount > 0 ? 'pass_with_warnings' : 'pass');

      // Bind the report to the actual bytes on disk: the export gate re-hashes
      // both the report and the artifacts, so a hard-coded subject digest here
      // would make every deterministic `qa_final` report look stale.
      const digestOf = (file: string | undefined): string | undefined =>
        file && existsSync(file) ? sha256(readFileSync(file)) : undefined;
      const finalInput = stage === 'final' ? (input as QaFinalInput) : null;
      const subject: QaSubjectDigestsV1 = {
        inputDigest: input.inputDigest,
        scriptVersion: input.scriptVersion,
        ...(finalInput
          ? {
              ...(digestOf(finalInput.videoFile) ? { mp4Sha256: digestOf(finalInput.videoFile)! } : {}),
              ...(digestOf(finalInput.subtitlesFile)
                ? { srtSha256: digestOf(finalInput.subtitlesFile)! }
                : {}),
              ...(digestOf(finalInput.manifestFile)
                ? { manifestSha256: digestOf(finalInput.manifestFile)! }
                : {}),
            }
          : {}),
      };

      const report: QaReportV1 = {
        schemaVersion: '1',
        kind: 'asvs.qa-report',
        reportId: `qarep_${stage}_${input.runId}`,
        runId: input.runId,
        workspaceId: input.workspaceId,
        projectId: input.projectId,
        videoId: input.videoId,
        stage,
        policyVersion: POLICY_VERSION,
        verdict,
        summary: {
          totalFindings: findings.length,
          blockerCount,
          warningCount,
          infoCount: findings.filter((finding) => finding.severity === 'info').length,
          privacyBlockerCount: findings.filter(
            (finding) => finding.severity === 'blocker' && finding.category === 'privacy',
          ).length,
          technicalBlockerCount: findings.filter(
            (finding) => finding.severity === 'blocker' && finding.category === 'technical',
          ).length,
          factBlockerCount: findings.filter(
            (finding) => finding.severity === 'blocker' && finding.category === 'fact',
          ).length,
          contentBlockerCount: findings.filter(
            (finding) => finding.severity === 'blocker' && finding.category === 'content',
          ).length,
        },
        checks,
        findings,
        coverage: emptyCoverage(),
        subject,
        durationMs: 1,
        createdAt: new Date().toISOString(),
      };

      const reportDir = path.join(input.runDir, 'qa');
      mkdirSync(reportDir, { recursive: true });
      const reportFile = path.join(reportDir, `qa-${stage}-report.json`);
      const serialized = JSON.stringify(report, null, 2);
      writeFileSync(reportFile, serialized, 'utf8');
      callbacks?.onCheckpoint?.('qa_report_written', {
        stage,
        verdict,
        reportId: report.reportId,
      });

      const evidenceFrames = (this.script.evidenceFor ?? [])
        .map((spec, index) => {
          const file = path.join(reportDir, `evidence-${stage}-${index + 1}.png`);
          // 1×1 transparent PNG; bytes only need to be stable, not meaningful.
          const png = Buffer.from(
            'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
            'base64',
          );
          writeFileSync(file, png);
          const finding = findings.find((item) => item.ruleId === spec.ruleId);
          return {
            findingId: finding?.id ?? `qaf_${stage}_${index + 1}`,
            file,
            sha256: sha256(png),
            byteSize: png.byteLength,
            redacted: spec.category === 'privacy',
          };
        });

      return {
        report,
        reportFile,
        reportSha256: sha256(serialized),
        evidenceFrames,
      };
    } finally {
      this.running = false;
    }
  }
}
