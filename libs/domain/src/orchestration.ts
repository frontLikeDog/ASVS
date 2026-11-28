import { z } from 'zod';
import {
  aspectRatioSchema,
  idSchema,
  isoDateSchema,
  stepStatusSchema,
} from './schemas';
import type { Claim, ClaimPublishEligibility } from './schemas';
import {
  renderAudioAssetV1Schema,
  renderInputV1Schema,
  renderMediaAssetV1Schema,
  renderProfileSchema,
} from './render';

/**
 * Step 5A orchestration contracts (docs/05 §4, docs/06 §5).
 *
 * The server orchestrator is the only authority over run/job state. These
 * schemas are shared by `apps/api` (persistence + scheduler),
 * `workers/render-worker` (JSONL worker protocol) and the browser (read-only
 * projection over HTTP), so every side validates the same shapes.
 */
export const ORCHESTRATION_SCHEMA_VERSION = '1' as const;

const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/, '需要 64 位小写十六进制 SHA256');

export const ORCHESTRATION_RUN_STATUSES = [
  'queued',
  'running',
  'awaiting_approval',
  'succeeded',
  'failed',
  'cancelled',
] as const;
export const orchestrationRunStatusSchema = z.enum(ORCHESTRATION_RUN_STATUSES);
export type OrchestrationRunStatus = z.infer<typeof orchestrationRunStatusSchema>;

export const ORCHESTRATION_JOB_STATUSES = [
  'queued',
  'leased',
  'running',
  'succeeded',
  'retryable',
  'failed',
  'cancelled',
] as const;
export const orchestrationJobStatusSchema = z.enum(ORCHESTRATION_JOB_STATUSES);
export type OrchestrationJobStatus = z.infer<typeof orchestrationJobStatusSchema>;

export const ORCHESTRATION_STEP_KEYS = [
  'freeze_input',
  'verify_claims',
  'prepare_media',
  'synthesize_voice',
  'generate_subtitles',
  'render_video',
  'register_artifacts',
] as const;
export const orchestrationStepKeySchema = z.enum(ORCHESTRATION_STEP_KEYS);
export type OrchestrationStepKey = z.infer<typeof orchestrationStepKeySchema>;

export interface OrchestrationStepDefinition {
  stepKey: OrchestrationStepKey;
  name: string;
  description: string;
  /** `worker` steps run in the isolated render subprocess; the rest inline. */
  executor: 'inline' | 'worker';
}

/** The fixed seven-step 5B DAG. 5C inserts `capture_demo` before `render_video`. */
export const ORCHESTRATION_STEPS: readonly OrchestrationStepDefinition[] = [
  {
    stepKey: 'freeze_input',
    name: '冻结渲染输入',
    description: '读取工作区快照，冻结 RenderInputV1 并计算 digest；拒绝非 16:9。',
    executor: 'inline',
  },
  {
    stepKey: 'verify_claims',
    name: '核验功能声明',
    description: '按 4D 规则阻断未核验、已过期或人工驳回的 Claim。',
    executor: 'inline',
  },
  {
    stepKey: 'prepare_media',
    name: '准备真实素材',
    description: '校验真实录屏文件与 SHA256；没有真实文件时明确标记占位。',
    executor: 'inline',
  },
  {
    stepKey: 'synthesize_voice',
    name: '合成旁白音频',
    description: '逐镜头调用 SpeechPort；内容哈希命中缓存时不重复扣费，旁白超长时延展镜头或明确报错。',
    executor: 'inline',
  },
  {
    stepKey: 'generate_subtitles',
    name: '生成并校验 SRT',
    description: '按冻结帧时间轴生成 SRT，并用独立解析器校验序号、单调、无重叠、不越界。',
    executor: 'inline',
  },
  {
    stepKey: 'render_video',
    name: '渲染视频',
    description: '以独立子进程驱动 render-worker，渲染 H.264 + AAC，ffprobe 校验音画时长与非静音。',
    executor: 'worker',
  },
  {
    stepKey: 'register_artifacts',
    name: '登记产物',
    description: '复核 MP4 / SRT / 回执 / 清单一致性并登记为可下载产物。',
    executor: 'inline',
  },
];

export function orchestrationStepDefinition(
  stepKey: OrchestrationStepKey,
): OrchestrationStepDefinition {
  const definition = ORCHESTRATION_STEPS.find((step) => step.stepKey === stepKey);
  if (!definition) throw new Error(`未知编排步骤：${stepKey}`);
  return definition;
}

// ── State machines ─────────────────────────────────────────────────────────

export const ALLOWED_RUN_TRANSITIONS: Record<
  OrchestrationRunStatus,
  readonly OrchestrationRunStatus[]
> = {
  queued: ['running', 'cancelled', 'failed'],
  running: ['awaiting_approval', 'succeeded', 'failed', 'cancelled'],
  awaiting_approval: ['running', 'cancelled', 'failed'],
  // `failed` may be requeued only through the explicit retry command.
  failed: ['queued'],
  succeeded: [],
  cancelled: [],
};

export const ALLOWED_JOB_TRANSITIONS: Record<
  OrchestrationJobStatus,
  readonly OrchestrationJobStatus[]
> = {
  queued: ['leased', 'cancelled', 'failed'],
  leased: ['running', 'retryable', 'failed', 'cancelled'],
  running: ['succeeded', 'retryable', 'failed', 'cancelled'],
  succeeded: [],
  // A retryable job must be leased again (or manually failed/cancelled).
  retryable: ['queued', 'leased', 'failed', 'cancelled'],
  // Retrying a failed job goes through the run-level retry command first.
  failed: ['queued'],
  cancelled: [],
};

export function canTransitionRun(
  from: OrchestrationRunStatus,
  to: OrchestrationRunStatus,
): boolean {
  return ALLOWED_RUN_TRANSITIONS[from].includes(to);
}

export function canTransitionJob(
  from: OrchestrationJobStatus,
  to: OrchestrationJobStatus,
): boolean {
  return ALLOWED_JOB_TRANSITIONS[from].includes(to);
}

export class OrchestrationTransitionError extends Error {
  readonly code = 'invalid_transition';

  constructor(
    readonly entity: 'run' | 'job',
    readonly from: string,
    readonly to: string,
  ) {
    super(`非法的${entity === 'run' ? '运行' : '任务'}状态迁移：${from} → ${to}`);
    this.name = 'OrchestrationTransitionError';
  }
}

export function assertRunTransition(
  from: OrchestrationRunStatus,
  to: OrchestrationRunStatus,
): void {
  if (!canTransitionRun(from, to)) throw new OrchestrationTransitionError('run', from, to);
}

export function assertJobTransition(
  from: OrchestrationJobStatus,
  to: OrchestrationJobStatus,
): void {
  if (!canTransitionJob(from, to)) throw new OrchestrationTransitionError('job', from, to);
}

export function isTerminalRunStatus(status: OrchestrationRunStatus): boolean {
  return status === 'succeeded' || status === 'failed' || status === 'cancelled';
}

export function isActiveRunStatus(status: OrchestrationRunStatus): boolean {
  return status === 'queued' || status === 'running' || status === 'awaiting_approval';
}

// ── Failure / approval / step state ─────────────────────────────────────────

export const ORCHESTRATION_FAILURE_CODES = [
  'aspect_not_supported',
  'claims_blocked',
  'media_invalid',
  'narration_overflow',
  'tts_not_configured',
  'tts_failed',
  'subtitle_invalid',
  'render_failed',
  'worker_crash_exhausted',
  'heartbeat_lost_exhausted',
  'artifact_mismatch',
  'deadline_exceeded',
  'invalid_input',
  'unexpected_error',
] as const;

export const orchestrationFailureV1Schema = z.object({
  code: z.string().min(1),
  message: z.string().min(1),
  stepKey: orchestrationStepKeySchema.optional(),
  retryable: z.boolean(),
});
export type OrchestrationFailureV1 = z.infer<typeof orchestrationFailureV1Schema>;

export const orchestrationApprovalV1Schema = z.object({
  approvalId: idSchema,
  stepKey: orchestrationStepKeySchema,
  status: z.enum(['pending', 'approved']),
  /** Digest of the subject the approval is bound to (Gate 2, docs/06 §3). */
  subjectDigest: sha256Schema.optional(),
  requestedAt: isoDateSchema,
  approvedAt: isoDateSchema.optional(),
});
export type OrchestrationApprovalV1 = z.infer<typeof orchestrationApprovalV1Schema>;

export const orchestrationStepStateV1Schema = z.object({
  stepKey: orchestrationStepKeySchema,
  status: stepStatusSchema,
  attempt: z.number().int().min(0),
  /** Checkpoint phases already persisted for this step, in arrival order. */
  checkpointPhases: z.array(z.string()).default([]),
  startedAt: isoDateSchema.optional(),
  finishedAt: isoDateSchema.optional(),
  errorCode: z.string().optional(),
  errorMessage: z.string().optional(),
});
export type OrchestrationStepStateV1 = z.infer<typeof orchestrationStepStateV1Schema>;

export const orchestrationInputSummaryV1Schema = z.object({
  sceneCount: z.number().int().min(0),
  durationSec: z.number().min(0),
  aspect: aspectRatioSchema,
  claimCount: z.number().int().min(0),
  usingPlaceholder: z.boolean().optional(),
  /** 5B: narration state; absent for runs that opt out of voice. */
  narration: z
    .object({
      enabled: z.boolean(),
      clipCount: z.number().int().min(0),
      cacheHits: z.number().int().min(0),
      synthetic: z.boolean(),
      timingPolicy: z.string().min(1),
      adjustments: z.number().int().min(0),
    })
    .optional(),
});
export type OrchestrationInputSummaryV1 = z.infer<typeof orchestrationInputSummaryV1Schema>;

export const orchestrationRunV1Schema = z.object({
  schemaVersion: z.literal(ORCHESTRATION_SCHEMA_VERSION),
  id: idSchema,
  workspaceId: idSchema,
  projectId: idSchema,
  videoId: idSchema,
  idempotencyKey: z.string().min(1).max(200),
  status: orchestrationRunStatusSchema,
  renderProfile: renderProfileSchema,
  /** Digest of the frozen RenderInputV1; null until `freeze_input` ran. */
  inputDigest: sha256Schema.nullable(),
  currentStepKey: orchestrationStepKeySchema.nullable(),
  steps: z.array(orchestrationStepStateV1Schema),
  input: orchestrationInputSummaryV1Schema,
  approval: orchestrationApprovalV1Schema.optional(),
  failure: orchestrationFailureV1Schema.optional(),
  createdAt: isoDateSchema,
  updatedAt: isoDateSchema,
  startedAt: isoDateSchema.optional(),
  finishedAt: isoDateSchema.optional(),
});
export type OrchestrationRunV1 = z.infer<typeof orchestrationRunV1Schema>;

export function buildInitialRunSteps(): OrchestrationStepStateV1[] {
  return ORCHESTRATION_STEPS.map((definition) => ({
    stepKey: definition.stepKey,
    status: 'pending' as const,
    attempt: 0,
    checkpointPhases: [],
  }));
}

/** 0–100 across the five steps; succeeded steps count fully. */
export function runProgressPercent(run: Pick<OrchestrationRunV1, 'status' | 'steps'>): number {
  if (run.status === 'succeeded') return 100;
  if (run.steps.length === 0) return 0;
  const total = run.steps.reduce(
    (sum, step) => sum + (step.status === 'succeeded' || step.status === 'skipped' ? 1 : 0),
    0,
  );
  return Math.round((total / run.steps.length) * 100);
}

export function nextPendingStep(
  run: Pick<OrchestrationRunV1, 'steps'>,
): OrchestrationStepStateV1 | undefined {
  return run.steps.find(
    (step) => step.status !== 'succeeded' && step.status !== 'skipped',
  );
}

// ── Jobs, checkpoints, artifacts, events (docs/05 §4 JobEnvelopeV1) ────────

export const ORCHESTRATION_JOB_TYPES = ['inline', 'render'] as const;
export const orchestrationJobTypeSchema = z.enum(ORCHESTRATION_JOB_TYPES);
export type OrchestrationJobType = z.infer<typeof orchestrationJobTypeSchema>;

export const orchestrationJobV1Schema = z.object({
  schemaVersion: z.literal(ORCHESTRATION_SCHEMA_VERSION),
  jobId: idSchema,
  runId: idSchema,
  workspaceId: idSchema,
  stepKey: orchestrationStepKeySchema,
  type: orchestrationJobTypeSchema,
  status: orchestrationJobStatusSchema,
  idempotencyKey: z.string().min(1).max(300),
  inputDigest: sha256Schema,
  attempt: z.number().int().min(0),
  maxAttempts: z.number().int().min(1).max(20),
  leaseOwner: z.string().min(1).nullable(),
  leaseExpiresAt: isoDateSchema.nullable(),
  heartbeatAt: isoDateSchema.nullable(),
  workerPid: z.number().int().positive().nullable(),
  deadlineAt: isoDateSchema.nullable(),
  lastCheckpointPhase: z.string().nullable(),
  errorCode: z.string().nullable(),
  errorMessage: z.string().nullable(),
  createdAt: isoDateSchema,
  updatedAt: isoDateSchema,
});
export type OrchestrationJobV1 = z.infer<typeof orchestrationJobV1Schema>;

export const CHECKPOINT_PHASES = [
  'step_done',
  'narration_ready',
  'subtitles_ready',
  'bundle_ready',
  'video_rendered',
  'verified_receipt',
] as const;
export const checkpointPhaseSchema = z.enum(CHECKPOINT_PHASES);
export type CheckpointPhase = z.infer<typeof checkpointPhaseSchema>;

export const orchestrationCheckpointV1Schema = z.object({
  schemaVersion: z.literal(ORCHESTRATION_SCHEMA_VERSION),
  id: idSchema,
  runId: idSchema,
  stepKey: orchestrationStepKeySchema,
  phase: z.string().min(1),
  inputDigest: sha256Schema,
  payload: z.record(z.unknown()),
  createdAt: isoDateSchema,
});
export type OrchestrationCheckpointV1 = z.infer<typeof orchestrationCheckpointV1Schema>;

export const ORCHESTRATION_ARTIFACT_KINDS = [
  'video_mp4',
  'subtitles_srt',
  'render_manifest',
  'artifact_receipt',
] as const;
export const orchestrationArtifactKindSchema = z.enum(ORCHESTRATION_ARTIFACT_KINDS);
export type OrchestrationArtifactKind = z.infer<typeof orchestrationArtifactKindSchema>;

export const orchestrationArtifactV1Schema = z.object({
  schemaVersion: z.literal(ORCHESTRATION_SCHEMA_VERSION),
  id: idSchema,
  runId: idSchema,
  workspaceId: idSchema,
  jobId: idSchema,
  kind: orchestrationArtifactKindSchema,
  fileName: z.string().min(1),
  mimeType: z.string().min(1),
  byteSize: z.number().int().nonnegative(),
  sha256: sha256Schema,
  /** POSIX path relative to `artifactRoot`; never absolute or `..`. */
  storageRef: z.string().min(1),
  metadata: z.record(z.unknown()).default({}),
  createdAt: isoDateSchema,
});
export type OrchestrationArtifactV1 = z.infer<typeof orchestrationArtifactV1Schema>;

export const ORCHESTRATION_EVENT_LEVELS = ['info', 'warn', 'error', 'success'] as const;
export const orchestrationEventLevelSchema = z.enum(ORCHESTRATION_EVENT_LEVELS);
export type OrchestrationEventLevel = z.infer<typeof orchestrationEventLevelSchema>;

export const ORCHESTRATION_EVENT_TYPES = [
  'state_change',
  'checkpoint',
  'heartbeat_lost',
  'worker_crash',
  'retry',
  'cancel',
  'approval',
  'log',
] as const;
export const orchestrationEventTypeSchema = z.enum(ORCHESTRATION_EVENT_TYPES);
export type OrchestrationEventType = z.infer<typeof orchestrationEventTypeSchema>;

export const orchestrationEventV1Schema = z.object({
  schemaVersion: z.literal(ORCHESTRATION_SCHEMA_VERSION),
  id: z.number().int().min(1),
  runId: idSchema,
  stepKey: orchestrationStepKeySchema.nullable(),
  level: orchestrationEventLevelSchema,
  eventType: orchestrationEventTypeSchema,
  message: z.string().min(1),
  details: z.record(z.unknown()).optional(),
  createdAt: isoDateSchema,
});
export type OrchestrationEventV1 = z.infer<typeof orchestrationEventV1Schema>;

export const orchestrationRunDetailV1Schema = z.object({
  run: orchestrationRunV1Schema,
  jobs: z.array(orchestrationJobV1Schema),
  checkpoints: z.array(orchestrationCheckpointV1Schema),
  artifacts: z.array(orchestrationArtifactV1Schema),
  events: z.array(orchestrationEventV1Schema),
});
export type OrchestrationRunDetailV1 = z.infer<typeof orchestrationRunDetailV1Schema>;

// ── Render job protocol (apps/api ⇄ workers/render-worker) ─────────────────

/**
 * Written by the orchestrator to `<runDir>/render-job-input.json` and read by
 * the worker. Paths are absolute because the worker must not guess the
 * workspace layout; every file it touches is named here.
 */
export const renderJobInputV1Schema = z.object({
  schemaVersion: z.literal(ORCHESTRATION_SCHEMA_VERSION),
  kind: z.literal('asvs.render-job'),
  jobId: idSchema,
  artifactId: idSchema,
  runId: idSchema,
  input: renderInputV1Schema,
  /** Real capture files referenced by `Asset.media`; empty when placeholder. */
  media: z.array(renderMediaAssetV1Schema).default([]),
  /** Normalized narration WAV files copied into the render public dir. */
  audio: z.array(renderAudioAssetV1Schema).default([]),
  /** Absolute path of the server-verified SRT to bind into manifest.json. */
  subtitlesPath: z.string().min(1).optional(),
  /** Scene durations extended to fit narration; surfaced in manifest.json. */
  timingAdjustments: z
    .array(
      z.object({
        sceneId: idSchema,
        originalDurationFrames: z.number().int().min(1),
        effectiveDurationFrames: z.number().int().min(1),
        audioDurationMs: z.number().int().min(1),
        overflowMs: z.number().int().min(0),
      }),
    )
    .optional(),
  outputFileName: z.string().regex(/^[A-Za-z0-9._-]+\.mp4$/, '输出文件名必须是安全的 .mp4'),
  jobDigest: sha256Schema,
  createdAt: isoDateSchema,
});
export type RenderJobInputV1 = z.infer<typeof renderJobInputV1Schema>;

/** Persisted inside the run artifact dir; survives API and worker restarts. */
export const renderCheckpointFileV1Schema = z.object({
  schemaVersion: z.literal(ORCHESTRATION_SCHEMA_VERSION),
  kind: z.literal('asvs.render-checkpoint'),
  jobDigest: sha256Schema,
  updatedAt: isoDateSchema,
  phases: z.array(
    z.object({
      phase: z.string().min(1),
      at: isoDateSchema,
      payload: z.record(z.unknown()).default({}),
    }),
  ),
});
export type RenderCheckpointFileV1 = z.infer<typeof renderCheckpointFileV1Schema>;

export const WORKER_EVENT_PREFIX = 'ASVS_EVENT ' as const;

export const workerEventSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('heartbeat'),
    pid: z.number().int().positive(),
    at: isoDateSchema,
  }),
  z.object({
    type: z.literal('progress'),
    phase: z.string().min(1),
    percent: z.number().min(0).max(100),
    at: isoDateSchema.optional(),
  }),
  z.object({
    type: z.literal('checkpoint'),
    phase: z.string().min(1),
    payload: z.record(z.unknown()).default({}),
    at: isoDateSchema.optional(),
  }),
  z.object({
    type: z.literal('log'),
    level: z.enum(['info', 'warn', 'error']),
    message: z.string(),
    at: isoDateSchema.optional(),
  }),
  z.object({
    type: z.literal('completed'),
    receiptPath: z.string().min(1),
    manifestPath: z.string().min(1),
    outputPath: z.string().min(1),
    outputSha256: sha256Schema,
    byteSize: z.number().int().positive(),
    /** Present when the job carried narration; the worker's own probe result. */
    audio: z
      .object({
        codecName: z.string(),
        sampleRate: z.number().int().positive(),
        channels: z.number().int().min(1).max(2),
        durationMs: z.number().int().nonnegative(),
        meanVolumeDb: z.number(),
      })
      .optional(),
    at: isoDateSchema.optional(),
  }),
  z.object({
    type: z.literal('failed'),
    code: z.string().min(1),
    message: z.string().min(1),
    at: isoDateSchema.optional(),
  }),
]);
export type WorkerEvent = z.infer<typeof workerEventSchema>;

export function encodeWorkerEvent(event: WorkerEvent): string {
  return `${WORKER_EVENT_PREFIX}${JSON.stringify(event)}`;
}

export function parseWorkerEventLine(line: string): WorkerEvent | null {
  const trimmed = line.trim();
  if (!trimmed.startsWith(WORKER_EVENT_PREFIX)) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed.slice(WORKER_EVENT_PREFIX.length)) as unknown;
  } catch {
    return null;
  }
  const result = workerEventSchema.safeParse(parsed);
  return result.success ? result.data : null;
}

/** Digest that binds a worker run to its exact job input and artifact ids. */
export async function renderJobDigest(input: {
  jobId: string;
  artifactId: string;
  renderInput: unknown;
  media: unknown[];
  audio?: unknown[];
  subtitlesPath?: string;
  timingAdjustments?: unknown[];
}): Promise<string> {
  const canonical = stableJson({
    jobId: input.jobId,
    artifactId: input.artifactId,
    input: input.renderInput,
    media: [...input.media].sort((a, b) =>
      JSON.stringify(a).localeCompare(JSON.stringify(b)),
    ),
    audio: [...(input.audio ?? [])].sort((a, b) =>
      JSON.stringify(a).localeCompare(JSON.stringify(b)),
    ),
    subtitlesPath: input.subtitlesPath ?? null,
    timingAdjustments: input.timingAdjustments ?? [],
  });
  return sha256Hex(canonical);
}

// ── Export bundle (Gate 3 bound delivery, AC-10) ───────────────────────────

export const exportBundleV1Schema = z.object({
  schemaVersion: z.literal(ORCHESTRATION_SCHEMA_VERSION),
  id: idSchema,
  workspaceId: idSchema,
  projectId: idSchema,
  videoId: idSchema,
  runId: idSchema,
  mp4ArtifactId: idSchema,
  srtArtifactId: idSchema,
  manifestArtifactId: idSchema,
  receiptArtifactId: idSchema,
  mp4Sha256: sha256Schema,
  srtSha256: sha256Schema,
  manifestSha256: sha256Schema,
  scriptVersion: z.number().int().min(1),
  approvalNote: z.string().optional(),
  createdAt: isoDateSchema,
});
export type ExportBundleV1 = z.infer<typeof exportBundleV1Schema>;

/** Download descriptor returned by the export API; URLs are path-form. */
export const exportBundleFileV1Schema = z.object({
  artifactId: idSchema,
  kind: orchestrationArtifactKindSchema,
  fileName: z.string().min(1),
  mimeType: z.string().min(1),
  byteSize: z.number().int().nonnegative(),
  sha256: sha256Schema,
  downloadUrl: z.string().min(1),
});
export type ExportBundleFileV1 = z.infer<typeof exportBundleFileV1Schema>;

export const exportBundleDetailV1Schema = z.object({
  bundle: exportBundleV1Schema,
  files: z.array(exportBundleFileV1Schema),
  videoDurationMs: z.number().int().nonnegative().optional(),
  audioDurationMs: z.number().int().nonnegative().optional(),
  narration: z
    .object({
      provider: z.string().min(1),
      voiceId: z.string().min(1),
      language: z.string().min(1),
      license: z.string().min(1),
      synthetic: z.boolean(),
      timingPolicy: z.string().min(1),
    })
    .optional(),
});
export type ExportBundleDetailV1 = z.infer<typeof exportBundleDetailV1Schema>;

// ── Claim gate (reuses 4D publishability rules) ────────────────────────────

export const BLOCKING_ELIGIBILITIES: readonly ClaimPublishEligibility[] = [
  'blocked_unverified',
  'blocked_stale',
  'blocked_rejected',
];

export interface ClaimGateBlockedClaim {
  claimId: string;
  eligibility: ClaimPublishEligibility;
  reason: string;
}

export interface ClaimGateEvaluation {
  blocked: ClaimGateBlockedClaim[];
  warnings: ClaimGateBlockedClaim[];
}

/**
 * The 5A `verify_claims` rule. A claim blocks the render when the 4D
 * publishability evaluator marked it `blocked_*`. Claims persisted before 4D
 * carry only `status`, so `stale` / `rejected` are treated as blocking too —
 * failing closed is the whole point of the gate.
 */
export function evaluateClaimGate(claims: Claim[]): ClaimGateEvaluation {
  const blocked: ClaimGateBlockedClaim[] = [];
  const warnings: ClaimGateBlockedClaim[] = [];
  for (const claim of claims) {
    const eligibility: ClaimPublishEligibility | undefined =
      claim.eligibility ??
      (claim.status === 'stale'
        ? 'blocked_stale'
        : claim.status === 'rejected'
          ? 'blocked_rejected'
          : claim.status === 'supported'
            ? 'needs_qualification'
            : claim.status === 'verified'
              ? 'publishable'
              : 'blocked_unverified');
    if (BLOCKING_ELIGIBILITIES.includes(eligibility)) {
      blocked.push({
        claimId: claim.id,
        eligibility,
        reason:
          claim.blockers?.[0] ??
          claim.guidance ??
          `声明 ${claim.id} 的可发布资格为 ${eligibility}。`,
      });
    } else if (eligibility === 'needs_qualification') {
      warnings.push({
        claimId: claim.id,
        eligibility,
        reason: claim.guidance ?? '需要限定表述，渲染仍继续。',
      });
    }
  }
  return { blocked, warnings };
}

// ── Safe storage paths ─────────────────────────────────────────────────────

/** Returns null when `relative` escapes the root or is not POSIX-relative. */
export function isSafeRelativePath(relative: string): boolean {
  if (!relative || relative.startsWith('/') || relative.startsWith('\\')) return false;
  if (/^[A-Za-z]:[\\/]/.test(relative)) return false;
  const segments = relative.split(/[\\/]+/);
  return segments.every((segment) => segment !== '' && segment !== '.' && segment !== '..');
}

export function joinStorageRef(...parts: string[]): string {
  return parts.filter(Boolean).join('/');
}

// ── Small crypto helpers (no Node deps: usable in browser + worker + API) ───

function normalizeForStableJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(normalizeForStableJson);
  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, entry]) => entry !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return Object.fromEntries(entries.map(([key, entry]) => [key, normalizeForStableJson(entry)]));
  }
  return value;
}

export function stableJson(value: unknown): string {
  return JSON.stringify(normalizeForStableJson(value));
}

/**
 * SHA-256 of a UTF-8 string. WebCrypto is available in Node 22 (API, worker,
 * tests) and in the browser, so the same implementation serves every runtime
 * without pulling `node:crypto` into the browser bundle.
 */
export async function sha256Hex(text: string): Promise<string> {
  const bytes = new TextEncoder().encode(text);
  const subtle = globalThis.crypto?.subtle;
  if (!subtle) throw new Error('当前运行时没有可用的 SHA-256 实现');
  const digest = await subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
}

