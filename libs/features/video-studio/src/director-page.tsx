import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useParams, useSearchParams } from 'react-router-dom';
import type { DirectorChange, Feature, Scene, Tone, VideoProject } from '@asvs/domain';
import {
  TONE_INFO,
  formatRelativeTime,
  orderedScenes,
  totalDuration,
} from '@asvs/domain';
import {
  ArrowRight,
  Bot,
  Check,
  CircleAlert,
  CornerDownLeft,
  Pencil,
  Send,
  Sparkles,
  UserRound,
} from 'lucide-react';
import {
  Badge,
  Button,
  Callout,
  ClaimStatusBadge,
  Dialog,
  DialogContent,
  FeatureStatusBadge,
  Field,
  Input,
  Page,
  Panel,
  PanelHeader,
  ScenePreview,
  SegmentedControl,
  Slider,
  Textarea,
  ThinkingDots,
  buttonStyles,
  cn,
} from '@asvs/ui';
import { useStudioStore, useUiStore } from '@asvs/state';
import { useShallow } from 'zustand/react/shallow';
import { NotFoundInline } from './not-found-inline';
import { VideoWorkspaceHeader } from './video-workspace-header';

export function DirectorPage() {
  const { videoId = '' } = useParams();
  const [searchParams] = useSearchParams();
  const video = useStudioStore((state) => state.videos.find((item) => item.id === videoId));
  const project = useStudioStore((state) =>
    state.projects.find((item) => item.id === video?.projectId),
  );
  const features = useStudioStore(
    useShallow((state) => state.features.filter((item) => item.projectId === video?.projectId)),
  );
  const claims = useStudioStore(
    useShallow((state) => state.claims.filter((item) => item.projectId === video?.projectId)),
  );
  const setVideoStage = useStudioStore((state) => state.setVideoStage);
  const sendDirectorCommand = useStudioStore((state) => state.sendDirectorCommand);
  const pushToast = useUiStore((state) => state.pushToast);

  const [draft, setDraft] = useState('');
  const [sending, setSending] = useState(false);
  const [briefOpen, setBriefOpen] = useState(false);
  const [focusSceneId, setFocusSceneId] = useState<string | undefined>(
    searchParams.get('scene') ?? undefined,
  );
  const scrollRef = useRef<HTMLDivElement>(null);

  const scenes = useMemo(() => (video ? orderedScenes(video.scenes) : []), [video]);
  const focusScene = scenes.find((scene) => scene.id === focusSceneId) ?? scenes[0];
  const selectedFeatures = video
    ? video.brief.featureIds
        .map((id) => features.find((feature) => feature.id === id))
        .filter((feature): feature is Feature => Boolean(feature))
    : [];
  const messages = video?.directorMessages ?? [];
  const lastChanges = [...messages]
    .reverse()
    .find((message) => message.changes && message.changes.length > 0)?.changes;
  const producing = video?.stage === 'producing';

  useEffect(() => {
    const node = scrollRef.current;
    if (node) node.scrollTop = node.scrollHeight;
  }, [messages.length, sending]);

  if (!video || !project) return <NotFoundInline label="视频工程不存在或已被删除。" />;

  const runCommand = async (command: string) => {
    if (!command.trim() || sending || producing) return;
    setSending(true);
    setDraft('');
    try {
      await sendDirectorCommand(video.id, command, focusSceneId);
    } finally {
      setSending(false);
    }
  };

  const quickCommands = buildQuickCommands(video, selectedFeatures);

  return (
    <Page wide>
      <VideoWorkspaceHeader
        video={video}
        project={project}
        active="director"
        actions={
          video.stage === 'script_review' || video.stage === 'draft' || video.stage === 'planning' ? (
            <Button
              variant="primary"
              size="sm"
              disabled={producing}
              onClick={() => {
                setVideoStage(video.id, 'storyboard_ready');
                pushToast({
                  tone: 'success',
                  title: '脚本已确认，可以进入分镜',
                  description: '确认不会开始生产；你可以继续调整镜头与节奏。',
                });
              }}
              icon={<Check size={13} />}
            >
              确认脚本
            </Button>
          ) : (
            <Link to={`/videos/${video.id}/storyboard`} className={buttonStyles({ variant: 'secondary', size: 'sm' })}>
              进入分镜 <ArrowRight size={12} />
            </Link>
          )
        }
      />

      {producing ? (
        <Callout tone="warning" className="mt-4" title="模拟生产正在运行，导演编辑已暂时锁定">
          生产运行期间修改脚本会让输出与工程版本不一致。请到生产监控暂停或取消运行后再编辑。
          <Link to={`/videos/${video.id}/production`} className="ml-1 text-warn underline-offset-2 hover:underline">
            打开生产监控
          </Link>
        </Callout>
      ) : null}

      <div className="mt-4 grid grid-cols-[minmax(0,1fr)] gap-4 xl:grid-cols-[280px_minmax(0,1fr)_292px]">
        <div className="space-y-3">
          <Panel>
            <PanelHeader
              title="创作简报"
              actions={
                <Button
                  variant="ghost"
                  size="icon-sm"
                  aria-label="编辑创作简报"
                  onClick={() => setBriefOpen(true)}
                  disabled={producing}
                >
                  <Pencil size={12} />
                </Button>
              }
            />
            <div className="space-y-3 p-3.5">
              <div>
                <div className="text-[9px] uppercase tracking-wide text-faint">目标</div>
                <p className="mt-0.5 text-[11px] leading-[17px] text-fg">{video.brief.objective}</p>
              </div>
              <div>
                <div className="text-[9px] uppercase tracking-wide text-faint">受众</div>
                <p className="mt-0.5 text-[11px] leading-[17px] text-muted">{video.brief.audience}</p>
              </div>
              <div className="grid grid-cols-3 gap-px overflow-hidden rounded-sm border border-line bg-line">
                {[
                  { label: '时长', value: `${totalDuration(video.scenes)}s` },
                  { label: '画幅', value: video.brief.aspect },
                  { label: '语气', value: TONE_INFO[video.brief.tone].label.slice(0, 2) },
                ].map((item) => (
                  <div key={item.label} className="bg-raised/60 px-1.5 py-1.5 text-center">
                    <div className="text-[8.5px] text-faint">{item.label}</div>
                    <div className="mt-0.5 font-mono text-[10px] text-fg">{item.value}</div>
                  </div>
                ))}
              </div>
              <div className="flex items-center justify-between gap-2 text-[9.5px] text-faint">
                <span>CTA</span>
                <span className="truncate text-muted">{video.brief.cta || '未设置'}</span>
              </div>
            </div>
          </Panel>

          <Panel>
            <PanelHeader title="卖点与证据" description={`${selectedFeatures.length} 个功能约束着脚本`} />
            <div className="divide-y divide-line border-t border-line">
              {selectedFeatures.map((feature) => {
                const claim = claims.find((item) => item.id === feature.claimIds[0]);
                return (
                  <div key={feature.id} className="px-3.5 py-2.5">
                    <div className="flex items-center gap-1.5">
                      <span className="min-w-0 flex-1 truncate text-[10.5px] text-fg">{feature.name}</span>
                      <FeatureStatusBadge status={feature.status} />
                    </div>
                    <div className="mt-1 flex items-center gap-1.5">
                      {claim ? <ClaimStatusBadge status={claim.status} /> : <Badge tone="danger">无声明</Badge>}
                      <Link
                        to={`/projects/${project.id}/knowledge?feature=${feature.id}`}
                        className="ml-auto text-[9px] text-faint hover:text-accent"
                      >
                        证据 →
                      </Link>
                    </div>
                  </div>
                );
              })}
            </div>
          </Panel>

          <Panel>
            <PanelHeader title="镜头上下文" description="重生成命令会优先作用于这里。" />
            <div className="p-3">
              <select
                value={focusScene?.id ?? ''}
                onChange={(event) => setFocusSceneId(event.target.value)}
                className="h-7 w-full rounded-sm border border-line bg-raised/60 px-2 text-[10.5px] text-fg"
                aria-label="选择聚焦镜头"
              >
                {scenes.map((scene) => (
                  <option key={scene.id} value={scene.id}>
                    镜头 {scene.order + 1} · {scene.title}
                  </option>
                ))}
              </select>
              {focusScene ? (
                <div className="mt-2 overflow-hidden rounded-sm border border-line">
                  <div className="aspect-video">
                    <ScenePreview
                      scene={focusScene}
                      project={project}
                      feature={selectedFeatures.find((feature) => feature.id === focusScene.featureId)}
                      aspect="16:9"
                      showCaption={false}
                      showChrome={false}
                    />
                  </div>
                  <div className="border-t border-line bg-raised/40 px-2 py-1.5 text-[9px] text-faint">
                    {focusScene.durationSec}s · {sceneTypeLabel(focusScene)}
                  </div>
                </div>
              ) : null}
            </div>
          </Panel>
        </div>

        <Panel className="flex min-h-[620px] flex-col overflow-hidden">
          <div className="flex items-center justify-between border-b border-line px-4 py-3">
            <div className="flex items-center gap-2">
              <span className="grid size-6 place-items-center rounded-md border border-ai/25 bg-ai-soft text-ai">
                <Sparkles size={12} />
              </span>
              <div>
                <div className="text-[12px] font-medium text-fg">AI 导演</div>
                <div className="text-[9px] text-faint">确定性模拟 · 只执行可解释的结构化修改</div>
              </div>
            </div>
            <Badge tone="outline" dot={false}>脚本 v{video.scriptVersion}</Badge>
          </div>

          <div ref={scrollRef} className="flex-1 space-y-4 overflow-y-auto px-4 py-4">
            {messages.map((message) => (
              <div key={message.id} className={cn('flex gap-2.5', message.role === 'user' ? 'justify-end' : '')}>
                {message.role !== 'user' ? (
                  <span className="mt-0.5 grid size-6 shrink-0 place-items-center rounded-full border border-ai/25 bg-ai-soft text-ai">
                    <Bot size={12} />
                  </span>
                ) : null}
                <div className={cn('max-w-[86%]', message.role === 'user' ? 'order-first' : '')}>
                  <div
                    className={cn(
                      'rounded-lg px-3.5 py-2.5 text-[11.5px] leading-[19px]',
                      message.role === 'user'
                        ? 'rounded-br-sm border border-accent/20 bg-accent-soft text-fg'
                        : 'rounded-bl-sm border border-line bg-raised/50 text-fg',
                    )}
                  >
                    {message.text}
                    {message.changes && message.changes.length > 0 ? (
                      <div className="mt-2.5 space-y-1 border-t border-line/80 pt-2">
                        <div className="text-[9px] uppercase tracking-wide text-faint">已写入工程</div>
                        {message.changes.map((change, index) => (
                          <div key={`${change.field}-${index}`} className="flex items-start gap-1.5 text-[10px]">
                            <Check size={10} className="mt-0.5 shrink-0 text-success" />
                            <span className="text-muted">
                              {change.label}
                              {change.from || change.to ? (
                                <span className="text-faint">
                                  {change.from ? ` · ${change.from}` : ''}
                                  {change.to ? ` → ${change.to}` : ''}
                                </span>
                              ) : null}
                            </span>
                          </div>
                        ))}
                      </div>
                    ) : null}
                  </div>
                  <div className={cn('mt-1 text-[8.5px] text-faint', message.role === 'user' ? 'text-right' : '')}>
                    {message.role === 'user' ? '你' : '模拟导演'} · {formatRelativeTime(message.at)}
                  </div>
                </div>
                {message.role === 'user' ? (
                  <span className="mt-0.5 grid size-6 shrink-0 place-items-center rounded-full border border-line bg-overlay text-muted">
                    <UserRound size={12} />
                  </span>
                ) : null}
              </div>
            ))}

            {sending ? (
              <div className="flex gap-2.5">
                <span className="mt-0.5 grid size-6 shrink-0 place-items-center rounded-full border border-ai/25 bg-ai-soft text-ai">
                  <Bot size={12} />
                </span>
                <div className="flex items-center gap-2 rounded-lg rounded-bl-sm border border-line bg-raised/50 px-3.5 py-3">
                  <ThinkingDots />
                  <span className="text-[10px] text-faint">解析意图并写入工程…</span>
                </div>
              </div>
            ) : null}
          </div>

          <div className="border-t border-line p-3">
            <div className="mb-2 flex flex-wrap gap-1">
              {quickCommands.map((command) => (
                <button
                  key={command}
                  type="button"
                  disabled={sending || producing}
                  onClick={() => void runCommand(command)}
                  className="rounded-full border border-line bg-raised/40 px-2 py-1 text-[9.5px] text-muted transition-colors hover:border-accent/30 hover:text-accent disabled:opacity-40"
                >
                  {command}
                </button>
              ))}
            </div>
            <div className="flex items-end gap-2 rounded-md border border-line bg-raised/40 p-1.5 focus-within:border-accent/40">
              <Textarea
                value={draft}
                onChange={(event) => setDraft(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter' && !event.shiftKey) {
                    event.preventDefault();
                    void runCommand(draft);
                  }
                }}
                placeholder={producing ? '生产运行中，暂不可编辑…' : '告诉导演要改什么，例如「缩短到 30 秒」…'}
                disabled={sending || producing}
                className="min-h-[44px] flex-1 resize-none border-0 bg-transparent px-2 py-1.5 text-[12px] focus:ring-0"
                rows={2}
              />
              <Button
                variant="primary"
                size="icon"
                aria-label="发送导演指令"
                disabled={!draft.trim() || sending || producing}
                onClick={() => void runCommand(draft)}
              >
                <Send size={14} />
              </Button>
            </div>
            <div className="mt-1.5 flex items-center justify-between text-[8.5px] text-faint">
              <span>Enter 发送 · Shift + Enter 换行</span>
              <span className="flex items-center gap-1"><CornerDownLeft size={9} /> 修改会立即落盘</span>
            </div>
          </div>
        </Panel>

        <div className="space-y-3">
          <Panel>
            <PanelHeader title="最近一次变更" description={lastChanges ? '可在编辑器中撤销' : '还没有结构修改'} />
            <div className="px-3.5 pb-3.5">
              {lastChanges ? (
                <div className="space-y-2">
                  {lastChanges.map((change, index) => (
                    <ChangeRow key={`${change.field}-${index}`} change={change} />
                  ))}
                </div>
              ) : (
                <p className="text-[10px] leading-4 text-faint">
                  发出可识别的导演指令后，这里会显示实际写入的字段。
                </p>
              )}
            </div>
          </Panel>

          <Panel>
            <PanelHeader title="导演能做什么" />
            <div className="space-y-2 px-3.5 pb-3.5">
              {[
                '整体时长与单个镜头时长',
                '语气、受众与视觉风格',
                '功能卖点的增删',
                '镜头顺序与重新生成',
                '旁白与字幕文本',
              ].map((item) => (
                <div key={item} className="flex items-center gap-2 text-[10px] text-muted">
                  <Check size={10} className="shrink-0 text-success" />
                  {item}
                </div>
              ))}
            </div>
          </Panel>

          <Panel>
            <PanelHeader title="不支持的能力" description="会明确拒绝，而不是假装执行。" />
            <div className="space-y-2 px-3.5 pb-3.5">
              <p className="text-[10px] leading-4 text-faint">
                真人出镜、任意主题重写、真实素材下载、跨项目改写等都不在模拟导演的意图范围内。
              </p>
              <button
                type="button"
                disabled={sending || producing}
                onClick={() => void runCommand('换成真人出镜')}
                className="w-full rounded-sm border border-dashed border-line px-2 py-1.5 text-left text-[9.5px] text-faint transition-colors hover:border-line-strong hover:text-muted disabled:opacity-40"
              >
                测试边界：把视频换成真人出镜 →
              </button>
            </div>
          </Panel>

          <Panel>
            <PanelHeader title="下一步" />
            <div className="px-3.5 pb-3.5">
              <div className="space-y-1.5 text-[10px] leading-4 text-muted">
                <p className="flex gap-2"><span className="font-mono text-faint">01</span> 确认脚本</p>
                <p className="flex gap-2"><span className="font-mono text-faint">02</span> 在分镜工作室调整镜头</p>
                <p className="flex gap-2"><span className="font-mono text-faint">03</span> 在编辑器中检查时间线</p>
                <p className="flex gap-2"><span className="font-mono text-faint">04</span> 启动模拟生产</p>
              </div>
              <Link
                to={`/videos/${video.id}/storyboard`}
                className={buttonStyles({ variant: 'secondary', size: 'sm', className: 'mt-3 w-full' })}
              >
                打开分镜工作室 <ArrowRight size={11} />
              </Link>
            </div>
          </Panel>
        </div>
      </div>

      <BriefDialog open={briefOpen} onClose={() => setBriefOpen(false)} videoId={video.id} />

      <p className="mt-4 flex items-center gap-1.5 text-[10px] text-faint">
        <CircleAlert size={11} />
        导演是确定性意图解析器，不调用真实模型；所有修改只作用于当前浏览器中的视频工程。
      </p>
    </Page>
  );
}

function ChangeRow({ change }: { change: DirectorChange }) {
  return (
    <div className="rounded-sm border border-line bg-raised/30 px-2.5 py-2">
      <div className="text-[10px] font-medium text-fg">{change.label}</div>
      <div className="mt-1 space-y-0.5 text-[9.5px] leading-4">
        {change.from ? (
          <div className="flex gap-1.5">
            <span className="shrink-0 text-faint">原</span>
            <span className="min-w-0 break-words text-muted line-through decoration-line-strong">{change.from}</span>
          </div>
        ) : null}
        {change.to ? (
          <div className="flex gap-1.5">
            <span className="shrink-0 text-faint">新</span>
            <span className="min-w-0 break-words text-fg">{change.to}</span>
          </div>
        ) : null}
      </div>
    </div>
  );
}

function BriefDialog({ open, onClose, videoId }: { open: boolean; onClose: () => void; videoId: string }) {
  const video = useStudioStore((state) => state.videos.find((item) => item.id === videoId));
  const updateBrief = useStudioStore((state) => state.updateBrief);
  const pushToast = useUiStore((state) => state.pushToast);
  const [draft, setDraft] = useState(() => ({
    objective: video?.brief.objective ?? '',
    audience: video?.brief.audience ?? '',
    cta: video?.brief.cta ?? '',
    durationSec: video?.brief.durationSec ?? 30,
    tone: video?.brief.tone ?? ('confident' as Tone),
  }));

  useEffect(() => {
    if (open && video) {
      setDraft({
        objective: video.brief.objective,
        audience: video.brief.audience,
        cta: video.brief.cta,
        durationSec: totalDuration(video.scenes),
        tone: video.brief.tone,
      });
    }
  }, [open, video]);

  if (!video) return null;

  return (
    <Dialog open={open} onOpenChange={(next) => { if (!next) onClose(); }}>
      <DialogContent
        title="编辑创作简报"
        description="修改会写入工程；时长变化会重新分配每个镜头的秒数。"
        footer={
          <>
            <Button variant="ghost" onClick={onClose}>取消</Button>
            <Button
              variant="primary"
              disabled={!draft.objective.trim() || !draft.audience.trim()}
              onClick={() => {
                updateBrief(video.id, {
                  objective: draft.objective.trim(),
                  audience: draft.audience.trim(),
                  cta: draft.cta.trim(),
                  tone: draft.tone,
                  durationSec: draft.durationSec,
                });
                onClose();
                pushToast({ tone: 'success', title: '创作简报已更新', description: '脚本、分镜与时间线已同步。' });
              }}
            >
              保存简报
            </Button>
          </>
        }
      >
        <div className="space-y-4">
          <Field label="创作目标" required>
            <Textarea
              value={draft.objective}
              className="min-h-[70px]"
              onChange={(event) => setDraft({ ...draft, objective: event.target.value })}
            />
          </Field>
          <Field label="目标受众" required>
            <Textarea
              value={draft.audience}
              className="min-h-[60px]"
              onChange={(event) => setDraft({ ...draft, audience: event.target.value })}
            />
          </Field>
          <Field label="片尾行动号召">
            <Input value={draft.cta} onChange={(event) => setDraft({ ...draft, cta: event.target.value })} />
          </Field>
          <Slider
            label="目标总时长"
            value={draft.durationSec}
            min={10}
            max={120}
            step={5}
            onValueChange={(value) => setDraft({ ...draft, durationSec: value })}
            formatValue={(value) => `${value} 秒`}
          />
          <div>
            <div className="mb-1.5 text-[12.5px] font-medium text-fg">语气</div>
            <SegmentedControl
              value={draft.tone}
              onChange={(tone) => setDraft({ ...draft, tone })}
              ariaLabel="语气"
              options={[
                { value: 'confident', label: '自信' },
                { value: 'warm', label: '友好' },
                { value: 'technical', label: '技术' },
                { value: 'bold', label: '有力' },
              ]}
            />
          </div>
          <Callout tone="info" size="sm">
            简报变化不会自动重写所有文案。需要重写某个镜头时，继续用导演指令。
          </Callout>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function buildQuickCommands(video: VideoProject, features: Feature[]): string[] {
  const commands: string[] = [];
  commands.push(video.brief.durationSec > 34 ? '缩短到 30 秒' : '延长到 45 秒');
  commands.push(video.brief.tone === 'confident' ? '把语气调得更轻松' : '把语气调得更自信');
  commands.push('把受众改成开发者');
  if (video.scenes.some((scene) => scene.visualType === 'real_demo')) commands.push('把录屏演示提前');
  commands.push('重新生成第 2 个分镜');
  if (features.length > 1) commands.push(`删除「${features[features.length - 1]!.name}」卖点`);
  commands.push('把风格换成极简');
  return commands.slice(0, 6);
}

function sceneTypeLabel(scene: Scene): string {
  if (scene.visualType === 'title') return '片头';
  if (scene.visualType === 'cta') return '片尾';
  if (scene.visualType === 'real_demo') return '产品演示';
  if (scene.visualType === 'generated') return '生成画面';
  return '动效';
}
