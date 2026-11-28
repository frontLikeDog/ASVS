import type { DatabaseSync } from 'node:sqlite';
import {
  orchestrationApprovalV1Schema,
  type OrchestrationApprovalStatus,
  type OrchestrationApprovalV1,
} from '@asvs/domain';

/**
 * Gate 2 approval ledger (Step 5C, migration v7).
 *
 * The run row keeps a denormalized `approval_json` because the scheduler reads
 * it on every pump; this table is the audit authority. A plan edit inserts a
 * new row and marks the previous one `superseded`, so "which plan was approved
 * when, by whom" stays answerable after the run has moved on.
 *
 * Every write that changes a decision runs inside `BEGIN IMMEDIATE`: two
 * concurrent approves (two browser tabs) must not both win.
 */
export interface InsertApprovalInput {
  workspaceId: string;
  approval: OrchestrationApprovalV1;
  /** Present for Gate 2; null for a generic gate. */
  planDigest?: string | null;
  riskLevel?: string | null;
  /** When replacing a pending approval, the row it replaces. */
  supersedes?: string | null;
}

interface ApprovalRow {
  id: string;
  run_id: string;
  workspace_id: string;
  step_key: string;
  gate_type: string;
  status: string;
  plan_id: string | null;
  plan_digest: string | null;
  policy_version: string | null;
  risk_level: string | null;
  requested_at: string;
  decided_at: string | null;
  decided_by: string | null;
  decision_note: string | null;
  superseded_by: string | null;
  payload: string;
  created_at: string;
  updated_at: string;
}

/**
 * The ledger columns are authoritative, not the `payload` blob: a supersede
 * only flips `status`/`superseded_by`, and reading the stale blob would report
 * a superseded approval as still pending.
 */
function decodeApproval(row: ApprovalRow): OrchestrationApprovalV1 {
  const payload = JSON.parse(row.payload) as Record<string, unknown>;
  const decidedAt = row.decided_at ?? undefined;
  return orchestrationApprovalV1Schema.parse({
    ...payload,
    status: row.status,
    ...(row.decided_by ? { decidedBy: row.decided_by } : {}),
    ...(row.decision_note ? { decisionNote: row.decision_note } : {}),
    ...(row.status === 'approved' && decidedAt ? { approvedAt: decidedAt } : {}),
    ...(row.status === 'rejected' && decidedAt ? { rejectedAt: decidedAt } : {}),
  });
}

export class OrchestrationApprovalStore {
  constructor(private readonly db: DatabaseSync) {}

  /**
   * Inserts a pending approval bound to `runId`. When `supersedes` is set the
   * previous row is marked `superseded` in the same transaction, so there is
   * never a moment with two pending approvals for one run.
   */
  createPending(runId: string, input: InsertApprovalInput): OrchestrationApprovalV1 {
    const approval = orchestrationApprovalV1Schema.parse({
      ...input.approval,
      status: 'pending',
    });
    const timestamp = approval.requestedAt;
    this.db.exec('BEGIN IMMEDIATE');
    try {
      if (input.supersedes) {
        this.db
          .prepare(
            `UPDATE orchestration_approvals
                SET status = 'superseded', superseded_by = ?, updated_at = ?
              WHERE id = ? AND status = 'pending' AND run_id = ?`,
          )
          .run(timestamp, input.supersedes, input.supersedes, runId);
      }
      this.db
        .prepare(
          `INSERT INTO orchestration_approvals
            (id, run_id, workspace_id, step_key, gate_type, status, plan_id, plan_digest,
             policy_version, risk_level, requested_at, decided_at, decided_by, decision_note,
             superseded_by, payload, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?, ?, NULL, NULL, NULL, NULL, ?, ?, ?)`,
        )
        .run(
          approval.approvalId,
          runId,
          input.workspaceId,
          approval.stepKey,
          approval.gateType,
          approval.planId ?? null,
          input.planDigest ?? approval.subjectDigest ?? null,
          approval.policyVersion ?? null,
          input.riskLevel ?? null,
          approval.requestedAt,
          JSON.stringify(approval),
          timestamp,
          timestamp,
        );
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
    return approval;
  }

  /** Latest row for a run regardless of status (the audit view). */
  getLatestByRun(runId: string): OrchestrationApprovalV1 | null {
    const row = this.db
      .prepare(
        'SELECT * FROM orchestration_approvals WHERE run_id = ? ORDER BY requested_at DESC, rowid DESC LIMIT 1',
      )
      .get(runId) as ApprovalRow | undefined;
    return row ? decodeApproval(row) : null;
  }

  getById(runId: string, approvalId: string): OrchestrationApprovalV1 | null {
    const row = this.db
      .prepare('SELECT * FROM orchestration_approvals WHERE run_id = ? AND id = ?')
      .get(runId, approvalId) as ApprovalRow | undefined;
    return row ? decodeApproval(row) : null;
  }

  /**
   * Approves a pending row. Returns null when the row is no longer pending —
   * the caller must treat that as "someone else already decided".
   */
  markApproved(
    runId: string,
    approvalId: string,
    input: { at: string; decidedBy: string; note?: string },
  ): OrchestrationApprovalV1 | null {
    return this.decide(runId, approvalId, 'approved', input);
  }

  markRejected(
    runId: string,
    approvalId: string,
    input: { at: string; decidedBy: string; note?: string },
  ): OrchestrationApprovalV1 | null {
    return this.decide(runId, approvalId, 'rejected', input);
  }

  /**
   * Marks a pending approval superseded without inserting a replacement (used
   * when a run is cancelled or a new plan is being prepared elsewhere).
   */
  supersede(runId: string, approvalId: string, at: string): void {
    this.db
      .prepare(
        `UPDATE orchestration_approvals
            SET status = 'superseded', decided_at = ?, updated_at = ?
          WHERE run_id = ? AND id = ? AND status = 'pending'`,
      )
      .run(at, at, runId, approvalId);
  }

  listByRun(runId: string): OrchestrationApprovalV1[] {
    const rows = this.db
      .prepare(
        'SELECT * FROM orchestration_approvals WHERE run_id = ? ORDER BY requested_at ASC, rowid ASC',
      )
      .all(runId) as unknown as ApprovalRow[];
    return rows.map(decodeApproval);
  }

  /** Count of pending Gate 2 approvals for a workspace (health/UI badge). */
  countPending(workspaceId: string): number {
    const row = this.db
      .prepare(
        `SELECT COUNT(*) AS count FROM orchestration_approvals
          WHERE workspace_id = ? AND status = 'pending'`,
      )
      .get(workspaceId) as { count: number } | undefined;
    return Number(row?.count ?? 0);
  }

  private decide(
    runId: string,
    approvalId: string,
    status: Extract<OrchestrationApprovalStatus, 'approved' | 'rejected'>,
    input: { at: string; decidedBy: string; note?: string },
  ): OrchestrationApprovalV1 | null {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const row = this.db
        .prepare(
          `SELECT * FROM orchestration_approvals
            WHERE run_id = ? AND id = ? AND status = 'pending'`,
        )
        .get(runId, approvalId) as ApprovalRow | undefined;
      if (!row) {
        this.db.exec('ROLLBACK');
        return null;
      }
      const current = decodeApproval(row);
      const next = orchestrationApprovalV1Schema.parse({
        ...current,
        status,
        ...(status === 'approved' ? { approvedAt: input.at } : { rejectedAt: input.at }),
        decidedBy: input.decidedBy,
        ...(input.note ? { decisionNote: input.note } : {}),
      });
      this.db
        .prepare(
          `UPDATE orchestration_approvals
              SET status = ?, decided_at = ?, decided_by = ?, decision_note = ?,
                  payload = ?, updated_at = ?
            WHERE run_id = ? AND id = ?`,
        )
        .run(
          next.status,
          input.at,
          input.decidedBy,
          input.note ?? null,
          JSON.stringify(next),
          input.at,
          runId,
          approvalId,
        );
      this.db.exec('COMMIT');
      return next;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }
}
