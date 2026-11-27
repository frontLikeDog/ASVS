import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Link, useParams } from 'react-router-dom';
import type { ProductionRun, ProductionStep, RunScenario, StepStatus } from '@asvs/domain';
import {
  SCENARIO_DESCRIPTIONS,
  formatElapsed,
  formatRelativeTime,
  totalDuration,
  validateVideoForProduction,
} from '@asvs/domain';
import {
  AlertTriangle,
  ArrowDown,
  ArrowRight,
  BadgeCheck,
  Ban,
  BookOpen,
  Check,
  CheckCircle2,
  CircleDashed,
  Clock3,
  FileText,
  Gauge,
  GitBranch,
  Layers,
  Loader2,
  Mic,
  MonitorPlay,
  Pause,
  Play,
  RefreshCw,
  RotateCcw,
  ShieldCheck,
  Sparkles,
  Square,
  Workflow,
  XCircle,
} from 'lucide-react';
import {
  Badge,
  Button,
  Callout,
  Dialog,
  DialogContent,
  Page,
  Panel,
  PanelHeader,
  ProgressBar,
  RunStatusBadge,
  SegmentedControl,
  buttonStyles,
  cn,
} from '@asvs/ui';
import { useStudioStore, useUiStore } from '@asvs/state';
import { useShallow } from 'zustand/react/shallow';
import { NotFoundInline } from './not-found-inline';
import { ServerOrchestrationPanel } from './server-orchestration-panel';
import { useServerOrchestration } from './server-orchestration';

const SCENARIOS: { value: RunScenario; label: string; short: string; detail: string; icon: typeof Sparkles }[] = [
  {
    value: 'happy_path',
    label: '标准成功路径',
    short: '一路通过',
    detail: '所有步骤按顺序完成，用于验证完整生产闭环。',
    icon: CheckCircle2,
  },
  {
    value: 'capture_retry',
    label: '录制失败 → 重试',
    short: '失败恢复',
    detail: '录制步骤在固定位置超时失败；手动重试后继续。',
    icon: RefreshCw,
  },
  {
    value: 'approval_gate',
    label: '人工审批 Gate',
    short: '等待批准',
    detail: '录制开始前暂停，必须人工批准才会继续。',
    icon: ShieldCheck,
  },
];

const STEP_ICONS: Record<string, typeof BookOpen> = {
  knowledge: BookOpen,
  claims: ShieldCheck,
  script: FileText,
  storyboard: Layers,
  capture: MonitorPlay,
  voice: Mic,
  compose: Sparkles,
  qa: BadgeCheck,
};

const STEP_GROUPS: string[][] = [
  ['knowledge'],
  ['claims'],
  ['script'],
  ['storyboard'],
  ['capture', 'voice'],
  ['compose'],
  ['qa'],
];

const STEP_STATUS_META: Record<StepStatus, { label: string; tone: 'neutral' | 'accent' | 'success' | 'warn' | 'danger' }> = {
  pending: { label: '待执行', tone: 'neutral' },
  running: { label: '执行中', tone: 'accent' },
  succeeded: { label: '已完成', tone: 'success' },
  failed: { label: '失败', tone: 'danger' },
  skipped: { label: '已跳过', tone: 'neutral' },
  awaiting_approval: { label: '待批准', tone: 'warn' },
};

const RUN_SCENARIO_LABEL: Record<RunScenario, string> = {
  happy_path: '标准成功',
  capture_retry: '录制失败后重试',
  approval_gate: '人工审批 Gate',
};

export function ProductionPage() {
  const { videoId = '' } = useParams();
  const video = useStudioStore((state) => state.videos.find((item) => item.id === videoId));
  const project = useStudioStore((state) =>
    state.projects.find((item) => item.id === video?.projectId),
  );
  const runs = useStudioStore(
    useShallow((state) =>
      state.runs
        .filter((run) => run.videoId === videoId)
        .sort((a, b) => new Date(b.startedAt).getTime() - new Date(a.startedAt).getTime()),
    ),
  );
  const startProduction = useStudioStore((state) => state.startProduction);
  const tickProduction = useStudioStore((state) => state.tickProduction);
  const pauseRun = useStudioStore((state) => state.pauseRun);
  const resumeRun = useStudioStore((state) => state.resumeRun);
  const cancelRun = useStudioStore((state) => state.cancelRun);
  const retryRun = useStudioStore((state) => state.retryRun);
  const approveRun = useStudioStore((state) => state.approveRun);
  const changeRunSpeed = useStudioStore((state) => state.changeRunSpeed);
  const pushToast = useUiStore((state) => state.pushToast);

  const [selectedRunId, setSelectedRunId] = useState<string | undefined>();
  const [scenario, setScenario] = useState<RunScenario>('happy_path');
  // 5A: server-authoritative real render (SQLite + worker subprocess). The
  // browser-only simulated DAG below stays untouched when the API is absent.
  const serverApi = useServerOrchestration(videoId);
  const [cancelling, setCancelling] = useState(false);
  const logRef = useRef<HTMLDivElement>(null);

  const activeRun = runs.find((run) =>
    ['running', 'paused', 'awaiting_approval'].includes(run.status),
  );
  const selectedRun =
    runs.find((run) => run.id === selectedRunId) ?? activeRun ?? runs[0];
  const runningIds = runs
    .filter((run) => run.status === 'running')
    .map((run) => run.id)
    .join(',');

  useEffect(() => {
    if (!runningIds) return;
    const ids = runningIds.split(',');
    const timer = window.setInterval(() => {
      ids.forEach((id) => tickProduction(id, 250));
    }, 250);
    return () => window.clearInterval(timer);
  }, [runningIds, tickProduction]);

  useEffect(() => {
    const node = logRef.current;
    if (node) node.scrollTop = node.scrollHeight;
  }, [selectedRun?.logs.length, selectedRun?.status]);

  if (!video || !project) return <NotFoundInline label="视频工程不存在或已被删除。" />;

  const readiness = validateVideoForProduction(video);
  const steps = selectedRun?.steps ?? [];
  const progress = selectedRun ? runProgress(selectedRun) : 0;
  const activeStep = selectedRun
    ? selectedRun.steps.find((step) => step.status === 'running') ??
      selectedRun.steps.find((step) => step.status === 'awaiting_approval') ??
      selectedRun.steps.find((step) => step.status === 'failed')
    : undefined;

  const start = () => {
    const runId = startProduction(video.id, scenario);
    if (runId) {
      setSelectedRunId(runId);
      pushToast({
        tone: 'info',
        title: '模拟生产已启动',
        description: '运行时间只在生产监控页打开时推进，不会生成真实媒体。',
      });
    }
  };

  return (
    <Page wide>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[10.5px] text-faint">
        <Link to={`/projects/${project.id}/videos`} className="hover:text-accent">{project.name}</Link>
        <span>/</span>
        <Link to={`/videos/${video.id}/storyboard`} className="hover:text-accent">{video.title}</Link>
        <span>/</span>
        <span>模拟生产</span>
        <span className="ml-auto rounded-sm border border-line px-1.5 py-0.5 text-[9px]">Demo · 无真实渲染</span>
      </div>
      <div className="mt-2 flex flex-wrap items-start justify-between gap-4">
        <div>
          <div className="flex flex-wrap items-center gap-2">
            <h1 className="font-display text-[24px] font-medium tracking-[-0.02em] text-fg">生产监控</h1>
            <Badge tone="outline" dot={false}>确定性模拟 DAG</Badge>
            {selectedRun ? <RunStatusBadge status={selectedRun.status} /> : null}
          </div>
          <p className="mt-1 max-w-2xl text-[11.5px] leading-5 text-muted">
            {video.scenes.length} 个镜头 · {totalDuration(video.scenes)} 秒 · {video.brief.aspect} · {video.brief.language}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Link to={`/videos/${video.id}/editor`} className={buttonStyles({ variant: 'ghost', size: 'sm' })}>
            返回编辑器
          </Link>
          {selectedRun && ['review', 'changes_requested', 'approved', 'exported'].includes(video.stage) ? (
            <Link to={`/videos/${video.id}/review`} className={buttonStyles({ variant: 'primary', size: 'sm' })}>
              去审核 <ArrowRight size={12} />
            </Link>
          ) : null}
        </div>
      </div>

      {activeRun && selectedRun?.id !== activeRun.id ? (
        <button
          type="button"
          onClick={() => setSelectedRunId(activeRun.id)}
          className="mt-4 flex w-full items-center justify-between rounded-md border border-accent/30 bg-accent-soft/30 px-3 py-2 text-left text-[10.5px] text-accent"
        >
          <span className="flex items-center gap-2"><Loader2 size={12} className="animate-spin" /> 有正在运行的模拟生产；当前查看的是历史记录</span>
          <span>回到当前运行 →</span>
        </button>
      ) : null}

      <div className="mt-4 grid grid-cols-[minmax(0,1fr)] gap-4 xl:grid-cols-[minmax(0,1fr)_330px]">
        <div className="space-y-4">
          <ServerOrchestrationPanel api={serverApi} />
          {!selectedRun ? (
            <Panel>
              <div className="p-6">
                <div className="mx-auto max-w-lg text-center">
                  <span className="mx-auto grid size-12 place-items-center rounded-full border border-line bg-raised text-muted">
                    <Workflow size={22} />
                  </span>
                  <h2 className="mt-4 font-display text-[18px] text-fg">还没有生产运行</h2>
                  <p className="mt-1 text-[11.5px] leading-5 text-muted">
                    选择一种确定性场景，观察知识、脚本、录制、配音、合成与质检如何依次推进。
                  </p>
                  <div className="mt-4 grid gap-2 text-left sm:grid-cols-3">
                    {SCENARIOS.map((item) => {
                      const Icon = item.icon;
                      return (
                        <button
                          key={item.value}
                          type="button"
                          onClick={() => setScenario(item.value)}
                          className={cn(
                            'rounded-md border p-3 text-left transition-colors',
                            scenario === item.value
                              ? 'border-accent/45 bg-accent-soft/30'
                              : 'border-line hover:border-line-strong',
                          )}
                        >
                          <Icon size={14} className={scenario === item.value ? 'text-accent' : 'text-faint'} />
                          <div className="mt-2 text-[10.5px] font-medium text-fg">{item.label}</div>
                          <div className="mt-1 text-[9px] leading-4 text-faint">{item.detail}</div>
                        </button>
                      );
                    })}
                  </div>
                  {!readiness.ok ? (
                    <Callout tone="danger" size="sm" className="mt-3 text-left" title="当前工程还不能生产">
                      {readiness.reason}
                    </Callout>
                  ) : null}
                  <Button
                    variant="primary"
                    className="mt-4"
                    disabled={!readiness.ok}
                    onClick={start}
                    icon={<Play size={13} />}
                  >
                    启动模拟生产
                  </Button>
                  <p className="mt-2 text-[9px] text-faint">约 30 秒模拟耗时 · 不会上传或渲染任何真实文件</p>
                </div>
              </div>
            </Panel>
          ) : (
            <>
              <Panel className="overflow-hidden">
                <div className="grid grid-cols-2 divide-x divide-line border-b border-line sm:grid-cols-4">
                  <RunStat label="运行状态" value={<RunStatusBadge status={selectedRun.status} />} hint={activeStep ? activeStep.name : '所有步骤已结束'} />
                  <RunStat label="总进度" value={`${progress.toFixed(0)}%`} hint={`${selectedRun.steps.filter((step) => step.status === 'succeeded').length}/${selectedRun.steps.length} 步完成`} />
                  <RunStat label="模拟耗时" value={formatElapsed(selectedRun.elapsedMs)} hint="只在页面打开时推进" mono />
                  <RunStat
                    label="结束时间"
                    value={selectedRun.finishedAt ? formatRelativeTime(selectedRun.finishedAt) : '进行中'}
                    hint={RUN_SCENARIO_LABEL[selectedRun.scenario]}
                  />
                </div>
                <div className="px-4 py-3">
                  <ProgressBar
                    value={progress}
                    tone={selectedRun.status === 'failed' ? 'danger' : selectedRun.status === 'succeeded' ? 'success' : 'accent'}
                  />
                  <div className="mt-1.5 flex items-center justify-between text-[9px] text-faint">
                    <span className="font-mono">{selectedRun.id}</span>
                    <span>{selectedRun.input.sceneCount} 镜 / {selectedRun.input.durationSec}s / {selectedRun.input.claimCount} 声明</span>
                  </div>
                </div>
              </Panel>

              <Panel>
                <PanelHeader
                  title="生产流水线"
                  description="每个节点都由前序依赖触发；第 5 步并行执行录制与配音。"
                  actions={<Badge tone="outline" dot={false}>DAG</Badge>}
                />
                <div className="border-t border-line p-4">
                  {STEP_GROUPS.map((group, groupIndex) => {
                    const groupSteps = group
                      .map((key) => steps.find((step) => step.key === key))
                      .filter((step): step is ProductionStep => Boolean(step));
                    if (groupSteps.length === 0) return null;
                    return (
                      <div key={group.join('-')}>
                        {groupIndex > 0 ? (
                          <div className="flex items-center justify-center py-1">
                            <ArrowDown size={12} className="text-line-strong" />
                          </div>
                        ) : null}
                        {groupSteps.length > 1 ? (
                          <div className="mb-1 flex items-center gap-2 text-[8.5px] uppercase tracking-wide text-faint">
                            <GitBranch size={9} /> 并行执行
                          </div>
                        ) : null}
                        <div className={cn('grid gap-2.5', groupSteps.length > 1 ? 'sm:grid-cols-2' : 'grid-cols-1')}>
                          {groupSteps.map((step) => (
                            <StepCard key={step.id} step={step} allSteps={steps} />
                          ))}
                        </div>
                      </div>
                    );
                  })}
                </div>
              </Panel>

              {selectedRun.status === 'awaiting_approval' ? (
                <Callout
                  tone="warning"
                  title="Gate 2 · 录制前需要人工批准"
                  action={
                    <Button
                      variant="primary"
                      size="sm"
                      icon={<Check size={12} />}
                      onClick={() => {
                        approveRun(selectedRun.id);
                        pushToast({ tone: 'success', title: 'Gate 已批准', description: '录制步骤继续执行。' });
                      }}
                    >
                      批准并继续
                    </Button>
                  }
                >
                  模拟生产已暂停等待。批准只会继续本地确定性 DAG，不会操作真实产品环境。
                </Callout>
              ) : null}

              {selectedRun.status === 'failed' ? (
                <Callout
                  tone="danger"
                  title="模拟生产失败，可重试失败步骤"
                  action={
                    <Button
                      variant="secondary"
                      size="sm"
                      icon={<RotateCcw size={12} />}
                      onClick={() => {
                        retryRun(selectedRun.id);
                        pushToast({ tone: 'info', title: '已重试失败步骤', description: '运行从录制步骤继续。' });
                      }}
                    >
                      重试此步骤
                    </Button>
                  }
                >
                  <div className="space-y-1">
                    <p>{selectedRun.failure?.message}</p>
                    <p className="text-[10px] text-faint">建议：{selectedRun.failure?.hint}</p>
                  </div>
                </Callout>
              ) : null}

              {selectedRun.status === 'succeeded' ? (
                <Callout
                  tone="success"
                  title="模拟生产完成，可以进入审核"
                  action={
                    <Link to={`/videos/${video.id}/review`} className={buttonStyles({ variant: 'primary', size: 'sm' })}>
                      去审核 <ArrowRight size={12} />
                    </Link>
                  }
                >
                  已生成可审核的工程版本，但没有真实 MP4/WebM。审核会检查声明、字幕、隐私与生产版本一致性。
                </Callout>
              ) : null}

              <Panel className="overflow-hidden">
                <PanelHeader
                  title="运行日志"
                  description="使用模拟耗时；日志由确定性状态机生成。"
                  actions={<Badge tone="outline" dot={false}>{selectedRun.logs.length} 行</Badge>}
                />
                <div
                  ref={logRef}
                  className="max-h-[260px] overflow-y-auto border-t border-line bg-[#0A0C10] p-3 font-mono text-[10px] leading-5"
                >
                  {selectedRun.logs.map((log) => (
                    <div key={log.id} className="flex gap-2">
                      <span className="shrink-0 text-white/25">{formatElapsed(log.atMs)}</span>
                      <span
                        className={cn(
                          'shrink-0 uppercase',
                          log.level === 'error'
                            ? 'text-danger'
                            : log.level === 'success'
                              ? 'text-success'
                              : log.level === 'warn'
                                ? 'text-warn'
                                : 'text-white/30',
                        )}
                      >
                        {log.level}
                      </span>
                      <span className="min-w-0 text-white/65">{log.text}</span>
                    </div>
                  ))}
                  {selectedRun.logs.length === 0 ? (
                    <div className="text-white/30">等待运行开始…</div>
                  ) : null}
                </div>
              </Panel>
            </>
          )}
        </div>

        <div className="space-y-3">
          <Panel>
            <PanelHeader
              title={activeRun ? '运行控制' : '新建运行'}
              description={activeRun ? '控制当前确定性模拟。' : '选择场景后启动。'}
            />
            <div className="space-y-3 p-4">
              {!activeRun ? (
                <>
                  {SCENARIOS.map((item) => {
                    const Icon = item.icon;
                    const active = scenario === item.value;
                    return (
                      <button
                        key={item.value}
                        type="button"
                        onClick={() => setScenario(item.value)}
                        className={cn(
                          'w-full rounded-md border px-3 py-2.5 text-left transition-colors',
                          active ? 'border-accent/45 bg-accent-soft/30' : 'border-line hover:border-line-strong',
                        )}
                      >
                        <div className="flex items-center gap-2">
                          <Icon size={12} className={active ? 'text-accent' : 'text-faint'} />
                          <span className="text-[10.5px] font-medium text-fg">{item.label}</span>
                          {active ? <Check size={10} className="ml-auto text-accent" /> : null}
                        </div>
                        <p className="mt-1 text-[9px] leading-4 text-faint">{SCENARIO_DESCRIPTIONS[item.value]}</p>
                      </button>
                    );
                  })}
                  {video.stage === 'review' || video.stage === 'approved' || video.stage === 'exported' ? (
                    <Callout tone="warning" size="sm">
                      当前视频已有审核状态。重新生产会让审核结果失效，需要重新审核。
                    </Callout>
                  ) : null}
                  {!readiness.ok ? (
                    <div className="flex items-start gap-1.5 text-[9.5px] leading-4 text-danger">
                      <AlertTriangle size={11} className="mt-0.5 shrink-0" />
                      {readiness.reason}
                    </div>
                  ) : null}
                  <Button
                    variant="primary"
                    className="w-full"
                    disabled={!readiness.ok}
                    icon={<Play size={13} />}
                    onClick={start}
                  >
                    启动「{SCENARIOS.find((item) => item.value === scenario)?.short}」
                  </Button>
                </>
              ) : selectedRun?.id === activeRun.id ? (
                <>
                  <div className="flex items-center justify-between gap-3">
                    <div>
                      <div className="text-[10px] text-faint">场景</div>
                      <div className="text-[11.5px] text-fg">{RUN_SCENARIO_LABEL[activeRun.scenario]}</div>
                    </div>
                    <RunStatusBadge status={activeRun.status} />
                  </div>
                  <div className="flex items-center justify-between gap-3 border-t border-line pt-3">
                    <div>
                      <div className="flex items-center gap-1 text-[10px] text-faint"><Gauge size={10} /> 速度</div>
                      <div className="mt-0.5 text-[9px] text-faint">只影响模拟耗时</div>
                    </div>
                    <SegmentedControl
                      value={String(activeRun.speed)}
                      onChange={(value) => changeRunSpeed(activeRun.id, Number(value))}
                      size="sm"
                      ariaLabel="模拟运行速度"
                      options={[
                        { value: '0.5', label: '0.5×' },
                        { value: '1', label: '1×' },
                        { value: '2', label: '2×' },
                        { value: '4', label: '4×' },
                      ]}
                    />
                  </div>
                  <div className="grid grid-cols-2 gap-2 border-t border-line pt-3">
                    {activeRun.status === 'running' ? (
                      <Button variant="secondary" size="sm" icon={<Pause size={12} />} onClick={() => pauseRun(activeRun.id)}>
                        暂停
                      </Button>
                    ) : activeRun.status === 'paused' ? (
                      <Button variant="secondary" size="sm" icon={<Play size={12} />} onClick={() => resumeRun(activeRun.id)}>
                        继续
                      </Button>
                    ) : (
                      <Button
                        variant="secondary"
                        size="sm"
                        icon={<Play size={12} />}
                        onClick={() => {
                          approveRun(activeRun.id);
                          pushToast({ tone: 'success', title: '已批准并继续' });
                        }}
                        disabled={activeRun.status !== 'awaiting_approval'}
                      >
                        批准继续
                      </Button>
                    )}
                    <Button variant="ghost" size="sm" icon={<Square size={11} />} onClick={() => setCancelling(true)}>
                      取消
                    </Button>
                  </div>
                  <div className="flex items-center gap-1.5 text-[9px] text-faint">
                    <Clock3 size={9} />
                    页面关闭后模拟进度不会推进。
                  </div>
                </>
              ) : (
                <div className="space-y-2">
                  <p className="text-[10px] leading-4 text-faint">你正在查看历史运行。</p>
                  <Button variant="secondary" size="sm" className="w-full" onClick={() => setSelectedRunId(activeRun.id)}>
                    回到当前运行
                  </Button>
                  <Button variant="ghost" size="sm" className="w-full" onClick={() => setSelectedRunId(runs[0]?.id)}>
                    查看最新运行
                  </Button>
                </div>
              )}
            </div>
          </Panel>

          <Panel>
            <PanelHeader title="输入快照" description="本 run 冻结的工程输入。" />
            <div className="space-y-2 px-4 pb-4">
              {selectedRun ? (
                <>
                  <InputRow label="镜头" value={`${selectedRun.input.sceneCount}`} />
                  <InputRow label="时长" value={`${selectedRun.input.durationSec}s`} />
                  <InputRow label="画幅" value={selectedRun.input.aspect} />
                  <InputRow label="声明引用" value={`${selectedRun.input.claimCount}`} />
                  <InputRow label="开始时间" value={formatRelativeTime(selectedRun.startedAt)} />
                </>
              ) : (
                <div className="text-[10px] text-faint">还没有运行。</div>
              )}
            </div>
          </Panel>

          {runs.length > 0 ? (
            <Panel>
              <PanelHeader title="运行历史" description={`${runs.length} 次本地模拟`} />
              <div className="divide-y divide-line border-t border-line">
                {runs.map((run) => (
                  <button
                    key={run.id}
                    type="button"
                    onClick={() => setSelectedRunId(run.id)}
                    className={cn(
                      'flex w-full items-center gap-2 px-3.5 py-2.5 text-left transition-colors',
                      selectedRun?.id === run.id ? 'bg-overlay/50' : 'hover:bg-overlay/30',
                    )}
                  >
                    <span className="min-w-0 flex-1">
                      <span className="flex items-center gap-1.5">
                        <span className="truncate text-[10px] text-fg">{RUN_SCENARIO_LABEL[run.scenario]}</span>
                        {activeRun?.id === run.id ? <span className="size-1 rounded-full bg-accent" /> : null}
                      </span>
                      <span className="mt-0.5 block text-[8.5px] text-faint">
                        {formatRelativeTime(run.startedAt)} · {formatElapsed(run.elapsedMs)}
                      </span>
                    </span>
                    <RunStatusBadge status={run.status} />
                  </button>
                ))}
              </div>
            </Panel>
          ) : null}

          <Callout tone="warning" size="sm" title="这是模拟 DAG">
            没有真实 Playwright 录制、FFmpeg/Remotion 渲染或文件上传。失败与审批是可复现的确定性场景。
          </Callout>
        </div>
      </div>

      <Dialog open={cancelling} onOpenChange={setCancelling}>
        <DialogContent
          title="取消这次模拟生产？"
          description="未完成的步骤会跳过；已完成的步骤保留。视频会回到分镜就绪。"
          size="sm"
          footer={
            <>
              <Button variant="ghost" onClick={() => setCancelling(false)}>继续运行</Button>
              <Button
                variant="danger"
                onClick={() => {
                  if (activeRun) cancelRun(activeRun.id);
                  setCancelling(false);
                  pushToast({ tone: 'info', title: '模拟生产已取消' });
                }}
              >
                确认取消
              </Button>
            </>
          }
        >
          <div className="rounded-md border border-line bg-raised/40 px-3 py-2.5 text-[11px] text-muted">
            取消不会删除日志或历史运行；可以新建一次运行重新开始。
          </div>
        </DialogContent>
      </Dialog>
    </Page>
  );
}

function StepCard({ step, allSteps }: { step: ProductionStep; allSteps: ProductionStep[] }) {
  const Icon = STEP_ICONS[step.key] ?? Workflow;
  const meta = STEP_STATUS_META[step.status];
  const dependencies = step.dependsOn
    .map((key) => allSteps.find((item) => item.key === key)?.name)
    .filter(Boolean)
    .join('、');

  return (
    <div
      className={cn(
        'relative rounded-md border bg-raised/20 p-3 transition-colors',
        step.status === 'running'
          ? 'border-accent/40 bg-accent-soft/10'
          : step.status === 'failed'
            ? 'border-danger/30 bg-danger-soft/20'
            : step.status === 'awaiting_approval'
              ? 'border-warn/30 bg-warn-soft/20'
              : step.status === 'succeeded'
                ? 'border-success/20'
                : 'border-line',
      )}
    >
      <div className="flex items-start gap-2.5">
        <span
          className={cn(
            'mt-0.5 grid size-7 shrink-0 place-items-center rounded-sm border',
            step.status === 'running'
              ? 'border-accent/30 bg-accent-soft text-accent'
              : step.status === 'succeeded'
                ? 'border-success/25 bg-success-soft text-success'
                : step.status === 'failed'
                  ? 'border-danger/25 bg-danger-soft text-danger'
                  : step.status === 'awaiting_approval'
                    ? 'border-warn/25 bg-warn-soft text-warn'
                    : 'border-line bg-overlay text-faint',
          )}
        >
          {step.status === 'running' ? <Loader2 size={13} className="animate-spin" /> : <Icon size={13} />}
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="text-[11.5px] font-medium text-fg">{step.name}</span>
            <Badge tone={meta.tone} dot={false}>{meta.label}</Badge>
            {step.attempt > 0 ? <span className="font-mono text-[8.5px] text-faint">尝试 {step.attempt}</span> : null}
          </div>
          <p className="mt-0.5 text-[9.5px] leading-4 text-faint">{step.description}</p>
          {step.status === 'running' || (step.status === 'failed' && step.progress > 0) ? (
            <div className="mt-2">
              <ProgressBar value={step.progress} tone={step.status === 'failed' ? 'danger' : 'accent'} size="sm" />
              <div className="mt-0.5 font-mono text-[8px] text-faint">{step.progress.toFixed(0)}%</div>
            </div>
          ) : null}
          {step.error ? <div className="mt-1.5 text-[9px] text-danger">{step.error}</div> : null}
          <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-0.5 text-[8.5px] text-faint">
            <span>模拟 {Math.round(step.durationMs / 100) / 10}s</span>
            {dependencies ? <span>依赖 {dependencies}</span> : <span>起始节点</span>}
            {step.requiresApproval ? <span className="text-warn">需审批</span> : null}
            {step.status === 'skipped' ? <span className="flex items-center gap-0.5"><Ban size={8} /> 已跳过</span> : null}
            {step.status === 'pending' ? <span className="flex items-center gap-0.5"><CircleDashed size={8} /> 等待前序</span> : null}
            {step.status === 'succeeded' ? <span className="flex items-center gap-0.5 text-success"><Check size={8} /> 完成</span> : null}
            {step.status === 'failed' ? <span className="flex items-center gap-0.5 text-danger"><XCircle size={8} /> 已停止</span> : null}
          </div>
        </div>
      </div>
    </div>
  );
}

function RunStat({
  label,
  value,
  hint,
  mono,
}: {
  label: string;
  value: ReactNode;
  hint: string;
  mono?: boolean;
}) {
  return (
    <div className="p-3.5">
      <div className="text-[9px] uppercase tracking-wide text-faint">{label}</div>
      <div className={cn('mt-0.5 text-[13px] text-fg', mono && 'font-mono text-[12px]')}>{value}</div>
      <div className="mt-0.5 truncate text-[9px] text-faint">{hint}</div>
    </div>
  );
}

function InputRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between gap-2 text-[10px]">
      <span className="text-faint">{label}</span>
      <span className="font-mono text-fg">{value}</span>
    </div>
  );
}

function runProgress(run: ProductionRun): number {
  if (run.status === 'succeeded') return 100;
  if (run.steps.length === 0) return 0;
  return (
    run.steps.reduce(
      (sum, step) => sum + (step.status === 'succeeded' ? 100 : step.progress),
      0,
    ) / run.steps.length
  );
}
