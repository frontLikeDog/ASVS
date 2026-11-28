import type {
  CaptureJobInputV1,
  CaptureJobResultV1,
  DemoPlanDraftV1,
  DemoPlanTemplateId,
  ExportBundleDetailV1,
  NarrationTimingPolicy,
  OrchestrationApprovalV1,
  OrchestrationArtifactV1,
  OrchestrationRunDetailV1,
  OrchestrationRunV1,
  RenderJobInputV1,
  RenderProfile,
  WorkerEvent,
} from '@asvs/domain';
import type { SpeechHealth } from './speech';

/**
 * Step 5C capture options. Omitting `capture` (or `enabled: false`) keeps the
 * 5A/5B behaviour: `plan_demo` and `capture_demo` are recorded as skipped at
 * creation time. `enabled: true` on a video without `real_demo` scenes fails
 * closed at creation with `no_real_demo_scenes` — never a silent skip.
 */
export interface CaptureRunOptions {
  enabled: boolean;
  template?: DemoPlanTemplateId;
  baseUrl?: string;
  resetStrategy?: 'fixture' | 'none';
  viewport?: { width: number; height: number };
  capture?: { width: number; height: number; fps?: number; clipDurationMs?: number };
  /** Template `custom` only; validated by the domain draft schema. */
  customSteps?: DemoPlanDraftV1['steps'];
}

/** Body accepted by `POST /v1/workspaces/:id/orchestration/runs`. */
export interface CreateOrchestrationRunInput {
  videoId: string;
  idempotencyKey: string;
  renderProfile?: Partial<RenderProfile>;
  /** 5B voice options; omitted means narration enabled with server defaults. */
  narration?: {
    enabled?: boolean;
    voiceId?: string;
    speed?: number;
    timingPolicy?: NarrationTimingPolicy;
  };
  /** 5C Gate 2 capture; omitted means no capture (steps skipped). */
  capture?: CaptureRunOptions;
}

/** Body accepted by `PUT /v1/workspaces/:id/orchestration/runs/:runId/demo-plan`. */
export interface UpdateDemoPlanInput {
  /** Replaces the editable fields of the waiting draft. */
  patch: {
    template?: DemoPlanTemplateId;
    baseUrl?: string;
    resetStrategy?: 'fixture' | 'none';
    customSteps?: DemoPlanDraftV1['steps'];
  };
  /** Must equal the digest the caller reviewed; a stale value is a 409. */
  expectedPlanDigest: string;
  note?: string;
}

/** Body accepted by `POST .../runs/:runId/reject`. */
export interface RejectGateInput {
  approvalId: string;
  reason?: string;
}

/** Body accepted by `POST /v1/workspaces/:id/orchestration/exports`. */
export interface CreateExportBundleInput {
  videoId: string;
  runId?: string;
  approvalNote?: string;
}

export interface ExportBundleListOptions {
  videoId?: string;
  limit?: number;
}

export type { ExportBundleDetailV1 };

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
 * Outcome of one capture-job subprocess invocation. Like the render result it
 * reports *what happened*; the orchestrator owns state transitions and the
 * decision to register evidence.
 */
export type CaptureJobExecutionResult =
  | {
      ok: true;
      workerPid: number | null;
      exitCode: number | null;
      checkpoints: Array<{ phase: string; payload: Record<string, unknown> }>;
      result: CaptureJobResultV1;
    }
  | {
      ok: false;
      workerPid: number | null;
      exitCode: number | null;
      signal: string | null;
      /** True when the process died by signal or without writing a result. */
      crashed: boolean;
      code: string;
      message: string;
      checkpoints: Array<{ phase: string; payload: Record<string, unknown> }>;
      /** Present when the worker wrote a structured failure before exiting. */
      result?: CaptureJobResultV1;
    };

export interface CaptureJobExecutorCallbacks {
  onHeartbeat?(pid: number): void;
  onProgress?(phase: string, percent: number): void;
  onCheckpoint?(phase: string, payload: Record<string, unknown>): void;
  onLog?(level: 'info' | 'warn' | 'error', message: string): void;
  onSpawn?(pid: number): void;
}

/**
 * Runs one capture job in an isolated OS process. Implementations must resolve
 * (never reject) after the process exits; `abort()` terminates the browser
 * worker and its Chromium children.
 */
export interface CaptureJobExecutorPort {
  execute(
    job: CaptureJobInputV1,
    inputFile: string,
    outDir: string,
    checkpointFile: string,
    callbacks: CaptureJobExecutorCallbacks,
  ): Promise<CaptureJobExecutionResult>;
  abort(): void;
  isRunning(): boolean;
}

/** `/v1/health` capture block; never contains credentials or full paths. */
export interface CaptureHealth {
  enabled: boolean;
  /** Exact origins captures may target (server allowlist). */
  allowedOrigins: string[];
  defaultBaseUrl: string;
  /** Whether the worker may auto-start a web server for a down target. */
  allowAutoServe: boolean;
  /** Policy version Gate 2 approvals are bound to. */
  policyVersion: string;
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
  /**
   * Gate 2 approval. The server recomputes the waiting plan's digest and
   * refuses unless it equals both the stored one and `subjectDigest`.
   */
  approveRun(
    workspaceId: string,
    runId: string,
    input: { approvalId: string; subjectDigest?: string; decidedBy?: string; note?: string },
  ): Promise<OrchestrationApprovalV1>;
  /** Gate 2 rejection: terminal `failed` with `approval_rejected`. */
  rejectRun(
    workspaceId: string,
    runId: string,
    input: RejectGateInput,
  ): Promise<OrchestrationApprovalV1>;
  /**
   * Replaces the waiting draft (Gate 2). Supersedes the previous approval and
   * returns the new pending approval with a fresh digest.
   */
  updateDemoPlan(
    workspaceId: string,
    runId: string,
    input: UpdateDemoPlanInput,
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
  /**
   * Gate 3 bound export (AC-10): verifies the video is approved for the exact
   * script version, re-hashes MP4 + SRT + manifest, persists the bundle.
   * Throws a 409 `OrchestrationHttpError` when any gate fails.
   */
  createExportBundle(
    workspaceId: string,
    input: CreateExportBundleInput,
  ): Promise<ExportBundleDetailV1>;
  listExportBundles(
    workspaceId: string,
    options?: ExportBundleListOptions,
  ): Promise<ExportBundleDetailV1[]>;
  /** TTS availability for `/v1/health`; never exposes credentials. */
  speechHealth(): SpeechHealth;
  /** Capture capability for `/v1/health`; never exposes full worker paths. */
  captureHealth(): CaptureHealth;
  /** Starts the scheduler loop and recovers orphaned leases. Idempotent. */
  start(): Promise<void>;
  /** Stops the loop, aborts the active worker and waits for it to exit. */
  stop(): Promise<void>;
}
