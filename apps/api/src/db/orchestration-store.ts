import type { DatabaseSync } from 'node:sqlite';
import {
  orchestrationArtifactV1Schema,
  orchestrationCheckpointV1Schema,
  orchestrationEventV1Schema,
  orchestrationJobV1Schema,
  orchestrationRunV1Schema,
  type OrchestrationArtifactKind,
  type OrchestrationArtifactV1,
  type OrchestrationCheckpointV1,
  type OrchestrationEventV1,
  type OrchestrationJobStatus,
  type OrchestrationJobType,
  type OrchestrationJobV1,
  type OrchestrationRunDetailV1,
  type OrchestrationRunV1,
  type OrchestrationStepKey,
} from '@asvs/domain';

interface RunRow {
  payload: string;
}

interface JobRow {
  id: string;
  run_id: string;
  workspace_id: string;
  step_key: string;
  job_type: string;
  status: string;
  attempt: number;
  max_attempts: number;
  input_digest: string;
  lease_owner: string | null;
  lease_expires_at: string | null;
  heartbeat_at: string | null;
  worker_pid: number | null;
  deadline_at: string | null;
  last_checkpoint_phase: string | null;
  error_code: string | null;
  error_message: string | null;
  created_at: string;
  updated_at: string;
}

interface CheckpointRow {
  id: string;
  run_id: string;
  step_key: string;
  phase: string;
  input_digest: string;
  payload: string;
  created_at: string;
}

interface ArtifactRow {
  id: string;
  run_id: string;
  workspace_id: string;
  job_id: string;
  kind: string;
  file_name: string;
  mime_type: string;
  byte_size: number;
  sha256: string;
  storage_ref: string;
  metadata_json: string;
  created_at: string;
}

interface EventRow {
  id: number;
  run_id: string;
  step_key: string | null;
  level: string;
  event_type: string;
  message: string;
  details_json: string | null;
  created_at: string;
}

export interface CreateRunRecordInput {
  run: OrchestrationRunV1;
  jobs: Array<{
    id: string;
    stepKey: OrchestrationStepKey;
    type: OrchestrationJobType;
    inputDigest: string;
    maxAttempts: number;
    createdAt: string;
  }>;
}

export interface LeaseOptions {
  owner: string;
  stepKey: OrchestrationStepKey;
  leaseTtlMs: number;
  now: Date;
  /** Jobs whose lease expired or belongs to another instance become reclaimable. */
  currentInstanceId: string;
}

export interface AcquireJobResult {
  job: OrchestrationJobV1;
  attempt: number;
}

function decodeRun(row: RunRow): OrchestrationRunV1 {
  return orchestrationRunV1Schema.parse(JSON.parse(row.payload) as unknown);
}

function decodeJob(row: JobRow): OrchestrationJobV1 {
  return orchestrationJobV1Schema.parse({
    schemaVersion: '1',
    jobId: row.id,
    runId: row.run_id,
    workspaceId: row.workspace_id,
    stepKey: row.step_key,
    type: row.job_type,
    status: row.status,
    idempotencyKey: `${row.run_id}:${row.step_key}`,
    inputDigest: row.input_digest,
    attempt: row.attempt,
    maxAttempts: row.max_attempts,
    leaseOwner: row.lease_owner,
    leaseExpiresAt: row.lease_expires_at,
    heartbeatAt: row.heartbeat_at,
    workerPid: row.worker_pid,
    deadlineAt: row.deadline_at,
    lastCheckpointPhase: row.last_checkpoint_phase,
    errorCode: row.error_code,
    errorMessage: row.error_message,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  });
}

function decodeCheckpoint(row: CheckpointRow): OrchestrationCheckpointV1 {
  return orchestrationCheckpointV1Schema.parse({
    schemaVersion: '1',
    id: row.id,
    runId: row.run_id,
    stepKey: row.step_key,
    phase: row.phase,
    inputDigest: row.input_digest,
    payload: JSON.parse(row.payload) as unknown,
    createdAt: row.created_at,
  });
}

function decodeArtifact(row: ArtifactRow): OrchestrationArtifactV1 {
  return orchestrationArtifactV1Schema.parse({
    schemaVersion: '1',
    id: row.id,
    runId: row.run_id,
    workspaceId: row.workspace_id,
    jobId: row.job_id,
    kind: row.kind,
    fileName: row.file_name,
    mimeType: row.mime_type,
    byteSize: row.byte_size,
    sha256: row.sha256,
    storageRef: row.storage_ref,
    metadata: JSON.parse(row.metadata_json) as unknown,
    createdAt: row.created_at,
  });
}

function decodeEvent(row: EventRow): OrchestrationEventV1 {
  return orchestrationEventV1Schema.parse({
    schemaVersion: '1',
    id: row.id,
    runId: row.run_id,
    stepKey: row.step_key,
    level: row.level,
    eventType: row.event_type,
    message: row.message,
    details: row.details_json ? (JSON.parse(row.details_json) as unknown) : undefined,
    createdAt: row.created_at,
  });
}

/**
 * Persistence for the 5A orchestrator. Every state change is one `BEGIN
 * IMMEDIATE` transaction; no subprocess or large file I/O ever happens inside
 * one, so a worker can take minutes while the DB stays lock-free.
 */
export class SqliteOrchestrationStore {
  constructor(private readonly db: DatabaseSync) {}

  /**
   * The connection this store owns. The Gate 2 approval ledger lives in the
   * same SQLite file and must share the connection so a supersede and the run
   * update that references it see one consistent state.
   */
  get database(): DatabaseSync {
    return this.db;
  }

  // ── Runs ────────────────────────────────────────────────────────────────

  /** Idempotent: a second call with the same (workspace, key) returns the first. */
  insertRun(input: CreateRunRecordInput): { run: OrchestrationRunV1; created: boolean } {
    const { run } = input;
    orchestrationRunV1Schema.parse(run);
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const existing = this.db
        .prepare(
          'SELECT payload FROM orchestration_runs WHERE workspace_id = ? AND idempotency_key = ?',
        )
        .get(run.workspaceId, run.idempotencyKey) as RunRow | undefined;
      if (existing) {
        this.db.exec('COMMIT');
        return { run: decodeRun(existing), created: false };
      }

      this.db
        .prepare(
          `INSERT INTO orchestration_runs
            (id, workspace_id, project_id, video_id, idempotency_key, status, input_digest,
             current_step_key, approval_json, failure_json, payload, created_at, updated_at, finished_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          run.id,
          run.workspaceId,
          run.projectId,
          run.videoId,
          run.idempotencyKey,
          run.status,
          run.inputDigest,
          run.currentStepKey,
          run.approval ? JSON.stringify(run.approval) : null,
          run.failure ? JSON.stringify(run.failure) : null,
          JSON.stringify(run),
          run.createdAt,
          run.updatedAt,
          run.finishedAt ?? null,
        );

      const insertJob = this.db.prepare(
        `INSERT INTO orchestration_jobs
          (id, run_id, workspace_id, step_key, job_type, status, attempt, max_attempts, input_digest,
           lease_owner, lease_expires_at, heartbeat_at, worker_pid, deadline_at,
           last_checkpoint_phase, error_code, error_message, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, 'queued', 0, ?, ?, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, ?, ?)`,
      );
      for (const job of input.jobs) {
        insertJob.run(
          job.id,
          run.id,
          run.workspaceId,
          job.stepKey,
          job.type,
          job.maxAttempts,
          job.inputDigest,
          job.createdAt,
          job.createdAt,
        );
      }

      this.db.exec('COMMIT');
      return { run, created: true };
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  getRun(runId: string): OrchestrationRunV1 | null {
    const row = this.db
      .prepare('SELECT payload FROM orchestration_runs WHERE id = ?')
      .get(runId) as RunRow | undefined;
    return row ? decodeRun(row) : null;
  }

  findRunByKey(workspaceId: string, idempotencyKey: string): OrchestrationRunV1 | null {
    const row = this.db
      .prepare(
        'SELECT payload FROM orchestration_runs WHERE workspace_id = ? AND idempotency_key = ?',
      )
      .get(workspaceId, idempotencyKey) as RunRow | undefined;
    return row ? decodeRun(row) : null;
  }

  listRuns(workspaceId: string, options: { videoId?: string; limit?: number } = {}): OrchestrationRunV1[] {
    const limit = Math.min(Math.max(options.limit ?? 50, 1), 200);
    const rows = (
      options.videoId
        ? this.db
            .prepare(
              'SELECT payload FROM orchestration_runs WHERE workspace_id = ? AND video_id = ? ORDER BY created_at DESC, id DESC LIMIT ?',
            )
            .all(workspaceId, options.videoId, limit)
        : this.db
            .prepare(
              'SELECT payload FROM orchestration_runs WHERE workspace_id = ? ORDER BY created_at DESC, id DESC LIMIT ?',
            )
            .all(workspaceId, limit)
    ) as unknown as RunRow[];
    return rows.map(decodeRun);
  }

  /** Runs that still need the scheduler (queued/running/awaiting_approval). */
  listActiveRuns(workspaceId?: string): OrchestrationRunV1[] {
    const rows = (
      workspaceId
        ? this.db
            .prepare(
              "SELECT payload FROM orchestration_runs WHERE workspace_id = ? AND status IN ('queued','running','awaiting_approval') ORDER BY created_at ASC",
            )
            .all(workspaceId)
        : this.db
            .prepare(
              "SELECT payload FROM orchestration_runs WHERE status IN ('queued','running','awaiting_approval') ORDER BY created_at ASC",
            )
            .all()
    ) as unknown as RunRow[];
    return rows.map(decodeRun);
  }

  updateRun(run: OrchestrationRunV1): void {
    const validated = orchestrationRunV1Schema.parse(run);
    this.db
      .prepare(
        `UPDATE orchestration_runs
           SET status = ?, input_digest = ?, current_step_key = ?, approval_json = ?,
               failure_json = ?, payload = ?, updated_at = ?, finished_at = ?
         WHERE id = ?`,
      )
      .run(
        validated.status,
        validated.inputDigest,
        validated.currentStepKey,
        validated.approval ? JSON.stringify(validated.approval) : null,
        validated.failure ? JSON.stringify(validated.failure) : null,
        JSON.stringify(validated),
        validated.updatedAt,
        validated.finishedAt ?? null,
        validated.id,
      );
  }

  // ── Jobs ────────────────────────────────────────────────────────────────

  getJob(jobId: string): OrchestrationJobV1 | null {
    const row = this.db
      .prepare('SELECT * FROM orchestration_jobs WHERE id = ?')
      .get(jobId) as JobRow | undefined;
    return row ? decodeJob(row) : null;
  }

  getJobForStep(runId: string, stepKey: OrchestrationStepKey): OrchestrationJobV1 | null {
    const row = this.db
      .prepare('SELECT * FROM orchestration_jobs WHERE run_id = ? AND step_key = ?')
      .get(runId, stepKey) as JobRow | undefined;
    return row ? decodeJob(row) : null;
  }

  updateJob(job: OrchestrationJobV1): void {
    const validated = orchestrationJobV1Schema.parse(job);
    this.db
      .prepare(
        `UPDATE orchestration_jobs
           SET status = ?, attempt = ?, lease_owner = ?, lease_expires_at = ?, heartbeat_at = ?,
               worker_pid = ?, deadline_at = ?, last_checkpoint_phase = ?, error_code = ?,
               error_message = ?, updated_at = ?
         WHERE id = ?`,
      )
      .run(
        validated.status,
        validated.attempt,
        validated.leaseOwner,
        validated.leaseExpiresAt,
        validated.heartbeatAt,
        validated.workerPid,
        validated.deadlineAt,
        validated.lastCheckpointPhase,
        validated.errorCode,
        validated.errorMessage,
        validated.updatedAt,
        validated.jobId,
      );
  }

  /**
   * Atomically claims the next runnable job for `owner`. One statement so two
   * instances (or a restart racing a stale lease) can never both win.
   *
   * Runnable = queued/retryable, or leased/running whose lease expired or is
   * owned by a previous instance. The attempt counter increments on the claim,
   * so a crash loop exhausts `maxAttempts` deterministically.
   */
  acquireJob(options: LeaseOptions): AcquireJobResult | null {
    const nowIso = options.now.toISOString();
    const leaseExpiresAt = new Date(options.now.getTime() + options.leaseTtlMs).toISOString();
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const row = this.db
        .prepare(
          `SELECT * FROM orchestration_jobs
            WHERE status IN ('queued','retryable')
              AND step_key = ?
            ORDER BY created_at ASC
            LIMIT 1`,
        )
        .get(options.stepKey) as JobRow | undefined;
      const orphan = row
        ? undefined
        : (this.db
            .prepare(
              `SELECT * FROM orchestration_jobs
                WHERE status IN ('leased','running') AND step_key = ?
                  AND (lease_expires_at IS NULL OR lease_expires_at <= ? OR lease_owner != ?)
                ORDER BY created_at ASC
                LIMIT 1`,
            )
            .get(options.stepKey, nowIso, options.currentInstanceId) as JobRow | undefined);

      const target = row ?? orphan;
      if (!target) {
        this.db.exec('COMMIT');
        return null;
      }

      const nextAttempt = target.attempt + 1;
      this.db
        .prepare(
          `UPDATE orchestration_jobs
             SET status = 'leased', attempt = ?, lease_owner = ?, lease_expires_at = ?,
                 heartbeat_at = ?, updated_at = ?
           WHERE id = ?`,
        )
        .run(nextAttempt, options.owner, leaseExpiresAt, nowIso, nowIso, target.id);
      this.db.exec('COMMIT');

      const updated = this.db
        .prepare('SELECT * FROM orchestration_jobs WHERE id = ?')
        .get(target.id) as unknown as JobRow;
      return { job: decodeJob(updated), attempt: nextAttempt };
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  /**
   * Atomically leases one specific job (the scheduler advances one run at a
   * time). Returns null when the job is terminal or is actively leased by a
   * live owner; `attempt` is incremented by the lease so crashes exhaust
   * `maxAttempts` deterministically.
   */
  leaseJob(jobId: string, options: { owner: string; leaseTtlMs: number; now: Date }): OrchestrationJobV1 | null {
    const nowIso = options.now.toISOString();
    const leaseExpiresAt = new Date(options.now.getTime() + options.leaseTtlMs).toISOString();
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const row = this.db
        .prepare('SELECT * FROM orchestration_jobs WHERE id = ?')
        .get(jobId) as JobRow | undefined;
      if (!row) {
        this.db.exec('COMMIT');
        return null;
      }
      if (!['queued', 'retryable', 'leased', 'running'].includes(row.status)) {
        this.db.exec('COMMIT');
        return null;
      }
      const activelyLeased =
        (row.status === 'leased' || row.status === 'running') &&
        row.lease_owner === options.owner &&
        row.lease_expires_at !== null &&
        row.lease_expires_at > nowIso;
      if (activelyLeased) {
        this.db.exec('COMMIT');
        return null;
      }

      this.db
        .prepare(
          `UPDATE orchestration_jobs
             SET status = 'leased', attempt = ?, lease_owner = ?, lease_expires_at = ?,
                 heartbeat_at = ?, updated_at = ?
           WHERE id = ?`,
        )
        .run(row.attempt + 1, options.owner, leaseExpiresAt, nowIso, nowIso, jobId);
      this.db.exec('COMMIT');
      const updated = this.db
        .prepare('SELECT * FROM orchestration_jobs WHERE id = ?')
        .get(jobId) as unknown as JobRow;
      return decodeJob(updated);
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  /** After `freeze_input` every job carries the real frozen-input digest. */
  updateJobInputDigest(runId: string, inputDigest: string, updatedAt: string): void {
    this.db
      .prepare('UPDATE orchestration_jobs SET input_digest = ?, updated_at = ? WHERE run_id = ?')
      .run(inputDigest, updatedAt, runId);
  }

  /** Requeues failed/retryable jobs for the manual retry command. */
  resetJobsForRetry(runId: string, stepKeys: OrchestrationStepKey[], updatedAt: string): void {
    const statement = this.db.prepare(
      `UPDATE orchestration_jobs
          SET status = 'queued', attempt = 0, lease_owner = NULL, lease_expires_at = NULL,
              heartbeat_at = NULL, worker_pid = NULL, error_code = NULL, error_message = NULL,
              updated_at = ?
        WHERE run_id = ? AND step_key = ? AND status IN ('failed','retryable','cancelled')`,
    );
    this.db.exec('BEGIN IMMEDIATE');
    try {
      for (const stepKey of stepKeys) statement.run(updatedAt, runId, stepKey);
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  /** Leases for this instance whose heartbeat has gone stale. */
  listExpiredLeases(currentInstanceId: string, now: Date): OrchestrationJobV1[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM orchestration_jobs
          WHERE status IN ('leased','running')
            AND (lease_expires_at IS NULL OR lease_expires_at <= ? OR lease_owner != ?)
          ORDER BY created_at ASC`,
      )
      .all(now.toISOString(), currentInstanceId) as unknown as JobRow[];
    return rows.map(decodeJob);
  }

  listJobs(runId: string): OrchestrationJobV1[] {
    const rows = this.db
      .prepare('SELECT * FROM orchestration_jobs WHERE run_id = ? ORDER BY created_at ASC')
      .all(runId) as unknown as JobRow[];
    return rows.map(decodeJob);
  }

  countJobsByStatus(runId: string, stepKey: OrchestrationStepKey): number {
    const row = this.db
      .prepare('SELECT COUNT(*) AS count FROM orchestration_jobs WHERE run_id = ? AND step_key = ?')
      .get(runId, stepKey) as { count: number };
    return row.count;
  }

  /** Test/diagnostic helper: how many jobs exist for a run. */
  listJobStatuses(runId: string): OrchestrationJobStatus[] {
    const rows = this.db
      .prepare('SELECT status FROM orchestration_jobs WHERE run_id = ? ORDER BY created_at ASC')
      .all(runId) as Array<{ status: string }>;
    return rows.map((row) => row.status as OrchestrationJobStatus);
  }

  // ── Checkpoints ─────────────────────────────────────────────────────────

  /** Idempotent on (run, step, phase); a replay refreshes the payload. */
  upsertCheckpoint(checkpoint: OrchestrationCheckpointV1): void {
    const validated = orchestrationCheckpointV1Schema.parse(checkpoint);
    this.db
      .prepare(
        `INSERT INTO orchestration_checkpoints (id, run_id, step_key, phase, input_digest, payload, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(run_id, step_key, phase) DO UPDATE SET
           input_digest = excluded.input_digest,
           payload = excluded.payload,
           created_at = excluded.created_at`,
      )
      .run(
        validated.id,
        validated.runId,
        validated.stepKey,
        validated.phase,
        validated.inputDigest,
        JSON.stringify(validated.payload),
        validated.createdAt,
      );
  }

  listCheckpoints(runId: string): OrchestrationCheckpointV1[] {
    const rows = this.db
      .prepare(
        'SELECT * FROM orchestration_checkpoints WHERE run_id = ? ORDER BY created_at ASC, rowid ASC',
      )
      .all(runId) as unknown as CheckpointRow[];
    return rows.map(decodeCheckpoint);
  }

  getCheckpoint(
    runId: string,
    stepKey: OrchestrationStepKey,
    phase: string,
  ): OrchestrationCheckpointV1 | null {
    const row = this.db
      .prepare(
        'SELECT * FROM orchestration_checkpoints WHERE run_id = ? AND step_key = ? AND phase = ?',
      )
      .get(runId, stepKey, phase) as CheckpointRow | undefined;
    return row ? decodeCheckpoint(row) : null;
  }

  // ── Artifacts ───────────────────────────────────────────────────────────

  insertArtifact(artifact: OrchestrationArtifactV1): void {
    const validated = orchestrationArtifactV1Schema.parse(artifact);
    this.db
      .prepare(
        `INSERT INTO orchestration_artifacts
          (id, run_id, workspace_id, job_id, kind, file_name, mime_type, byte_size, sha256,
           storage_ref, metadata_json, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           byte_size = excluded.byte_size,
           sha256 = excluded.sha256,
           storage_ref = excluded.storage_ref,
           metadata_json = excluded.metadata_json`,
      )
      .run(
        validated.id,
        validated.runId,
        validated.workspaceId,
        validated.jobId,
        validated.kind,
        validated.fileName,
        validated.mimeType,
        validated.byteSize,
        validated.sha256,
        validated.storageRef,
        JSON.stringify(validated.metadata),
        validated.createdAt,
      );
  }

  listArtifacts(runId: string): OrchestrationArtifactV1[] {
    const rows = this.db
      .prepare('SELECT * FROM orchestration_artifacts WHERE run_id = ? ORDER BY created_at ASC')
      .all(runId) as unknown as ArtifactRow[];
    return rows.map(decodeArtifact);
  }

  getArtifact(workspaceId: string, artifactId: string): OrchestrationArtifactV1 | null {
    const row = this.db
      .prepare('SELECT * FROM orchestration_artifacts WHERE workspace_id = ? AND id = ?')
      .get(workspaceId, artifactId) as ArtifactRow | undefined;
    return row ? decodeArtifact(row) : null;
  }

  listArtifactsByKind(
    workspaceId: string,
    videoId: string,
    kind: OrchestrationArtifactKind,
  ): OrchestrationArtifactV1[] {
    const rows = this.db
      .prepare(
        `SELECT a.* FROM orchestration_artifacts a
           JOIN orchestration_runs r ON r.id = a.run_id
          WHERE a.workspace_id = ? AND r.video_id = ? AND a.kind = ?
          ORDER BY a.created_at DESC`,
      )
      .all(workspaceId, videoId, kind) as unknown as ArtifactRow[];
    return rows.map(decodeArtifact);
  }

  // ── Events ──────────────────────────────────────────────────────────────

  appendEvent(event: Omit<OrchestrationEventV1, 'id'>): number {
    const result = this.db
      .prepare(
        `INSERT INTO orchestration_events (run_id, step_key, level, event_type, message, details_json, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        event.runId,
        event.stepKey,
        event.level,
        event.eventType,
        event.message,
        event.details === undefined ? null : JSON.stringify(event.details),
        event.createdAt,
      );
    return Number(result.lastInsertRowid);
  }

  listEvents(runId: string, limit = 500): OrchestrationEventV1[] {
    const rows = this.db
      .prepare('SELECT * FROM orchestration_events WHERE run_id = ? ORDER BY id ASC LIMIT ?')
      .all(runId, limit) as unknown as EventRow[];
    return rows.map(decodeEvent);
  }

  getDetail(runId: string): OrchestrationRunDetailV1 | null {
    const run = this.getRun(runId);
    if (!run) return null;
    return {
      run,
      jobs: this.listJobs(runId),
      checkpoints: this.listCheckpoints(runId),
      artifacts: this.listArtifacts(runId),
      events: this.listEvents(runId),
    };
  }
}
