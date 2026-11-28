import type {
  DemoPlanTemplateId,
  ExportBundleDetailV1,
  OrchestrationApprovalV1,
  OrchestrationArtifactKind,
  OrchestrationArtifactV1,
  OrchestrationRunDetailV1,
  OrchestrationRunV1,
  RenderProfile,
} from '@asvs/domain';
import type {
  CaptureHealth,
  CreateExportBundleInput,
  ExportBundleListOptions,
} from './orchestration';
import type { QaReportResponse } from './qa';

export interface CreateOrchestrationRunRequest {
  videoId: string;
  idempotencyKey: string;
  renderProfile?: Partial<RenderProfile>;
  narration?: {
    enabled?: boolean;
    voiceId?: string;
    speed?: number;
    timingPolicy?: 'extend_scene' | 'fail_on_overflow';
  };
  /** 5C Gate 2 capture; omitted means the capture steps are skipped. */
  capture?: {
    enabled: boolean;
    template?: DemoPlanTemplateId;
    baseUrl?: string;
    resetStrategy?: 'fixture' | 'none';
    viewport?: { width: number; height: number };
    capture?: { width: number; height: number; fps?: number; clipDurationMs?: number };
  };
}

/** Body of `PUT .../runs/:runId/demo-plan`; the digest guards a stale editor. */
export interface UpdateDemoPlanRequest {
  patch: {
    template?: DemoPlanTemplateId;
    baseUrl?: string;
    resetStrategy?: 'fixture' | 'none';
  };
  expectedPlanDigest: string;
  note?: string;
}

export interface CreateOrchestrationRunResponse {
  run: OrchestrationRunV1;
  created: boolean;
}

export interface ListOrchestrationRunsQuery {
  videoId?: string;
}

/**
 * Browser-safe port over `/v1/workspaces/:workspaceId/orchestration`.
 * `libs/adapters-http` implements it; `libs/state` loads it lazily so the
 * adapter and its Zod schemas stay out of the initial bundle.
 */
export interface OrchestrationClientPort {
  createRun(
    workspaceId: string,
    input: CreateOrchestrationRunRequest,
  ): Promise<CreateOrchestrationRunResponse>;
  listRuns(
    workspaceId: string,
    options?: ListOrchestrationRunsQuery,
  ): Promise<OrchestrationRunV1[]>;
  getRun(workspaceId: string, runId: string): Promise<OrchestrationRunDetailV1 | null>;
  cancelRun(workspaceId: string, runId: string): Promise<OrchestrationRunV1>;
  retryRun(workspaceId: string, runId: string): Promise<OrchestrationRunV1>;
  approveRun(
    workspaceId: string,
    runId: string,
    input: { approvalId: string; subjectDigest: string; note?: string },
  ): Promise<OrchestrationApprovalV1>;
  rejectRun(
    workspaceId: string,
    runId: string,
    input: { approvalId: string; reason?: string },
  ): Promise<OrchestrationApprovalV1>;
  /** Edits a waiting Gate 2 draft; supersedes the previous approval. */
  updateDemoPlan(
    workspaceId: string,
    runId: string,
    input: UpdateDemoPlanRequest,
  ): Promise<OrchestrationApprovalV1>;
  /**
   * Latest succeeded run's MP4 for a video, with a ready-made download URL.
   * Artifact metadata for any run comes from `getRun().artifacts`, so no
   * separate metadata endpoint is needed.
   */
  getLatestVideoArtifact(
    workspaceId: string,
    videoId: string,
  ): Promise<{
    run: OrchestrationRunV1;
    artifact: OrchestrationArtifactV1;
    downloadUrl: string;
  } | null>;
  /**
   * 5D · QA report for one run. `stage` omitted returns `final`, or the
   * `capture` report for a run blocked before rendering. `null` on 404.
   */
  getRunQaReport(
    workspaceId: string,
    runId: string,
    stage?: 'capture' | 'final',
  ): Promise<QaReportResponse | null>;
  /**
   * Gate 3 core query: newest QA report for a video, **including runs that QA
   * blocked** (a failed run with no new MP4 still explains itself). `null` on
   * 404. A tampered report file rejects with a 409 `qa_report_tampered`.
   */
  getLatestQaReport(workspaceId: string, videoId: string): Promise<QaReportResponse | null>;
  /** Base-relative URL usable in an `<a download>`. */
  artifactDownloadUrl(
    workspaceId: string,
    artifactId: string,
    kind?: OrchestrationArtifactKind,
  ): string;
  /**
   * Inline preview URL (`?inline=1`). The route only serves PNG bytes inline;
   * anything else is still `attachment`, so this can never become a
   * content-type sniffing hole.
   */
  artifactInlineUrl(workspaceId: string, artifactId: string): string;
  /** Gate 3 bound export; 409 when the video is not approved for this run. */
  createExportBundle(
    workspaceId: string,
    input: CreateExportBundleInput,
  ): Promise<ExportBundleDetailV1>;
  listExportBundles(
    workspaceId: string,
    options?: ExportBundleListOptions,
  ): Promise<ExportBundleDetailV1[]>;
  /** TTS availability from `/v1/health`; never contains credentials. */
  getHealth(): Promise<{
    configured: boolean;
    provider: string;
    synthetic: boolean;
    license: string;
    /** 5C capture capability; absent when the server predates Step 5C. */
    capture?: CaptureHealth;
    /** 5D QA capability; absent when the server predates Step 5D. */
    qa?: {
      enabled: boolean;
      ocrProvider: string;
      ocrConfigured: boolean;
      policyVersion: string;
    };
  }>;
  /** Cheap reachability probe; resolves false instead of throwing. */
  isReachable(): Promise<boolean>;
}
