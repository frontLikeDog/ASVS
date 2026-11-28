import type { DatabaseSync } from 'node:sqlite';
import { qaReportV1Schema, type QaReportV1, type QaStage } from '@asvs/domain';

interface QaReportRow {
  id: string;
  run_id: string;
  workspace_id: string;
  project_id: string;
  video_id: string;
  stage: string;
  verdict: string;
  policy_version: string;
  blocker_count: number;
  warning_count: number;
  privacy_blocker_count: number;
  report_artifact_id: string | null;
  report_sha256: string;
  input_digest: string;
  script_version: number;
  payload: string;
  created_at: string;
}

export interface StoredQaReport {
  report: QaReportV1;
  reportArtifactId: string | null;
  reportSha256: string;
  createdAt: string;
}

export interface UpsertQaReportInput {
  report: QaReportV1;
  reportArtifactId?: string;
  reportSha256: string;
}

function decode(row: QaReportRow): StoredQaReport {
  return {
    // Re-validate on read: the row is a cache, the payload is the contract.
    report: qaReportV1Schema.parse(JSON.parse(row.payload) as unknown),
    reportArtifactId: row.report_artifact_id,
    reportSha256: row.report_sha256,
    createdAt: row.created_at,
  };
}

/**
 * Persistence for Step 5D QA reports.
 *
 * The report file on disk is the authority (the export gate re-hashes it), but
 * this table is what makes Gate 3 work for a *failed* run: `findLatestByVideo`
 * deliberately ignores `orchestration_runs.status`, so a run blocked at
 * `qa_capture` still surfaces its report to the reviewer.
 */
export class QaReportStore {
  constructor(private readonly db: DatabaseSync) {}

  upsert(input: UpsertQaReportInput): StoredQaReport {
    const report = input.report;
    this.db
      .prepare(
        `INSERT INTO qa_reports (
           id, run_id, workspace_id, project_id, video_id, stage, verdict,
           policy_version, blocker_count, warning_count, privacy_blocker_count,
           report_artifact_id, report_sha256, input_digest, script_version,
           payload, created_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(run_id, stage) DO UPDATE SET
           id = excluded.id,
           verdict = excluded.verdict,
           policy_version = excluded.policy_version,
           blocker_count = excluded.blocker_count,
           warning_count = excluded.warning_count,
           privacy_blocker_count = excluded.privacy_blocker_count,
           report_artifact_id = excluded.report_artifact_id,
           report_sha256 = excluded.report_sha256,
           input_digest = excluded.input_digest,
           script_version = excluded.script_version,
           payload = excluded.payload,
           created_at = excluded.created_at`,
      )
      .run(
        report.reportId,
        report.runId,
        report.workspaceId,
        report.projectId,
        report.videoId,
        report.stage,
        report.verdict,
        report.policyVersion,
        report.summary.blockerCount,
        report.summary.warningCount,
        report.summary.privacyBlockerCount,
        input.reportArtifactId ?? null,
        input.reportSha256,
        report.subject.inputDigest,
        report.subject.scriptVersion,
        JSON.stringify(report),
        report.createdAt,
      );
    return {
      report,
      reportArtifactId: input.reportArtifactId ?? null,
      reportSha256: input.reportSha256,
      createdAt: report.createdAt,
    };
  }

  /**
   * Report for one run. With no `stage`, `final` wins: a run that reached
   * `qa_final` has the strictly stronger verdict, and a run blocked at
   * `qa_capture` only has a capture report, which is then what is returned.
   */
  getByRun(workspaceId: string, runId: string, stage?: QaStage): StoredQaReport | null {
    if (stage) {
      const row = this.db
        .prepare(
          'SELECT * FROM qa_reports WHERE workspace_id = ? AND run_id = ? AND stage = ?',
        )
        .get(workspaceId, runId, stage) as QaReportRow | undefined;
      return row ? decode(row) : null;
    }
    const row = this.db
      .prepare(
        `SELECT * FROM qa_reports WHERE workspace_id = ? AND run_id = ?
         ORDER BY CASE stage WHEN 'final' THEN 0 ELSE 1 END, created_at DESC
         LIMIT 1`,
      )
      .get(workspaceId, runId) as QaReportRow | undefined;
    return row ? decode(row) : null;
  }

  listByRun(workspaceId: string, runId: string): StoredQaReport[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM qa_reports WHERE workspace_id = ? AND run_id = ?
         ORDER BY CASE stage WHEN 'capture' THEN 0 ELSE 1 END`,
      )
      .all(workspaceId, runId) as unknown as QaReportRow[];
    return rows.map(decode);
  }

  /**
   * Gate 3's core query: the newest report for a video regardless of the run's
   * terminal status, so a QA-blocked failure is still explained to the reviewer.
   */
  findLatestByVideo(workspaceId: string, videoId: string): StoredQaReport | null {
    const row = this.db
      .prepare(
        `SELECT * FROM qa_reports WHERE workspace_id = ? AND video_id = ?
         ORDER BY created_at DESC, rowid DESC
         LIMIT 1`,
      )
      .get(workspaceId, videoId) as QaReportRow | undefined;
    return row ? decode(row) : null;
  }

  deleteByRun(workspaceId: string, runId: string): void {
    this.db
      .prepare('DELETE FROM qa_reports WHERE workspace_id = ? AND run_id = ?')
      .run(workspaceId, runId);
  }
}
