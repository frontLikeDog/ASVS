import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type {
  DemoPlanTemplateId,
  OrchestrationEventV1,
  OrchestrationJobV1,
  OrchestrationRunDetailV1,
  OrchestrationRunV1,
  OrchestrationStepKey,
  OrchestrationStepStateV1,
  StepStatus,
} from '@asvs/domain';
import {
  buildRunIdempotencyKey,
  getOrchestrationClient,
  useWorkspaceSyncStore,
} from '@asvs/state';

export type ServerModeAvailability = 'probing' | 'unavailable' | 'ready';

const ACTIVE_STATUSES = new Set<OrchestrationRunV1['status']>(['queued', 'running', 'awaiting_approval']);
const POLL_INTERVAL_MS = 1_500;

export function isActiveServerRun(run: OrchestrationRunV1 | null | undefined): boolean {
  return Boolean(run && ACTIVE_STATUSES.has(run.status));
}

export interface ServerStepView {
  stepKey: OrchestrationStepKey;
  name: string;
  description: string;
  status: StepStatus;
  attempt: number;
  checkpointPhases: string[];
  errorMessage?: string;
}

/** A UI row per DAG step — always all nine, even before the server reports them. */
export function buildServerStepViews(
  run: OrchestrationRunV1 | null,
  jobs: OrchestrationJobV1[] = [],
): ServerStepView[] {
  const definitions: Array<{ stepKey: OrchestrationStepKey; name: string; description: string }> = [
    { stepKey: 'freeze_input', name: '冻结渲染输入', description: '冻结 RenderInputV1 并计算 digest' },
    { stepKey: 'verify_claims', name: '核验功能声明', description: '按 4D 规则阻断未核验/过期/驳回的 Claim' },
    { stepKey: 'plan_demo', name: '生成演示计划', description: '按模板生成 DemoPlanDraftV1 与 digest，挂起 Gate 2 审批' },
    { stepKey: 'capture_demo', name: '受控真实录屏', description: '已批准的 DemoPlan 驱动 browser-worker；断言全过才回填' },
    { stepKey: 'prepare_media', name: '准备真实素材', description: '校验录屏文件与 SHA256，缺失时明确标记占位' },
    { stepKey: 'synthesize_voice', name: '合成旁白音频', description: '按镜头合成 48kHz 旁白；内容哈希命中缓存时不重复计费' },
    { stepKey: 'generate_subtitles', name: '生成并校验 SRT', description: '按冻结帧时间轴生成 SRT，并独立校验序号/单调/无重叠' },
    { stepKey: 'render_video', name: '渲染视频', description: '独立子进程渲染 H.264 + AAC，ffprobe 校验音画与非静音' },
    { stepKey: 'register_artifacts', name: '登记产物', description: '复核 MP4 / SRT / 回执 / 清单并登记可下载产物' },
  ];
  return definitions.map((definition) => {
    const state: OrchestrationStepStateV1 | undefined = run?.steps.find(
      (step) => step.stepKey === definition.stepKey,
    );
    const job = jobs.find((item) => item.stepKey === definition.stepKey);
    return {
      ...definition,
      status: state?.status ?? 'pending',
      attempt: state?.attempt ?? job?.attempt ?? 0,
      checkpointPhases: state?.checkpointPhases ?? [],
      errorMessage: state?.errorMessage,
    };
  });
}

/** Human label for a worker checkpoint phase (docs/13 §4). */
export function checkpointLabel(phase: string): string {
  switch (phase) {
    case 'step_done':
      return '步骤完成';
    case 'plan_ready':
      return '计划已生成';
    case 'plan_verified':
      return '计划摘要已复检';
    case 'capture_started':
      return '浏览器已启动';
    case 'capture_recorded':
      return '录屏已录制';
    case 'clip_transcoded':
      return '片段已转码';
    case 'narration_ready':
      return '旁白已就绪';
    case 'subtitles_ready':
      return '字幕已校验';
    case 'bundle_ready':
      return '打包完成';
    case 'video_rendered':
      return '视频已写出';
    case 'verified_receipt':
      return '回执已核验';
    default:
      return phase;
  }
}

// Formatting and verified downloads live in `orchestration-format.ts` so the
// lazily loaded Gate 2 panel can share them without pulling this hook module
// (and React state) into its chunk. Re-exported here for existing callers.
export {
  downloadVerifiedArtifact,
  formatArtifactSize,
  formatDurationMs,
  shortSha,
} from './orchestration-format';

interface ServerOrchestrationState {
  availability: ServerModeAvailability;
  workspaceId: string;
  run: OrchestrationRunV1 | null;
  detail: OrchestrationRunDetailV1 | null;
  error: string | null;
  busy: boolean;
}

/** Narration options surfaced on the production page (5B). */
export interface NarrationOptions {
  enabled: boolean;
  voiceId: string;
  /** 0.85–1.2 × in the UI; the domain allows 0.75–1.35. */
  speed: number;
  timingPolicy: 'extend_scene' | 'fail_on_overflow';
}

export const DEFAULT_NARRATION_OPTIONS: NarrationOptions = {
  enabled: true,
  voiceId: '',
  speed: 1,
  timingPolicy: 'extend_scene',
};

/** Server-reported TTS availability; `configured: false` means fail closed. */
export interface SpeechHealthView {
  configured: boolean;
  provider: string;
  synthetic: boolean;
  license: string;
}

/** 5C capture options surfaced on the production page (Gate 2 input form). */
export interface CaptureOptions {
  enabled: boolean;
  template: DemoPlanTemplateId;
  baseUrl: string;
  resetStrategy: 'fixture' | 'none';
}

export const DEFAULT_CAPTURE_OPTIONS: CaptureOptions = {
  enabled: false,
  template: 'web_studio_knowledge_claim',
  baseUrl: '',
  resetStrategy: 'fixture',
};

/** Server-reported capture capability; absent means the server predates 5C. */
export interface CaptureHealthView {
  enabled: boolean;
  allowedOrigins: string[];
  defaultBaseUrl: string;
  allowAutoServe: boolean;
  policyVersion: string;
}

export interface ServerOrchestrationApi extends ServerOrchestrationState {
  steps: ServerStepView[];
  events: OrchestrationEventV1[];
  canCreate: boolean;
  speech: SpeechHealthView | null;
  narration: NarrationOptions;
  setNarration: (options: NarrationOptions) => void;
  capture: CaptureOptions;
  setCapture: (options: CaptureOptions) => void;
  captureHealth: CaptureHealthView | null;
  start: () => Promise<void>;
  cancel: () => Promise<void>;
  retry: () => Promise<void>;
  /**
   * Gate 2 approve. The digest is required: it is what the reviewer saw, and
   * the server refuses anything else (a plan edited mid-review). `note` is
   * persisted in the approval ledger as `decisionNote`.
   */
  approve: (note?: string) => Promise<void>;
  reject: (reason?: string) => Promise<void>;
  editDemoPlan: (patch: {
    template?: DemoPlanTemplateId;
    baseUrl?: string;
    resetStrategy?: 'fixture' | 'none';
  }) => Promise<void>;
  refresh: () => Promise<void>;
}

/**
 * Server-mode bridge for the production page.
 *
 * The browser never owns run state: it creates a run with an idempotency key,
 * then polls the authoritative detail until the run is terminal. Polling also
 * resumes after a page reload — a run keeps progressing on the server while the
 * tab is closed, which is the whole point of slice 5A.
 */
export function useServerOrchestration(videoId: string): ServerOrchestrationApi {
  const syncConfig = useWorkspaceSyncStore((state) => state.config);
  const [availability, setAvailability] = useState<ServerModeAvailability>('probing');
  const [run, setRun] = useState<OrchestrationRunV1 | null>(null);
  const [detail, setDetail] = useState<OrchestrationRunDetailV1 | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [speech, setSpeech] = useState<SpeechHealthView | null>(null);
  const [narration, setNarration] = useState<NarrationOptions>(DEFAULT_NARRATION_OPTIONS);
  const [capture, setCapture] = useState<CaptureOptions>(DEFAULT_CAPTURE_OPTIONS);
  const [captureHealth, setCaptureHealth] = useState<CaptureHealthView | null>(null);
  // Keeps the idempotency key stable across a double click.
  const pendingKey = useRef<string | null>(null);
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const workspaceId = syncConfig.workspaceId;

  useEffect(() => {
    let cancelled = false;
    if (!syncConfig.enabled || !videoId) {
      setAvailability('unavailable');
      return;
    }
    void (async () => {
      try {
        const client = await getOrchestrationClient(syncConfig.baseUrl);
        const reachable = await client.isReachable();
        if (cancelled) return;
        if (!reachable) {
          setAvailability('unavailable');
          return;
        }
        setAvailability('ready');
        void client.getHealth().then(
          (health) => {
            if (cancelled) return;
            setSpeech(health);
            if (health.capture) {
              setCaptureHealth(health.capture);
              // Pre-fill the form with the server's own default so the
              // reviewer never types an origin the allowlist will refuse.
              setCapture((current) =>
                current.baseUrl ? current : { ...current, baseUrl: health.capture!.defaultBaseUrl },
              );
            }
          },
          () => undefined,
        );
        const runs = await client.listRuns(workspaceId, { videoId });
        if (cancelled) return;
        const latest = runs[0] ?? null;
        if (latest) {
          setRun(latest);
          const loaded = await client.getRun(workspaceId, latest.id);
          if (!cancelled) setDetail(loaded);
          if (isActiveServerRun(latest)) setError(null);
        }
      } catch {
        if (!cancelled) setAvailability('unavailable');
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [syncConfig.enabled, syncConfig.baseUrl, workspaceId, videoId]);

  const refresh = useCallback(async () => {
    if (!syncConfig.enabled || !run) return;
    try {
      const client = await getOrchestrationClient(syncConfig.baseUrl);
      const loaded = await client.getRun(workspaceId, run.id);
      if (!mounted.current) return;
      if (loaded) {
        setDetail(loaded);
        setRun(loaded.run);
      }
    } catch (caught) {
      if (mounted.current) setError(caught instanceof Error ? caught.message : String(caught));
    }
  }, [syncConfig.enabled, syncConfig.baseUrl, workspaceId, run]);

  // Poll only while the run is active; a terminal run never changes on its own.
  useEffect(() => {
    if (!isActiveServerRun(run)) return;
    const timer = window.setInterval(() => void refresh(), POLL_INTERVAL_MS);
    return () => window.clearInterval(timer);
  }, [run, refresh]);

  const guarded = useCallback(async (action: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    try {
      await action();
    } catch (caught) {
      if (mounted.current) setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      if (mounted.current) setBusy(false);
    }
  }, []);

  const start = useCallback(async () => {
    await guarded(async () => {
      const client = await getOrchestrationClient(syncConfig.baseUrl);
      if (!pendingKey.current) pendingKey.current = buildRunIdempotencyKey(videoId);
      const created = await client.createRun(workspaceId, {
        videoId,
        idempotencyKey: pendingKey.current,
        narration: {
          enabled: narration.enabled,
          ...(narration.voiceId ? { voiceId: narration.voiceId } : {}),
          speed: narration.speed,
          timingPolicy: narration.timingPolicy,
        },
        capture: capture.enabled
          ? {
              enabled: true,
              template: capture.template,
              ...(capture.baseUrl ? { baseUrl: capture.baseUrl } : {}),
              resetStrategy: capture.resetStrategy,
            }
          : // Explicit `enabled: false` (not an omitted key): the server then
            // records the two capture steps as skipped instead of guessing.
            { enabled: false },
      });
      pendingKey.current = null;
      if (!mounted.current) return;
      setRun(created.run);
      const loaded = await client.getRun(workspaceId, created.run.id);
      if (mounted.current) setDetail(loaded);
    });
  }, [guarded, syncConfig.baseUrl, workspaceId, videoId, narration, capture]);

  const cancel = useCallback(async () => {
    if (!run) return;
    await guarded(async () => {
      const client = await getOrchestrationClient(syncConfig.baseUrl);
      const cancelled = await client.cancelRun(workspaceId, run.id);
      if (!mounted.current) return;
      setRun(cancelled);
      setDetail(await client.getRun(workspaceId, run.id));
    });
  }, [guarded, run, syncConfig.baseUrl, workspaceId]);

  const retry = useCallback(async () => {
    if (!run) return;
    await guarded(async () => {
      const client = await getOrchestrationClient(syncConfig.baseUrl);
      const retried = await client.retryRun(workspaceId, run.id);
      if (!mounted.current) return;
      setRun(retried);
      setDetail(await client.getRun(workspaceId, run.id));
    });
  }, [guarded, run, syncConfig.baseUrl, workspaceId]);

  const approve = useCallback(
    async (note?: string) => {
      if (!run?.approval) return;
      // Gate 2 binds the plan digest the reviewer saw. A generic gate has no
      // plan, so there is nothing to prove beyond the approval id.
      const subjectDigest = run.demoPlan?.planDigest ?? run.approval.subjectDigest ?? '';
      const approvalId = run.approval.approvalId;
      await guarded(async () => {
        const client = await getOrchestrationClient(syncConfig.baseUrl);
        await client.approveRun(workspaceId, run.id, {
          approvalId,
          subjectDigest,
          ...(note?.trim() ? { note: note.trim() } : {}),
        });
        if (!mounted.current) return;
        // The run resumes on the server; take its own row back so polling
        // continues from the real status instead of a guessed one.
        const loaded = await client.getRun(workspaceId, run.id);
        if (!mounted.current) return;
        setDetail(loaded);
        if (loaded) setRun(loaded.run);
      });
    },
    [guarded, run, syncConfig.baseUrl, workspaceId],
  );

  const reject = useCallback(
    async (reason?: string) => {
      if (!run?.approval) return;
      await guarded(async () => {
        const client = await getOrchestrationClient(syncConfig.baseUrl);
        await client.rejectRun(workspaceId, run.id, {
          approvalId: run.approval!.approvalId,
          ...(reason ? { reason } : {}),
        });
        if (!mounted.current) return;
        setDetail(await client.getRun(workspaceId, run.id));
      });
    },
    [guarded, run, syncConfig.baseUrl, workspaceId],
  );

  const editDemoPlan = useCallback(
    async (patch: {
      template?: DemoPlanTemplateId;
      baseUrl?: string;
      resetStrategy?: 'fixture' | 'none';
    }) => {
      if (!run?.demoPlan) return;
      await guarded(async () => {
        const client = await getOrchestrationClient(syncConfig.baseUrl);
        await client.updateDemoPlan(workspaceId, run.id, {
          patch,
          expectedPlanDigest: run.demoPlan!.planDigest,
        });
        if (!mounted.current) return;
        // The server issued a new approvalId + digest; refetch so the panel
        // never displays the superseded plan next to the new one.
        const loaded = await client.getRun(workspaceId, run.id);
        if (!mounted.current) return;
        setDetail(loaded);
        if (loaded) setRun(loaded.run);
        setCapture((current) => ({
          ...current,
          ...(patch.template ? { template: patch.template } : {}),
          ...(patch.baseUrl ? { baseUrl: patch.baseUrl } : {}),
          ...(patch.resetStrategy ? { resetStrategy: patch.resetStrategy } : {}),
        }));
      });
    },
    [guarded, run, syncConfig.baseUrl, workspaceId],
  );

  const steps = useMemo(() => buildServerStepViews(run, detail?.jobs ?? []), [run, detail]);
  const events = useMemo(() => detail?.events ?? [], [detail]);

  return {
    availability,
    workspaceId,
    run,
    detail,
    error,
    busy,
    steps,
    events,
    canCreate: availability === 'ready' && !isActiveServerRun(run),
    speech,
    narration,
    setNarration,
    capture,
    setCapture,
    captureHealth,
    start,
    cancel,
    retry,
    approve,
    reject,
    editDemoPlan,
    refresh,
  };
}
