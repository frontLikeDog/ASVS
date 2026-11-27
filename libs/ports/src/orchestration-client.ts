import type {
  OrchestrationApprovalV1,
  OrchestrationArtifactKind,
  OrchestrationArtifactV1,
  OrchestrationRunDetailV1,
  OrchestrationRunV1,
  RenderProfile,
} from '@asvs/domain';

export interface CreateOrchestrationRunRequest {
  videoId: string;
  idempotencyKey: string;
  renderProfile?: Partial<RenderProfile>;
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
    input: { approvalId: string; subjectDigest?: string },
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
  /** Base-relative URL usable in an `<a download>`. */
  artifactDownloadUrl(
    workspaceId: string,
    artifactId: string,
    kind?: OrchestrationArtifactKind,
  ): string;
  /** Cheap reachability probe; resolves false instead of throwing. */
  isReachable(): Promise<boolean>;
}
