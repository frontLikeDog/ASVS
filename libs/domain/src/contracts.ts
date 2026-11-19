import type {
  AspectRatio,
  Asset,
  BrandKit,
  Claim,
  DirectorChange,
  Evidence,
  Feature,
  KnowledgeSuggestion,
  Language,
  ProductionRun,
  ReviewCheck,
  SourceConnection,
  SourceKind,
  VideoProject,
} from './schemas';

export interface DirectorResult {
  intent: string;
  recognized: boolean;
  reply: string;
  changes: DirectorChange[];
  video: VideoProject;
}

export interface GeneratedKnowledge {
  features: Feature[];
  claims: Claim[];
  evidence: Evidence[];
  suggestions: KnowledgeSuggestion[];
  pullRequests?: import('./schemas').PullRequest[];
  releases?: import('./schemas').Release[];
}

export interface ConnectionResult {
  ok: boolean;
  source: SourceConnection;
  error?: string;
}

export interface ReviewBundle {
  checks: ReviewCheck[];
  canApprove: boolean;
  failCount: number;
  warnCount: number;
}

export interface DirectorContext {
  features: Feature[];
  claims: Claim[];
  evidence: Evidence[];
  assets: Asset[];
}

export type ProductionRunSummary = Pick<
  ProductionRun,
  'id' | 'status' | 'scenario' | 'elapsedMs' | 'startedAt' | 'videoId'
>;

export interface KnowledgeSnapshotMeta {
  sourceCount: number;
  featureCount: number;
  verifiedClaimCount: number;
  pendingSuggestionCount: number;
  lastSyncedAt?: string;
}

export interface OnboardingDraft {
  name: string;
  productName: string;
  description: string;
  website: string;
  methods: SourceKind[];
  githubRepo: string;
  branch: string;
  demoUrl: string;
  docs: string[];
  resetStrategy: 'fixture' | 'snapshot' | 'manual';
  brand: BrandKit;
  defaultAspect: AspectRatio;
  defaultLanguage: Language;
  templateId: string;
  connections: Partial<Record<SourceKind, SourceConnection>>;
}

export type { ReviewCheck };
