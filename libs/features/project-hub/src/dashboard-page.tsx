import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';
import type { ActivityEvent, VideoProject } from '@asvs/domain';
import {
  formatDuration,
  formatRelativeTime,
  orderedScenes,
  totalDuration,
} from '@asvs/domain';
import {
  AlertTriangle,
  ArrowRight,
  ArrowUpRight,
  BookOpen,
  Check,
  CheckCircle2,
  Clapperboard,
  Clock,
  Film,
  FolderKanban,
  Info,
  Play,
  Plus,
  RefreshCw,
  ShieldCheck,
  Sparkles,
  Workflow,
} from 'lucide-react';
import {
  Badge,
  Button,
  Callout,
  EmptyState,
  Metric,
  Page,
  PageHeader,
  Panel,
  PanelHeader,
  ScenePreview,
  VideoStageBadge,
  buttonStyles,
  cn,
} from '@asvs/ui';
import { useStudioStore, useUiStore } from '@asvs/state';

interface QueueItem {
  id: string;
  title: string;
  detail: string;
  tone: 'warn' | 'danger' | 'accent' | 'ai';
  icon: ReactNode;
  to: string;
  action: string;
  projectId?: string;
}

export function DashboardPage() {
  const projects = useStudioStore((state) => state.projects);
  const videos = useStudioStore((state) => state.videos);
  const features = useStudioStore((state) => state.features);
  const claims = useStudioStore((state) => state.claims);
  const suggestions = useStudioStore((state) => state.suggestions);
  const runs = useStudioStore((state) => state.runs);
  const activity = useStudioStore((state) => state.activity);
  const lastProjectId = useUiStore((state) => state.lastProjectId);
  const setCommandOpen = useUiStore((state) => state.setCommandOpen);

  if (projects.length === 0) {
    return (
      <Page>
        <PageHeader eyebrow="Studio" title="欢迎来到 AI Software Video Studio" description="从一个可信的软件事实开始，生成一条可以审核、可以修改的视频。" />
        <EmptyState
          className="mt-10"
          icon={<FolderKanban size={20} />}
          title="还没有项目"
          description="用六步入门连接一个模拟来源，我们会生成功能、声明与证据的初始知识。"
          action={
            <Link to="/onboarding" className={buttonStyles({ variant: 'primary', size: 'lg' })}>
              <Plus size={15} /> 创建第一个项目
            </Link>
          }
        />
      </Page>
    );
  }

  const sortedVideos = [...videos].sort(
    (a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime(),
  );
  const featured =
    sortedVideos.find((video) => video.stage === 'review') ??
    sortedVideos.find((video) => !['exported', 'draft'].includes(video.stage)) ??
    sortedVideos[0];
  const featuredProject = featured ? projects.find((project) => project.id === featured.projectId) : undefined;
  const featuredScene = featured
    ? orderedScenes(featured.scenes).find((scene) => scene.visualType === 'real_demo') ??
      orderedScenes(featured.scenes)[0]
    : undefined;
  const featuredFeature = featuredScene?.featureId
    ? features.find((feature) => feature.id === featuredScene.featureId)
    : undefined;

  const pendingSuggestions = suggestions.filter((suggestion) => suggestion.status === 'pending');
  const staleFeatures = features.filter((feature) => feature.status === 'stale');
  const reviewVideos = videos.filter((video) => video.stage === 'review');
  const failedRuns = runs.filter((run) => run.status === 'failed');
  const scriptVideos = videos.filter((video) => video.stage === 'script_review');

  const queue: QueueItem[] = [];
  reviewVideos.forEach((video) => {
    const project = projects.find((item) => item.id === video.projectId);
    queue.push({
      id: `review-${video.id}`,
      title: `审核「${video.title}」`,
      detail: `${project?.name ?? '项目'} · ${video.scenes.length} 个镜头 · 已有一次成功模拟生产`,
      tone: 'warn',
      icon: <ShieldCheck size={15} />,
      to: `/videos/${video.id}/review`,
      action: '去审核',
      projectId: video.projectId,
    });
  });
  staleFeatures.slice(0, 2).forEach((feature) => {
    const project = projects.find((item) => item.id === feature.projectId);
    queue.push({
      id: `stale-${feature.id}`,
      title: `重新验证「${feature.name}」`,
      detail: `${project?.name ?? '项目'} · 证据已过期，会阻断视频审核`,
      tone: 'danger',
      icon: <AlertTriangle size={15} />,
      to: `/projects/${feature.projectId}/knowledge?feature=${feature.id}`,
      action: '处理证据',
      projectId: feature.projectId,
    });
  });
  failedRuns.slice(0, 1).forEach((run) => {
    const video = videos.find((item) => item.id === run.videoId);
    queue.push({
      id: `run-${run.id}`,
      title: `重试失败的模拟生产`,
      detail: video?.title ?? '视频',
      tone: 'danger',
      icon: <Workflow size={15} />,
      to: `/videos/${run.videoId}/production`,
      action: '查看失败',
      projectId: run.projectId,
    });
  });
  scriptVideos.slice(0, 1).forEach((video) => {
    queue.push({
      id: `script-${video.id}`,
      title: `确认「${video.title}」的脚本`,
      detail: 'AI 已生成分镜，等待你检查旁白与镜头节奏',
      tone: 'accent',
      icon: <Sparkles size={15} />,
      to: `/videos/${video.id}/director`,
      action: '打开导演',
      projectId: video.projectId,
    });
  });
  pendingSuggestions.slice(0, 1).forEach((suggestion) => {
    queue.push({
      id: `suggestion-${suggestion.id}`,
      title: suggestion.title,
      detail: '知识中心有待确认的 AI 建议',
      tone: 'ai',
      icon: <BookOpen size={15} />,
      to: `/projects/${suggestion.projectId}/knowledge`,
      action: '去确认',
      projectId: suggestion.projectId,
    });
  });

  const verifiedClaims = claims.filter((claim) => claim.status === 'verified').length;
  const usableVideos = videos.filter((video) => ['review', 'approved', 'exported', 'producing'].includes(video.stage)).length;
  const knowledgeProjects = projects.map((project) => {
    const projectClaims = claims.filter((claim) => claim.projectId === project.id);
    const count = (status: string) => projectClaims.filter((claim) => claim.status === status).length;
    return {
      project,
      total: projectClaims.length,
      verified: count('verified'),
      supported: count('supported'),
      stale: count('stale'),
      other: projectClaims.filter((claim) => !['verified', 'supported', 'stale'].includes(claim.status)).length,
    };
  });

  const latestActivity = activity.slice(0, 6);

  return (
    <Page wide>
      <PageHeader
        eyebrow={
          <>
            <span className="size-1.5 rounded-full bg-accent" />
            Studio overview · {new Date().toLocaleDateString('zh-CN', { month: 'long', day: 'numeric' })}
          </>
        }
        title="把可信的产品事实，变成可审阅的视频。"
        description="知识、脚本、分镜与生产运行共用同一份数据。所有标为 Demo 的内容都是本地模拟，可随时重置。"
        actions={
          <>
            <Button variant="ghost" onClick={() => setCommandOpen(true)}>
              快速跳转
            </Button>
            <Link to="/onboarding" className={buttonStyles({ variant: 'secondary' })}>
              <Plus size={15} />
              新建项目
            </Link>
            {featuredProject ? (
              <Link
                to={`/projects/${featuredProject.id}/videos/new`}
                className={buttonStyles({ variant: 'primary' })}
              >
                <Clapperboard size={15} />
                新建视频
              </Link>
            ) : null}
          </>
        }
      />

      <div className="mt-6 grid grid-cols-2 divide-line rounded-lg border border-line bg-surface/70 sm:grid-cols-4 sm:divide-x">
        <div className="border-b border-line p-4 sm:border-b-0">
          <Metric
            label="待你处理"
            value={queue.length}
            hint={queue.length > 0 ? '审核、证据与失败运行' : '队列已清空'}
            tone={queue.length > 0 ? 'warn' : 'default'}
          />
        </div>
        <div className="border-b border-line p-4 sm:border-b-0">
          <Metric
            label="待审核视频"
            value={reviewVideos.length}
            hint="生产完成但未批准"
            tone={reviewVideos.length > 0 ? 'accent' : 'default'}
          />
        </div>
        <div className="p-4">
          <Metric label="已核验声明" value={`${verifiedClaims}/${claims.length}`} hint="可安全用于对外视频" tone="default" />
        </div>
        <div className="border-l border-line p-4 sm:border-l">
          <Metric
            label="待确认建议"
            value={pendingSuggestions.length}
            hint="来自模拟 AI 分析"
            tone={pendingSuggestions.length > 0 ? 'ai' : 'default'}
          />
        </div>
      </div>

      <div className="mt-4 grid grid-cols-[minmax(0,1fr)] gap-4 xl:grid-cols-[1.6fr_1fr]">
        {featured && featuredProject && featuredScene ? (
          <Panel className="overflow-hidden">
            <div className="grid md:grid-cols-[1.08fr_.92fr]">
              <div className="flex flex-col p-5 lg:p-6">
                <div className="flex items-center gap-2">
                  <Badge tone="accent" dot={false}>
                    继续上次工作
                  </Badge>
                  <VideoStageBadge stage={featured.stage} />
                  <span className="ml-auto font-mono text-[10.5px] text-faint">
                    {formatRelativeTime(featured.updatedAt)}更新
                  </span>
                </div>
                <h2 className="mt-4 font-display text-[26px] font-medium leading-[1.15] tracking-[-0.02em] text-fg">
                  {featured.title}
                </h2>
                <p className="mt-2 max-w-xl text-[12.5px] leading-5 text-muted">
                  {featured.brief.objective}
                </p>
                <div className="mt-4 flex flex-wrap items-center gap-x-4 gap-y-2 text-[11.5px] text-muted">
                  <span className="flex items-center gap-1.5">
                    <FolderKanban size={12} className="text-faint" />
                    {featuredProject.name}
                  </span>
                  <span className="flex items-center gap-1.5">
                    <Film size={12} className="text-faint" />
                    {featured.scenes.length} 个镜头
                  </span>
                  <span className="flex items-center gap-1.5">
                    <Clock size={12} className="text-faint" />
                    {formatDuration(totalDuration(featured.scenes))}
                  </span>
                  <Badge tone="outline" dot={false}>
                    {featured.brief.aspect}
                  </Badge>
                </div>
                <div className="mt-auto flex flex-wrap items-center gap-2 pt-6">
                  <Link
                    to={nextStep(featured).to}
                    className={buttonStyles({ variant: 'primary' })}
                  >
                    {nextStep(featured).label}
                    <ArrowRight size={14} />
                  </Link>
                  <Link
                    to={`/videos/${featured.id}/storyboard`}
                    className={buttonStyles({ variant: 'secondary' })}
                  >
                    <Play size={14} />
                    查看分镜
                  </Link>
                  <span className="text-[11px] text-faint">模拟预览 · 不播放真实音轨</span>
                </div>
              </div>
              <div className="relative flex min-h-[240px] items-center justify-center border-t border-line bg-ink p-3 md:border-l md:border-t-0">
                <div
                  className={cn(
                    'relative overflow-hidden rounded-md border border-line',
                    featured.brief.aspect === '9:16'
                      ? 'aspect-[9/16] h-full w-auto max-w-full'
                      : featured.brief.aspect === '1:1'
                        ? 'aspect-square h-full w-auto max-w-full'
                        : 'aspect-video w-full',
                  )}
                >
                  <ScenePreview
                    scene={featuredScene}
                    project={featuredProject}
                    feature={featuredFeature}
                    aspect={featured.brief.aspect}
                    showCaption
                    showChrome={false}
                  />
                  <div className="absolute inset-x-0 bottom-0 flex items-center justify-between bg-gradient-to-t from-black/75 to-transparent p-3 pt-10">
                    <span className="text-[10px] text-white/70">
                      第 {featuredScene.order + 1} 镜 · {featuredScene.title}
                    </span>
                    <span className="rounded-sm border border-white/20 bg-black/40 px-1.5 py-0.5 text-[9px] text-white/65">
                      模拟画面
                    </span>
                  </div>
                </div>
              </div>
            </div>
          </Panel>
        ) : (
          <EmptyState
            icon={<Clapperboard size={20} />}
            title="还没有视频工程"
            description="从一个已核验的功能开始，AI 导演会先与你确认脚本，再生成可编辑的分镜。"
            action={
              <Link to="/projects" className={buttonStyles({ variant: 'primary' })}>
                选择项目 <ArrowRight size={14} />
              </Link>
            }
          />
        )}

        <Panel>
          <PanelHeader title="今天从哪里开始" description="按顺序完成，数据会贯穿每一步。" />
          <div className="space-y-1 px-3 pb-4">
            {[
              {
                label: '同步产品知识',
                detail: `${features.length} 个功能 · ${claims.length} 条声明`,
                to: `/projects/${projects[0]?.id}/knowledge`,
                done: features.length > 0,
              },
              {
                label: '创建或调整视频策划',
                detail: `${videos.length} 个视频工程`,
                to: featuredProject ? `/projects/${featuredProject.id}/videos/new` : '/projects',
                done: videos.length > 0,
              },
              {
                label: '完成一次模拟生产',
                detail: `${runs.filter((run) => run.status === 'succeeded').length} 次成功运行`,
                to: featured ? `/videos/${featured.id}/production` : '/projects',
                done: runs.some((run) => run.status === 'succeeded'),
              },
              {
                label: '审核并导出',
                detail: `${videos.filter((video) => ['approved', 'exported'].includes(video.stage)).length} 条已通过`,
                to: featured ? `/videos/${featured.id}/review` : '/projects',
                done: videos.some((video) => ['approved', 'exported'].includes(video.stage)),
              },
            ].map((step, index) => (
              <Link
                key={step.label}
                to={step.to}
                className="group flex items-center gap-3 rounded-md px-2 py-2.5 transition-colors hover:bg-overlay/60"
              >
                <span
                  className={cn(
                    'grid size-6 shrink-0 place-items-center rounded-full border text-[10px] font-mono',
                    step.done
                      ? 'border-success/40 bg-success-soft text-success'
                      : 'border-line-strong text-faint',
                  )}
                >
                  {step.done ? <Check size={12} strokeWidth={2.6} /> : index + 1}
                </span>
                <span className="min-w-0 flex-1">
                  <span className={cn('block text-[12.5px] font-medium', step.done ? 'text-muted' : 'text-fg')}>
                    {step.label}
                  </span>
                  <span className="block text-[10.5px] text-faint">{step.detail}</span>
                </span>
                <ArrowUpRight size={13} className="text-faint transition-colors group-hover:text-accent" />
              </Link>
            ))}
          </div>
          <div className="border-t border-line px-4 py-3">
            <Callout tone="info" size="sm">
              所有数据和交互都保存在本地；这里没有账号、云端同步或真实模型调用。
            </Callout>
          </div>
        </Panel>
      </div>

      <div className="mt-4 grid grid-cols-[minmax(0,1fr)] gap-4 xl:grid-cols-[1.35fr_1fr]">
        <Panel>
          <PanelHeader
            title="待你处理"
            description="按阻断程度排序；每一项都能回到具体上下文。"
            actions={<Badge tone={queue.length > 0 ? 'warn' : 'success'}>{queue.length} 项</Badge>}
          />
          <div className="divide-y divide-line border-t border-line">
            {queue.length === 0 ? (
              <div className="flex items-center gap-3 px-5 py-8 text-[12.5px] text-muted">
                <CheckCircle2 size={18} className="text-success" />
                队列已经清空。可以从一条新视频开始。
              </div>
            ) : (
              queue.slice(0, 5).map((item) => (
                <div key={item.id} className="flex items-center gap-3 px-5 py-3">
                  <span
                    className={cn(
                      'grid size-8 shrink-0 place-items-center rounded-md border',
                      item.tone === 'danger' && 'border-danger/25 bg-danger-soft text-danger',
                      item.tone === 'warn' && 'border-warn/25 bg-warn-soft text-warn',
                      item.tone === 'accent' && 'border-accent/25 bg-accent-soft text-accent',
                      item.tone === 'ai' && 'border-ai/25 bg-ai-soft text-ai',
                    )}
                  >
                    {item.icon}
                  </span>
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-[12.5px] font-medium text-fg">{item.title}</div>
                    <div className="truncate text-[11px] text-faint">{item.detail}</div>
                  </div>
                  <Link
                    to={item.to}
                    className={buttonStyles({ variant: 'ghost', size: 'sm', className: 'shrink-0' })}
                  >
                    {item.action}
                    <ArrowRight size={12} />
                  </Link>
                </div>
              ))
            )}
          </div>
        </Panel>

        <Panel>
          <PanelHeader
            title="知识可信度"
            description="审核用的声明必须已核验；待验证内容需要限定表述。"
            actions={
              <Link to={`/projects/${projects[0]?.id}/knowledge`} className="text-[11px] text-muted hover:text-accent">
                知识中心 →
              </Link>
            }
          />
          <div className="space-y-4 border-t border-line px-5 py-4">
            {knowledgeProjects.map(({ project, total, verified, supported, stale, other }) => {
              const percent = total > 0 ? Math.round((verified / total) * 100) : 0;
              return (
                <Link
                  key={project.id}
                  to={`/projects/${project.id}/knowledge`}
                  className="block rounded-md border border-line bg-raised/30 p-3 transition-colors hover:border-line-strong hover:bg-raised/60"
                >
                  <div className="flex items-center justify-between gap-3">
                    <div className="flex min-w-0 items-center gap-2">
                      <span
                        className="size-2 shrink-0 rounded-[2px]"
                        style={{ background: project.brand.primary }}
                      />
                      <span className="truncate text-[12px] font-medium text-fg">{project.name}</span>
                    </div>
                    <span className="shrink-0 font-mono text-[11px] text-muted">{percent}%</span>
                  </div>
                  <div className="mt-2.5 flex h-1.5 overflow-hidden rounded-full bg-overlay">
                    <span className="bg-success" style={{ width: `${(verified / Math.max(1, total)) * 100}%` }} />
                    <span className="bg-warn" style={{ width: `${(supported / Math.max(1, total)) * 100}%` }} />
                    <span className="bg-danger/70" style={{ width: `${(stale / Math.max(1, total)) * 100}%` }} />
                    <span className="bg-line-strong" style={{ width: `${(other / Math.max(1, total)) * 100}%` }} />
                  </div>
                  <div className="mt-2 flex flex-wrap gap-x-3 gap-y-1 text-[10px] text-faint">
                    <span className="text-success">{verified} 已核验</span>
                    <span className="text-warn">{supported} 待验证</span>
                    <span className="text-danger">{stale} 过期</span>
                    <span>{other} 其他</span>
                    <span className="ml-auto">{total} 条声明</span>
                  </div>
                </Link>
              );
            })}
          </div>
        </Panel>
      </div>

      <div className="mt-4 grid grid-cols-[minmax(0,1fr)] gap-4 xl:grid-cols-[1.6fr_1fr]">
        <Panel>
          <PanelHeader
            title="最近视频"
            description="工程状态与实际镜头同步，点击继续编辑。"
            actions={
              <Link to="/videos" className="text-[11px] text-muted hover:text-accent">
                全部视频 →
              </Link>
            }
          />
          <div className="grid gap-3 border-t border-line p-3 sm:grid-cols-2">
            {sortedVideos.slice(0, 4).map((video) => (
              <VideoCard key={video.id} video={video} />
            ))}
            {sortedVideos.length === 0 ? (
              <div className="col-span-2 px-2 py-6 text-[12px] text-muted">还没有视频工程。</div>
            ) : null}
          </div>
        </Panel>

        <Panel>
          <PanelHeader title="最近活动" description="工作区里的真实操作记录。" />
          <div className="border-t border-line px-4 py-2">
            {latestActivity.map((event) => (
              <ActivityRow key={event.id} event={event} />
            ))}
            {latestActivity.length === 0 ? (
              <div className="py-6 text-center text-[12px] text-faint">还没有活动记录。</div>
            ) : null}
          </div>
        </Panel>
      </div>

      <p className="mt-5 flex flex-wrap items-center gap-x-2 text-[10.5px] text-faint">
        <Info size={11} />
        标注「Demo 数据」的项目与视频为本地模拟；模拟预览、模拟生产与模拟导出不会生成真实媒体文件。
        <button type="button" onClick={() => setCommandOpen(true)} className="text-muted underline-offset-2 hover:text-accent hover:underline">
          搜索全部内容
        </button>
      </p>
    </Page>
  );
}

function nextStep(video: VideoProject): { label: string; to: string } {
  switch (video.stage) {
    case 'review':
      return { label: '审核并提出结论', to: `/videos/${video.id}/review` };
    case 'changes_requested':
      return { label: '继续修改工程', to: `/videos/${video.id}/editor` };
    case 'approved':
    case 'exported':
      return { label: '查看导出记录', to: `/videos/${video.id}/review` };
    case 'producing':
      return { label: '查看生产进度', to: `/videos/${video.id}/production` };
    case 'storyboard_ready':
      return { label: '开始模拟生产', to: `/videos/${video.id}/production` };
    case 'script_review':
      return { label: '继续与 AI 导演确认', to: `/videos/${video.id}/director` };
    default:
      return { label: '打开视频工程', to: `/videos/${video.id}/director` };
  }
}

function VideoCard({ video }: { video: VideoProject }) {
  const projects = useStudioStore((state) => state.projects);
  const features = useStudioStore((state) => state.features);
  const project = projects.find((item) => item.id === video.projectId);
  const scene = orderedScenes(video.scenes).find((item) => item.visualType === 'real_demo') ?? orderedScenes(video.scenes)[0];
  if (!project) return null;
  const feature = scene?.featureId ? features.find((item) => item.id === scene.featureId) : undefined;
  return (
    <Link
      to={`/videos/${video.id}/${video.stage === 'review' ? 'review' : 'editor'}`}
      className="group overflow-hidden rounded-md border border-line bg-ink/40 transition-colors hover:border-line-strong"
    >
      <div className="relative aspect-[16/9] overflow-hidden">
        {scene ? (
          <ScenePreview scene={scene} project={project} feature={feature} aspect={video.brief.aspect} showCaption={false} showChrome={false} />
        ) : null}
        <div className="absolute inset-0 bg-gradient-to-t from-black/55 via-transparent to-transparent" />
        <div className="absolute left-2 top-2">
          <VideoStageBadge stage={video.stage} />
        </div>
        <div className="absolute bottom-2 right-2 rounded-sm bg-black/50 px-1.5 py-0.5 font-mono text-[9.5px] text-white/75 backdrop-blur-sm">
          {formatDuration(totalDuration(video.scenes))}
        </div>
      </div>
      <div className="px-3 py-2.5">
        <div className="truncate text-[12px] font-medium text-fg transition-colors group-hover:text-accent">
          {video.title}
        </div>
        <div className="mt-1 flex items-center justify-between text-[10px] text-faint">
          <span>{project.name}</span>
          <span>{formatRelativeTime(video.updatedAt)}</span>
        </div>
      </div>
    </Link>
  );
}

function ActivityRow({ event }: { event: ActivityEvent }) {
  const icon =
    event.kind === 'knowledge' ? (
      <BookOpen size={13} />
    ) : event.kind === 'production' ? (
      <Workflow size={13} />
    ) : event.kind === 'review' ? (
      <ShieldCheck size={13} />
    ) : event.kind === 'export' ? (
      <ArrowUpRight size={13} />
    ) : event.kind === 'project' ? (
      <FolderKanban size={13} />
    ) : (
      <Clapperboard size={13} />
    );
  return (
    <div className="flex gap-3 py-2.5">
      <span className="mt-0.5 grid size-6 shrink-0 place-items-center rounded-full border border-line bg-raised text-faint">
        {icon}
      </span>
      <div className="min-w-0 flex-1">
        <div className="text-[11.5px] leading-4 text-fg">{event.title}</div>
        {event.detail ? <div className="mt-0.5 line-clamp-2 text-[10.5px] leading-4 text-faint">{event.detail}</div> : null}
      </div>
      <span className="shrink-0 text-[9.5px] text-faint">{formatRelativeTime(event.at)}</span>
    </div>
  );
}
