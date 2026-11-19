import { z } from 'zod';

export const idSchema = z.string().min(1);
export const isoDateSchema = z.string().min(1);
export const hexColorSchema = z
  .string()
  .regex(/^#[0-9a-fA-F]{6}$/, '需要 #RRGGBB 格式的颜色');

export const ASPECT_RATIOS = ['16:9', '9:16', '1:1'] as const;
export const aspectRatioSchema = z.enum(ASPECT_RATIOS);
export type AspectRatio = z.infer<typeof aspectRatioSchema>;

export const LANGUAGES = ['zh-CN', 'en-US'] as const;
export const languageSchema = z.enum(LANGUAGES);
export type Language = z.infer<typeof languageSchema>;

export const LOGO_MARKS = ['spark', 'orbit', 'grid', 'wave'] as const;
export const logoMarkSchema = z.enum(LOGO_MARKS);
export type LogoMark = z.infer<typeof logoMarkSchema>;

export const VISUAL_STYLES = ['editorial', 'product', 'bold', 'minimal'] as const;
export const visualStyleSchema = z.enum(VISUAL_STYLES);
export type VisualStyle = z.infer<typeof visualStyleSchema>;

export const FONT_PAIRS = ['grotesk', 'clean', 'serif', 'mono'] as const;
export const fontPairSchema = z.enum(FONT_PAIRS);
export type FontPair = z.infer<typeof fontPairSchema>;

export const brandKitSchema = z.object({
  logoText: z.string().min(1).max(24),
  logoMark: logoMarkSchema,
  primary: hexColorSchema,
  secondary: hexColorSchema,
  fontPair: fontPairSchema,
  style: visualStyleSchema,
  intro: z.string().max(140),
  outro: z.string().max(140),
});
export type BrandKit = z.infer<typeof brandKitSchema>;

export const SOURCE_KINDS = ['github', 'docs', 'website'] as const;
export const sourceKindSchema = z.enum(SOURCE_KINDS);
export type SourceKind = z.infer<typeof sourceKindSchema>;

export const CONNECTOR_STATUSES = [
  'connected',
  'syncing',
  'error',
  'pending',
  'disconnected',
] as const;
export const connectorStatusSchema = z.enum(CONNECTOR_STATUSES);
export type ConnectorStatus = z.infer<typeof connectorStatusSchema>;

export const sourceConnectionSchema = z.object({
  id: idSchema,
  kind: sourceKindSchema,
  name: z.string().min(1),
  detail: z.string(),
  status: connectorStatusSchema,
  scope: z.string().optional(),
  lastSyncedAt: isoDateSchema.optional(),
  error: z.string().optional(),
  demo: z.boolean(),
});
export type SourceConnection = z.infer<typeof sourceConnectionSchema>;

export const PROJECT_STAGES = ['onboarding', 'active'] as const;
export const projectStageSchema = z.enum(PROJECT_STAGES);
export type ProjectStage = z.infer<typeof projectStageSchema>;

export const projectSchema = z.object({
  id: idSchema,
  name: z.string().min(1),
  productName: z.string().min(1),
  description: z.string(),
  website: z.string(),
  stage: projectStageSchema,
  brand: brandKitSchema,
  sources: z.array(sourceConnectionSchema),
  defaultAspect: aspectRatioSchema,
  defaultLanguage: languageSchema,
  templateId: idSchema,
  analysisCount: z.number().int().min(0),
  createdAt: isoDateSchema,
  updatedAt: isoDateSchema,
  demo: z.boolean(),
});
export type Project = z.infer<typeof projectSchema>;

export const FEATURE_STATUSES = [
  'proposed',
  'implemented',
  'verified',
  'deployed',
  'stale',
  'deprecated',
] as const;
export const featureStatusSchema = z.enum(FEATURE_STATUSES);
export type FeatureStatus = z.infer<typeof featureStatusSchema>;

export const SOURCE_REF_KINDS = ['pr', 'commit', 'file', 'doc', 'runtime', 'release'] as const;
export const sourceRefSchema = z.object({
  kind: z.enum(SOURCE_REF_KINDS),
  label: z.string(),
  detail: z.string(),
});
export type SourceRef = z.infer<typeof sourceRefSchema>;

export const featureSchema = z.object({
  id: idSchema,
  projectId: idSchema,
  name: z.string().min(1),
  summary: z.string(),
  category: z.string(),
  status: featureStatusSchema,
  confidence: z.number().min(0).max(100),
  userConfirmed: z.boolean(),
  sourceRefs: z.array(sourceRefSchema),
  claimIds: z.array(idSchema),
  prIds: z.array(idSchema),
  demoRoute: z.string(),
  updatedAt: isoDateSchema,
  tags: z.array(z.string()),
  demo: z.boolean(),
});
export type Feature = z.infer<typeof featureSchema>;

export const CLAIM_STATUSES = ['proposed', 'supported', 'verified', 'stale', 'rejected'] as const;
export const claimStatusSchema = z.enum(CLAIM_STATUSES);
export type ClaimStatus = z.infer<typeof claimStatusSchema>;

export const claimVerificationSchema = z.object({
  environment: z.string(),
  appVersion: z.string(),
  verifiedAt: isoDateSchema,
  scope: z.string(),
});
export type ClaimVerification = z.infer<typeof claimVerificationSchema>;

export const claimSchema = z.object({
  id: idSchema,
  projectId: idSchema,
  featureId: idSchema,
  statement: z.string().min(1),
  audience: z.string(),
  status: claimStatusSchema,
  evidenceIds: z.array(idSchema),
  verification: claimVerificationSchema.optional(),
  demo: z.boolean(),
});
export type Claim = z.infer<typeof claimSchema>;

export const EVIDENCE_KINDS = ['source', 'test', 'runtime', 'release', 'human'] as const;
export const evidenceKindSchema = z.enum(EVIDENCE_KINDS);
export type EvidenceKind = z.infer<typeof evidenceKindSchema>;

export const EVIDENCE_STATUSES = ['valid', 'stale', 'missing'] as const;
export const evidenceStatusSchema = z.enum(EVIDENCE_STATUSES);
export type EvidenceStatus = z.infer<typeof evidenceStatusSchema>;

export const evidenceSchema = z.object({
  id: idSchema,
  projectId: idSchema,
  featureId: idSchema.optional(),
  claimId: idSchema.optional(),
  kind: evidenceKindSchema,
  title: z.string().min(1),
  detail: z.string(),
  ref: z.string(),
  status: evidenceStatusSchema,
  capturedAt: isoDateSchema,
  demo: z.boolean(),
});
export type Evidence = z.infer<typeof evidenceSchema>;

export const SUGGESTION_KINDS = ['new_feature', 'link_evidence', 'status_change'] as const;
export const suggestionKindSchema = z.enum(SUGGESTION_KINDS);
export type SuggestionKind = z.infer<typeof suggestionKindSchema>;

export const SUGGESTION_STATUSES = ['pending', 'accepted', 'rejected'] as const;
export const suggestionStatusSchema = z.enum(SUGGESTION_STATUSES);
export type SuggestionStatus = z.infer<typeof suggestionStatusSchema>;

export const proposedFeatureSchema = z.object({
  name: z.string().min(1),
  summary: z.string(),
  category: z.string(),
  confidence: z.number().min(0).max(100),
});
export type ProposedFeature = z.infer<typeof proposedFeatureSchema>;

export const knowledgeSuggestionSchema = z.object({
  id: idSchema,
  projectId: idSchema,
  kind: suggestionKindSchema,
  title: z.string(),
  rationale: z.string(),
  confidence: z.number().min(0).max(100),
  targetId: idSchema.optional(),
  claimId: idSchema.optional(),
  proposedStatus: featureStatusSchema.optional(),
  proposedFeature: proposedFeatureSchema.optional(),
  status: suggestionStatusSchema,
  createdAt: isoDateSchema,
  demo: z.boolean(),
});
export type KnowledgeSuggestion = z.infer<typeof knowledgeSuggestionSchema>;

export const PR_KINDS = ['feature', 'improvement', 'internal'] as const;
export const pullRequestSchema = z.object({
  id: idSchema,
  projectId: idSchema,
  number: z.number().int().positive(),
  title: z.string(),
  author: z.string(),
  mergedAt: isoDateSchema,
  kind: z.enum(PR_KINDS),
  summary: z.string(),
  featureIds: z.array(idSchema),
  demo: z.boolean(),
});
export type PullRequest = z.infer<typeof pullRequestSchema>;

export const releaseSchema = z.object({
  id: idSchema,
  projectId: idSchema,
  version: z.string(),
  name: z.string(),
  releasedAt: isoDateSchema,
  prIds: z.array(idSchema),
  highlight: z.string(),
  demo: z.boolean(),
});
export type Release = z.infer<typeof releaseSchema>;

export const ASSET_KINDS = ['capture', 'b-roll', 'image', 'audio'] as const;
export const assetSchema = z.object({
  id: idSchema,
  projectId: idSchema,
  name: z.string(),
  kind: z.enum(ASSET_KINDS),
  durationSec: z.number().min(0),
  description: z.string(),
  palette: z.tuple([z.string(), z.string()]),
  mock: z.boolean(),
});
export type Asset = z.infer<typeof assetSchema>;

export const TEMPLATE_SURFACES = ['paper', 'ink', 'tint', 'brand'] as const;
export const TEMPLATE_LAYOUTS = ['editorial', 'product', 'soft', 'kinetic'] as const;
export const videoTemplateSchema = z.object({
  id: idSchema,
  name: z.string(),
  description: z.string(),
  surface: z.enum(TEMPLATE_SURFACES),
  layout: z.enum(TEMPLATE_LAYOUTS),
});
export type VideoTemplate = z.infer<typeof videoTemplateSchema>;

export const VIDEO_MODES = ['product_film', 'release_video', 'tutorial', 'content_factory'] as const;
export const videoModeSchema = z.enum(VIDEO_MODES);
export type VideoMode = z.infer<typeof videoModeSchema>;

export const VIDEO_STAGES = [
  'draft',
  'planning',
  'script_review',
  'storyboard_ready',
  'producing',
  'review',
  'changes_requested',
  'approved',
  'exported',
] as const;
export const videoStageSchema = z.enum(VIDEO_STAGES);
export type VideoStage = z.infer<typeof videoStageSchema>;

export const TONES = ['confident', 'warm', 'technical', 'bold'] as const;
export const toneSchema = z.enum(TONES);
export type Tone = z.infer<typeof toneSchema>;

export const SCENE_VISUAL_TYPES = ['real_demo', 'motion', 'generated', 'title', 'cta'] as const;
export const sceneVisualTypeSchema = z.enum(SCENE_VISUAL_TYPES);
export type SceneVisualType = z.infer<typeof sceneVisualTypeSchema>;

/**
 * Render IR visual discriminator (docs/05 §4, extended with the editor's
 * `title` / `cta` scenes). `real_demo` deliberately allows a missing
 * `demoPlanId` until Step 2 wires real capture; the renderer must show a
 * non-passable placeholder in that case.
 */
export const sceneVisualSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('title') }).strict(),
  z.object({ type: z.literal('cta') }).strict(),
  z
    .object({
      type: z.literal('real_demo'),
      demoPlanId: idSchema.optional(),
      assetId: idSchema.optional(),
    })
    .strict(),
  z
    .object({
      type: z.literal('motion_graphics'),
      templateId: idSchema,
      props: z.record(z.unknown()).default({}),
    })
    .strict(),
  z
    .object({
      type: z.literal('generated_visual'),
      assetId: idSchema.optional(),
    })
    .strict(),
]);
export type SceneVisual = z.infer<typeof sceneVisualSchema>;

export const SCENE_STATUSES = ['draft', 'approved', 'review'] as const;
export const sceneStatusSchema = z.enum(SCENE_STATUSES);
export type SceneStatus = z.infer<typeof sceneStatusSchema>;

export const SCENE_LOOKS = ['clean', 'warm', 'cinematic'] as const;
export const sceneLookSchema = z.enum(SCENE_LOOKS);
export type SceneLook = z.infer<typeof sceneLookSchema>;

export const videoBriefSchema = z.object({
  objective: z.string().min(1),
  audience: z.string().min(1),
  featureIds: z.array(idSchema),
  releaseId: idSchema.optional(),
  durationSec: z.number().min(5).max(300),
  aspect: aspectRatioSchema,
  language: languageSchema,
  tone: toneSchema,
  style: visualStyleSchema,
  templateId: idSchema,
  useRealCapture: z.boolean(),
  useGeneratedVisuals: z.boolean(),
  cta: z.string(),
  bannedPhrases: z.array(z.string()),
});
export type VideoBrief = z.infer<typeof videoBriefSchema>;

export const sceneSchema = z.object({
  id: idSchema,
  order: z.number().int().min(0),
  /** Monotonic revision for invalidation; bumped whenever the scene changes. */
  revision: z.number().int().min(1).default(1),
  title: z.string(),
  intent: z.string(),
  narration: z.string(),
  caption: z.string(),
  durationSec: z.number().min(2).max(120),
  /** Optional frame cache. `buildStoryboardV1` re-derives it from durationSec. */
  durationFrames: z.number().int().min(1).optional(),
  visualType: sceneVisualTypeSchema,
  /** Structured render IR. Absent on data persisted before the v2 migration. */
  visual: sceneVisualSchema.optional(),
  templateId: idSchema,
  featureId: idSchema.optional(),
  claimIds: z.array(idSchema),
  assetId: idSchema.optional(),
  status: sceneStatusSchema,
  look: sceneLookSchema,
  brightness: z.number().min(0.6).max(1.4),
  vignette: z.boolean(),
  notes: z.string().optional(),
});
export type Scene = z.infer<typeof sceneSchema>;

export const directorChangeSchema = z.object({
  field: z.string(),
  label: z.string(),
  from: z.string().optional(),
  to: z.string().optional(),
});
export type DirectorChange = z.infer<typeof directorChangeSchema>;

export const directorMessageSchema = z.object({
  id: idSchema,
  role: z.enum(['user', 'assistant', 'system']),
  text: z.string(),
  at: isoDateSchema,
  changes: z.array(directorChangeSchema).optional(),
});
export type DirectorMessage = z.infer<typeof directorMessageSchema>;

export const reviewStateSchema = z.object({
  status: z.enum(['pending', 'approved', 'changes_requested']),
  note: z.string().optional(),
  decidedAt: isoDateSchema.optional(),
});
export type ReviewState = z.infer<typeof reviewStateSchema>;

export const DEFAULT_VIDEO_FPS = 30;

export const videoProjectSchema = z.object({
  id: idSchema,
  projectId: idSchema,
  title: z.string().min(1),
  mode: videoModeSchema,
  stage: videoStageSchema,
  /** Timeline frame rate. Frozen when a storyboard is built. */
  fps: z.number().int().min(1).max(60).default(DEFAULT_VIDEO_FPS),
  brief: videoBriefSchema,
  scenes: z.array(sceneSchema),
  directorMessages: z.array(directorMessageSchema),
  scriptVersion: z.number().int().min(1),
  createdAt: isoDateSchema,
  updatedAt: isoDateSchema,
  producedAt: isoDateSchema.optional(),
  review: reviewStateSchema.optional(),
  demo: z.boolean(),
});
export type VideoProject = z.infer<typeof videoProjectSchema>;

export const RUN_SCENARIOS = ['happy_path', 'capture_retry', 'approval_gate'] as const;
export const runScenarioSchema = z.enum(RUN_SCENARIOS);
export type RunScenario = z.infer<typeof runScenarioSchema>;

export const RUN_STATUSES = [
  'queued',
  'running',
  'paused',
  'awaiting_approval',
  'succeeded',
  'failed',
  'cancelled',
] as const;
export const runStatusSchema = z.enum(RUN_STATUSES);
export type RunStatus = z.infer<typeof runStatusSchema>;

export const STEP_STATUSES = [
  'pending',
  'running',
  'succeeded',
  'failed',
  'skipped',
  'awaiting_approval',
] as const;
export const stepStatusSchema = z.enum(STEP_STATUSES);
export type StepStatus = z.infer<typeof stepStatusSchema>;

export const productionStepSchema = z.object({
  id: idSchema,
  key: z.string(),
  name: z.string(),
  description: z.string(),
  status: stepStatusSchema,
  durationMs: z.number().min(0),
  progress: z.number().min(0).max(100),
  attempt: z.number().int().min(0),
  dependsOn: z.array(z.string()),
  requiresApproval: z.boolean().optional(),
  startedAtMs: z.number().optional(),
  finishedAtMs: z.number().optional(),
  error: z.string().optional(),
});
export type ProductionStep = z.infer<typeof productionStepSchema>;

export const LOG_LEVELS = ['info', 'warn', 'error', 'success'] as const;
export const productionLogSchema = z.object({
  id: idSchema,
  atMs: z.number(),
  level: z.enum(LOG_LEVELS),
  text: z.string(),
  stepId: idSchema.optional(),
});
export type ProductionLog = z.infer<typeof productionLogSchema>;

export const productionRunSchema = z.object({
  id: idSchema,
  projectId: idSchema,
  videoId: idSchema,
  scenario: runScenarioSchema,
  status: runStatusSchema,
  steps: z.array(productionStepSchema),
  logs: z.array(productionLogSchema),
  elapsedMs: z.number().min(0),
  startedAt: isoDateSchema,
  finishedAt: isoDateSchema.optional(),
  speed: z.number().min(0.5).max(4),
  approval: z
    .object({
      stepId: idSchema,
      status: z.enum(['pending', 'approved']),
      requestedAtMs: z.number(),
      approvedAtMs: z.number().optional(),
    })
    .optional(),
  failure: z
    .object({
      stepId: idSchema,
      message: z.string(),
      hint: z.string(),
    })
    .optional(),
  input: z.object({
    sceneCount: z.number().int(),
    durationSec: z.number(),
    aspect: aspectRatioSchema,
    claimCount: z.number().int(),
  }),
  demo: z.boolean(),
});
export type ProductionRun = z.infer<typeof productionRunSchema>;

export const EXPORT_FORMATS = ['mp4', 'webm', 'json', 'srt'] as const;
export const exportFormatSchema = z.enum(EXPORT_FORMATS);
export type ExportFormat = z.infer<typeof exportFormatSchema>;

export const EXPORT_STATUSES = ['queued', 'processing', 'completed', 'failed'] as const;
export const exportStatusSchema = z.enum(EXPORT_STATUSES);
export type ExportStatus = z.infer<typeof exportStatusSchema>;

export const exportRecordSchema = z.object({
  id: idSchema,
  projectId: idSchema,
  videoId: idSchema,
  format: exportFormatSchema,
  aspect: aspectRatioSchema,
  resolution: z.string(),
  status: exportStatusSchema,
  progress: z.number().min(0).max(100),
  simulated: z.boolean(),
  note: z.string().optional(),
  fileName: z.string().optional(),
  createdAt: isoDateSchema,
});
export type ExportRecord = z.infer<typeof exportRecordSchema>;

export const reviewCheckSchema = z.object({
  id: z.string(),
  label: z.string(),
  description: z.string(),
  status: z.enum(['pass', 'warn', 'fail']),
  detail: z.string().optional(),
  action: z.enum(['knowledge', 'editor', 'production', 'none']),
});
export type ReviewCheck = z.infer<typeof reviewCheckSchema>;

export const ACTIVITY_KINDS = [
  'project',
  'knowledge',
  'video',
  'production',
  'review',
  'export',
  'system',
] as const;
export const activityEventSchema = z.object({
  id: idSchema,
  projectId: idSchema.optional(),
  videoId: idSchema.optional(),
  kind: z.enum(ACTIVITY_KINDS),
  title: z.string(),
  detail: z.string().optional(),
  at: isoDateSchema,
});
export type ActivityEvent = z.infer<typeof activityEventSchema>;

export const studioSnapshotSchema = z.object({
  projects: z.array(projectSchema),
  features: z.array(featureSchema),
  claims: z.array(claimSchema),
  evidence: z.array(evidenceSchema),
  pullRequests: z.array(pullRequestSchema),
  releases: z.array(releaseSchema),
  suggestions: z.array(knowledgeSuggestionSchema),
  assets: z.array(assetSchema),
  templates: z.array(videoTemplateSchema),
  videos: z.array(videoProjectSchema),
  runs: z.array(productionRunSchema),
  exports: z.array(exportRecordSchema),
  activity: z.array(activityEventSchema),
});
export type StudioSnapshot = z.infer<typeof studioSnapshotSchema>;
