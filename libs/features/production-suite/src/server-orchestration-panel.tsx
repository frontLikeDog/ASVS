import { Suspense, lazy, useEffect, useRef, useState, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import type {
  OrchestrationArtifactV1,
  OrchestrationRunV1,
  OrchestrationStepKey,
} from '@asvs/domain';
import {
  AlertTriangle,
  CheckCircle2,
  CircleDashed,
  Clock3,
  Download,
  FileText,
  HardDrive,
  Loader2,
  RotateCcw,
  Server,
  ShieldAlert,
  Square,
  XCircle,
} from 'lucide-react';
import {
  Badge,
  Button,
  Callout,
  Panel,
  PanelHeader,
  ProgressBar,
  Field,
  Input,
  Select,
  Switch,
  cn,
} from '@asvs/ui';
import { getOrchestrationClient, useUiStore } from '@asvs/state';
import {
  checkpointLabel,
  downloadVerifiedArtifact,
  formatArtifactSize,
  formatDurationMs,
  isActiveServerRun,
  shortSha,
  type CaptureHealthView,
  type CaptureOptions,
  type NarrationOptions,
  type ServerOrchestrationApi,
  type ServerStepView,
} from './server-orchestration';

/**
 * Gate 2 approval + capture evidence, in its own chunk.
 *
 * `production` has a 24 kB gzip route budget; the plan table and evidence
 * viewer are the biggest thing on the page and are only needed once a run
 * exists, so they must not enter the route's static import closure.
 */
const Gate2ApprovalPanel = lazy(() => import('./gate2-approval-panel'));

/** UI-bounded speed range; the domain allows 0.75–1.35 but 0.85–1.2 is sane. */
const SPEED_OPTIONS = [0.85, 0.9, 1, 1.1, 1.2] as const;

/**
 * 5D · failure codes that mean "independent QA blocked this run". The findings
 * themselves are only on the Gate 3 review page — this log deliberately shows
 * the code and a link, never a redacted match or a finding summary, so a
 * sensitive value can never reach the production log.
 */
const QA_FAILURE_CODES = new Set([
  'qa_privacy_blocked',
  'qa_ocr_unavailable',
  'qa_technical_blocked',
  'qa_fact_blocked',
  'qa_content_blocked',
]);

/**
 * Format line for a server render. Never claims audio the file does not have:
 * the manifest decides, not the user's narration toggle.
 */
function formatLine(hasAudio: boolean): string {
  return hasAudio ? '16:9 · H.264 + AAC 48kHz · 含旁白音轨' : '16:9 · H.264 · 无音轨';
}

const STEP_TONE: Record<ServerStepView['status'], { label: string; tone: 'neutral' | 'accent' | 'success' | 'warn' | 'danger' }> = {
  pending: { label: '待执行', tone: 'neutral' },
  running: { label: '执行中', tone: 'accent' },
  succeeded: { label: '已完成', tone: 'success' },
  failed: { label: '失败', tone: 'danger' },
  skipped: { label: '已跳过', tone: 'neutral' },
  awaiting_approval: { label: '待批准', tone: 'warn' },
};

const EVENT_TONE: Record<string, string> = {
  info: 'text-white/40',
  warn: 'text-warn',
  error: 'text-danger',
  success: 'text-success',
};

function runProgressPercent(run: OrchestrationRunV1 | null): number {
  if (!run) return 0;
  if (run.status === 'succeeded') return 100;
  const done = run.steps.filter((step) => step.status === 'succeeded' || step.status === 'skipped').length;
  return Math.round((done / Math.max(1, run.steps.length)) * 100);
}

/**
 * Server-authoritative production panel.
 *
 * Renders the seven-step DAG the Fastify orchestrator actually executes, polls
 * it while it runs, and keeps working after a reload (the run lives in SQLite,
 * not in this tab). The audio metadata shown here comes from the worker's own
 * ffprobe result in the manifest — never from the requested narration options.
 */
export function ServerOrchestrationPanel({
  api,
  realDemoSceneCount = 0,
}: {
  api: ServerOrchestrationApi;
  /** Scenes the video marks `real_demo`; the capture toggle is pointless at 0. */
  realDemoSceneCount?: number;
}) {
  const pushToast = useUiStore((state) => state.pushToast);
  const { availability, run, detail, error, busy, steps, events } = api;
  const [downloading, setDownloading] = useState(false);
  const logRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const node = logRef.current;
    if (node) node.scrollTop = node.scrollHeight;
  }, [events.length]);

  const progress = runProgressPercent(run);
  const videoArtifact = detail?.artifacts.find((artifact) => artifact.kind === 'video_mp4') ?? null;
  const manifestArtifact = detail?.artifacts.find((artifact) => artifact.kind === 'render_manifest') ?? null;
  const srtArtifact = detail?.artifacts.find((artifact) => artifact.kind === 'subtitles_srt') ?? null;
  const videoHasAudio = videoArtifact?.metadata.hasAudio === true;
  const syntheticVoice = videoArtifact?.metadata.narration
    ? (videoArtifact.metadata.narration as { synthetic?: boolean }).synthetic === true
    : api.speech?.synthetic === true;
  const narrationEnabled = run?.input.narration?.enabled ?? api.narration.enabled;
  const speechUnavailable = api.speech !== null && !api.speech.configured;
  // The server fails closed here; disabling the button just saves a round trip.
  const captureBlocked = api.capture.enabled && realDemoSceneCount === 0;

  const download = async (artifact: OrchestrationArtifactV1) => {
    setDownloading(true);
    try {
      const client = await getOrchestrationClient();
      await downloadVerifiedArtifact(client.artifactDownloadUrl(api.workspaceId, artifact.id), artifact);
      pushToast({
        tone: 'success',
        title: `已下载 ${artifact.fileName}`,
        description: `SHA256 ${shortSha(artifact.sha256)} 已校验 · ${formatArtifactSize(artifact.byteSize)}`,
      });
    } catch (caught) {
      pushToast({
        tone: 'danger',
        title: '下载产物失败',
        description: caught instanceof Error ? caught.message : String(caught),
      });
    } finally {
      setDownloading(false);
    }
  };

  if (availability === 'probing') {
    return (
      <Panel>
        <div className="flex items-center gap-2 p-4 text-[10.5px] text-faint">
          <Loader2 size={12} className="animate-spin" /> 正在探测本机服务端编排能力…
        </div>
      </Panel>
    );
  }

  if (availability === 'unavailable') {
    return (
      <Callout tone="warning" size="sm" title="服务端编排未连接">
        连接本机工作区（设置 → 工作区同步）并运行 <span className="font-mono">pnpm dev:api</span> 后，可在此启动真实
        MP4 渲染。下面仍可使用浏览器内的确定性模拟 DAG。
      </Callout>
    );
  }

  return (
    <Panel className="overflow-hidden">
      <PanelHeader
        title="服务端真实渲染"
        description="任务状态持久化在 SQLite；关闭页面后仍继续渲染，崩溃后按 checkpoint 续跑。"
        actions={
          <div className="flex items-center gap-1.5">
            <Badge tone="accent" dot={false}>
              <Server size={9} className="mr-1" />
              服务端
            </Badge>
            {run ? <RunStatusBadge status={run.status} /> : null}
          </div>
        }
      />
      <div className="space-y-3 border-t border-line p-4">
        {!run ? (
          <>
            <div className="grid gap-2 sm:grid-cols-2">
              <FactCard label="渲染器" value="Remotion · 独立子进程" />
              <FactCard label="产物" value="MP4（含 AAC 旁白） · SRT · receipt.json · manifest.json" />
              <FactCard label="格式" value="16:9 · H.264 + AAC 48kHz" />
              <FactCard label="恢复策略" value="SIGKILL / API 重启后按 checkpoint 续跑" />
            </div>

            <NarrationOptionsPanel
              options={api.narration}
              onChange={api.setNarration}
              speech={api.speech}
              disabled={busy}
            />

            <CaptureOptionsPanel
              options={api.capture}
              onChange={api.setCapture}
              health={api.captureHealth}
              realDemoSceneCount={realDemoSceneCount}
              disabled={busy}
            />

            {api.error ? (
              <div className="flex items-start gap-1.5 text-[9.5px] leading-4 text-danger">
                <AlertTriangle size={11} className="mt-0.5 shrink-0" />
                {api.error}
              </div>
            ) : null}

            <div className="flex flex-wrap items-center gap-2">
              <Button
                variant="primary"
                size="sm"
                icon={<Server size={12} />}
                disabled={busy || (narrationEnabled && speechUnavailable) || captureBlocked}
                onClick={() => void api.start()}
              >
                {busy ? '正在创建…' : '启动服务端渲染'}
              </Button>
              <span className="text-[9px] text-faint">
                {captureBlocked
                  ? '已启用真实录屏但没有 real_demo 镜头：服务端会以 400 no_real_demo_scenes 拒绝创建，不会静默跳过。'
                  : narrationEnabled && speechUnavailable
                    ? '未配置 TTS：旁白已启用时服务端会拒绝创建运行（503），不会静默降级为无声。'
                    : api.capture.enabled
                      ? '运行会先停在上报计划等待 Gate 2 审批；批准后才启动浏览器录制。'
                      : '真实的 16:9 MP4 会写入服务器产物目录；不依赖浏览器定时器。'}
              </span>
            </div>
          </>
        ) : (
          <>
            <div className="grid grid-cols-2 gap-px overflow-hidden rounded-sm border border-line bg-line sm:grid-cols-4">
              <RunStat label="状态" value={<RunStatusBadge status={run.status} />} hint={run.currentStepKey ? stepName(run.currentStepKey) : '—'} />
              <RunStat label="进度" value={`${progress}%`} hint={`${run.steps.filter((step) => step.status === 'succeeded').length}/${run.steps.length} 步`} />
              <RunStat label="镜头 / 时长" value={`${run.input.sceneCount} / ${run.input.durationSec}s`} hint={`${run.input.claimCount} 条声明`} mono />
              <RunStat
                label="真实素材"
                value={run.input.usingPlaceholder ? '含占位画面' : '全部真实录屏'}
                hint={run.input.usingPlaceholder ? '缺失录屏的镜头已明确标注' : 'SHA256 已校验'}
              />
            </div>
            {run.input.narration?.enabled ? (
              <div className="flex flex-wrap items-center gap-2 text-[9.5px] text-faint">
                <span>
                  旁白 {run.input.narration.clipCount} 段 · 缓存命中 {run.input.narration.cacheHits} 段 ·{' '}
                  时长调整 {run.input.narration.adjustments} 处（{run.input.narration.timingPolicy}）
                </span>
                {run.input.narration.synthetic ? (
                  <Badge tone="warn" dot={false}>测试合成音轨 · 非真人配音</Badge>
                ) : (
                  <Badge tone="success" dot={false}>真实商用配音</Badge>
                )}
              </div>
            ) : (
              <div className="text-[9.5px] text-faint">本运行未启用旁白（无声 MP4，不生成 SRT）。</div>
            )}
            <div>
              <ProgressBar
                value={progress}
                tone={run.status === 'failed' ? 'danger' : run.status === 'succeeded' ? 'success' : 'accent'}
              />
              <div className="mt-1 flex items-center justify-between font-mono text-[9px] text-faint">
                <span>{run.id}</span>
                <span>digest {run.inputDigest ? shortSha(run.inputDigest) : '待冻结'}</span>
              </div>
            </div>

            <div className="space-y-2">
              {steps.map((step, index) => (
                <ServerStepRow key={step.stepKey} step={step} index={index} />
              ))}
            </div>

            {run.failure ? (
              <Callout tone="danger" size="sm" title={`运行失败 · ${run.failure.code}`}>
                <div className="space-y-1">
                  <p>{run.failure.message}</p>
                  <p className="text-[10px] text-faint">
                    {run.failure.stepKey ? `失败步骤：${stepName(run.failure.stepKey)} · ` : ''}
                    {run.failure.retryable ? '可从最近 checkpoint 手动重试。' : '需要先修复输入或知识状态。'}
                  </p>
                  {/* 5D · independent QA blocked the run: the findings live on
                      the Gate 3 review page, never in this log. */}
                  {QA_FAILURE_CODES.has(run.failure.code) ? (
                    <p>
                      <Link
                        to={`/videos/${run.videoId}/review`}
                        className="text-[10px] underline underline-offset-2"
                      >
                        到审核页查看独立 QA 报告与定位 →
                      </Link>
                    </p>
                  ) : null}
                </div>
              </Callout>
            ) : null}

            {run.demoPlan || run.captureFailure ? (
              <Suspense
                fallback={
                  <div className="flex items-center gap-1.5 rounded-sm border border-line px-3 py-2 text-[9.5px] text-faint">
                    <Loader2 size={11} className="animate-spin" /> 正在载入 Gate 2 审批与录屏证据…
                  </div>
                }
              >
                <Gate2ApprovalPanel api={api} />
              </Suspense>
            ) : null}

            {run.approval && run.approval.status === 'pending' && !run.demoPlan ? (
              <Callout
                tone="warning"
                size="sm"
                title="Gate · 需要人工批准"
                action={
                  <Button variant="primary" size="sm" disabled={busy} onClick={() => void api.approve()}>
                    批准并继续
                  </Button>
                }
              >
                当前 Gate 绑定审批 ID <span className="font-mono">{run.approval.approvalId}</span>。
              </Callout>
            ) : null}

            <div className="flex flex-wrap items-center gap-2">
              {isActiveServerRun(run) ? (
                <Button
                  variant="ghost"
                  size="sm"
                  icon={<Square size={11} />}
                  disabled={busy}
                  onClick={() => void api.cancel()}
                >
                  取消运行
                </Button>
              ) : null}
              {run.status === 'failed' && run.failure?.retryable ? (
                <Button
                  variant="secondary"
                  size="sm"
                  icon={<RotateCcw size={12} />}
                  disabled={busy}
                  onClick={() => void api.retry()}
                >
                  重试失败步骤
                </Button>
              ) : null}
              {run.status === 'succeeded' && videoArtifact ? (
                <Button
                  variant="primary"
                  size="sm"
                  icon={<Download size={12} />}
                  disabled={downloading}
                  onClick={() => void download(videoArtifact)}
                >
                  {downloading ? '下载中…' : `下载 MP4 · ${formatArtifactSize(videoArtifact.byteSize)}`}
                </Button>
              ) : null}
              {run.status === 'succeeded' && srtArtifact ? (
                <Button
                  variant="secondary"
                  size="sm"
                  icon={<FileText size={12} />}
                  disabled={downloading}
                  onClick={() => void download(srtArtifact)}
                >
                  下载 SRT · {String(srtArtifact.metadata.cueCount ?? '?')} 条
                </Button>
              ) : null}
              {run.status === 'succeeded' && manifestArtifact ? (
                <Button
                  variant="ghost"
                  size="sm"
                  icon={<HardDrive size={12} />}
                  disabled={downloading}
                  onClick={() => void download(manifestArtifact)}
                >
                  下载 manifest.json
                </Button>
              ) : null}
              <span className="ml-auto text-[9px] text-faint">
                页面关闭后渲染仍在服务端继续。
              </span>
            </div>

            {run.status === 'succeeded' && videoArtifact ? (
              <div className="rounded-sm border border-success/25 bg-success-soft/20 p-3">
                <div className="flex flex-wrap items-center gap-1.5 text-[10.5px] font-medium text-success">
                  <CheckCircle2 size={12} /> 真实 MP4 已生成
                  {syntheticVoice ? (
                    <Badge tone="warn" dot={false} className="ml-1">测试合成音轨 · 非真人配音</Badge>
                  ) : null}
                </div>
                <div className="mt-1.5 grid gap-x-4 gap-y-1 text-[9.5px] sm:grid-cols-2">
                  <ArtifactFact label="文件" value={videoArtifact.fileName} mono />
                  <ArtifactFact
                    label="分辨率"
                    value={`${String(videoArtifact.metadata.width ?? '?')}×${String(videoArtifact.metadata.height ?? '?')} · ${formatLine(videoHasAudio)}`}
                  />
                  <ArtifactFact
                    label="时长"
                    value={typeof videoArtifact.metadata.durationMs === 'number' ? formatDurationMs(videoArtifact.metadata.durationMs) : '—'}
                    mono
                  />
                  <ArtifactFact label="大小" value={formatArtifactSize(videoArtifact.byteSize)} mono />
                  <ArtifactFact label="SHA256" value={shortSha(videoArtifact.sha256, 20)} mono />
                  <ArtifactFact label="编码" value={String(videoArtifact.metadata.codecName ?? 'h264')} mono />
                  {videoHasAudio ? (
                    <ArtifactFact
                      label="音轨"
                      value={`${String(videoArtifact.metadata.audioCodecName ?? 'aac')} · ${String(videoArtifact.metadata.audioSampleRate ?? 48000)}Hz · ${String(videoArtifact.metadata.audioChannels ?? 1)}ch`}
                      mono
                    />
                  ) : null}
                  {typeof videoArtifact.metadata.audioMeanVolumeDb === 'number' ? (
                    <ArtifactFact
                      label="响度"
                      value={`mean ${videoArtifact.metadata.audioMeanVolumeDb.toFixed(1)} dB`}
                      mono
                    />
                  ) : null}
                  {srtArtifact ? (
                    <ArtifactFact
                      label="字幕"
                      value={`${srtArtifact.fileName} · ${String(srtArtifact.metadata.cueCount ?? '?')} 条`}
                      mono
                    />
                  ) : null}
                </div>
              </div>
            ) : null}

            <div>
              <div className="mb-1 flex items-center justify-between text-[9px] uppercase tracking-wide text-faint">
                <span>服务端事件</span>
                <span>{events.length} 条</span>
              </div>
              <div
                ref={logRef}
                className="max-h-[180px] overflow-y-auto rounded-sm border border-line bg-[#0A0C10] p-2.5 font-mono text-[9.5px] leading-[18px]"
              >
                {events.map((event) => (
                  <div key={event.id} className="flex gap-2">
                    <span className="shrink-0 text-white/25">
                      {new Date(event.createdAt).toLocaleTimeString('zh-CN', { hour12: false })}
                    </span>
                    <span className={cn('shrink-0 uppercase', EVENT_TONE[event.level] ?? 'text-white/30')}>
                      {event.eventType}
                    </span>
                    <span className="min-w-0 text-white/60">
                      {event.stepKey ? `[${stepName(event.stepKey)}] ` : ''}
                      {event.message}
                    </span>
                  </div>
                ))}
                {events.length === 0 ? <div className="text-white/30">等待任务事件…</div> : null}
              </div>
            </div>
          </>
        )}

        {error ? (
          <div className="flex items-start gap-1.5 text-[9.5px] leading-4 text-danger">
            <AlertTriangle size={11} className="mt-0.5 shrink-0" />
            {error}
          </div>
        ) : null}
      </div>
    </Panel>
  );
}

function ServerStepRow({ step, index }: { step: ServerStepView; index: number }) {
  const meta = STEP_TONE[step.status];
  const Icon =
    step.status === 'running'
      ? Loader2
      : step.status === 'succeeded'
        ? CheckCircle2
        : step.status === 'failed'
          ? XCircle
          : step.status === 'skipped'
            ? ShieldAlert
            : CircleDashed;
  return (
    <div
      className={cn(
        'flex items-start gap-2.5 rounded-md border px-3 py-2',
        step.status === 'running'
          ? 'border-accent/40 bg-accent-soft/10'
          : step.status === 'failed'
            ? 'border-danger/30 bg-danger-soft/15'
            : step.status === 'succeeded'
              ? 'border-success/20'
              : 'border-line',
      )}
    >
      <span className="mt-0.5 font-mono text-[9px] text-faint">{index + 1}</span>
      <Icon
        size={13}
        className={cn(
          'mt-0.5 shrink-0',
          step.status === 'running'
            ? 'animate-spin text-accent'
            : step.status === 'succeeded'
              ? 'text-success'
              : step.status === 'failed'
                ? 'text-danger'
                : 'text-faint',
        )}
      />
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="text-[10.5px] font-medium text-fg">{step.name}</span>
          <Badge tone={meta.tone} dot={false}>{meta.label}</Badge>
          {step.attempt > 0 ? <span className="font-mono text-[8.5px] text-faint">尝试 {step.attempt}</span> : null}
          {step.checkpointPhases.map((phase) => (
            <span
              key={phase}
              className="rounded-sm border border-line px-1 py-px font-mono text-[8px] text-faint"
              title={`已持久化 checkpoint：${phase}`}
            >
              {checkpointLabel(phase)}
            </span>
          ))}
        </div>
        <p className="mt-0.5 text-[9px] leading-4 text-faint">{step.description}</p>
        {step.errorMessage ? <div className="mt-1 text-[9px] text-danger">{step.errorMessage}</div> : null}
      </div>
      {step.status === 'running' ? <Clock3 size={10} className="mt-0.5 shrink-0 text-accent" /> : null}
    </div>
  );
}

function RunStatusBadge({ status }: { status: OrchestrationRunV1['status'] }) {
  const map = {
    queued: { label: '已入队', tone: 'neutral' as const },
    running: { label: '渲染中', tone: 'accent' as const },
    awaiting_approval: { label: '待审批', tone: 'warn' as const },
    succeeded: { label: '已完成', tone: 'success' as const },
    failed: { label: '失败', tone: 'danger' as const },
    cancelled: { label: '已取消', tone: 'neutral' as const },
  };
  const meta = map[status];
  return <Badge tone={meta.tone} dot={false}>{meta.label}</Badge>;
}

/**
 * Narration controls for a new run.
 *
 * The toggle is the only thing that can turn voice off, and it is honest about
 * what that means: a silent MP4 with no SRT. When the server has no TTS
 * configured the start button is disabled rather than letting the run fail.
 */
function NarrationOptionsPanel({
  options,
  onChange,
  speech,
  disabled,
}: {
  options: NarrationOptions;
  onChange: (options: NarrationOptions) => void;
  speech: ServerOrchestrationApi['speech'];
  disabled: boolean;
}) {
  const set = (patch: Partial<NarrationOptions>) => onChange({ ...options, ...patch });
  const unconfigured = speech !== null && !speech.configured;
  return (
    <div className="rounded-sm border border-line bg-raised/20 p-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <Switch
            checked={options.enabled}
            onCheckedChange={(checked) => set({ enabled: checked })}
            disabled={disabled}
            label="合成旁白音轨"
          />
          <div>
            <div className="text-[10.5px] font-medium text-fg">合成旁白音轨（TTS）</div>
            <div className="text-[8.5px] text-faint">
              按镜头合成 → 规整为 48kHz WAV → 混入 MP4 并生成 SRT；文本相同则命中缓存、不重复计费。
            </div>
          </div>
        </div>
        {speech ? (
          speech.synthetic ? (
            <Badge tone="warn" dot={false}>测试合成音轨 · 非真人配音</Badge>
          ) : speech.configured ? (
            <Badge tone="success" dot={false}>真实配音 · {speech.provider}</Badge>
          ) : (
            <Badge tone="danger" dot={false}>TTS 未配置</Badge>
          )
        ) : (
          <Badge tone="outline" dot={false}>TTS 状态未知</Badge>
        )}
      </div>

      {options.enabled ? (
        <div className="mt-3 grid gap-2 sm:grid-cols-3">
          <Field label="音色 voiceId" optional>
            <Input
              value={options.voiceId}
              placeholder="留空使用服务端默认音色"
              disabled={disabled}
              onChange={(event) => set({ voiceId: event.target.value })}
            />
          </Field>
          <Field label="语速" hint="0.75–1.35 为服务端允许范围">
            <Select
              value={String(options.speed)}
              disabled={disabled}
              onChange={(event) => set({ speed: Number(event.target.value) })}
            >
              {SPEED_OPTIONS.map((speed) => (
                <option key={speed} value={speed}>
                  {speed.toFixed(2)}×
                </option>
              ))}
            </Select>
          </Field>
          <Field label="时长策略">
            <Select
              value={options.timingPolicy}
              disabled={disabled}
              onChange={(event) =>
                set({ timingPolicy: event.target.value as NarrationOptions['timingPolicy'] })
              }
            >
              <option value="extend_scene">延长镜头以容纳旁白（extend_scene）</option>
              <option value="fail_on_overflow">溢出即失败（fail_on_overflow）</option>
            </Select>
          </Field>
        </div>
      ) : null}

      {unconfigured ? (
        <div className="mt-2 flex items-start gap-1.5 rounded-sm border border-warn/25 bg-warn-soft/20 px-2.5 py-2 text-[9px] leading-4 text-warn">
          <AlertTriangle size={10} className="mt-0.5 shrink-0" />
          服务端未配置 TTS（ASVS_TTS_PROVIDER / ASVS_TTS_API_URL / ASVS_TTS_API_KEY）。启用旁白时创建运行会返回 503；
          不会静默降级为伪造音轨。也可以关闭旁白，只渲染无声 MP4。
        </div>
      ) : options.enabled ? (
        <p className="mt-2 text-[9px] leading-4 text-faint">
          旁白绝不截断、绝不跨镜头；extend_scene 只延长镜头，保证音画同长。{speech ? `许可：${speech.license}` : ''}
        </p>
      ) : (
        <p className="mt-2 flex items-start gap-1.5 text-[9px] leading-4 text-warn">
          <AlertTriangle size={10} className="mt-0.5 shrink-0" />
          关闭旁白将产出无声 MP4，且不生成 SRT；导出包会因缺少字幕被拒绝（export_incomplete）。
        </p>
      )}
    </div>
  );
}

/**
 * Capture controls for a new run (Gate 2 input).
 *
 * The toggle is the opt-in: leaving it off records `plan_demo`/`capture_demo`/
 * `qa_capture` as skipped at creation. Turning it on without a `real_demo`
 * scene is a server-side 400, so the button says why instead of letting the
 * create fail.
 */
function CaptureOptionsPanel({
  options,
  onChange,
  health,
  realDemoSceneCount,
  disabled,
}: {
  options: CaptureOptions;
  onChange: (options: CaptureOptions) => void;
  health: CaptureHealthView | null;
  realDemoSceneCount: number;
  disabled: boolean;
}) {
  const set = (patch: Partial<CaptureOptions>) => onChange({ ...options, ...patch });
  const serverOff = health !== null && !health.enabled;
  const noRealDemo = realDemoSceneCount === 0;
  return (
    <div className="rounded-sm border border-line bg-raised/20 p-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <Switch
            checked={options.enabled}
            onCheckedChange={(checked) => set({ enabled: checked })}
            disabled={disabled || serverOff}
            label="真实录屏（Gate 2）"
          />
          <div>
            <div className="text-[10.5px] font-medium text-fg">真实录屏（Gate 2 审批）</div>
            <div className="text-[8.5px] text-faint">
              生成受控 DemoPlan → 人工审批 → 独立子进程驱动 Chromium 录制；断言全过才回填渲染输入。
            </div>
          </div>
        </div>
        {serverOff ? (
          <Badge tone="danger" dot={false}>服务端未启用</Badge>
        ) : health ? (
          <Badge tone="success" dot={false}>已配置 · 策略 {health.policyVersion}</Badge>
        ) : (
          <Badge tone="outline" dot={false}>状态未知</Badge>
        )}
      </div>

      {options.enabled ? (
        <div className="mt-3 grid gap-2 sm:grid-cols-3">
          <Field label="计划模板">
            <Select
              value={options.template}
              disabled={disabled}
              onChange={(event) => set({ template: event.target.value as CaptureOptions['template'] })}
            >
              <option value="web_studio_knowledge_claim">4D 知识与声明验证</option>
              <option value="web_studio_tour">web-studio 巡览</option>
              <option value="web_studio_route_focus">按路由聚焦</option>
              <option value="custom">自定义计划</option>
            </Select>
          </Field>
          <Field label="目标 baseUrl" hint="必须命中服务端 origin 白名单">
            <Input
              value={options.baseUrl}
              placeholder={health?.defaultBaseUrl || 'http://localhost:4200'}
              disabled={disabled}
              onChange={(event) => set({ baseUrl: event.target.value })}
            />
          </Field>
          <Field label="重置策略">
            <Select
              value={options.resetStrategy}
              disabled={disabled}
              onChange={(event) => set({ resetStrategy: event.target.value as CaptureOptions['resetStrategy'] })}
            >
              <option value="fixture">fixture（清空存储并重载种子）</option>
              <option value="none">none（不重置）</option>
            </Select>
          </Field>
        </div>
      ) : null}

      {serverOff ? (
        <div className="mt-2 flex items-start gap-1.5 rounded-sm border border-warn/25 bg-warn-soft/20 px-2.5 py-2 text-[9px] leading-5 text-warn">
          <AlertTriangle size={10} className="mt-0.5 shrink-0" />
          服务端未启用真实录屏（ASVS_CAPTURE_ENABLED）。开启后创建运行会返回 503 capture_not_configured；
          不会静默降级为模拟画面。
        </div>
      ) : options.enabled && noRealDemo ? (
        <div className="mt-2 flex items-start gap-1.5 rounded-sm border border-warn/25 bg-warn-soft/20 px-2.5 py-2 text-[9px] leading-5 text-warn">
          <AlertTriangle size={10} className="mt-0.5 shrink-0" />
          本视频没有 <span className="font-mono">real_demo</span> 镜头。服务端以 400 no_real_demo_scenes
          拒绝创建（fail-closed），请先在分镜中把某个镜头改为真实录屏。
        </div>
      ) : options.enabled ? (
        <p className="mt-2 text-[9px] leading-4 text-faint">
          白名单 origin：{health?.allowedOrigins.join(' · ') ?? '（启动后由服务端下发）'}。计划只允许语义
          selector，任何 CSS / XPath / 脚本都会在浏览器启动前被拒绝。
        </p>
      ) : (
        <p className="mt-2 text-[9px] leading-4 text-faint">
          未启用时 plan_demo / capture_demo / qa_capture 会在创建运行时记为 skipped，DAG 仍完整展示这些步骤。
        </p>
      )}
    </div>
  );
}

function FactCard({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-sm border border-line bg-raised/20 px-2.5 py-2">
      <div className="text-[8.5px] uppercase tracking-wide text-faint">{label}</div>
      <div className="mt-0.5 text-[10px] text-fg">{value}</div>
    </div>
  );
}

function ArtifactFact({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="flex items-baseline justify-between gap-2">
      <span className="shrink-0 text-faint">{label}</span>
      <span className={cn('truncate text-fg', mono && 'font-mono')}>{value}</span>
    </div>
  );
}

function RunStat({ label, value, hint, mono }: { label: string; value: ReactNode; hint: string; mono?: boolean }) {
  return (
    <div className="bg-surface p-2.5">
      <div className="text-[8.5px] uppercase tracking-wide text-faint">{label}</div>
      <div className={cn('mt-0.5 text-[11.5px] text-fg', mono && 'font-mono text-[10.5px]')}>{value}</div>
      <div className="mt-0.5 truncate text-[8.5px] text-faint">{hint}</div>
    </div>
  );
}

function stepName(stepKey: OrchestrationStepKey): string {
  switch (stepKey) {
    case 'freeze_input':
      return '冻结输入';
    case 'verify_claims':
      return '核验声明';
    case 'plan_demo':
      return '生成计划';
    case 'capture_demo':
      return '真实录屏';
    case 'qa_capture':
      return '录屏 QA';
    case 'prepare_media':
      return '准备素材';
    case 'synthesize_voice':
      return '合成旁白';
    case 'generate_subtitles':
      return '生成字幕';
    case 'render_video':
      return '渲染视频';
    case 'qa_final':
      return '成片 QA';
    case 'register_artifacts':
      return '登记产物';
  }
}
