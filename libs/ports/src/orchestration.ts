import type {
  OrchestrationApprovalV1,
  OrchestrationArtifactV1,
  OrchestrationRunDetailV1,
  OrchestrationRunV1,
  RenderJobInputV1,
  RenderProfile,
  WorkerEvent,
} from '@asvs/domain';

/** Body accepted by `POST /v1/workspaces/:id/orchestration/runs`. */
export interface CreateOrchestrationRunInput {
  videoId: string;
  idempotencyKey: string;
  renderProfile?: Partial<RenderProfile>;
}

export interface CreateOrchestrationRunResult {
  run: OrchestrationRunV1;
  /** False when an existing run was returned for the same idempotency key. */
  created: boolean;
}

export interface ListOrchestrationRunsOptions {
  videoId?: string;
  limit?: number;
}

/**
 * Outcome of one executor invocation. The executor reports *what happened*;
 * the orchestrator alone decides state transitions, retries and artifact
 * registration.
 */
export type RenderJobExecutionResult =
  | {
      ok: true;
      workerPid: number | null;
      exitCode: number | null;
      checkpoints: Array<{ phase: string; payload: Record<string, unknown> }>;
      completed: Extract<WorkerEvent, { type: 'completed' }>;
    }
  | {
      ok: false;
      workerPid: number | null;
      exitCode: number | null;
      signal: string | null;
      /** True when the process died by signal or died without a `failed` event. */
      crashed: boolean;
      code: string;
      message: string;
      checkpoints: Array<{ phase: string; payload: Record<string, unknown> }>;
    };

export interface RenderJobExecutorCallbacks {
  onHeartbeat?(pid: number): void;
  onProgress?(phase: string, percent: number): void;
  /** Persist immediately: a crash right after this event must not lose it. */
  onCheckpoint?(phase: string, payload: Record<string, unknown>): void;
  onLog?(level: 'info' | 'warn' | 'error', message: string): void;
  /** Called once the OS process exists, so cancel can target the real pid. */
  onSpawn?(pid: number): void;
}

/**
 * Runs one render job in an isolated OS process. Implementations must resolve
 * (never reject) after the process exits so the scheduler owns all error
 * policy; `abort()` terminates the current process.
 */
export interface RenderJobExecutorPort {
  execute(
    job: RenderJobInputV1,
    inputFile: string,
    outDir: string,
    checkpointFile: string,
    callbacks: RenderJobExecutorCallbacks,
  ): Promise<RenderJobExecutionResult>;
  abort(): void;
  isRunning(): boolean;
}

/**
 * Server-side boundary for the 5A orchestrator (docs/06 §5). HTTP routes and
 * tests talk to this; one instance serves every workspace, and each method is
 * scoped by `workspaceId`.
 */
export interface OrchestrationServicePort {
  createRun(
    workspaceId: string,
    input: CreateOrchestrationRunInput,
  ): Promise<CreateOrchestrationRunResult>;
  listRuns(
    workspaceId: string,
    options?: ListOrchestrationRunsOptions,
  ): Promise<OrchestrationRunV1[]>;
  getRun(workspaceId: string, runId: string): Promise<OrchestrationRunDetailV1 | null>;
  cancelRun(workspaceId: string, runId: string): Promise<OrchestrationRunV1>;
  retryRun(workspaceId: string, runId: string): Promise<OrchestrationRunV1>;
  approveRun(
    workspaceId: string,
    runId: string,
    input: { approvalId: string; subjectDigest?: string },
  ): Promise<OrchestrationApprovalV1>;
  /** Artifact row for the download route; null when unknown in this workspace. */
  getArtifact(workspaceId: string, artifactId: string): Promise<OrchestrationArtifactV1 | null>;
  /**
   * Resolves an artifact to an absolute file inside the artifact root. Returns
   * null when the row is unknown or the stored ref would escape the root; the
   * route never has to know the storage layout.
   */
  resolveArtifactFile(
    workspaceId: string,
    artifactId: string,
  ): Promise<{ artifact: OrchestrationArtifactV1; file: string } | null>;
  /** Latest succeeded run's MP4 artifact for a video, if any. */
  findLatestSucceededVideo(
    workspaceId: string,
    videoId: string,
  ): { run: OrchestrationRunV1; artifact: OrchestrationArtifactV1 } | null;
  /** Starts the scheduler loop and recovers orphaned leases. Idempotent. */
  start(): Promise<void>;
  /** Stops the loop, aborts the active worker and waits for it to exit. */
  stop(): Promise<void>;
}
