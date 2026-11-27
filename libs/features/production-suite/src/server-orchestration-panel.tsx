import { useEffect, useRef, useState, type ReactNode } from 'react';
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
  cn,
} from '@asvs/ui';
import { getOrchestrationClient, useUiStore } from '@asvs/state';
import {
  checkpointLabel,
  formatArtifactSize,
  formatDurationMs,
  isActiveServerRun,
  shortSha,
  type ServerOrchestrationApi,
  type ServerStepView,
} from './server-orchestration';

const NO_AUDIO_NOTE = '16:9 · H.264 · 无音轨（5B 接入配音与 SRT）';

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
 * Renders the five-step DAG the Fastify orchestrator actually executes, polls
 * it while it runs, and keeps working after a reload (the run lives in SQLite,
 * not in this tab). States the UI does not implement yet (approval Gate, 5B
 * audio) are labelled instead of implied.
 */
export function ServerOrchestrationPanel({ api }: { api: ServerOrchestrationApi }) {
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

  const download = async (artifact: OrchestrationArtifactV1) => {
    setDownloading(true);
    try {
      const client = await getOrchestrationClient();
      const response = await fetch(client.artifactDownloadUrl(api.workspaceId, artifact.id));
      if (!response.ok) throw new Error(`下载失败（HTTP ${response.status}）`);
      const blob = await response.blob();
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = artifact.fileName;
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      window.setTimeout(() => URL.revokeObjectURL(url), 1200);
      pushToast({
        tone: 'success',
        title: `已下载 ${artifact.fileName}`,
        description: `SHA256 ${shortSha(artifact.sha256)} · ${formatArtifactSize(artifact.byteSize)}`,
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
              <FactCard label="产物" value="MP4 · receipt.json · manifest.json" />
              <FactCard label="格式" value={NO_AUDIO_NOTE} />
              <FactCard label="恢复策略" value="SIGKILL / API 重启后按 checkpoint 续跑" />
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <Button
                variant="primary"
                size="sm"
                icon={<Server size={12} />}
                disabled={busy}
                onClick={() => void api.start()}
              >
                {busy ? '正在创建…' : '启动服务端渲染'}
              </Button>
              <span className="text-[9px] text-faint">
                真实的 16:9 MP4 会写入服务器产物目录；不依赖浏览器定时器。
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
                </div>
              </Callout>
            ) : null}

            {run.approval && run.approval.status === 'pending' ? (
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
                <div className="flex items-center gap-1.5 text-[10.5px] font-medium text-success">
                  <CheckCircle2 size={12} /> 真实 MP4 已生成
                </div>
                <div className="mt-1.5 grid gap-x-4 gap-y-1 text-[9.5px] sm:grid-cols-2">
                  <ArtifactFact label="文件" value={videoArtifact.fileName} mono />
                  <ArtifactFact label="分辨率" value={`${String(videoArtifact.metadata.width ?? '?')}×${String(videoArtifact.metadata.height ?? '?')} · ${NO_AUDIO_NOTE}`} />
                  <ArtifactFact
                    label="时长"
                    value={typeof videoArtifact.metadata.durationMs === 'number' ? formatDurationMs(videoArtifact.metadata.durationMs) : '—'}
                    mono
                  />
                  <ArtifactFact label="大小" value={formatArtifactSize(videoArtifact.byteSize)} mono />
                  <ArtifactFact label="SHA256" value={shortSha(videoArtifact.sha256, 20)} mono />
                  <ArtifactFact label="编码" value={String(videoArtifact.metadata.codecName ?? 'h264')} mono />
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
    case 'prepare_media':
      return '准备素材';
    case 'render_video':
      return '渲染视频';
    case 'register_artifacts':
      return '登记产物';
  }
}
