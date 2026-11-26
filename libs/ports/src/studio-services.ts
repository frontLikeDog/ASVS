import type {
  AspectRatio,
  Asset,
  Claim,
  ConnectionResult,
  DirectorContext,
  DirectorResult,
  Evidence,
  ExportFormat,
  ExportRecord,
  Feature,
  GeneratedKnowledge,
  KnowledgeSuggestion,
  OnboardingDraft,
  ProductionRun,
  Project,
  Release,
  ReviewBundle,
  RunScenario,
  SourceKind,
  StudioSnapshot,
  VideoBrief,
  VideoMode,
  VideoProject,
  WorkspaceRecord,
} from '@asvs/domain';

export type { ConnectionResult, WorkspaceRecord };

export interface KnowledgeSyncInput {
  project: Project;
  features: Feature[];
  claims: Claim[];
  suggestions: KnowledgeSuggestion[];
}

export interface KnowledgeSyncResult {
  project: Project;
  suggestion?: KnowledgeSuggestion;
  message: string;
}

export interface KnowledgeSuggestionResolution {
  suggestion: KnowledgeSuggestion;
  feature?: Feature;
  claim?: Claim;
  evidence?: Evidence;
  message: string;
}

export interface ClaimReverification {
  claim: Claim;
  feature: Feature;
  evidence: Evidence;
}

export interface ConnectionTestInput {
  kind: SourceKind;
  value: string;
  branch?: string;
}

export interface OnboardingResult {
  project: Project;
  knowledge: GeneratedKnowledge;
}

export interface CreateVideoPlanInput {
  project: Project;
  videoTitle: string;
  brief: VideoBrief;
  mode: VideoMode;
  features: Feature[];
  claims: Claim[];
  assets: Asset[];
  release?: Release;
}

export interface InterpretDirectorInput {
  command: string;
  video: VideoProject;
  context: DirectorContext;
  focusSceneId?: string;
}

export interface CreateProductionRunInput {
  video: VideoProject;
  scenario: RunScenario;
}

export interface ReviewBundleInput {
  video: VideoProject;
  project: Project;
  features: Feature[];
  claims: Claim[];
  evidence: Evidence[];
  runs: ProductionRun[];
}

export interface ExportConfig {
  format: ExportFormat;
  aspect: AspectRatio;
  resolution: string;
}

export interface CreateExportRecordInput {
  video: VideoProject;
  config: ExportConfig;
}

/**
 * Boundary for product-knowledge facts. The deterministic mock is one
 * implementation; a real GitHub/doc indexer replaces it without touching the
 * UI state layer.
 */
export interface ProductKnowledgePort {
  syncKnowledge(input: KnowledgeSyncInput): KnowledgeSyncResult;
  acceptSuggestion(
    suggestion: KnowledgeSuggestion,
    features: Feature[],
    claims: Claim[],
  ): KnowledgeSuggestionResolution | null;
  rejectSuggestion(suggestion: KnowledgeSuggestion): KnowledgeSuggestion;
  reverifyClaim(claim: Claim, feature: Feature): ClaimReverification;
}

export interface OnboardingPort {
  simulateConnection(input: ConnectionTestInput): ConnectionResult;
  generateProjectKnowledge(draft: OnboardingDraft): OnboardingResult;
}

/**
 * Demo/production execution boundary. Today every step is a deterministic
 * in-browser simulation; a worker-backed implementation can satisfy the same
 * contract later.
 */
export interface DemoExecutionPort {
  createProductionRun(input: CreateProductionRunInput): ProductionRun;
  tickProductionRun(run: ProductionRun, deltaMs: number): ProductionRun;
  pauseProductionRun(run: ProductionRun): ProductionRun;
  resumeProductionRun(run: ProductionRun): ProductionRun;
  cancelProductionRun(run: ProductionRun): ProductionRun;
  retryProductionRun(run: ProductionRun): ProductionRun;
  approveProductionRun(run: ProductionRun): ProductionRun;
  setProductionSpeed(run: ProductionRun, speed: number): ProductionRun;
}

export interface EvidenceVerificationPort {
  buildReviewBundle(input: ReviewBundleInput): ReviewBundle;
}

export interface DirectorPort {
  createVideoPlan(input: CreateVideoPlanInput): VideoProject;
  interpretDirectorCommand(input: InterpretDirectorInput): DirectorResult;
}

export interface MediaExportPort {
  createExportRecord(input: CreateExportRecordInput): ExportRecord;
  tickExportRecord(record: ExportRecord, deltaMs: number): ExportRecord;
}

export interface StudioClock {
  newId(prefix: string): string;
  nowIso(): string;
  delay(ms: number): Promise<void>;
}

/**
 * Everything the studio store needs from the outside world, grouped by
 * capability so a real backend can replace one port at a time.
 */
export interface StudioServices {
  knowledge: ProductKnowledgePort;
  onboarding: OnboardingPort;
  demo: DemoExecutionPort;
  evidence: EvidenceVerificationPort;
  director: DirectorPort;
  export: MediaExportPort;
  clock: StudioClock;
}

export interface WorkspaceSaveInput {
  workspace: StudioSnapshot;
  /** Revision the client started from; 0 means "create". */
  baseRevision: number;
}

export type WorkspaceSaveResult =
  | { ok: true; record: WorkspaceRecord }
  | { ok: false; conflict: WorkspaceRecord | null };

/**
 * Persistence boundary for the whole workspace. `HttpWorkspaceRepository` talks
 * to apps/api; `LocalWorkspaceRepository` keeps the browser-only mode.
 */
export interface WorkspaceRepository {
  load(workspaceId: string): Promise<WorkspaceRecord | null>;
  save(workspaceId: string, input: WorkspaceSaveInput): Promise<WorkspaceSaveResult>;
}

export interface ProductionRunRepository {
  list(workspaceId: string): Promise<ProductionRun[]>;
  get(workspaceId: string, runId: string): Promise<ProductionRun | null>;
}
