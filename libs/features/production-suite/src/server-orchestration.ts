import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type {
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

/** A UI row per DAG step — always all seven, even before the server reports them. */
export function buildServerStepViews(
  run: OrchestrationRunV1 | null,
  jobs: OrchestrationJobV1[] = [],
): ServerStepView[] {
  const definitions: Array<{ stepKey: OrchestrationStepKey; name: string; description: string }> = [
    { stepKey: 'freeze_input', name: '冻结渲染输入', description: '冻结 RenderInputV1 并计算 digest' },
    { stepKey: 'verify_claims', name: '核验功能声明', description: '按 4D 规则阻断未核验/过期/驳回的 Claim' },
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

export function formatArtifactSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function formatDurationMs(ms: number): string {
  const totalSeconds = Math.max(0, ms) / 1000;
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = Math.round(totalSeconds % 60);
  return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
}

export function shortSha(sha: string, length = 12): string {
  return sha.length > length ? `${sha.slice(0, length)}…` : sha;
}

/**
 * Downloads an artifact and verifies its bytes against the registered SHA256
 * before the browser saves it. A mismatch is treated as a failure, never as a
 * warning: a tampered MP4 must not reach the user's disk silently.
 */
export async function downloadVerifiedArtifact(
  url: string,
  artifact: { fileName: string; mimeType: string; sha256: string },
): Promise<void> {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`下载失败（HTTP ${response.status}）`);
  const buffer = await response.arrayBuffer();
  const digest = await crypto.subtle.digest('SHA-256', buffer);
  const hex = Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
  if (hex !== artifact.sha256) {
    throw new Error(
      `下载内容 SHA256 不匹配（${hex.slice(0, 12)}… vs ${artifact.sha256.slice(0, 12)}…）`,
    );
  }
  const objectUrl = URL.createObjectURL(new Blob([buffer], { type: artifact.mimeType }));
  const anchor = document.createElement('a');
  anchor.href = objectUrl;
  anchor.download = artifact.fileName;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  window.setTimeout(() => URL.revokeObjectURL(objectUrl), 1200);
}

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

export interface ServerOrchestrationApi extends ServerOrchestrationState {
  steps: ServerStepView[];
  events: OrchestrationEventV1[];
  canCreate: boolean;
  speech: SpeechHealthView | null;
  narration: NarrationOptions;
  setNarration: (options: NarrationOptions) => void;
  start: () => Promise<void>;
  cancel: () => Promise<void>;
  retry: () => Promise<void>;
  approve: () => Promise<void>;
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
            if (!cancelled) setSpeech(health);
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
      });
      pendingKey.current = null;
      if (!mounted.current) return;
      setRun(created.run);
      const loaded = await client.getRun(workspaceId, created.run.id);
      if (mounted.current) setDetail(loaded);
    });
  }, [guarded, syncConfig.baseUrl, workspaceId, videoId, narration]);

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

  const approve = useCallback(async () => {
    if (!run?.approval) return;
    await guarded(async () => {
      const client = await getOrchestrationClient(syncConfig.baseUrl);
      await client.approveRun(workspaceId, run.id, { approvalId: run.approval!.approvalId });
      if (!mounted.current) return;
      setDetail(await client.getRun(workspaceId, run.id));
    });
  }, [guarded, run, syncConfig.baseUrl, workspaceId]);

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
    start,
    cancel,
    retry,
    approve,
    refresh,
  };
}
