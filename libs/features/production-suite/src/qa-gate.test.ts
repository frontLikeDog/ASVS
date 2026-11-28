import { describe, expect, it } from 'vitest';
import type { QaCategory, QaCheckSummaryV1, QaFindingV1, QaReportResponse, QaSeverity } from '@asvs/ports';
import { deriveQaGate } from './qa-gate';

/**
 * Step 5D · the Gate 3 review page's local mirror of the server QA gate.
 *
 * These are pure-function tests on purpose: the approve buttons read
 * `deriveQaGate`, and a wrong answer there either hides a QA block or blocks a
 * clean run. The server's own gate is covered by the orchestrator tests.
 */

const SHA = 'a'.repeat(64);

function finding(
  category: QaCategory,
  severity: QaSeverity,
  overrides: Partial<QaFindingV1> = {},
): QaFindingV1 {
  return {
    id: `qaf_${category}_${severity}_${Object.keys(overrides).length}`,
    ruleId: `${category}.test`,
    category,
    severity,
    sourceKind: 'render_frame',
    title: `${category} ${severity}`,
    message: '脱敏说明',
    remediation: '重新生产',
    remediationAction: 'production',
    location: { scope: 'global' },
    ...overrides,
  };
}

function check(category: QaCategory, findings: QaFindingV1[]): QaCheckSummaryV1 {
  const mine = findings.filter((item) => item.category === category);
  const blockers = mine.filter((item) => item.severity === 'blocker').length;
  const warnings = mine.filter((item) => item.severity === 'warning').length;
  return {
    category,
    status: blockers > 0 ? 'fail' : warnings > 0 ? 'warn' : 'pass',
    blockerCount: blockers,
    warningCount: warnings,
    infoCount: mine.filter((item) => item.severity === 'info').length,
    summary: `${category} 摘要`,
  };
}

function envelope(options: {
  findings?: QaFindingV1[];
  scriptVersion?: number;
  verdict?: 'pass' | 'pass_with_warnings' | 'fail';
} = {}): QaReportResponse {
  const findings = options.findings ?? [];
  const blockerCount = findings.filter((item) => item.severity === 'blocker').length;
  const warningCount = findings.filter((item) => item.severity === 'warning').length;
  const categories: QaCategory[] = ['privacy', 'technical', 'fact', 'content'];
  return {
    run: {
      id: 'orchrun_gate_1',
      videoId: 'vid_gate_1',
      status: 'succeeded',
    } as QaReportResponse['run'],
    report: {
      schemaVersion: '1',
      kind: 'asvs.qa-report',
      reportId: 'qarep_gate_1',
      runId: 'orchrun_gate_1',
      workspaceId: 'ws_gate',
      projectId: 'proj_gate',
      videoId: 'vid_gate_1',
      stage: 'final',
      policyVersion: 'qa-v1',
      verdict:
        options.verdict ??
        (blockerCount > 0 ? 'fail' : warningCount > 0 ? 'pass_with_warnings' : 'pass'),
      summary: {
        totalFindings: findings.length,
        blockerCount,
        warningCount,
        infoCount: findings.filter((item) => item.severity === 'info').length,
        privacyBlockerCount: findings.filter(
          (item) => item.severity === 'blocker' && item.category === 'privacy',
        ).length,
        technicalBlockerCount: findings.filter(
          (item) => item.severity === 'blocker' && item.category === 'technical',
        ).length,
        factBlockerCount: findings.filter(
          (item) => item.severity === 'blocker' && item.category === 'fact',
        ).length,
        contentBlockerCount: findings.filter(
          (item) => item.severity === 'blocker' && item.category === 'content',
        ).length,
      },
      checks: categories.map((category) => check(category, findings)),
      findings,
      coverage: {
        scannedCaptureFrames: 12,
        scannedRenderFrames: 12,
        scannedScreenshots: 3,
        scannedTraceEntries: 40,
        skippedTraceStaticEntries: 0,
        scannedScenes: 3,
        scannedSrtCues: 4,
        ocrProvider: 'tesseract_cli',
        ocrExecuted: true,
        ocrSynthetic: false,
        allowlistedDomains: [],
      },
      subject: {
        inputDigest: SHA,
        scriptVersion: options.scriptVersion ?? 1,
      },
      durationMs: 1200,
      createdAt: '2026-11-28T10:00:00.000Z',
    },
    reportArtifact: { id: 'artifact_qa_report' } as QaReportResponse['reportArtifact'],
    evidenceArtifacts: [],
  };
}

describe('deriveQaGate · Gate 3 的本地 QA 门禁镜像', () => {
  it('无阻断的通过报告不阻止批准，并给出计数', () => {
    const gate = deriveQaGate(
      envelope({ findings: [finding('technical', 'warning')] }),
      1,
    );
    expect(gate.status).toBe('ready');
    expect(gate.blocked).toBe(false);
    expect(gate.stale).toBe(false);
    expect(gate.reason).toBeNull();
    expect(gate.blockerCount).toBe(0);
    expect(gate.privacyBlockerCount).toBe(0);
  });

  it('隐私阻断同时阻断批准，并给出含 AC-07 的说明', () => {
    const gate = deriveQaGate(
      envelope({
        findings: [
          finding('privacy', 'blocker', {
            ruleId: 'privacy.email',
            location: { scope: 'scene', sceneId: 'scene_one', sceneOrder: 0 },
          }),
        ],
      }),
      1,
    );
    expect(gate.blocked).toBe(true);
    expect(gate.blockerCount).toBe(1);
    expect(gate.privacyBlockerCount).toBe(1);
    expect(gate.reason).toContain('AC-07');
    expect(gate.reason).toContain('1 项阻断');
  });

  it('非隐私阻断也阻止批准，但说明不声称 AC-07 命中', () => {
    const gate = deriveQaGate(envelope({ findings: [finding('fact', 'blocker')] }), 1);
    expect(gate.blocked).toBe(true);
    expect(gate.privacyBlockerCount).toBe(0);
    expect(gate.reason).toContain('1 项阻断');
    expect(gate.reason).not.toContain('AC-07');
  });

  it('报告对应旧脚本版本时按过期处理并阻止批准', () => {
    const gate = deriveQaGate(envelope({ scriptVersion: 2 }), 3);
    expect(gate.stale).toBe(true);
    expect(gate.blocked).toBe(false);
    expect(gate.reason).toContain('v2');
    expect(gate.reason).toContain('v3');
  });

  it('旧版本的通过报告不会被当成当前版本的通过', () => {
    // Approving here would bind v3 review to a v2 QA verdict — the server
    // refuses with `export_qa_stale`, and the page must not pretend otherwise.
    const gate = deriveQaGate(envelope({ scriptVersion: 1, verdict: 'pass' }), 2);
    expect(gate.stale).toBe(true);
    expect(gate.envelope?.report.verdict).toBe('pass');
  });
});
