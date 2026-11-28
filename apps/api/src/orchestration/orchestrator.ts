import { createHash, randomUUID } from 'node:crypto';
import {
  copyFileSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  DEFAULT_NARRATION_TIMING_POLICY,
  MIN_SPEECH_SPEED,
  MAX_SPEECH_SPEED,
  ORCHESTRATION_STEPS,
  NarrationOverflowError,
  artifactReceiptV1Schema,
  buildInitialRunSteps,
  buildRenderInput,
  buildSrtFromTimeline,
  canTransitionJob,
  canTransitionRun,
  evaluateClaimGate,
  isRealCaptureAsset,
  isRetryableCaptureCode,
  orchestrationStepDefinition,
  parseAndValidateSrt,
  renderJobDigest,
  renderManifestV1Schema,
  renderProfileSchema,
  reconcileStoryboardWithNarration,
  speechLanguageSchema,
  speechVoiceProfileSchema,
  captureJobDigest,
  computeDemoPlanDigest,
  withDemoPlanApproval,
  stableJson,
  storyboardDurationMs,
  totalStoryboardFrames,
  DEMO_PLAN_TEMPLATE_IDS,
  captureJobInputV1Schema,
  captureReceiptV1Schema,
  type Asset,
  type CaptureJobInputV1,
  type CaptureJobResultV1,
  type CaptureReceiptV1,
  type Claim,
  type DemoPlanDraftV1,
  type DemoPlanSummaryV1,
  type DemoPlanTemplateId,
  type CaptureFailureSummaryV1,
  type ExportBundleDetailV1,
  type ExportBundleFileV1,
  type NarrationClipV1,
  type NarrationInputV1,
  type NarrationTimingAdjustment,
  type NarrationTimingPolicy,
  type OrchestrationApprovalV1,
  type OrchestrationArtifactV1,
  type OrchestrationCheckpointV1,
  type OrchestrationEventLevel,
  type OrchestrationEventType,
  type OrchestrationRunDetailV1,
  type OrchestrationRunV1,
  type OrchestrationStepKey,
  type OrchestrationStepStateV1,
  type RenderAudioAssetV1,
  type RenderInputV1,
  type RenderJobInputV1,
  type RenderMediaAssetV1,
  type RenderProfile,
  type SpeechLanguage,
  type StudioSnapshot,
  type VideoProject,
} from '@asvs/domain';
import type {
  CaptureHealth,
  CaptureJobExecutionResult,
  CaptureJobExecutorPort,
  CreateExportBundleInput,
  CreateOrchestrationRunInput,
  CreateOrchestrationRunResult,
  ExportBundleListOptions,
  ListOrchestrationRunsOptions,
  OrchestrationServicePort,
  RejectGateInput,
  RenderJobExecutionResult,
  RenderJobExecutorPort,
  SpeechHealth,
  UpdateDemoPlanInput,
} from '@asvs/ports';
import type { ExportBundleStore } from '../db/export-bundle-store';
import { OrchestrationApprovalStore } from '../db/orchestration-approval-store';
import { SqliteOrchestrationStore } from '../db/orchestration-store';
import {
  DEFAULT_CAPTURE_CONFIG,
  DemoPlannerService,
  realDemoScenes,
  type CaptureServiceConfig,
  type PlannedCapture,
  type ResolvedCaptureOptions,
} from './demo-planner-service';
import type { SpeechService } from '../speech/speech-service';
import {
  fileExists,
  fileSize,
  readJsonFile,
  resolveArtifactPath,
  sha256File,
  writeJsonFile,
} from './artifacts';
import { OrchestrationHttpError } from './errors';

export interface OrchestratorLogger {
  info: (message: string) => void;
  warn: (message: string) => void;
  error: (message: string) => void;
}

export interface OrchestratorOptions {
  store: SqliteOrchestrationStore;
  /** Root for `workspaces/<ws>/runs/<run>/…`; also the download traversal root. */
  artifactDir: string;
  /** Resolves a workspace snapshot; null when the workspace was never synced. */
  loadWorkspace: (workspaceId: string) => StudioSnapshot | null;
  /**
   * Root for real capture files referenced by capture receipts (`dist/…`).
   * Defaults to the repository root that contains `apps/`.
   */
  mediaRoot?: string;
  executor?: RenderJobExecutorPort;
  /**
   * Narration synthesis (5B). Omitted keeps the orchestrator in 5A silent mode:
   * a run explicitly asking for narration then fails closed with
   * `tts_not_configured` instead of shipping a fake voice.
   */
  speech?: SpeechService | null;
  /** Gate-3 bundle persistence; required for `createExportBundle`. */
  exportStore?: ExportBundleStore | null;
  /**
   * 5C · capture executor. Omitted means real capture is unavailable and the
   * `capture_demo` step fails closed (`capture_not_configured`) rather than
   * pretending a capture happened.
   */
  captureExecutor?: CaptureJobExecutorPort | null;
  /** 5C · server origin allowlist + planner defaults. */
  captureConfig?: CaptureServiceConfig;
  /** Test hook: reuse a planner instead of building one from `captureConfig`. */
  capturePlanner?: DemoPlannerService;
  maxAttempts?: number;
  leaseTtlMs?: number;
  schedulerIntervalMs?: number;
  /** Defaults to a random per-process id; tests pin it for lease assertions. */
  instanceId?: string;
  now?: () => Date;
  logger?: OrchestratorLogger;
}

/**
 * Provenance envelope `capture_demo` writes next to the frozen input: which
 * approved plan produced the real clip now bound into `input.json`. It is not
 * part of the render IR (so it never enters the digest), but it must survive
 * every later rewrite of the file — the run view, the manifest and the
 * acceptance script all read it back to prove the render used real footage.
 */
interface FrozenCaptureProvenance {
  planId: string;
  planDigest: string;
  assetId: string;
  clipSha256: string;
  clipDurationMs: number;
  assertions: { total: number; passed: number };
}

function newId(prefix: string): string {
  return `${prefix}_${randomUUID().replace(/-/g, '').slice(0, 24)}`;
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function runDirFor(artifactDir: string, workspaceId: string, runId: string): string {
  return path.join(artifactDir, 'workspaces', workspaceId, 'runs', runId);
}

function defaultMediaRoot(): string {
  // apps/api/src/orchestration → repository root. `import.meta.url` because
  // both the API and scripts run this module as ESM under tsx.
  return path.resolve(fileURLToPath(new URL('.', import.meta.url)), '../../../..');
}

function isRetryableRenderCode(code: string, crashed: boolean): boolean {
  if (crashed) return true;
  // The worker marks transient failures (render/ffprobe mismatches) as
  // retryable; input and schema problems are deterministic and must not loop.
  return code === 'render_failed' || code === 'artifact_mismatch';
}

/**
 * 5A orchestrator: the single authority over run/job state.
 *
 * - DAG advancement runs in-process; the render step alone is delegated to an
 *   isolated subprocess through `RenderJobExecutorPort`.
 * - Every transition is persisted before the next side effect, so a crash can
 *   only ever repeat work that has a checkpoint, never skip it.
 * - Subprocess crashes (`SIGKILL`, OOM, deadline) increment `attempt` on the
 *   next lease; exhausting `maxAttempts` fails the run with a structured error
 *   (AC-06).
 */
export class Orchestrator implements OrchestrationServicePort {
  private readonly store: SqliteOrchestrationStore;
  private readonly artifactDir: string;
  private readonly mediaRoot: string;
  private readonly loadWorkspace: (workspaceId: string) => StudioSnapshot | null;
  private readonly executor: RenderJobExecutorPort | null;
  private readonly captureExecutor: CaptureJobExecutorPort | null;
  private readonly planner: DemoPlannerService;
  private readonly approvals: OrchestrationApprovalStore;
  private readonly speech: SpeechService | null;
  private readonly exportStore: ExportBundleStore | null;
  private readonly maxAttempts: number;
  private readonly leaseTtlMs: number;
  private readonly intervalMs: number;
  private readonly instanceId: string;
  private readonly now: () => Date;
  private readonly logger: OrchestratorLogger;

  private timer: NodeJS.Timeout | null = null;
  private pumping = false;
  private stopped = true;
  private activeRunId: string | null = null;
  /** Run whose capture subprocess is alive right now (cancel routing). */
  private activeCaptureRunId: string | null = null;
  private readonly abortRequested = new Set<string>();

  constructor(options: OrchestratorOptions) {
    this.store = options.store;
    this.artifactDir = path.resolve(options.artifactDir);
    this.mediaRoot = path.resolve(options.mediaRoot ?? defaultMediaRoot());
    this.loadWorkspace = options.loadWorkspace;
    this.executor = options.executor ?? null;
    this.captureExecutor = options.captureExecutor ?? null;
    this.planner =
      options.capturePlanner ??
      new DemoPlannerService({ config: options.captureConfig ?? DEFAULT_CAPTURE_CONFIG });
    this.approvals = new OrchestrationApprovalStore(options.store.database);
    this.speech = options.speech ?? null;
    this.exportStore = options.exportStore ?? null;
    this.maxAttempts = options.maxAttempts ?? 3;
    this.leaseTtlMs = options.leaseTtlMs ?? 15_000;
    this.intervalMs = options.schedulerIntervalMs ?? 500;
    this.instanceId = options.instanceId ?? `api_${randomUUID().slice(0, 8)}`;
    this.now = options.now ?? (() => new Date());
    this.logger = options.logger ?? {
      info: () => undefined,
      warn: () => undefined,
      error: () => undefined,
    };
  }

  get instance(): string {
    return this.instanceId;
  }

  // ── Public service API ──────────────────────────────────────────────────

  async createRun(
    workspaceId: string,
    input: CreateOrchestrationRunInput,
  ): Promise<CreateOrchestrationRunResult> {
    const existing = this.store.findRunByKey(workspaceId, input.idempotencyKey);
    if (existing) return { run: existing, created: false };

    const snapshot = this.loadWorkspace(workspaceId);
    if (!snapshot) {
      throw new OrchestrationHttpError(
        404,
        'workspace_not_found',
        `工作区 ${workspaceId} 尚未同步到服务器；无法创建服务端渲染。`,
      );
    }
    const video = snapshot.videos.find((item) => item.id === input.videoId);
    if (!video) {
      throw new OrchestrationHttpError(
        404,
        'video_not_found',
        `视频 ${input.videoId} 不在工作区 ${workspaceId} 中。`,
      );
    }
    if (video.brief.aspect !== '16:9') {
      throw new OrchestrationHttpError(
        400,
        'aspect_not_supported',
        `服务端渲染只支持 16:9，收到 ${video.brief.aspect}。`,
      );
    }
    const renderProfile = renderProfileSchema.parse(input.renderProfile ?? {});
    if (!isSixteenByNine(renderProfile.width, renderProfile.height)) {
      throw new OrchestrationHttpError(
        400,
        'aspect_not_supported',
        `渲染分辨率必须是 16:9，收到 ${renderProfile.width}×${renderProfile.height}。`,
      );
    }
    const timestamp = this.now().toISOString();
    const runId = newId('orchrun');
    const claims = this.resolveClaims(snapshot, video);
    const narration = resolveNarrationRequest(input.narration);
    if (narration.enabled && (!this.speech || !this.speech.isConfigured())) {
      // Fail closed at creation time rather than after an expensive render:
      // a run that asks for narration must never silently ship silent video.
      throw new OrchestrationHttpError(
        503,
        'tts_not_configured',
        '未配置 TTS 服务（ASVS_TTS_PROVIDER / ASVS_TTS_API_URL / ASVS_TTS_API_KEY），无法生成旁白音频。请配置后重试，或显式关闭旁白。',
      );
    }
    // 5C: validate the capture request before any row exists, so a refused
    // request (`no_real_demo_scenes`, origin not allowed, capture disabled)
    // leaves no half-created run behind. `enabled: true` never silently skips.
    const capture = this.planner.validateCreateOptions(video, input.capture);
    if (capture.enabled && !this.captureExecutor) {
      throw new OrchestrationHttpError(
        503,
        'capture_not_configured',
        '服务端未接入 browser-worker 录屏执行器；无法执行真实录屏。请显式关闭 capture 选项，或在具备录屏环境时重试。',
      );
    }
    const captureSceneCount = realDemoScenes(video).length;
    const run: OrchestrationRunV1 = {
      schemaVersion: '1',
      id: runId,
      workspaceId,
      projectId: video.projectId,
      videoId: video.id,
      idempotencyKey: input.idempotencyKey,
      status: 'queued',
      renderProfile,
      inputDigest: null,
      currentStepKey: null,
      steps: buildInitialRunSteps(),
      input: {
        sceneCount: video.scenes.length,
        durationSec: video.scenes.reduce((sum, scene) => sum + scene.durationSec, 0),
        aspect: video.brief.aspect,
        claimCount: claims.length,
        narration: {
          enabled: narration.enabled,
          clipCount: 0,
          cacheHits: 0,
          synthetic: false,
          timingPolicy: narration.timingPolicy,
          adjustments: 0,
        },
        // Always present, even when capture is off: the difference between
        // "not requested" and "skipped" must be visible in the run itself.
        capture: {
          enabled: capture.enabled,
          ...(capture.resolved ? { template: capture.resolved.template } : {}),
          ...(capture.resolved ? { baseUrl: capture.resolved.baseUrl } : {}),
          realDemoSceneCount: captureSceneCount,
        },
      },
      createdAt: timestamp,
      updatedAt: timestamp,
    };

    // The request body is not part of `OrchestrationRunV1`, so it is persisted
    // next to the frozen input where `synthesize_voice` reads it back after a
    // crash. Nothing in it is secret (voice id and speed only).
    writeJsonFile(path.join(runDirFor(this.artifactDir, workspaceId, runId), NARRATION_REQUEST_FILE), {
      schemaVersion: '1',
      enabled: narration.enabled,
      voiceId: narration.voiceId,
      speed: narration.speed,
      timingPolicy: narration.timingPolicy,
      requestedAt: timestamp,
    } satisfies PersistedNarrationRequest);
    if (capture.resolved) {
      writeJsonFile(path.join(runDirFor(this.artifactDir, workspaceId, runId), CAPTURE_REQUEST_FILE), {
        schemaVersion: '1',
        ...capture.resolved,
        requestedAt: timestamp,
      } satisfies PersistedCaptureRequest);
    }

    const created = this.store.insertRun({
      run,
      jobs: ORCHESTRATION_STEPS.map((step) => ({
        id: newId('orchjob'),
        stepKey: step.stepKey,
        type: step.executor === 'worker' ? 'render' : step.executor === 'capture' ? 'capture' : 'inline',
        inputDigest: '0'.repeat(64),
        maxAttempts: this.maxAttempts,
        createdAt: timestamp,
      })),
    });
    if (!created.created) return { run: created.run, created: false };
    if (!narration.enabled) {
      // No voice was requested: the narration steps are not "skipped by luck",
      // they are recorded as skipped so the DAG view stays honest.
      this.markNarrationStepsSkipped(runId);
    }
    if (!capture.enabled) {
      // Same contract for capture: an unrequested capture is recorded as
      // skipped, never silently absent from the DAG.
      this.markCaptureStepsSkipped(runId);
    }

    this.appendEvent(runId, null, 'info', 'state_change', `运行已入队 · 视频 ${video.id}`);
    this.pumpSoon();
    // Return the post-marking row so the caller sees `skipped` immediately
    // rather than a stale `pending` for a step that will never run.
    return { run: this.store.getRun(runId) ?? created.run, created: true };
  }

  async listRuns(
    workspaceId: string,
    options: ListOrchestrationRunsOptions = {},
  ): Promise<OrchestrationRunV1[]> {
    return this.store.listRuns(workspaceId, options);
  }

  async getRun(workspaceId: string, runId: string): Promise<OrchestrationRunDetailV1 | null> {
    const detail = this.store.getDetail(runId);
    if (!detail || detail.run.workspaceId !== workspaceId) return null;
    return detail;
  }

  async cancelRun(workspaceId: string, runId: string): Promise<OrchestrationRunV1> {
    const run = this.requireRun(workspaceId, runId);
    if (run.status === 'cancelled') return run;
    if (!canTransitionRun(run.status, 'cancelled')) {
      throw new OrchestrationHttpError(
        409,
        'invalid_transition',
        `运行处于 ${run.status}，不能再取消。`,
      );
    }
    this.abortRequested.add(runId);
    const timestamp = this.now().toISOString();
    const steps = run.steps.map((step) =>
      step.status === 'succeeded' || step.status === 'skipped'
        ? step
        : { ...step, status: 'skipped' as const, finishedAt: timestamp },
    );
    const next: OrchestrationRunV1 = {
      ...run,
      status: 'cancelled',
      steps,
      currentStepKey: null,
      updatedAt: timestamp,
      finishedAt: timestamp,
    };
    this.store.updateRun(next);
    for (const job of this.store.listJobs(runId)) {
      if (canTransitionJob(job.status, 'cancelled')) {
        this.store.updateJob({
          ...job,
          status: 'cancelled',
          leaseOwner: null,
          leaseExpiresAt: null,
          updatedAt: timestamp,
        });
      }
    }
    if (this.activeRunId === runId) this.executor?.abort();
    if (this.activeCaptureRunId === runId) this.captureExecutor?.abort();
    this.appendEvent(runId, null, 'warn', 'cancel', '运行已被用户取消；活跃渲染进程已终止。');
    return next;
  }

  async retryRun(workspaceId: string, runId: string): Promise<OrchestrationRunV1> {
    const run = this.requireRun(workspaceId, runId);
    if (!canTransitionRun(run.status, 'queued')) {
      throw new OrchestrationHttpError(
        409,
        'invalid_transition',
        `只有 failed 运行可以重试，当前为 ${run.status}。`,
      );
    }
    const timestamp = this.now().toISOString();
    const failedIndex = run.steps.findIndex((step) => step.status !== 'succeeded' && step.status !== 'skipped');
    const retryKeys = run.steps
      .slice(failedIndex < 0 ? run.steps.length : failedIndex)
      .map((step) => step.stepKey);
    const steps = run.steps.map((step, index) =>
      failedIndex >= 0 && index >= failedIndex
        ? {
            ...step,
            status: 'pending' as const,
            attempt: 0,
            errorCode: undefined,
            errorMessage: undefined,
            finishedAt: undefined,
          }
        : step,
    );
    const next: OrchestrationRunV1 = {
      ...run,
      status: 'queued',
      steps,
      currentStepKey: null,
      failure: undefined,
      finishedAt: undefined,
      updatedAt: timestamp,
    };
    this.store.updateRun(next);
    this.store.resetJobsForRetry(runId, retryKeys, timestamp);
    this.abortRequested.delete(runId);
    this.appendEvent(runId, null, 'info', 'retry', `手动重试：${retryKeys.join(' → ')}`);
    this.pumpSoon();
    return next;
  }

  /**
   * Gate 2 approval (docs/06 §3, docs/08 §9 case 7).
   *
   * Four checks, all independent:
   *   1. the approval id names the *current* pending gate;
   *   2. the caller supplies the digest it reviewed — omitting it is never
   *      "approve anyway", it is a refusal;
   *   3. the stored subject digest equals the caller's;
   *   4. re-canonicalizing the stored draft still yields that digest, so a plan
   *      edited behind the API's back invalidates itself here (layer 1 of 3).
   *
   * The ledger write is conditional on `status = 'pending'`, so two browser
   * tabs approving at once cannot both win.
   */
  async approveRun(
    workspaceId: string,
    runId: string,
    input: { approvalId: string; subjectDigest?: string; decidedBy?: string; note?: string },
  ): Promise<OrchestrationApprovalV1> {
    const run = this.requireRun(workspaceId, runId);
    if (run.status !== 'awaiting_approval' || !run.approval) {
      throw new OrchestrationHttpError(409, 'invalid_transition', '当前运行没有待审批的 Gate。');
    }
    if (run.approval.status !== 'pending') {
      throw new OrchestrationHttpError(
        409,
        'approval_already_decided',
        `当前 Gate 已处于 ${run.approval.status}；不能重复决策。`,
      );
    }
    if (run.approval.approvalId !== input.approvalId) {
      throw new OrchestrationHttpError(409, 'approval_mismatch', '审批 ID 与当前 Gate 不匹配。');
    }
    if (!input.subjectDigest) {
      throw new OrchestrationHttpError(
        409,
        'approval_subject_missing',
        '审批必须携带 subjectDigest（计划摘要）；请重新载入计划后再批准。',
      );
    }
    if (run.approval.subjectDigest && run.approval.subjectDigest !== input.subjectDigest) {
      throw new OrchestrationHttpError(
        409,
        'approval_subject_mismatch',
        '审批对象摘要已变化；请基于最新计划重新审批。',
      );
    }
    const isGate2 = run.approval.gateType === 'gate2_demo_capture';
    if (isGate2) {
      if (!run.demoPlan) {
        throw new OrchestrationHttpError(
          409,
          'invalid_transition',
          'Gate 2 审批缺少待审批的演示计划；请重新创建运行。',
        );
      }
      if (run.demoPlan.planDigest !== input.subjectDigest) {
        throw new OrchestrationHttpError(
          409,
          'approval_subject_mismatch',
          '提交的计划摘要与待审批计划不一致；请刷新后重新审阅。',
        );
      }
      const recomputed = await this.recomputePlanDigest(run.demoPlan.draft);
      if (recomputed !== input.subjectDigest) {
        throw new OrchestrationHttpError(
          409,
          'approval_subject_mismatch',
          '服务端重新计算出的计划摘要与提交值不一致：计划在审批期间被修改，旧审批失效。',
        );
      }
      if (run.demoPlan.policyVersion !== this.planner.policyVersion) {
        throw new OrchestrationHttpError(
          409,
          'approval_policy_changed',
          `审批基于 ${run.demoPlan.policyVersion}，当前策略为 ${this.planner.policyVersion}；请重新生成计划。`,
        );
      }
    }
    const timestamp = this.now().toISOString();
    const decidedBy = input.decidedBy?.trim() || 'local';
    const ledger = this.approvals.markApproved(runId, run.approval.approvalId, {
      at: timestamp,
      decidedBy,
      ...(input.note ? { note: input.note } : {}),
    });
    if (!ledger) {
      throw new OrchestrationHttpError(
        409,
        'approval_already_decided',
        '审批已被其他请求处理；请刷新运行状态。',
      );
    }
    this.store.updateRun({
      ...run,
      status: 'running',
      approval: ledger,
      updatedAt: timestamp,
    });
    this.writeCheckpoint(run, run.approval.stepKey, 'step_done', {
      approved: true,
      approvalId: ledger.approvalId,
      subjectDigest: ledger.subjectDigest ?? null,
      decidedBy,
    });
    this.appendEvent(runId, run.approval.stepKey, 'success', 'approval', 'Gate 已批准，运行继续。', {
      approvalId: ledger.approvalId,
      ...(ledger.subjectDigest ? { subjectDigest: ledger.subjectDigest } : {}),
      decidedBy,
    });
    this.pumpSoon();
    return ledger;
  }

  /**
   * Gate 2 rejection. Terminal by design: a rejected plan must be re-planned
   * (or the run recreated), never approved by editing the row afterwards.
   */
  async rejectRun(
    workspaceId: string,
    runId: string,
    input: RejectGateInput,
  ): Promise<OrchestrationApprovalV1> {
    const run = this.requireRun(workspaceId, runId);
    if (run.status !== 'awaiting_approval' || !run.approval) {
      throw new OrchestrationHttpError(409, 'invalid_transition', '当前运行没有待审批的 Gate。');
    }
    if (run.approval.approvalId !== input.approvalId) {
      throw new OrchestrationHttpError(409, 'approval_mismatch', '审批 ID 与当前 Gate 不匹配。');
    }
    if (run.approval.status !== 'pending') {
      throw new OrchestrationHttpError(
        409,
        'approval_already_decided',
        `当前 Gate 已处于 ${run.approval.status}；不能重复决策。`,
      );
    }
    const timestamp = this.now().toISOString();
    const ledger = this.approvals.markRejected(runId, run.approval.approvalId, {
      at: timestamp,
      decidedBy: 'local',
      ...(input.reason ? { note: input.reason } : {}),
    });
    if (!ledger) {
      throw new OrchestrationHttpError(
        409,
        'approval_already_decided',
        '审批已被其他请求处理；请刷新运行状态。',
      );
    }
    this.store.updateRun({ ...run, approval: ledger, updatedAt: timestamp });
    this.appendEvent(
      runId,
      run.approval.stepKey,
      'warn',
      'approval',
      `Gate 被拒绝：${input.reason ?? '未填写原因'}`,
      { approvalId: ledger.approvalId },
    );
    this.failRun(
      run,
      run.approval.stepKey,
      'approval_rejected',
      input.reason
        ? `演示计划被拒绝：${input.reason}`
        : '演示计划被拒绝；请修改计划后重新运行。',
      false,
    );
    return ledger;
  }

  /**
   * Edits the waiting Gate 2 draft. The edit supersedes the previous approval
   * and issues a fresh `approvalId` + digest in one transaction, so a decision
   * taken against the earlier plan can never be reused (docs/08 §9 case 8).
   */
  async updateDemoPlan(
    workspaceId: string,
    runId: string,
    input: UpdateDemoPlanInput,
  ): Promise<OrchestrationApprovalV1> {
    const run = this.requireRun(workspaceId, runId);
    if (run.status !== 'awaiting_approval' || !run.demoPlan || !run.approval) {
      throw new OrchestrationHttpError(
        409,
        'invalid_transition',
        '当前运行没有等待审批的演示计划。',
      );
    }
    if (run.demoPlan.planDigest !== input.expectedPlanDigest) {
      throw new OrchestrationHttpError(
        409,
        'plan_digest_stale',
        '计划已被修改；请刷新后基于最新版本编辑。',
      );
    }
    const snapshot = this.requireWorkspace(run.workspaceId);
    const video = this.requireVideo(snapshot, run.videoId);
    const previous = this.readCaptureOptions(run);
    if (!previous) {
      throw new OrchestrationHttpError(409, 'invalid_transition', '当前运行没有 capture 配置。');
    }
    const template = input.patch.template ?? previous.template;
    if (!DEMO_PLAN_TEMPLATE_IDS.includes(template)) {
      throw new OrchestrationHttpError(400, 'capture_invalid_plan', `未知模板：${template}`);
    }
    const merged: ResolvedCaptureOptions = {
      template,
      baseUrl: input.patch.baseUrl ?? previous.baseUrl,
      resetStrategy: input.patch.resetStrategy ?? previous.resetStrategy,
      ...(previous.viewport ? { viewport: previous.viewport } : {}),
      ...(previous.capture ? { capture: previous.capture } : {}),
      ...(input.patch.customSteps
        ? { customSteps: input.patch.customSteps }
        : previous.customSteps
          ? { customSteps: previous.customSteps }
          : {}),
    };
    const planned = await this.planner.plan(snapshot, video, merged);
    const timestamp = this.now().toISOString();
    const approval: OrchestrationApprovalV1 = {
      approvalId: newId('appr'),
      stepKey: 'capture_demo',
      status: 'pending',
      gateType: 'gate2_demo_capture',
      subjectDigest: planned.digest,
      planId: planned.draft.id,
      policyVersion: planned.policyVersion,
      requestedAt: timestamp,
    };
    this.approvals.createPending(runId, {
      workspaceId,
      approval,
      planDigest: planned.digest,
      riskLevel: planned.risk.level,
      supersedes: run.approval.approvalId,
    });
    this.writeDemoPlanFiles(run, planned, merged);
    this.store.updateRun({
      ...run,
      approval,
      demoPlan: this.summarizePlan(planned, timestamp),
      input: {
        ...run.input,
        ...(run.input.capture
          ? { capture: { ...run.input.capture, planDigest: planned.digest } }
          : {}),
      },
      updatedAt: timestamp,
    });
    this.appendEvent(
      runId,
      'capture_demo',
      'info',
      'approval',
      '演示计划已更新：旧审批作废，等待新的 Gate 2 决策。',
      { approvalId: approval.approvalId, planDigest: planned.digest, supersedes: run.approval.approvalId },
    );
    return approval;
  }

  captureHealth(): CaptureHealth {
    return this.planner.health();
  }

  async getArtifact(workspaceId: string, artifactId: string): Promise<OrchestrationArtifactV1 | null> {
    return this.store.getArtifact(workspaceId, artifactId);
  }

  async resolveArtifactFile(
    workspaceId: string,
    artifactId: string,
  ): Promise<{ artifact: OrchestrationArtifactV1; file: string } | null> {
    const artifact = this.store.getArtifact(workspaceId, artifactId);
    if (!artifact) return null;
    try {
      const file = resolveArtifactPath(this.artifactDir, artifact.storageRef);
      if (!fileExists(file)) return null;
      return { artifact, file };
    } catch {
      return null;
    }
  }

  /** Finds the newest succeeded run + its MP4 artifact for a video. */
  findLatestSucceededVideo(
    workspaceId: string,
    videoId: string,
  ): { run: OrchestrationRunV1; artifact: OrchestrationArtifactV1 } | null {
    const runs = this.store
      .listRuns(workspaceId, { videoId, limit: 50 })
      .filter((run) => run.status === 'succeeded');
    for (const run of runs) {
      const artifact = this.store
        .listArtifacts(run.id)
        .find((item) => item.kind === 'video_mp4');
      if (artifact) return { run, artifact };
    }
    return null;
  }

  // ── Gate-3 export (AC-10) ───────────────────────────────────────────────

  /**
   * Creates a downloadable bundle from an *approved* video. Every gate is
   * re-checked here from server state, never trusted from the client:
   *
   * 1. the video is at stage `approved` or `exported` (Gate 3 passed);
   * 2. the run succeeded and belongs to this workspace + video;
   * 3. the run was produced from the video's current `scriptVersion`;
   * 4. MP4 / SRT / manifest still hash to what the run registered.
   */
  async createExportBundle(
    workspaceId: string,
    input: CreateExportBundleInput,
  ): Promise<ExportBundleDetailV1> {
    if (!this.exportStore) {
      throw new OrchestrationHttpError(503, 'export_unavailable', '导出存储未配置。');
    }
    const snapshot = this.loadWorkspace(workspaceId);
    if (!snapshot) {
      throw new OrchestrationHttpError(404, 'workspace_not_found', `工作区 ${workspaceId} 尚未同步。`);
    }
    const video = snapshot.videos.find((item) => item.id === input.videoId);
    if (!video) {
      throw new OrchestrationHttpError(404, 'video_not_found', `视频 ${input.videoId} 不在工作区中。`);
    }
    if (video.stage !== 'approved' && video.stage !== 'exported') {
      throw new OrchestrationHttpError(
        409,
        'export_not_approved',
        `视频处于 ${video.stage}；必须先在审核页通过 Gate 3 才能导出。`,
      );
    }
    if (video.review?.status !== 'approved') {
      throw new OrchestrationHttpError(
        409,
        'export_not_approved',
        '审核尚未批准（review.status ≠ approved），禁止导出。',
      );
    }

    const candidates = this.store
      .listRuns(workspaceId, { videoId: video.id, limit: 50 })
      .filter((run) => run.status === 'succeeded');
    const run = input.runId
      ? candidates.find((item) => item.id === input.runId)
      : candidates[0];
    if (!run) {
      throw new OrchestrationHttpError(
        409,
        'export_run_missing',
        input.runId
          ? `运行 ${input.runId} 不存在、未成功或不属于该视频。`
          : '没有成功的服务端渲染运行可供导出。',
      );
    }

    // Staleness: a script edit after the render invalidates the approval.
    const frozen = this.readFrozenScriptVersion(run);
    if (frozen !== null && frozen !== video.scriptVersion) {
      throw new OrchestrationHttpError(
        409,
        'export_stale',
        `运行基于 scriptVersion ${frozen}，当前为 ${video.scriptVersion}；请重新渲染并复审。`,
      );
    }

    const artifacts = this.store.listArtifacts(run.id);
    const byKind = (kind: OrchestrationArtifactV1['kind']) =>
      artifacts.find((item) => item.kind === kind);
    const mp4 = byKind('video_mp4');
    const srt = byKind('subtitles_srt');
    const manifest = byKind('render_manifest');
    const receipt = byKind('artifact_receipt');
    if (!mp4 || !srt || !manifest || !receipt) {
      throw new OrchestrationHttpError(
        409,
        'export_incomplete',
        `运行 ${run.id} 缺少完整产物（MP4/SRT/manifest/receipt），无法导出。`,
      );
    }

    // Re-hash now: the row is a claim, the file on disk is the truth.
    const verified: Record<'video_mp4' | 'subtitles_srt' | 'render_manifest' | 'artifact_receipt', OrchestrationArtifactV1> = {
      video_mp4: this.rehashArtifact(workspaceId, mp4),
      subtitles_srt: this.rehashArtifact(workspaceId, srt),
      render_manifest: this.rehashArtifact(workspaceId, manifest),
      artifact_receipt: this.rehashArtifact(workspaceId, receipt),
    };

    const timestamp = this.now().toISOString();
    const bundleId = newId('exportbundle');
    const baseUrl = `/v1/workspaces/${encodeURIComponent(workspaceId)}/orchestration/artifacts`;
    const fileNameFor = (artifact: OrchestrationArtifactV1): string => {
      if (artifact.kind === 'video_mp4') return `${video.id}.mp4`;
      if (artifact.kind === 'subtitles_srt') return `${video.id}.srt`;
      if (artifact.kind === 'render_manifest') return `${video.id}.manifest.json`;
      return `${video.id}.receipt.json`;
    };
    const files: ExportBundleFileV1[] = [
      verified.video_mp4,
      verified.subtitles_srt,
      verified.render_manifest,
      verified.artifact_receipt,
    ].map((artifact) => ({
      artifactId: artifact.id,
      kind: artifact.kind,
      fileName: fileNameFor(artifact),
      mimeType: artifact.mimeType,
      byteSize: artifact.byteSize,
      sha256: artifact.sha256,
      downloadUrl: `${baseUrl}/${encodeURIComponent(artifact.id)}/download`,
    }));

    const manifestJson = readJsonFile<{
      ffprobe?: { durationMs?: number; audio?: { durationMs?: number } };
      narration?: {
        provider?: string;
        voiceId?: string;
        language?: string;
        license?: string;
        synthetic?: boolean;
        timingPolicy?: string;
      };
    }>(resolveArtifactPath(this.artifactDir, verified.render_manifest.storageRef));
    const narrationMeta = manifestJson.narration;

    const bundle = {
      schemaVersion: '1' as const,
      id: bundleId,
      workspaceId,
      projectId: video.projectId,
      videoId: video.id,
      runId: run.id,
      mp4ArtifactId: verified.video_mp4.id,
      srtArtifactId: verified.subtitles_srt.id,
      manifestArtifactId: verified.render_manifest.id,
      receiptArtifactId: verified.artifact_receipt.id,
      mp4Sha256: verified.video_mp4.sha256,
      srtSha256: verified.subtitles_srt.sha256,
      manifestSha256: verified.render_manifest.sha256,
      scriptVersion: video.scriptVersion,
      ...(input.approvalNote ? { approvalNote: input.approvalNote } : {}),
      createdAt: timestamp,
    };
    const detail: ExportBundleDetailV1 = {
      bundle,
      files,
      ...(manifestJson.ffprobe?.durationMs !== undefined
        ? { videoDurationMs: manifestJson.ffprobe.durationMs }
        : {}),
      ...(manifestJson.ffprobe?.audio?.durationMs !== undefined
        ? { audioDurationMs: manifestJson.ffprobe.audio.durationMs }
        : {}),
      ...(narrationMeta?.provider && narrationMeta.voiceId && narrationMeta.language && narrationMeta.license && narrationMeta.timingPolicy
        ? {
            narration: {
              provider: narrationMeta.provider,
              voiceId: narrationMeta.voiceId,
              language: narrationMeta.language,
              license: narrationMeta.license,
              synthetic: Boolean(narrationMeta.synthetic),
              timingPolicy: narrationMeta.timingPolicy,
            },
          }
        : {}),
    };
    this.exportStore.insert(detail);
    this.appendEvent(
      run.id,
      null,
      'success',
      'state_change',
      `导出包已生成：${bundleId}（MP4 ${bundle.mp4Sha256.slice(0, 12)}… / SRT ${bundle.srtSha256.slice(0, 12)}…）`,
    );
    return detail;
  }

  async listExportBundles(
    workspaceId: string,
    options: ExportBundleListOptions = {},
  ): Promise<ExportBundleDetailV1[]> {
    return this.exportStore?.list(workspaceId, options) ?? [];
  }

  speechHealth(): SpeechHealth {
    return (
      this.speech?.health() ?? {
        configured: false,
        provider: 'unconfigured',
        model: 'none',
        synthetic: false,
        license: 'none',
      }
    );
  }

  /** Re-hashes one artifact and refuses to export a file that changed. */
  private rehashArtifact(
    workspaceId: string,
    artifact: OrchestrationArtifactV1,
  ): OrchestrationArtifactV1 {
    let file: string;
    try {
      file = resolveArtifactPath(this.artifactDir, artifact.storageRef);
    } catch {
      throw new OrchestrationHttpError(409, 'export_incomplete', `产物路径不安全：${artifact.fileName}`);
    }
    if (!fileExists(file)) {
      throw new OrchestrationHttpError(409, 'export_incomplete', `产物文件缺失：${artifact.fileName}`);
    }
    const actual = sha256File(file);
    const bytes = fileSize(file);
    if (actual !== artifact.sha256 || bytes !== artifact.byteSize) {
      this.logger.error(
        `${workspaceId}/${artifact.id} 哈希漂移：${actual.slice(0, 12)}… vs ${artifact.sha256.slice(0, 12)}…`,
      );
      throw new OrchestrationHttpError(
        409,
        'export_hash_mismatch',
        `产物 ${artifact.fileName} 的 SHA256 与登记值不一致，拒绝导出。`,
      );
    }
    return artifact;
  }

  /**
   * `scriptVersion` frozen into the run. The render IR has no such field, but
   * the storyboard pins `briefRevisionId = "<videoId>_brief_v<N>"` when it is
   * built, so that suffix is the authoritative frozen version.
   */
  private readFrozenScriptVersion(run: OrchestrationRunV1): number | null {
    const file = path.join(runDirFor(this.artifactDir, run.workspaceId, run.id), 'input.json');
    if (!fileExists(file)) return null;
    try {
      const frozen = readJsonFile<{ input?: { storyboard?: { briefRevisionId?: string } } }>(file);
      const revisionId = frozen.input?.storyboard?.briefRevisionId;
      if (!revisionId) return null;
      const match = /_brief_v(\d+)$/.exec(revisionId);
      return match ? Number(match[1]) : null;
    } catch {
      return null;
    }
  }

  // ── Scheduler ───────────────────────────────────────────────────────────

  async start(): Promise<void> {
    if (!this.stopped) return;
    this.stopped = false;
    this.recoverOrphanedLeases();
    this.timer = setInterval(() => void this.pump(), this.intervalMs);
    this.timer.unref?.();
    queueMicrotask(() => void this.pump());
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    // Killing the children makes any in-flight `execute()` resolve promptly.
    // Both executors are separate OS processes; a capture can be the live one.
    this.executor?.abort();
    this.captureExecutor?.abort();
    // Give the child a moment to exit so onClose does not orphan it.
    for (
      let i = 0;
      i < 40 && (this.executor?.isRunning() || this.captureExecutor?.isRunning());
      i += 1
    ) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    // A pump already inside `advanceRun` keeps writing after abort; let it
    // finish before the caller closes the database. `pump()` bails out of its
    // loop after each step once `stopped` is set, so this bounded wait lasts at
    // most one step — never one full render.
    for (let i = 0; i < 100 && this.pumping; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }

  private pumpSoon(): void {
    if (this.stopped) return;
    queueMicrotask(() => void this.pump());
  }

  /**
   * Recovers leases a previous API process left behind. Any lease owned by
   * another instance is considered orphaned: this deployment runs a single API
   * process over one SQLite file, and the next lease increments `attempt`, so
   * a crash loop still exhausts `maxAttempts`.
   */
  private recoverOrphanedLeases(): void {
    for (const job of this.store.listExpiredLeases(this.instanceId, this.now())) {
      const run = this.store.getRun(job.runId);
      if (!run || !['queued', 'running', 'awaiting_approval'].includes(run.status)) continue;
      this.appendEvent(
        job.runId,
        job.stepKey,
        'warn',
        'heartbeat_lost',
        `发现孤儿租约 ${job.leaseOwner ?? 'unknown'}（pid ${job.workerPid ?? '-'}），按 checkpoint 恢复。`,
      );
      // The lease is only released; `advanceRun` re-leases it, which
      // increments `attempt` and therefore eventually exhausts retries.
      this.store.updateJob({
        ...job,
        leaseOwner: null,
        leaseExpiresAt: null,
        updatedAt: this.now().toISOString(),
      });
    }
  }

  private async pump(): Promise<void> {
    if (this.pumping || this.stopped) return;
    this.pumping = true;
    try {
      // Bounded so a state race can never spin the event loop.
      for (let guard = 0; guard < 100; guard += 1) {
        const step = this.findRunnableStep();
        if (!step) break;
        await this.advanceRun(step.run, step.stepState);
      }
    } catch (error) {
      this.logger.error(`调度器异常：${error instanceof Error ? error.message : String(error)}`);
    } finally {
      this.pumping = false;
    }
  }

  private findRunnableStep(): { run: OrchestrationRunV1; stepState: OrchestrationStepStateV1 } | null {
    for (const run of this.store.listActiveRuns()) {
      if (run.status !== 'queued' && run.status !== 'running') continue;
      const state = run.steps.find(
        (step) => step.status === 'pending' || step.status === 'running',
      );
      if (!state) continue;
      const job = this.store.getJobForStep(run.id, state.stepKey);
      if (!job) continue;
      if (job.status === 'succeeded' || job.status === 'failed' || job.status === 'cancelled') {
        continue;
      }
      const activelyLeased =
        (job.status === 'leased' || job.status === 'running') &&
        job.leaseOwner === this.instanceId &&
        job.leaseExpiresAt !== null &&
        job.leaseExpiresAt > this.now().toISOString();
      if (activelyLeased) continue;
      return { run, stepState: state };
    }
    return null;
  }

  private async advanceRun(
    run: OrchestrationRunV1,
    stepState: OrchestrationStepStateV1,
  ): Promise<void> {
    const stepKey = stepState.stepKey;
    const definition = orchestrationStepDefinition(stepKey);
    const job = this.store.getJobForStep(run.id, stepKey);
    if (!job) return;

    const leased = this.store.leaseJob(job.jobId, {
      owner: this.instanceId,
      leaseTtlMs: this.leaseTtlMs,
      now: this.now(),
    });
    if (!leased) return;

    if (leased.attempt > leased.maxAttempts) {
      this.failRun(
        run,
        stepKey,
        'worker_crash_exhausted',
        `${definition.name} 已用尽 ${leased.maxAttempts} 次尝试，运行终止。`,
        false,
      );
      return;
    }

    const timestamp = this.now().toISOString();
    const startedRun: OrchestrationRunV1 = {
      ...run,
      status: 'running',
      currentStepKey: stepKey,
      startedAt: run.startedAt ?? timestamp,
      updatedAt: timestamp,
      steps: run.steps.map((step) =>
        step.stepKey === stepKey
          ? { ...step, status: 'running', attempt: leased.attempt, startedAt: step.startedAt ?? timestamp }
          : step,
      ),
    };
    this.store.updateRun(startedRun);
    this.store.updateJob({ ...leased, status: 'running', heartbeatAt: timestamp, updatedAt: timestamp });

    try {
      if (definition.executor === 'worker') {
        await this.executeRenderStep(startedRun, stepKey, leased.attempt);
      } else if (definition.executor === 'capture') {
        await this.executeCaptureStep(startedRun, stepKey, leased.attempt);
      } else {
        await this.executeInlineStep(startedRun, stepKey, leased.attempt);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (!(error instanceof StepFailure)) {
        this.logger.error(`${run.id}/${stepKey} 失败：${message}`);
      }
      this.handleStepFailure(startedRun, stepKey, leased.attempt, {
        crashed: false,
        code: error instanceof StepFailure ? error.code : 'unexpected_error',
        message,
        retryable: error instanceof StepFailure ? error.retryable : false,
        checkpoints: error instanceof StepFailure ? error.checkpoints : [],
      });
    }
  }

  // ── Step execution ──────────────────────────────────────────────────────

  private async executeInlineStep(
    run: OrchestrationRunV1,
    stepKey: OrchestrationStepKey,
    attempt: number,
  ): Promise<void> {
    switch (stepKey) {
      case 'freeze_input': {
        const frozen = this.freezeInput(run);
        this.store.updateJobInputDigest(run.id, frozen.digest, this.now().toISOString());
        this.writeCheckpoint(run, stepKey, 'step_done', {
          inputDigest: frozen.digest,
          inputFile: frozen.relativeFile,
        });
        this.completeStep(run, stepKey, attempt, {
          inputDigest: frozen.digest,
          input: run.input,
        });
        return;
      }
      case 'verify_claims': {
        const snapshot = this.requireWorkspace(run.workspaceId);
        const video = this.requireVideo(snapshot, run.videoId);
        const claims = this.resolveClaims(snapshot, video);
        const evaluation = evaluateClaimGate(claims);
        const file = path.join(runDirFor(this.artifactDir, run.workspaceId, run.id), 'claims-check.json');
        writeJsonFile(file, {
          schemaVersion: '1',
          checkedAt: this.now().toISOString(),
          blocked: evaluation.blocked,
          warnings: evaluation.warnings,
        });
        if (evaluation.blocked.length > 0) {
          // Deterministic input: a retry can never change the answer, so this
          // is a terminal failure rather than a retryable one.
          throw new StepFailure(
            'claims_blocked',
            `声明检查阻断：${evaluation.blocked.map((item) => `${item.claimId}(${item.eligibility})`).join('、')}`,
            false,
          );
        }
        this.writeCheckpoint(run, stepKey, 'step_done', {
          blocked: evaluation.blocked,
          warnings: evaluation.warnings,
          claimCount: claims.length,
        });
        this.completeStep(run, stepKey, attempt, {
          claimCount: claims.length,
          warnings: evaluation.warnings.length,
        });
        return;
      }
      case 'plan_demo': {
        await this.planDemoStep(run, stepKey, attempt);
        return;
      }
      case 'prepare_media': {
        const prepared = this.prepareMedia(run);
        this.writeCheckpoint(run, stepKey, 'step_done', {
          usingPlaceholder: prepared.usingPlaceholder,
          mediaFiles: prepared.mediaFiles.map((entry) => entry.assetId),
        });
        this.completeStep(run, stepKey, attempt, {
          usingPlaceholder: prepared.usingPlaceholder,
          mediaCount: prepared.mediaFiles.length,
        });
        return;
      }
      case 'synthesize_voice': {
        await this.synthesizeVoice(run, stepKey, attempt);
        return;
      }
      case 'generate_subtitles': {
        this.generateSubtitles(run, stepKey, attempt);
        return;
      }
      case 'register_artifacts': {
        const registered = this.registerArtifacts(run);
        this.writeCheckpoint(run, stepKey, 'step_done', { artifactIds: registered.artifactIds });
        this.completeStep(run, stepKey, attempt, { artifactIds: registered.artifactIds });
        return;
      }
      default:
        throw new StepFailure('unexpected_error', `未知的进程内步骤：${stepKey}`, false);
    }
  }

  /**
   * `synthesize_voice`: one provider call per unique text (cache hits cost
   * nothing), then reconcile the frozen storyboard against real audio lengths.
   *
   * This step is resumable at its own checkpoint: a crash after synthesis but
   * before the render replays `narration_ready` from disk, and the cache means
   * the replay makes zero provider calls.
   */
  /**
   * `plan_demo` (Gate 2, layer 1/3).
   *
   * Builds the deterministic draft, persists it, opens a pending approval and
   * parks the run in `awaiting_approval`. It never proceeds to capture on its
   * own: the only exit from `awaiting_approval` is an explicit approve (or a
   * reject / cancel).
   *
   * Re-running (after a crash) is idempotent: the draft is a pure function of
   * the workspace + options, so a replay reproduces the same digest and the
   * same plan id. The ledger keeps the previous attempts as history.
   */
  private async planDemoStep(
    run: OrchestrationRunV1,
    stepKey: OrchestrationStepKey,
    attempt: number,
  ): Promise<void> {
    const options = this.readCaptureOptions(run);
    if (!options) {
      // Reached only if the step was not marked skipped at creation; fail
      // loudly rather than inventing a plan nobody asked for.
      throw new StepFailure('capture_not_configured', '运行没有 capture 配置，无法生成演示计划。', false);
    }
    const snapshot = this.requireWorkspace(run.workspaceId);
    const video = this.requireVideo(snapshot, run.videoId);
    let planned;
    try {
      planned = await this.planner.plan(snapshot, video, options);
    } catch (error) {
      if (error instanceof OrchestrationHttpError) {
        throw new StepFailure(
          error.code === 'no_real_demo_scenes' ? 'no_real_demo_scenes' : 'demo_plan_invalid',
          error.message,
          false,
        );
      }
      throw error;
    }

    const timestamp = this.now().toISOString();
    this.writeDemoPlanFiles(run, planned, options);
    // The gate belongs to the step it blocks: a later re-plan (or a crash
    // replay during `plan_demo`) supersedes the previous gate with the same
    // stepKey, so the DAG keeps pointing at the approval that actually gates it.
    const gateStepKey: OrchestrationStepKey = 'capture_demo';
    const approval: OrchestrationApprovalV1 = {
      approvalId: newId('appr'),
      stepKey: gateStepKey,
      status: 'pending',
      gateType: 'gate2_demo_capture',
      subjectDigest: planned.digest,
      planId: planned.draft.id,
      policyVersion: planned.policyVersion,
      requestedAt: timestamp,
    };
    this.approvals.createPending(run.id, {
      workspaceId: run.workspaceId,
      approval,
      planDigest: planned.digest,
      riskLevel: planned.risk.level,
      supersedes: run.approval?.approvalId ?? null,
    });

    this.writeCheckpoint(run, stepKey, 'plan_ready', {
      planId: planned.draft.id,
      planDigest: planned.digest,
      stepCount: planned.draft.steps.length,
      assertionCount: planned.risk.assertionCount,
      riskLevel: planned.risk.level,
      approvalId: approval.approvalId,
    });

    const latest = this.store.getRun(run.id) ?? run;
    if (latest.status !== 'running' && latest.status !== 'queued') return;
    const now = this.now().toISOString();
    this.store.updateRun({
      ...latest,
      status: 'awaiting_approval',
      steps: latest.steps.map((step) =>
        step.stepKey === stepKey
          ? { ...step, status: 'succeeded' as const, attempt, finishedAt: now }
          : step,
      ),
      currentStepKey: null,
      approval,
      demoPlan: this.summarizePlan(planned, timestamp),
      input: {
        ...latest.input,
        ...(latest.input.capture
          ? {
              capture: {
                ...latest.input.capture,
                template: planned.template,
                baseUrl: planned.baseUrl,
                planDigest: planned.digest,
              },
            }
          : {}),
      },
      updatedAt: now,
    });
    const job = this.store.getJobForStep(run.id, stepKey);
    if (job) {
      this.store.updateJob({
        ...job,
        status: 'succeeded',
        leaseOwner: null,
        leaseExpiresAt: null,
        updatedAt: now,
      });
    }
    this.appendEvent(
      run.id,
      stepKey,
      'info',
      'approval',
      `演示计划已生成：${planned.draft.steps.length} 步、${planned.risk.assertionCount} 个断言、风险 ${planned.risk.level}；等待 Gate 2 审批。`,
      {
        approvalId: approval.approvalId,
        planId: planned.draft.id,
        planDigest: planned.digest,
        riskLevel: planned.risk.level,
      },
    );
  }

  private async synthesizeVoice(
    run: OrchestrationRunV1,
    stepKey: OrchestrationStepKey,
    attempt: number,
  ): Promise<void> {
    const runDir = runDirFor(this.artifactDir, run.workspaceId, run.id);
    const narrationFile = path.join(runDir, 'narration.json');
    const request = this.readNarrationRequest(run);

    if (!request.enabled) {
      this.completeSkippedNarrationStep(run, stepKey, attempt, '用户已显式关闭旁白');
      return;
    }
    if (!this.speech || !this.speech.isConfigured()) {
      throw new StepFailure(
        'tts_not_configured',
        '未配置 TTS 服务，无法合成旁白；拒绝以静音或假音色替代。',
        false,
      );
    }

    // Crash after synthesis, before the render: reuse the on-disk narration.
    if (fileExists(narrationFile)) {
      const cached = readJsonFile<{
        clips: NarrationClipV1[];
        audio: RenderAudioAssetV1[];
        cacheHits: number;
        providerCalls: number;
        provider: string;
        synthetic: boolean;
      }>(narrationFile);
      if (cached.clips.length > 0 && cached.audio.every((item) => fileExists(item.sourceFile))) {
        this.writeCheckpoint(run, stepKey, 'narration_ready', {
          clipCount: cached.clips.length,
          cacheHits: cached.cacheHits,
          reused: true,
        });
        this.completeStep(run, stepKey, attempt, {
          clipCount: cached.clips.length,
          cacheHits: cached.cacheHits,
          synthetic: cached.synthetic,
        });
        return;
      }
    }

    const frozen = this.readFrozenInput(run);
    const video = this.requireVideo(this.requireWorkspace(run.workspaceId), run.videoId);
    const language = speechLanguageSchema.parse(video.brief.language ?? 'zh-CN');
    const defaultVoice = this.speech.defaultVoice(language);
    const scenes = frozen.input.storyboard.scenes
      .filter((scene) => scene.narration.trim().length > 0)
      .map((scene) => ({
        sceneId: scene.id,
        sceneRevision: scene.revision,
        text: scene.narration,
        language,
        voiceId: request.voiceId ?? defaultVoice.voiceId,
        speed: request.speed,
      }));
    if (scenes.length === 0) {
      throw new StepFailure(
        'invalid_input',
        '所有镜头都没有旁白文本；请补写旁白或显式关闭旁白。',
        false,
      );
    }

    let report;
    try {
      report = await this.speech.synthesizeNarration(scenes);
    } catch (error) {
      const isSpeechError =
        error instanceof Error && (error as { code?: string }).code === 'tts_not_configured';
      throw new StepFailure(
        isSpeechError ? 'tts_not_configured' : 'tts_failed',
        error instanceof Error ? error.message : String(error),
        !isSpeechError,
      );
    }

    // The storyboard is extended where narration doesn't fit; the adjustment
    // list travels with the render job into manifest.json.
    let reconciled;
    try {
      reconciled = reconcileStoryboardWithNarration(frozen.input.storyboard, report.clips, {
        policy: request.timingPolicy,
      });
    } catch (error) {
      if (error instanceof NarrationOverflowError) {
        throw new StepFailure(
          'narration_overflow',
          `镜头 ${error.sceneId} 的旁白超出画面 ${error.overflowMs}ms（策略 fail_on_overflow）。`,
          false,
        );
      }
      throw error;
    }

    const narrationInput = buildNarrationInputForRender({
      clips: reconciled.clips,
      speed: request.speed,
      timingPolicy: request.timingPolicy,
      language,
    });
    const updatedInput: RenderInputV1 = {
      ...frozen.input,
      storyboard: reconciled.storyboard,
      narration: narrationInput,
    };
    // Keep the frozen IR self-consistent: digest is over the extended storyboard
    // so the worker's fingerprint check still passes.
    const digest = sha256OfJson({ renderInput: updatedInput });
    writeJsonFile(path.join(runDir, 'input.json'), {
      schemaVersion: '1',
      input: updatedInput,
      digest,
      storyboardFrames: totalStoryboardFrames(updatedInput.storyboard),
      durationMs: storyboardDurationMs(updatedInput.storyboard),
      frozenAt: this.now().toISOString(),
      narrationAppliedAt: this.now().toISOString(),
      // `capture_demo` ran before this step and wrote the clip provenance next
      // to the input; this rewrite must carry it forward. Dropping it would
      // make the finished film unprovable: nothing would tie the rendered
      // footage back to the approved plan and its SHA256.
      ...(frozen.capture ? { capture: frozen.capture } : {}),
    });
    const latestRun = this.store.getRun(run.id) ?? run;
    this.store.updateRun({ ...latestRun, inputDigest: digest, updatedAt: this.now().toISOString() });
    writeJsonFile(narrationFile, {
      schemaVersion: '1',
      clips: reconciled.clips,
      audio: report.audio,
      cacheHits: report.cacheHits,
      providerCalls: report.providerCalls,
      provider: report.provider,
      model: report.model,
      voiceId: report.voiceId,
      language: report.language,
      license: report.license,
      synthetic: report.synthetic,
      timingPolicy: request.timingPolicy,
      adjustments: reconciled.adjustments,
      synthesizedAt: this.now().toISOString(),
    });

    this.writeCheckpoint(run, stepKey, 'narration_ready', {
      clipCount: reconciled.clips.length,
      cacheHits: report.cacheHits,
      providerCalls: report.providerCalls,
      synthetic: report.synthetic,
      adjustments: reconciled.adjustments.length,
    });
    this.completeStep(run, stepKey, attempt, {
      clipCount: reconciled.clips.length,
      cacheHits: report.cacheHits,
      synthetic: report.synthetic,
      adjustments: reconciled.adjustments.length,
    });
  }

  /**
   * `generate_subtitles`: builds the SRT from the reconciled frame timeline and
   * validates it with the independent parser. An invalid SRT fails the run —
   * export is never unlocked by a file we cannot prove is well-formed.
   */
  private generateSubtitles(
    run: OrchestrationRunV1,
    stepKey: OrchestrationStepKey,
    attempt: number,
  ): void {
    const request = this.readNarrationRequest(run);
    if (!request.enabled) {
      this.completeSkippedNarrationStep(run, stepKey, attempt, '用户已显式关闭旁白');
      return;
    }
    const runDir = runDirFor(this.artifactDir, run.workspaceId, run.id);
    const frozen = this.readFrozenInput(run);
    const narration = fileExists(path.join(runDir, 'narration.json'))
      ? readJsonFile<{ clips: NarrationClipV1[] }>(path.join(runDir, 'narration.json'))
      : { clips: [] };
    const { cues, content } = buildSrtFromTimeline(frozen.input.storyboard, {
      clips: narration.clips,
    });
    const totalDurationMs = storyboardDurationMs(frozen.input.storyboard);
    const validation = parseAndValidateSrt(content, { totalDurationMs });
    if (!validation.ok) {
      throw new StepFailure(
        'subtitle_invalid',
        `SRT 未通过独立校验，禁止进入渲染/导出：${validation.issues.join('；')}`,
        false,
      );
    }
    const srtFile = path.join(runDir, 'subtitles.srt');
    writeFileSync(srtFile, content, 'utf8');
    // Re-read and re-validate the bytes actually on disk: writing and checking
    // the same in-memory string would not catch an encoding problem.
    const onDisk = readFileSync(srtFile, 'utf8');
    const recheck = parseAndValidateSrt(onDisk, { totalDurationMs });
    if (!recheck.ok) {
      throw new StepFailure(
        'subtitle_invalid',
        `写入后的 SRT 校验失败：${recheck.issues.join('；')}`,
        false,
      );
    }
    this.writeCheckpoint(run, stepKey, 'subtitles_ready', {
      cueCount: cues.length,
      sha256: sha256OfText(onDisk),
      totalDurationMs,
    });
    this.completeStep(run, stepKey, attempt, {
      cueCount: cues.length,
      sha256: sha256OfText(onDisk),
    });
  }

  /**
   * The capture options this run was created with, read back from disk. The
   * request body is not part of the run row, and `plan_demo` must replay
   * identically after a crash — the same contract as `narration-request.json`.
   */
  private readCaptureOptions(run: OrchestrationRunV1): ResolvedCaptureOptions | null {
    const file = path.join(runDirFor(this.artifactDir, run.workspaceId, run.id), CAPTURE_REQUEST_FILE);
    if (!fileExists(file)) return null;
    try {
      const raw = readJsonFile<ResolvedCaptureOptions>(file);
      if (!raw.template || !raw.baseUrl) return null;
      return raw;
    } catch {
      return null;
    }
  }

  /** Persists the draft + its digest next to the other frozen run inputs. */
  private writeDemoPlanFiles(
    run: OrchestrationRunV1,
    planned: PlannedCapture,
    options: ResolvedCaptureOptions,
  ): void {
    const runDir = runDirFor(this.artifactDir, run.workspaceId, run.id);
    writeJsonFile(path.join(runDir, 'demo-plan.json'), {
      schemaVersion: '1',
      planDigest: planned.digest,
      policyVersion: planned.policyVersion,
      template: planned.template,
      risk: planned.risk,
      draft: planned.draft,
      writtenAt: this.now().toISOString(),
    });
    writeJsonFile(path.join(runDir, CAPTURE_REQUEST_FILE), {
      schemaVersion: '1',
      ...options,
      requestedAt: this.now().toISOString(),
    } satisfies PersistedCaptureRequest);
  }

  private summarizePlan(planned: PlannedCapture, requestedAt: string): DemoPlanSummaryV1 {
    return {
      planId: planned.draft.id,
      template: planned.template,
      templateLabel: planned.templateLabel,
      baseUrl: planned.baseUrl,
      allowedOrigins: planned.allowedOrigins,
      planDigest: planned.digest,
      policyVersion: planned.policyVersion,
      requestedAt,
      risk: planned.risk,
      draft: planned.draft,
    };
  }

  /** Recomputes the digest from the stored draft (digest excludes approval). */
  private async recomputePlanDigest(draft: DemoPlanDraftV1): Promise<string> {
    return computeDemoPlanDigest(draft);
  }

  /** Marks the Gate 2 steps skipped at creation time when capture is off. */
  private markCaptureStepsSkipped(runId: string): void {
    const run = this.store.getRun(runId);
    if (!run) return;
    const timestamp = this.now().toISOString();
    const keys = ['plan_demo', 'capture_demo'] as const;
    const steps = run.steps.map((step) =>
      keys.includes(step.stepKey as (typeof keys)[number])
        ? { ...step, status: 'skipped' as const, finishedAt: timestamp }
        : step,
    );
    this.store.updateRun({ ...run, steps, updatedAt: timestamp });
    for (const stepKey of keys) {
      const job = this.store.getJobForStep(run.id, stepKey);
      if (job) {
        this.store.updateJob({
          ...job,
          status: 'succeeded',
          leaseOwner: null,
          leaseExpiresAt: null,
          updatedAt: timestamp,
        });
      }
    }
    this.appendEvent(runId, null, 'info', 'state_change', '未请求真实录屏：plan_demo / capture_demo 已标记为 skipped。');
  }

  private readNarrationRequest(run: OrchestrationRunV1): PersistedNarrationRequest {
    const file = path.join(runDirFor(this.artifactDir, run.workspaceId, run.id), NARRATION_REQUEST_FILE);
    if (!fileExists(file)) {
      // Runs created before 5B (or without the file) are silent by definition.
      return {
        schemaVersion: '1',
        enabled: false,
        speed: 1,
        timingPolicy: DEFAULT_NARRATION_TIMING_POLICY,
        requestedAt: run.createdAt,
      };
    }
    const raw = readJsonFile<Partial<PersistedNarrationRequest>>(file);
    return {
      schemaVersion: '1',
      enabled: raw.enabled ?? false,
      ...(raw.voiceId ? { voiceId: raw.voiceId } : {}),
      speed: raw.speed ?? 1,
      timingPolicy: raw.timingPolicy ?? DEFAULT_NARRATION_TIMING_POLICY,
      requestedAt: raw.requestedAt ?? run.createdAt,
    };
  }

  private readFrozenInput(run: OrchestrationRunV1): {
    input: RenderInputV1;
    digest: string;
    capture?: FrozenCaptureProvenance;
  } {
    const file = path.join(runDirFor(this.artifactDir, run.workspaceId, run.id), 'input.json');
    if (!fileExists(file)) {
      throw new StepFailure('invalid_input', '缺少冻结输入 input.json。', false);
    }
    return readJsonFile<{
      input: RenderInputV1;
      digest: string;
      capture?: FrozenCaptureProvenance;
    }>(file);
  }

  private completeSkippedNarrationStep(
    run: OrchestrationRunV1,
    stepKey: OrchestrationStepKey,
    attempt: number,
    reason: string,
  ): void {
    this.writeCheckpoint(run, stepKey, 'step_done', { skipped: true, reason });
    const timestamp = this.now().toISOString();
    const latest = this.store.getRun(run.id) ?? run;
    if (latest.status === 'failed' || latest.status === 'cancelled' || latest.status === 'succeeded') {
      return;
    }
    const steps = latest.steps.map((step) =>
      step.stepKey === stepKey
        ? { ...step, status: 'skipped' as const, attempt, finishedAt: timestamp }
        : step,
    );
    const allDone = steps.every((step) => step.status === 'succeeded' || step.status === 'skipped');
    const nextStep = steps.find((step) => step.status !== 'succeeded' && step.status !== 'skipped');
    this.store.updateRun({
      ...latest,
      status: allDone ? 'succeeded' : 'running',
      steps,
      currentStepKey: allDone ? null : (nextStep?.stepKey ?? null),
      updatedAt: timestamp,
      finishedAt: allDone ? timestamp : undefined,
    });
    const job = this.store.getJobForStep(run.id, stepKey);
    if (job) {
      this.store.updateJob({
        ...job,
        status: 'succeeded',
        leaseOwner: null,
        leaseExpiresAt: null,
        updatedAt: timestamp,
      });
    }
    this.appendEvent(run.id, stepKey, 'info', 'state_change', `${orchestrationStepDefinition(stepKey).name}已跳过：${reason}`);
  }

  /** Marks the voice steps skipped at creation time when narration is off. */
  private markNarrationStepsSkipped(runId: string): void {
    const run = this.store.getRun(runId);
    if (!run) return;
    const timestamp = this.now().toISOString();
    const steps = run.steps.map((step) =>
      step.stepKey === 'synthesize_voice' || step.stepKey === 'generate_subtitles'
        ? { ...step, status: 'skipped' as const, finishedAt: timestamp }
        : step,
    );
    this.store.updateRun({ ...run, steps, updatedAt: timestamp });
    for (const stepKey of ['synthesize_voice', 'generate_subtitles'] as const) {
      const job = this.store.getJobForStep(run.id, stepKey);
      if (job) {
        this.store.updateJob({
          ...job,
          status: 'succeeded',
          leaseOwner: null,
          leaseExpiresAt: null,
          updatedAt: timestamp,
        });
      }
    }
  }

  private async executeRenderStep(
    run: OrchestrationRunV1,
    stepKey: OrchestrationStepKey,
    attempt: number,
  ): Promise<void> {
    if (!this.executor) {
      throw new StepFailure('worker_missing', '未配置 render executor，无法执行渲染。', false);
    }
    const job = this.store.getJobForStep(run.id, stepKey);
    if (!job) throw new StepFailure('unexpected_error', '缺少 render_video 任务记录。', false);
    if (this.abortRequested.has(run.id)) return;

    const runDir = runDirFor(this.artifactDir, run.workspaceId, run.id);
    const frozenPath = path.join(runDir, 'input.json');
    if (!fileExists(frozenPath)) {
      throw new StepFailure('invalid_input', '缺少冻结输入 input.json；无法渲染。', false);
    }
    const frozen = readJsonFile<{ input: RenderInputV1 }>(frozenPath);
    const prepared = this.readPreparedMedia(run);
    const narrationState = this.readNarrationState(run);
    const srtFile = path.join(runDir, 'subtitles.srt');
    const subtitlesPath = narrationState.enabled && fileExists(srtFile) ? srtFile : undefined;
    const artifactId = job.jobId.replace(/^orchjob/, 'artifact');
    const jobDigest = await renderJobDigest({
      jobId: job.jobId,
      artifactId,
      renderInput: frozen.input,
      media: prepared,
      audio: narrationState.audio,
      subtitlesPath,
      timingAdjustments: narrationState.adjustments,
    });
    const renderInput: RenderJobInputV1 = {
      schemaVersion: '1',
      kind: 'asvs.render-job',
      jobId: job.jobId,
      artifactId,
      runId: run.id,
      input: frozen.input,
      media: prepared,
      audio: narrationState.audio,
      ...(subtitlesPath ? { subtitlesPath } : {}),
      ...(narrationState.adjustments.length > 0
        ? { timingAdjustments: narrationState.adjustments }
        : {}),
      outputFileName: `${run.id}.mp4`,
      jobDigest,
      createdAt: this.now().toISOString(),
    };
    const inputFile = path.join(runDir, 'render-job-input.json');
    writeJsonFile(inputFile, renderInput);
    const checkpointFile = path.join(runDir, 'render-checkpoint.json');
    const outDir = path.join(runDir, 'artifacts');
    mkdirSync(outDir, { recursive: true });

    let lastCheckpointPhase: string | null = job.lastCheckpointPhase;
    const touchJob = (mutate: (current: NonNullable<ReturnType<typeof this.store.getJob>>) => NonNullable<ReturnType<typeof this.store.getJob>>) => {
      const current = this.store.getJob(job.jobId);
      if (current) this.store.updateJob(mutate(current));
    };

    // A cancel may land during the awaits above (the job digest hashes every
    // media file). Re-check synchronously right before claiming the active run:
    // otherwise the run is already `cancelled`, `activeRunId` is still null so
    // `cancelRun` cannot abort, and a renderer would be spawned for a run whose
    // output will be discarded.
    if (this.abortRequested.has(run.id)) return;
    this.activeRunId = run.id;
    const result: RenderJobExecutionResult = await this.executor.execute(
      renderInput,
      inputFile,
      outDir,
      checkpointFile,
      {
        onHeartbeat: (pid: number) => {
          const at = this.now().toISOString();
          touchJob((current) => ({
            ...current,
            status: 'running',
            workerPid: pid,
            heartbeatAt: at,
            leaseExpiresAt: new Date(this.now().getTime() + this.leaseTtlMs).toISOString(),
            updatedAt: at,
          }));
        },
        onCheckpoint: (phase: string, payload: Record<string, unknown>) => {
          lastCheckpointPhase = phase;
          this.writeCheckpoint(run, stepKey, phase, payload);
          const at = this.now().toISOString();
          touchJob((current) => ({
            ...current,
            lastCheckpointPhase: phase,
            heartbeatAt: at,
            updatedAt: at,
          }));
        },
        onProgress: () => undefined,
        onLog: (level: 'info' | 'warn' | 'error', message: string) => {
          this.appendEvent(
            run.id,
            stepKey,
            level === 'error' ? 'error' : level === 'warn' ? 'warn' : 'info',
            'log',
            message,
          );
        },
        onSpawn: (pid: number) => {
          touchJob((current) => ({ ...current, workerPid: pid, updatedAt: this.now().toISOString() }));
        },
      },
    );
    this.activeRunId = null;

    if (result.ok) {
      this.writeCheckpoint(run, stepKey, 'verified_receipt', {
        receiptPath: path.join('artifacts', 'receipt.json'),
        manifestPath: path.join('artifacts', 'manifest.json'),
        sha256: result.completed.outputSha256,
      });
      this.completeStep(run, stepKey, attempt, {
        outputFileName: path.basename(result.completed.outputPath),
        sha256: result.completed.outputSha256,
        byteSize: result.completed.byteSize,
        workerPid: result.workerPid,
        checkpointPhases: result.checkpoints.map((entry) => entry.phase),
      });
      return;
    }

    if (this.abortRequested.has(run.id) || result.code === 'cancelled') {
      // `cancelRun` already persisted `cancelled`; do not retry or fail.
      return;
    }

    const at = this.now().toISOString();
    touchJob((current) => ({
      ...current,
      lastCheckpointPhase,
      errorCode: result.code,
      errorMessage: result.message,
      workerPid: result.workerPid ?? current.workerPid,
      updatedAt: at,
    }));
    this.handleStepFailure(run, stepKey, attempt, {
      crashed: result.crashed,
      code: result.code,
      message: result.message,
      retryable: isRetryableRenderCode(result.code, result.crashed),
      checkpoints: result.checkpoints,
    });
  }

  /**
   * `capture_demo` (Gate 2, layer 2/3).
   *
   * The run only gets here after an approval was persisted. Immediately before
   * spawning the worker the approval is re-read **from the ledger** (not from
   * the denormalized run row) and the plan digest is recomputed from the exact
   * bytes that will be written to `capture-job-input.json`. Any mismatch
   * refuses to spawn at all — the third check (inside the worker) then covers
   * tampering of that file after it was written.
   *
   * On success the clip is *backfilled* into the frozen render input: the
   * asset replaces the placeholder and `inputDigest` is recomputed, which is
   * what makes the later narration/SRT/render steps produce a real-capture
   * film. On failure every piece of evidence (report, screenshots, trace) is
   * registered as a downloadable artifact and the run carries a structured
   * `captureFailure`; a receipt is never fabricated.
   */
  private async executeCaptureStep(
    run: OrchestrationRunV1,
    stepKey: OrchestrationStepKey,
    attempt: number,
  ): Promise<void> {
    if (!this.captureExecutor) {
      throw new StepFailure('capture_not_configured', '未配置 browser-worker 录屏执行器。', false);
    }
    if (this.abortRequested.has(run.id)) return;
    const latest = this.store.getRun(run.id) ?? run;
    if (latest.status === 'cancelled' || latest.status === 'failed') return;

    const demoPlan = latest.demoPlan;
    const approval = latest.approval;
    if (!demoPlan || !approval || approval.gateType !== 'gate2_demo_capture') {
      throw new StepFailure('capture_not_configured', '运行没有待执行的 Gate 2 演示计划。', false);
    }
    // Layer 2: the ledger row — not the run's denormalized copy — decides.
    const ledger = this.approvals.getById(run.id, approval.approvalId);
    if (!ledger || ledger.status !== 'approved') {
      throw new StepFailure(
        'approval_rejected',
        `Gate 2 审批 ${approval.approvalId} 未处于 approved（${ledger?.status ?? 'missing'}）；拒绝启动浏览器。`,
        false,
      );
    }
    const planDigest = await this.recomputePlanDigest(demoPlan.draft);
    if (planDigest !== demoPlan.planDigest || planDigest !== ledger.subjectDigest) {
      this.appendEvent(run.id, stepKey, 'error', 'approval', '演示计划摘要在审批后发生变化，拒绝录屏。', {
        expected: demoPlan.planDigest,
        recomputed: planDigest,
        approved: ledger.subjectDigest ?? null,
      });
      throw new StepFailure(
        'capture_plan_tampered',
        '演示计划在审批后被修改（摘要不一致）；拒绝启动 Chromium。',
        false,
      );
    }

    const job = this.store.getJobForStep(run.id, stepKey);
    if (!job) throw new StepFailure('unexpected_error', '缺少 capture_demo 任务记录。', false);

    const runDir = runDirFor(this.artifactDir, run.workspaceId, run.id);
    const outDir = path.join(runDir, 'capture');
    mkdirSync(outDir, { recursive: true });
    const plan = withDemoPlanApproval(demoPlan.draft, {
      approvalId: ledger.approvalId,
      approvedPlanDigest: planDigest,
      ...(ledger.approvedAt ? { approvedAt: ledger.approvedAt } : {}),
    });
    const jobDigest = await captureJobDigest({
      jobId: job.jobId,
      runId: run.id,
      workspaceId: run.workspaceId,
      plan,
      planDigest,
      allowedOrigins: this.planner.config.allowedOrigins,
      policyVersion: demoPlan.policyVersion,
    });
    const captureJob: CaptureJobInputV1 = captureJobInputV1Schema.parse({
      schemaVersion: '1',
      kind: 'asvs.capture-job',
      jobId: job.jobId,
      runId: run.id,
      workspaceId: run.workspaceId,
      outDir,
      checkpointFile: path.join(runDir, 'capture-checkpoint.json'),
      // Must be the base the worker itself uses for `storageRefFor` refs. The
      // worker writes `media.sourceFile` / `screenshot.file` relative to the
      // repository root, and it re-resolves those refs against this value
      // before emitting `completed`. Pointing it at the artifact dir made the
      // worker fail to find the clip it had just produced.
      storageRefBase: this.mediaRoot,
      serve: this.shouldAutoServe(demoPlan.baseUrl),
      serveMode: 'preview',
      allowedOrigins: this.planner.config.allowedOrigins,
      plan,
      planDigest,
      policyVersion: demoPlan.policyVersion,
      jobDigest,
      createdAt: this.now().toISOString(),
    });
    const inputFile = path.join(runDir, 'capture-job-input.json');
    writeJsonFile(inputFile, captureJob);
    const checkpointFile = captureJob.checkpointFile;

    // A cancel may have landed while the digests were being computed.
    if (this.abortRequested.has(run.id)) return;
    this.activeCaptureRunId = run.id;
    const startedAt = Date.now();
    let timedOut = false;
    const timeoutMs = this.captureTimeoutMs(demoPlan);
    const timer = setTimeout(() => {
      timedOut = true;
      this.captureExecutor?.abort();
    }, timeoutMs);
    timer.unref?.();
    let result: CaptureJobExecutionResult;
    try {
      result = await this.captureExecutor.execute(captureJob, inputFile, outDir, checkpointFile, {
        onHeartbeat: (pid: number) => {
          const at = this.now().toISOString();
          this.touchJob(job.jobId, (current) => ({
            ...current,
            status: 'running',
            workerPid: pid,
            heartbeatAt: at,
            leaseExpiresAt: new Date(this.now().getTime() + this.leaseTtlMs).toISOString(),
            updatedAt: at,
          }));
        },
        onCheckpoint: (phase: string, payload: Record<string, unknown>) => {
          this.writeCheckpoint(run, stepKey, phase, payload);
          const at = this.now().toISOString();
          this.touchJob(job.jobId, (current) => ({
            ...current,
            lastCheckpointPhase: phase,
            heartbeatAt: at,
            updatedAt: at,
          }));
        },
        onProgress: () => undefined,
        onLog: (level: 'info' | 'warn' | 'error', message: string) => {
          this.appendEvent(
            run.id,
            stepKey,
            level === 'error' ? 'error' : level === 'warn' ? 'warn' : 'info',
            'capture',
            message,
          );
        },
        onSpawn: (pid: number) => {
          this.touchJob(job.jobId, (current) => ({
            ...current,
            workerPid: pid,
            updatedAt: this.now().toISOString(),
          }));
        },
      });
    } finally {
      clearTimeout(timer);
      this.activeCaptureRunId = null;
    }
    const durationMs = Date.now() - startedAt;

    if (this.abortRequested.has(run.id) || (!result.ok && result.code === 'cancelled')) return;

    if (result.ok && result.result.passed && result.result.completed) {
      try {
        const completed = result.result.completed;
        if (timedOut) throw new StepFailure('capture_timeout', '录屏超时', true);
        const backfilled = this.backfillCapture(run, outDir, completed, demoPlan, planDigest, job.jobId);
        this.writeCheckpoint(run, stepKey, 'step_done', {
          assetId: backfilled.assetId,
          clipSha256: completed.clipSha256,
          clipDurationMs: completed.clipDurationMs,
          assertions: completed.assertions,
          planDigest,
        });
        this.completeStep(run, stepKey, attempt, {
          assetId: backfilled.assetId,
          clipSha256: completed.clipSha256,
          clipDurationMs: completed.clipDurationMs,
          assertions: completed.assertions,
          planDigest,
          clipWidth: completed.clipWidth,
          clipHeight: completed.clipHeight,
          workerPid: result.workerPid,
        });
      } catch (error) {
        this.handleStepFailure(run, stepKey, attempt, {
          crashed: false,
          code: error instanceof StepFailure ? error.code : 'capture_artifact_mismatch',
          message: error instanceof Error ? error.message : String(error),
          retryable: !(error instanceof StepFailure) || error.retryable,
          checkpoints: [],
        });
      }
      return;
    }

    // Failure: keep the evidence, never invent a receipt.
    const failure = timedOut
      ? {
          crashed: false,
          code: 'capture_timeout',
          message: `录屏超过 ${Math.round(timeoutMs / 1000)}s 未完成，已终止浏览器进程。`,
          retryable: true,
          result: null,
        }
      : result.ok
        ? {
            crashed: false,
            code: 'capture_artifact_mismatch',
            message: '录屏报告声称通过但缺少完成事件；按产物不一致处理。',
            retryable: true,
            result: null,
          }
        : {
            crashed: result.crashed,
            code: result.code,
            message: result.message,
            retryable: isRetryableCaptureCode(result.code) || result.crashed,
            result: result.result ?? null,
          };
    const evidence = this.registerCaptureEvidence(run, stepKey, outDir, job.jobId, failure);
    const code =
      failure.crashed && attempt >= job.maxAttempts && !failure.code.startsWith('capture_')
        ? 'worker_crash_exhausted'
        : failure.code;
    const latestRun = this.store.getRun(run.id) ?? run;
    if (latestRun.status === 'cancelled' || latestRun.status === 'failed') return;
    this.store.updateRun({
      ...latestRun,
      captureFailure: evidence,
      updatedAt: this.now().toISOString(),
    });
    this.touchJob(job.jobId, (current) => ({
      ...current,
      errorCode: code,
      errorMessage: failure.message,
      updatedAt: this.now().toISOString(),
    }));
    this.handleStepFailure(run, stepKey, attempt, {
      crashed: failure.crashed,
      code,
      message: failure.message,
      retryable: failure.retryable,
      checkpoints: result.checkpoints,
    });
    this.appendEvent(run.id, stepKey, 'warn', 'capture', `录屏尝试耗时 ${(durationMs / 1000).toFixed(1)}s。`, {
      code,
    });
  }

  private touchJob(
    jobId: string,
    mutate: (current: NonNullable<ReturnType<SqliteOrchestrationStore['getJob']>>) => NonNullable<
      ReturnType<SqliteOrchestrationStore['getJob']>
    >,
  ): void {
    const current = this.store.getJob(jobId);
    if (current) this.store.updateJob(mutate(current));
  }

  /** Hard ceiling for one capture attempt; the worker has no own deadline. */
  private captureTimeoutMs(plan: DemoPlanSummaryV1): number {
    const steps = plan.draft.steps.length;
    const dwell = plan.draft.steps.reduce((sum, step) => sum + (step.dwellMs ?? 0), 0);
    // Generous but finite: 6s browser start + 12s per step + dwell + slack.
    return Math.min(15 * 60_000, 30_000 + steps * 12_000 + dwell + plan.draft.capture.clipDurationMs);
  }

  private shouldAutoServe(baseUrl: string): boolean {
    return (
      this.planner.config.allowAutoServe && /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(baseUrl)
    );
  }

  /**
   * Replaces the placeholder asset with the real clip inside the frozen render
   * input. The storyboard is re-derived from the snapshot because the run's
   * scenes were frozen before the capture existed; `freeze_input` never knew
   * the asset id. Everything else (storyboard text, render profile) is kept
   * byte-identical, and `inputDigest` is rewritten so downstream steps and the
   * render worker see one consistent input.
   */
  private backfillCapture(
    run: OrchestrationRunV1,
    outDir: string,
    completed: NonNullable<CaptureJobResultV1['completed']>,
    demoPlan: DemoPlanSummaryV1,
    planDigest: string,
    jobId: string,
  ): { assetId: string } {
    const receiptFile = path.join(outDir, 'capture-receipt.json');
    if (!fileExists(receiptFile)) {
      throw new StepFailure('capture_artifact_mismatch', '录屏通过但缺少 capture-receipt.json。', true);
    }
    const receipt = captureReceiptV1Schema.parse(readJsonFile(receiptFile)) as CaptureReceiptV1;
    if (receipt.planId !== demoPlan.planId || receipt.planDigest !== planDigest) {
      throw new StepFailure(
        'capture_artifact_mismatch',
        `回执绑定的计划（${receipt.planId} / ${receipt.planDigest.slice(0, 12)}…）与审批通过的计划不一致。`,
        true,
      );
    }
    if (receipt.assertions.total < 1 || receipt.assertions.passed !== receipt.assertions.total) {
      throw new StepFailure(
        'capture_assertion_failed',
        `回执记录 ${receipt.assertions.passed}/${receipt.assertions.total} 个断言通过；未全部通过不得回填。`,
        true,
      );
    }
    if (receipt.clip.sha256 !== completed.clipSha256) {
      throw new StepFailure('capture_artifact_mismatch', '回执与完成事件的片段 SHA256 不一致。', true);
    }
    const clipFile = this.resolveAllowedPath(receipt.media.sourceFile);
    if (!clipFile) {
      throw new StepFailure(
        'capture_artifact_mismatch',
        `回执指向的片段不在允许的根目录内：${receipt.media.sourceFile}`,
        true,
      );
    }
    const actualSha = sha256File(clipFile);
    if (actualSha !== receipt.clip.sha256) {
      throw new StepFailure('capture_artifact_mismatch', '磁盘上的片段 SHA256 与回执不一致。', true);
    }

    const snapshot = this.requireWorkspace(run.workspaceId);
    const video = this.requireVideo(snapshot, run.videoId);
    const project = snapshot.projects.find((item) => item.id === video.projectId);
    if (!project) throw new StepFailure('invalid_input', `项目 ${video.projectId} 不存在。`, false);
    const asset = receipt.asset;
    const videoWithAsset = {
      ...video,
      scenes: video.scenes.map((scene) =>
        scene.visualType === 'real_demo' || scene.visual?.type === 'real_demo'
          ? { ...scene, assetId: asset.id }
          : scene,
      ),
    };
    const features = snapshot.features.filter((feature) =>
      video.brief.featureIds.includes(feature.id),
    );
    const input = buildRenderInput({
      video: videoWithAsset,
      project,
      features,
      assets: [...snapshot.assets.filter((item) => item.id !== asset.id), asset],
      renderProfile: run.renderProfile as RenderProfile,
    });
    const digest = sha256OfJson({ renderInput: input });
    const runDir = runDirFor(this.artifactDir, run.workspaceId, run.id);
    writeJsonFile(path.join(runDir, 'input.json'), {
      schemaVersion: '1',
      input,
      digest,
      storyboardFrames: totalStoryboardFrames(input.storyboard),
      durationMs: storyboardDurationMs(input.storyboard),
      frozenAt: this.now().toISOString(),
      // Provenance: which approved plan produced the real clip in this input.
      capture: {
        planId: demoPlan.planId,
        planDigest,
        assetId: asset.id,
        clipSha256: actualSha,
        clipDurationMs: receipt.clip.durationMs,
        assertions: receipt.assertions,
      },
    });
    this.registerCaptureArtifacts(run, 'capture_demo', outDir, jobId, [
      {
        kind: 'capture_clip',
        file: clipFile,
        mimeType: 'video/mp4',
        metadata: {
          width: receipt.clip.width,
          height: receipt.clip.height,
          durationMs: receipt.clip.durationMs,
          fps: receipt.clip.fps,
          planId: demoPlan.planId,
          planDigest,
        },
      },
      {
        kind: 'capture_receipt',
        file: receiptFile,
        mimeType: 'application/json',
        metadata: {
          planId: demoPlan.planId,
          planDigest,
          approvalId: receipt.approvalId,
          assertions: receipt.assertions,
        },
      },
      ...receipt.screenshots.map((shot, index) => ({
        kind: 'capture_screenshot' as const,
        file: path.join(outDir, shot.file),
        mimeType: 'image/png',
        metadata: { index, assertions: receipt.assertions },
      })),
    ]);

    const latest = this.store.getRun(run.id) ?? run;
    this.store.updateRun({
      ...latest,
      inputDigest: digest,
      captureFailure: undefined,
      input: {
        ...latest.input,
        ...(latest.input.capture
          ? {
              capture: {
                ...latest.input.capture,
                planDigest,
                capturedAssetId: asset.id,
                clipSha256: actualSha,
                clipDurationMs: receipt.clip.durationMs,
                assertions: {
                  total: receipt.assertions.total,
                  passed: receipt.assertions.passed,
                },
              },
            }
          : {}),
      },
      updatedAt: this.now().toISOString(),
    });
    return { assetId: asset.id };
  }

  /** Registers whatever a failed attempt left behind; missing files are fine. */
  private registerCaptureEvidence(
    run: OrchestrationRunV1,
    stepKey: OrchestrationStepKey,
    outDir: string,
    jobId: string,
    failure: { code: string; message: string; result: CaptureJobResultV1 | null },
  ): CaptureFailureSummaryV1 {
    const result = failure.result;
    const reportFile = path.join(outDir, 'failure-report.json');
    const traceFile = path.join(outDir, 'trace.zip');
    const screenshotDir = path.join(outDir, 'screenshots');
    const screenshotFiles: string[] = [];
    try {
      for (const name of readdirSync(screenshotDir)) {
        if (name.toLowerCase().endsWith('.png')) screenshotFiles.push(path.join(screenshotDir, name));
      }
    } catch {
      // No screenshots dir: the capture failed before the first assertion.
    }
    const registered = this.registerCaptureArtifacts(run, stepKey, outDir, jobId, [
      ...(fileExists(reportFile)
        ? [
            {
              kind: 'capture_failure_report' as const,
              file: reportFile,
              mimeType: 'application/json',
              metadata: { code: failure.code },
            },
          ]
        : []),
      ...(fileExists(traceFile)
        ? [
            {
              kind: 'capture_trace' as const,
              file: traceFile,
              mimeType: 'application/zip',
              metadata: { code: failure.code },
            },
          ]
        : []),
      ...screenshotFiles.map((file, index) => ({
        kind: 'capture_screenshot' as const,
        file,
        mimeType: 'image/png',
        metadata: { index, code: failure.code },
      })),
    ]);
    const byKind = (kind: string) => registered.filter((item) => item.kind === kind).map((item) => item.id);
    let blockedRequests: string[] = [];
    if (fileExists(reportFile)) {
      try {
        const raw = readJsonFile<{ blockedRequests?: string[] }>(reportFile);
        blockedRequests = raw.blockedRequests ?? [];
      } catch {
        blockedRequests = [];
      }
    }
    return {
      code: failure.code,
      message: failure.message,
      ...(result?.failed?.failedStepId ? { failedStepId: result.failed.failedStepId } : {}),
      assertionFailures: result?.failed?.assertionFailures ?? 0,
      ...(byKind('capture_failure_report')[0]
        ? { failureReportArtifactId: byKind('capture_failure_report')[0]! }
        : {}),
      ...(byKind('capture_trace')[0] ? { traceArtifactId: byKind('capture_trace')[0]! } : {}),
      screenshotArtifactIds: byKind('capture_screenshot'),
      blockedRequests,
      retryable: isRetryableCaptureCode(failure.code),
      failedAt: this.now().toISOString(),
    };
  }

  /**
   * Inserts artifact rows for capture evidence. Files outside the artifact
   * root (the worker writes under `<runDir>/capture`, which is inside it) are
   * copied in first, so `storageRef` is always resolvable by the download
   * route and never escapes the root.
   */
  private registerCaptureArtifacts(
    run: OrchestrationRunV1,
    stepKey: OrchestrationStepKey,
    outDir: string,
    jobId: string,
    entries: Array<{ kind: OrchestrationArtifactV1['kind']; file: string; mimeType: string; metadata: Record<string, unknown> }>,
  ): OrchestrationArtifactV1[] {
    const timestamp = this.now().toISOString();
    const inserted: OrchestrationArtifactV1[] = [];
    for (const [index, entry] of entries.entries()) {
      if (!fileExists(entry.file)) continue;
      let file = entry.file;
      const within = path.resolve(file).startsWith(`${path.resolve(this.artifactDir)}${path.sep}`);
      if (!within) {
        const copied = path.join(outDir, path.basename(file));
        copyFileSync(file, copied);
        file = copied;
      }
      const relative = path.relative(this.artifactDir, file).split(path.sep).join('/');
      const publicRef = path.posix.isAbsolute(relative) ? relative.slice(1) : relative;
      try {
        resolveArtifactPath(this.artifactDir, publicRef);
      } catch {
        this.logger.warn(`跳过无法安全引用的 capture 产物：${entry.file}`);
        continue;
      }
      const artifact: OrchestrationArtifactV1 = {
        schemaVersion: '1',
        id: `artifact_${jobId.replace(/^orchjob_/, '')}_${entry.kind}${index === 0 ? '' : `_${index}`}`,
        runId: run.id,
        workspaceId: run.workspaceId,
        jobId,
        kind: entry.kind,
        fileName: path.basename(file),
        mimeType: entry.mimeType,
        byteSize: fileSize(file),
        sha256: sha256File(file),
        storageRef: publicRef,
        metadata: { ...entry.metadata, stepKey },
        createdAt: timestamp,
      };
      this.store.insertArtifact(artifact);
      inserted.push(artifact);
    }
    return inserted;
  }

  private handleStepFailure(
    run: OrchestrationRunV1,
    stepKey: OrchestrationStepKey,
    attempt: number,
    failure: {
      crashed: boolean;
      code: string;
      message: string;
      retryable: boolean;
      checkpoints: Array<{ phase: string; payload: Record<string, unknown> }>;
    },
  ): void {
    const job = this.store.getJobForStep(run.id, stepKey);
    if (!job) return;
    // A cancel that landed while the step was executing wins over failure.
    const latestRun = this.store.getRun(run.id);
    if (!latestRun || latestRun.status === 'cancelled') return;

    if (failure.crashed) {
      this.appendEvent(
        run.id,
        stepKey,
        'error',
        'worker_crash',
        `渲染进程异常退出（第 ${attempt}/${job.maxAttempts} 次）：${failure.message}`,
        { checkpoints: failure.checkpoints.map((entry) => entry.phase) },
      );
    }

    const canRetry = failure.retryable && attempt < job.maxAttempts;
    if (canRetry) {
      const retryAt = this.now().toISOString();
      this.store.updateJob({
        ...job,
        status: 'retryable',
        leaseOwner: null,
        leaseExpiresAt: null,
        errorCode: failure.code,
        errorMessage: failure.message,
        updatedAt: retryAt,
      });
      this.store.updateRun({
        ...latestRun,
        status: 'running',
        updatedAt: retryAt,
        steps: latestRun.steps.map((step) =>
          step.stepKey === stepKey
            ? {
                ...step,
                status: 'running',
                attempt,
                errorCode: failure.code,
                errorMessage: failure.message,
              }
            : step,
        ),
      });
      this.appendEvent(
        run.id,
        stepKey,
        'warn',
        'retry',
        `第 ${attempt}/${job.maxAttempts} 次尝试失败，将从最近 checkpoint 重试。`,
        { code: failure.code },
      );
      this.pumpSoon();
      return;
    }

    const code = failure.crashed ? 'worker_crash_exhausted' : failure.code;
    const message =
      failure.crashed && attempt >= job.maxAttempts
        ? `渲染进程连续崩溃 ${attempt} 次（上限 ${job.maxAttempts}），运行终止：${failure.message}`
        : failure.message;
    this.failRun(latestRun, stepKey, code, message, failure.retryable);
  }

  private failRun(
    runInput: OrchestrationRunV1,
    stepKey: OrchestrationStepKey,
    code: string,
    message: string,
    retryable: boolean,
  ): void {
    const latest = this.store.getRun(runInput.id) ?? runInput;
    if (latest.status === 'failed' || latest.status === 'cancelled' || latest.status === 'succeeded') {
      return;
    }
    const run = latest;
    const timestamp = this.now().toISOString();
    const next: OrchestrationRunV1 = {
      ...run,
      status: 'failed',
      currentStepKey: null,
      failure: { code, message, stepKey, retryable },
      updatedAt: timestamp,
      finishedAt: timestamp,
      steps: run.steps.map((step) =>
        step.stepKey === stepKey
          ? { ...step, status: 'failed', errorCode: code, errorMessage: message, finishedAt: timestamp }
          : step,
      ),
    };
    this.store.updateRun(next);
    const job = this.store.getJobForStep(run.id, stepKey);
    if (job) {
      this.store.updateJob({
        ...job,
        status: 'failed',
        leaseOwner: null,
        leaseExpiresAt: null,
        errorCode: code,
        errorMessage: message,
        updatedAt: timestamp,
      });
    }
    this.appendEvent(run.id, stepKey, 'error', 'state_change', `运行进入终态 failed：${message}`, {
      code,
    });
  }

  private completeStep(
    run: OrchestrationRunV1,
    stepKey: OrchestrationStepKey,
    attempt: number,
    details: Record<string, unknown>,
  ): void {
    const timestamp = this.now().toISOString();
    const latest = this.store.getRun(run.id) ?? run;
    if (latest.status === 'failed' || latest.status === 'cancelled' || latest.status === 'succeeded') {
      // Cancelled / failed runs are terminal; a late step completion must not
      // overwrite that state (it may already have been reported to the user).
      return;
    }
    const checkpointPhases = this.store
      .listCheckpoints(run.id)
      .filter((checkpoint) => checkpoint.stepKey === stepKey)
      .map((checkpoint) => checkpoint.phase);
    const nextSteps = latest.steps.map((step) =>
      step.stepKey === stepKey
        ? {
            ...step,
            status: 'succeeded' as const,
            attempt,
            finishedAt: timestamp,
            errorCode: undefined,
            errorMessage: undefined,
            checkpointPhases,
          }
        : step,
    );
    const allDone = nextSteps.every((step) => step.status === 'succeeded' || step.status === 'skipped');
    const nextStep = nextSteps.find((step) => step.status !== 'succeeded' && step.status !== 'skipped');
    let nextInput = latest.input;
    if (stepKey === 'prepare_media' && typeof details.usingPlaceholder === 'boolean') {
      nextInput = { ...nextInput, usingPlaceholder: details.usingPlaceholder };
    }
    if (stepKey === 'synthesize_voice' && latest.input.narration) {
      nextInput = {
        ...nextInput,
        narration: {
          ...latest.input.narration,
          clipCount: typeof details.clipCount === 'number' ? details.clipCount : 0,
          cacheHits: typeof details.cacheHits === 'number' ? details.cacheHits : 0,
          synthetic: details.synthetic === true,
          adjustments: typeof details.adjustments === 'number' ? details.adjustments : 0,
        },
      };
    }
    const next: OrchestrationRunV1 = {
      ...latest,
      status: allDone ? 'succeeded' : 'running',
      steps: nextSteps,
      currentStepKey: allDone ? null : (nextStep?.stepKey ?? null),
      input: nextInput,
      updatedAt: timestamp,
      finishedAt: allDone ? timestamp : undefined,
    };
    this.store.updateRun(next);
    const job = this.store.getJobForStep(run.id, stepKey);
    if (job) {
      this.store.updateJob({
        ...job,
        status: 'succeeded',
        leaseOwner: null,
        leaseExpiresAt: null,
        errorCode: null,
        errorMessage: null,
        updatedAt: timestamp,
      });
    }
    this.appendEvent(
      run.id,
      stepKey,
      'success',
      'state_change',
      `${orchestrationStepDefinition(stepKey).name}完成`,
      details,
    );
    if (allDone) {
      const artifacts = this.store.listArtifacts(run.id);
      this.appendEvent(run.id, null, 'success', 'state_change', `运行成功完成，产物 ${artifacts.length} 个。`);
    }
  }

  // ── Step implementations ────────────────────────────────────────────────

  private requireWorkspace(workspaceId: string): StudioSnapshot {
    const snapshot = this.loadWorkspace(workspaceId);
    if (!snapshot) {
      throw new StepFailure('invalid_input', `工作区 ${workspaceId} 不再存在。`, false);
    }
    return snapshot;
  }

  private requireVideo(snapshot: StudioSnapshot, videoId: string): VideoProject {
    const video = snapshot.videos.find((item) => item.id === videoId);
    if (!video) throw new StepFailure('invalid_input', `视频 ${videoId} 不再存在。`, false);
    return video;
  }

  /** Claims referenced by the video's brief/scenes, in workspace order. */
  private resolveClaims(snapshot: StudioSnapshot, video: VideoProject): Claim[] {
    const ids = new Set<string>();
    for (const scene of video.scenes) for (const id of scene.claimIds) ids.add(id);
    return snapshot.claims.filter(
      (claim) =>
        claim.projectId === video.projectId &&
        (ids.has(claim.id) || video.brief.featureIds.includes(claim.featureId)),
    );
  }

  private freezeInput(run: OrchestrationRunV1): { digest: string; relativeFile: string } {
    const snapshot = this.requireWorkspace(run.workspaceId);
    const video = this.requireVideo(snapshot, run.videoId);
    const project = snapshot.projects.find((item) => item.id === video.projectId);
    if (!project) throw new StepFailure('invalid_input', `项目 ${video.projectId} 不存在。`, false);
    const features = snapshot.features.filter((feature) =>
      video.brief.featureIds.includes(feature.id),
    );
    let input;
    try {
      input = buildRenderInput({
        video,
        project,
        features,
        assets: snapshot.assets,
        renderProfile: run.renderProfile as RenderProfile,
      });
    } catch (error) {
      throw new StepFailure(
        'aspect_not_supported',
        error instanceof Error ? error.message : String(error),
        false,
      );
    }
    const runDir = runDirFor(this.artifactDir, run.workspaceId, run.id);
    const file = path.join(runDir, 'input.json');
    // Derived from the canonical render input, so a replay after a crash reads
    // the same file and yields the same digest.
    const digest = sha256OfJson({ renderInput: input });
    writeJsonFile(file, {
      schemaVersion: '1',
      input,
      digest,
      storyboardFrames: totalStoryboardFrames(input.storyboard),
      durationMs: storyboardDurationMs(input.storyboard),
      frozenAt: this.now().toISOString(),
    });
    return { digest, relativeFile: path.relative(this.artifactDir, file).split(path.sep).join('/') };
  }

  /**
   * Resolves every `real_demo` asset to an immutable capture file.
   *
   * The Asset stores its capture receipt ref (a workspace-relative path); the
   * receipt is the authority for which clip file is the real capture. Mock
   * assets are skipped and surface as `usingPlaceholder` so the worker renders
   * an explicitly labelled placeholder frame instead of failing.
   */
  private prepareMedia(run: OrchestrationRunV1): {
    usingPlaceholder: boolean;
    mediaFiles: RenderMediaAssetV1[];
  } {
    const runDir = runDirFor(this.artifactDir, run.workspaceId, run.id);
    const frozenPath = path.join(runDir, 'input.json');
    if (!fileExists(frozenPath)) {
      throw new StepFailure('invalid_input', '缺少冻结输入，无法准备素材。', false);
    }
    const frozen = readJsonFile<{ input: { assets: Asset[] } }>(frozenPath);
    const media: RenderMediaAssetV1[] = [];
    let usingPlaceholder = false;
    for (const asset of frozen.input.assets) {
      if (!isRealCaptureAsset(asset)) {
        usingPlaceholder = true;
        continue;
      }
      const resolved = this.resolveCaptureFile(asset);
      const declaredSha = asset.media.sha256;
      const actualSha = sha256File(resolved.file);
      if (declaredSha && declaredSha !== actualSha) {
        throw new StepFailure(
          'media_invalid',
          `Asset ${asset.id} 的录屏 SHA256 与资产清单不一致（${actualSha.slice(0, 12)}… vs ${declaredSha.slice(0, 12)}…）。`,
          false,
        );
      }
      media.push({
        assetId: asset.id,
        sourceFile: resolved.file,
        sha256: actualSha,
        mimeType: asset.media.mimeType,
        width: asset.media.width,
        height: asset.media.height,
        durationMs: asset.media.durationMs,
      });
    }
    writeJsonFile(path.join(runDir, 'media-manifest.json'), {
      schemaVersion: '1',
      usingPlaceholder,
      media,
      preparedAt: this.now().toISOString(),
      note: usingPlaceholder
        ? '部分或全部 real_demo 资产没有真实录屏文件，渲染将使用明确标注的占位画面。'
        : '全部 real_demo 资产均有真实录屏文件并通过 SHA256 校验。',
    });
    return { usingPlaceholder, mediaFiles: media };
  }

  /**
   * Finds the clip file behind an asset. A capture receipt names the exact
   * file and hash; without a receipt we fall back to the asset's declared
   * `media.src` under the artifact dir. Every candidate must live under an
   * allowed root, so a malicious `Asset.media.src` cannot read arbitrary files.
   */
  private resolveCaptureFile(asset: Asset): { file: string; sha256: string } {
    if (!asset.media) {
      throw new StepFailure('media_invalid', `Asset ${asset.id} 缺少 media 元数据。`, false);
    }
    const receiptRef = asset.media.captureReceiptRef;
    if (receiptRef) {
      const receiptFile = this.resolveAllowedPath(receiptRef);
      if (receiptFile && fileExists(receiptFile)) {
        try {
          const raw = readJsonFile<{
            media?: { sourceFile?: string; sha256?: string };
            clip?: { file?: string; sha256?: string };
          }>(receiptFile);
          const source = raw.media?.sourceFile ?? raw.clip?.file;
          const sha256 = raw.media?.sha256 ?? raw.clip?.sha256;
          if (source && sha256) {
            const clipFile = this.resolveAllowedPath(source);
            if (clipFile && fileExists(clipFile)) return { file: clipFile, sha256 };
          }
        } catch {
          // Fall through to the declared media path below.
        }
      }
    }
    const declared = this.resolveAllowedPath(asset.media.src);
    if (declared && fileExists(declared)) {
      return { file: declared, sha256: asset.media.sha256 ?? '' };
    }
    throw new StepFailure(
      'media_invalid',
      `Asset ${asset.id} 标记为真实录屏，但找不到可用的录屏文件（${asset.media.captureReceiptRef ?? asset.media.src}）。`,
      false,
    );
  }

  /**
   * Maps a workspace-relative ref to an absolute path under one of the two
   * allowed roots: the artifact dir (server-produced data) or the media root
   * (the capture worker's `dist/` output). URLs and traversal are refused.
   */
  private resolveAllowedPath(ref: string): string | null {
    if (!ref || /^[a-z][a-z0-9+.-]*:\/\//i.test(ref)) return null;
    const normalized = ref.replace(/\\/g, '/');
    const roots = [this.artifactDir, this.mediaRoot];
    const candidates: string[] = [];
    if (path.isAbsolute(normalized)) {
      candidates.push(normalized);
    } else {
      for (const root of roots) candidates.push(path.resolve(root, ...normalized.split('/')));
    }
    for (const candidate of candidates) {
      const resolved = path.resolve(candidate);
      const within = roots.some((root) => {
        const rootResolved = path.resolve(root);
        return resolved === rootResolved || resolved.startsWith(`${rootResolved}${path.sep}`);
      });
      if (!within || !fileExists(resolved)) continue;
      return resolved;
    }
    return null;
  }

  private readPreparedMedia(run: OrchestrationRunV1): RenderMediaAssetV1[] {
    const file = path.join(runDirFor(this.artifactDir, run.workspaceId, run.id), 'media-manifest.json');
    if (!fileExists(file)) return [];
    return readJsonFile<{ media?: RenderMediaAssetV1[] }>(file).media ?? [];
  }

  /** Narration files + timing adjustments produced by `synthesize_voice`. */
  private readNarrationState(run: OrchestrationRunV1): {
    enabled: boolean;
    audio: RenderAudioAssetV1[];
    adjustments: NarrationTimingAdjustment[];
  } {
    const request = this.readNarrationRequest(run);
    const file = path.join(runDirFor(this.artifactDir, run.workspaceId, run.id), 'narration.json');
    if (!request.enabled || !fileExists(file)) {
      return { enabled: request.enabled, audio: [], adjustments: [] };
    }
    const raw = readJsonFile<{
      audio?: RenderAudioAssetV1[];
      adjustments?: NarrationTimingAdjustment[];
    }>(file);
    return {
      enabled: true,
      audio: raw.audio ?? [],
      adjustments: raw.adjustments ?? [],
    };
  }

  private registerArtifacts(run: OrchestrationRunV1): { artifactIds: string[] } {
    const runDir = runDirFor(this.artifactDir, run.workspaceId, run.id);
    const outDir = path.join(runDir, 'artifacts');
    // `runDir` is the source of the SRT; `outDir` holds the worker's output.
    const job = this.store.getJobForStep(run.id, 'render_video');
    if (!job) throw new StepFailure('unexpected_error', '缺少 render_video 任务记录。', false);

    const outputFile = path.join(outDir, `${run.id}.mp4`);
    const receiptFile = path.join(outDir, 'receipt.json');
    const manifestFile = path.join(outDir, 'manifest.json');
    for (const file of [outputFile, receiptFile, manifestFile]) {
      if (!fileExists(file)) {
        throw new StepFailure('artifact_mismatch', `缺少渲染产物：${path.basename(file)}`, false);
      }
    }
    let receipt;
    let manifest;
    try {
      receipt = artifactReceiptV1Schema.parse(readJsonFile(receiptFile));
      manifest = renderManifestV1Schema.parse(readJsonFile(manifestFile));
    } catch (error) {
      throw new StepFailure(
        'artifact_mismatch',
        `回执/清单校验失败：${error instanceof Error ? error.message : String(error)}`,
        false,
      );
    }
    const actualSha = sha256File(outputFile);
    const actualBytes = fileSize(outputFile);
    if (actualSha !== receipt.sha256 || actualSha !== manifest.output.sha256) {
      throw new StepFailure('artifact_mismatch', 'MP4 SHA256 与回执/清单不一致。', false);
    }
    if (actualBytes !== receipt.byteSize || actualBytes !== manifest.output.byteSize) {
      throw new StepFailure('artifact_mismatch', 'MP4 字节数与回执/清单不一致。', false);
    }
    if (receipt.jobId !== job.jobId || manifest.jobId !== job.jobId) {
      throw new StepFailure('artifact_mismatch', '回执的 jobId 与渲染任务不一致。', false);
    }
    if (manifest.ffprobe.width * 9 !== manifest.ffprobe.height * 16) {
      throw new StepFailure(
        'artifact_mismatch',
        `渲染产物不是 16:9：${manifest.ffprobe.width}×${manifest.ffprobe.height}`,
        false,
      );
    }

    const timestamp = this.now().toISOString();
    const ids: string[] = [];
    const register = (
      kind: OrchestrationArtifactV1['kind'],
      file: string,
      relative: string,
      sha256: string,
      bytes: number,
      mimeType: string,
      metadata: Record<string, unknown>,
    ) => {
      const publicRef = path.posix.join('workspaces', run.workspaceId, 'runs', run.id, relative);
      // Fail closed if anything about the layout produced an unsafe ref.
      resolveArtifactPath(this.artifactDir, publicRef);
      const artifactId = `${job.jobId}_${kind}`;
      this.store.insertArtifact({
        schemaVersion: '1',
        id: artifactId,
        runId: run.id,
        workspaceId: run.workspaceId,
        jobId: job.jobId,
        kind,
        fileName: path.basename(file),
        mimeType,
        byteSize: bytes,
        sha256,
        storageRef: publicRef,
        metadata,
        createdAt: timestamp,
      });
      ids.push(artifactId);
    };

    register(
      'video_mp4',
      outputFile,
      path.posix.join('artifacts', path.basename(outputFile)),
      actualSha,
      actualBytes,
      'video/mp4',
      {
        width: manifest.ffprobe.width,
        height: manifest.ffprobe.height,
        fps: manifest.ffprobe.fps,
        durationMs: manifest.ffprobe.durationMs,
        codecName: manifest.ffprobe.codecName,
        frameCount: manifest.ffprobe.frameCount ?? null,
        // The worker measured this; a narration run without an audio stream
        // would have failed `validateProbe` before reaching this code.
        hasAudio: Boolean(manifest.ffprobe.audio),
        ...(manifest.ffprobe.audio
          ? {
              audioCodecName: manifest.ffprobe.audio.codecName,
              audioSampleRate: manifest.ffprobe.audio.sampleRate,
              audioChannels: manifest.ffprobe.audio.channels,
              audioDurationMs: manifest.ffprobe.audio.durationMs,
              ...(manifest.ffprobe.audio.meanVolumeDb !== undefined
                ? { audioMeanVolumeDb: manifest.ffprobe.audio.meanVolumeDb }
                : {}),
            }
          : {}),
        aspect: '16:9',
        rendererVersion: manifest.rendererVersion,
        usingPlaceholder: run.input.usingPlaceholder ?? false,
        ...(manifest.narration
          ? {
              narration: {
                provider: manifest.narration.provider,
                voiceId: manifest.narration.voiceId,
                language: manifest.narration.language,
                license: manifest.narration.license,
                synthetic: manifest.narration.synthetic,
                timingPolicy: manifest.narration.timingPolicy,
              },
            }
          : {}),
      },
    );

    // The SRT is only registered if the manifest bound a valid one, so the
    // download route can never serve a subtitle the worker didn't verify.
    const srtFile = path.join(runDir, 'subtitles.srt');
    if (manifest.subtitles) {
      if (!fileExists(srtFile)) {
        throw new StepFailure('artifact_mismatch', '清单记录了字幕，但 subtitles.srt 不存在。', false);
      }
      const srtSha = sha256File(srtFile);
      if (srtSha !== manifest.subtitles.sha256) {
        throw new StepFailure(
          'artifact_mismatch',
          `SRT SHA256 与清单不一致（${srtSha.slice(0, 12)}… vs ${manifest.subtitles.sha256.slice(0, 12)}…）。`,
          false,
        );
      }
      register(
        'subtitles_srt',
        srtFile,
        'subtitles.srt',
        srtSha,
        fileSize(srtFile),
        'application/x-subrip; charset=utf-8',
        {
          cueCount: manifest.subtitles.cueCount,
          durationMs: manifest.subtitles.durationMs,
          language: manifest.narration?.language ?? 'zh-CN',
        },
      );
    } else if (fileExists(srtFile)) {
      // A stray SRT must not sit next to an MP4 it does not describe.
      throw new StepFailure(
        'artifact_mismatch',
        '目录中存在 subtitles.srt，但清单未记录字幕；拒绝登记可能过期的字幕。',
        false,
      );
    }

    register(
      'render_manifest',
      manifestFile,
      path.posix.join('artifacts', 'manifest.json'),
      sha256File(manifestFile),
      fileSize(manifestFile),
      'application/json',
      { renderInputDigest: manifest.renderInputDigest, storyboardDigest: manifest.storyboardDigest },
    );
    register(
      'artifact_receipt',
      receiptFile,
      path.posix.join('artifacts', 'receipt.json'),
      sha256File(receiptFile),
      fileSize(receiptFile),
      'application/json',
      { durationMs: receipt.durationMs },
    );
    return { artifactIds: ids };
  }

  // ── Persistence helpers ─────────────────────────────────────────────────

  private writeCheckpoint(
    run: OrchestrationRunV1,
    stepKey: OrchestrationStepKey,
    phase: string,
    payload: Record<string, unknown>,
  ): void {
    const checkpoint: OrchestrationCheckpointV1 = {
      schemaVersion: '1',
      id: `${run.id}_${stepKey}_${phase}`,
      runId: run.id,
      stepKey,
      phase,
      inputDigest: run.inputDigest ?? '0'.repeat(64),
      payload: clone(payload),
      createdAt: this.now().toISOString(),
    };
    this.store.upsertCheckpoint(checkpoint);
    this.appendEvent(run.id, stepKey, 'info', 'checkpoint', `写入 checkpoint：${phase}`, {
      phase,
    });
  }

  private appendEvent(
    runId: string,
    stepKey: OrchestrationStepKey | null,
    level: OrchestrationEventLevel,
    eventType: OrchestrationEventType,
    message: string,
    details?: Record<string, unknown>,
  ): void {
    this.store.appendEvent({
      schemaVersion: '1',
      runId,
      stepKey,
      level,
      eventType,
      message,
      ...(details === undefined ? {} : { details }),
      createdAt: this.now().toISOString(),
    });
  }

  private requireRun(workspaceId: string, runId: string): OrchestrationRunV1 {
    const run = this.store.getRun(runId);
    if (!run || run.workspaceId !== workspaceId) {
      throw new OrchestrationHttpError(404, 'not_found', `运行 ${runId} 不存在。`);
    }
    return run;
  }
}

function isSixteenByNine(width: number, height: number): boolean {
  return Math.abs(width / height - 16 / 9) < 0.01;
}

export interface ResolvedNarrationRequest {
  enabled: boolean;
  voiceId?: string;
  speed: number;
  timingPolicy: NarrationTimingPolicy;
}

/**
 * Where does the narration request live between `createRun` and the
 * `synthesize_voice` step? On disk: the request body isn't part of the run
 * row, and the step must replay identically after a crash. This is the file
 * contract for `<runDir>/narration-request.json`.
 */
export interface PersistedNarrationRequest extends ResolvedNarrationRequest {
  schemaVersion: '1';
  requestedAt: string;
}

const NARRATION_REQUEST_FILE = 'narration-request.json';

/** File contract for `<runDir>/capture-request.json` (Step 5C). */
export interface PersistedCaptureRequest extends ResolvedCaptureOptions {
  schemaVersion: '1';
  requestedAt: string;
}

const CAPTURE_REQUEST_FILE = 'capture-request.json';

/** Normalizes the optional body fields; absent means "narration on, defaults". */
export function resolveNarrationRequest(input?: {
  enabled?: boolean;
  voiceId?: string;
  speed?: number;
  timingPolicy?: NarrationTimingPolicy;
}): ResolvedNarrationRequest {
  const enabled = input?.enabled ?? true;
  const speed = input?.speed ?? 1;
  if (!Number.isFinite(speed) || speed < MIN_SPEECH_SPEED || speed > MAX_SPEECH_SPEED) {
    throw new OrchestrationHttpError(
      400,
      'invalid_narration_options',
      `旁白语速必须在 ${MIN_SPEECH_SPEED}–${MAX_SPEECH_SPEED} 之间，收到 ${input?.speed}。`,
    );
  }
  return {
    enabled,
    ...(input?.voiceId ? { voiceId: input.voiceId } : {}),
    speed,
    timingPolicy: input?.timingPolicy ?? DEFAULT_NARRATION_TIMING_POLICY,
  };
}

/**
 * Builds the narration input for the render job. The voice profile comes from
 * the clips themselves (they carry provider / model / license provenance), so
 * the manifest describes what was really synthesized, not what was requested.
 */
export function buildNarrationInputForRender(input: {
  clips: NarrationClipV1[];
  speed: number;
  timingPolicy: NarrationTimingPolicy;
  language: SpeechLanguage;
}): NarrationInputV1 {
  const first = input.clips[0];
  if (!first) throw new Error('旁白输入缺少片段');
  const voice = speechVoiceProfileSchema.parse({
    provider: first.provider,
    // Clips carry provenance but not the model name; the renderer never needs
    // it, and the manifest takes it from `narration.json` instead.
    model: 'provider-default',
    voiceId: first.voiceId,
    language: first.language,
    speed: input.speed,
    license: first.license,
    synthetic: first.synthetic,
  });
  return { voice, clips: input.clips, timingPolicy: input.timingPolicy };
}

class StepFailure extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly retryable: boolean,
    readonly checkpoints: Array<{ phase: string; payload: Record<string, unknown> }> = [],
  ) {
    super(message);
    this.name = 'StepFailure';
  }
}

function sha256OfJson(value: unknown): string {
  // Same canonical stringify the worker uses, so a resumed job sees an
  // identical digest for an identical frozen input.
  return createHash('sha256').update(stableJson(value), 'utf8').digest('hex');
}

function sha256OfText(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

export { StepFailure as OrchestrationStepFailure };
