import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  ORCHESTRATION_STEPS,
  artifactReceiptV1Schema,
  buildInitialRunSteps,
  buildRenderInput,
  canTransitionJob,
  canTransitionRun,
  evaluateClaimGate,
  isRealCaptureAsset,
  orchestrationStepDefinition,
  renderJobDigest,
  renderManifestV1Schema,
  renderProfileSchema,
  stableJson,
  storyboardDurationMs,
  totalStoryboardFrames,
  type Asset,
  type Claim,
  type OrchestrationApprovalV1,
  type OrchestrationArtifactV1,
  type OrchestrationCheckpointV1,
  type OrchestrationEventLevel,
  type OrchestrationEventType,
  type OrchestrationRunDetailV1,
  type OrchestrationRunV1,
  type OrchestrationStepKey,
  type OrchestrationStepStateV1,
  type RenderJobInputV1,
  type RenderInputV1,
  type RenderMediaAssetV1,
  type RenderProfile,
  type StudioSnapshot,
  type VideoProject,
} from '@asvs/domain';
import type {
  CreateOrchestrationRunInput,
  CreateOrchestrationRunResult,
  ListOrchestrationRunsOptions,
  OrchestrationServicePort,
  RenderJobExecutionResult,
  RenderJobExecutorPort,
} from '@asvs/ports';
import { SqliteOrchestrationStore } from '../db/orchestration-store';
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
  maxAttempts?: number;
  leaseTtlMs?: number;
  schedulerIntervalMs?: number;
  /** Defaults to a random per-process id; tests pin it for lease assertions. */
  instanceId?: string;
  now?: () => Date;
  logger?: OrchestratorLogger;
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
  private readonly abortRequested = new Set<string>();

  constructor(options: OrchestratorOptions) {
    this.store = options.store;
    this.artifactDir = path.resolve(options.artifactDir);
    this.mediaRoot = path.resolve(options.mediaRoot ?? defaultMediaRoot());
    this.loadWorkspace = options.loadWorkspace;
    this.executor = options.executor ?? null;
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
      },
      createdAt: timestamp,
      updatedAt: timestamp,
    };

    const created = this.store.insertRun({
      run,
      jobs: ORCHESTRATION_STEPS.map((step) => ({
        id: newId('orchjob'),
        stepKey: step.stepKey,
        type: step.executor === 'worker' ? 'render' : 'inline',
        inputDigest: '0'.repeat(64),
        maxAttempts: this.maxAttempts,
        createdAt: timestamp,
      })),
    });
    if (!created.created) return { run: created.run, created: false };

    this.appendEvent(runId, null, 'info', 'state_change', `运行已入队 · 视频 ${video.id}`);
    this.pumpSoon();
    return { run: created.run, created: true };
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

  async approveRun(
    workspaceId: string,
    runId: string,
    input: { approvalId: string; subjectDigest?: string },
  ): Promise<OrchestrationApprovalV1> {
    const run = this.requireRun(workspaceId, runId);
    if (run.status !== 'awaiting_approval' || !run.approval) {
      throw new OrchestrationHttpError(409, 'invalid_transition', '当前运行没有待审批的 Gate。');
    }
    if (run.approval.approvalId !== input.approvalId) {
      throw new OrchestrationHttpError(409, 'approval_mismatch', '审批 ID 与当前 Gate 不匹配。');
    }
    if (
      run.approval.subjectDigest &&
      input.subjectDigest &&
      run.approval.subjectDigest !== input.subjectDigest
    ) {
      throw new OrchestrationHttpError(
        409,
        'approval_subject_mismatch',
        '审批对象摘要已变化；请基于最新计划重新审批。',
      );
    }
    const timestamp = this.now().toISOString();
    const approval: OrchestrationApprovalV1 = {
      ...run.approval,
      status: 'approved',
      approvedAt: timestamp,
    };
    this.store.updateRun({
      ...run,
      status: 'running',
      approval,
      updatedAt: timestamp,
    });
    this.appendEvent(runId, run.approval.stepKey, 'success', 'approval', 'Gate 已批准，运行继续。');
    this.pumpSoon();
    return approval;
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
    // Killing the child makes any in-flight `execute()` resolve promptly.
    this.executor?.abort();
    // Give the child a moment to exit so onClose does not orphan it.
    for (let i = 0; i < 40 && this.executor?.isRunning(); i += 1) {
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
    const artifactId = job.jobId.replace(/^orchjob/, 'artifact');
    const jobDigest = await renderJobDigest({
      jobId: job.jobId,
      artifactId,
      renderInput: frozen.input,
      media: prepared,
    });
    const renderInput: RenderJobInputV1 = {
      schemaVersion: '1',
      kind: 'asvs.render-job',
      jobId: job.jobId,
      artifactId,
      runId: run.id,
      input: frozen.input,
      media: prepared,
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
    const nextInput =
      stepKey === 'prepare_media' && typeof details.usingPlaceholder === 'boolean'
        ? { ...latest.input, usingPlaceholder: details.usingPlaceholder }
        : latest.input;
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

  private registerArtifacts(run: OrchestrationRunV1): { artifactIds: string[] } {
    const runDir = runDirFor(this.artifactDir, run.workspaceId, run.id);
    const outDir = path.join(runDir, 'artifacts');
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
        hasAudio: false,
        aspect: '16:9',
        rendererVersion: manifest.rendererVersion,
        usingPlaceholder: run.input.usingPlaceholder ?? false,
      },
    );
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

export { StepFailure as OrchestrationStepFailure };
