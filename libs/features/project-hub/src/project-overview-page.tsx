import { Link, useParams } from 'react-router-dom';
import { formatDate, formatRelativeTime, orderedScenes, totalDuration } from '@asvs/domain';
import {
  ArrowRight,
  BookOpen,
  Clapperboard,
  ExternalLink,
  GitPullRequest,
  Globe2,
  Library,
  Link2,
  Plus,
  RefreshCw,
  ShieldCheck,
  Sparkles,
  Workflow,
} from 'lucide-react';
import {
  Badge,
  BrandMark,
  Button,
  Callout,
  DemoBadge,
  EmptyState,
  FeatureStatusBadge,
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
import { useShallow } from 'zustand/react/shallow';
import { NotFoundInline } from './not-found-inline';

export function ProjectOverviewPage() {
  const { projectId = '' } = useParams();
  const project = useStudioStore((state) => state.projects.find((item) => item.id === projectId));
  const features = useStudioStore(
    useShallow((state) => state.features.filter((item) => item.projectId === projectId)),
  );
  const claims = useStudioStore(
    useShallow((state) => state.claims.filter((item) => item.projectId === projectId)),
  );
  const suggestions = useStudioStore(
    useShallow((state) => state.suggestions.filter((item) => item.projectId === projectId)),
  );
  const videos = useStudioStore(
    useShallow((state) =>
      state.videos
        .filter((item) => item.projectId === projectId)
        .sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime()),
    ),
  );
  const runs = useStudioStore(
    useShallow((state) => state.runs.filter((run) => run.projectId === projectId)),
  );
  const exports = useStudioStore(
    useShallow((state) => state.exports.filter((item) => item.projectId === projectId)),
  );
  const pullRequests = useStudioStore(
    useShallow((state) => state.pullRequests.filter((item) => item.projectId === projectId)),
  );
  const releases = useStudioStore(
    useShallow((state) => state.releases.filter((item) => item.projectId === projectId)),
  );
  const syncProjectKnowledge = useStudioStore((state) => state.syncProjectKnowledge);
  const pushToast = useUiStore((state) => state.pushToast);

  if (!project) return <NotFoundInline label="项目不存在或已被删除。" />;

  const verified = claims.filter((claim) => claim.status === 'verified').length;
  const stale = claims.filter((claim) => claim.status === 'stale').length;
  const pending = suggestions.filter((suggestion) => suggestion.status === 'pending');
  const successRuns = runs.filter((run) => run.status === 'succeeded');
  const approved = videos.filter((video) => ['approved', 'exported'].includes(video.stage));
  const latestVideo = videos[0];
  const latestScene = latestVideo
    ? orderedScenes(latestVideo.scenes).find((scene) => scene.visualType === 'real_demo') ??
      orderedScenes(latestVideo.scenes)[0]
    : undefined;

  const stages = [
    {
      key: 'knowledge',
      label: '知识',
      value: `${features.length} 个功能`,
      hint: `${verified}/${claims.length} 条声明已核验`,
      to: `/projects/${project.id}/knowledge`,
      done: features.length > 0,
      icon: BookOpen,
    },
    {
      key: 'plan',
      label: '策划',
      value: `${videos.length} 个视频`,
      hint: 'Brief、脚本与分镜',
      to: `/projects/${project.id}/videos`,
      done: videos.length > 0,
      icon: Sparkles,
    },
    {
      key: 'produce',
      label: '生产',
      value: `${successRuns.length} 次成功`,
      hint: `${runs.filter((run) => run.status === 'failed').length} 次失败运行`,
      to: latestVideo ? `/videos/${latestVideo.id}/production` : `/projects/${project.id}/videos`,
      done: successRuns.length > 0,
      icon: Workflow,
    },
    {
      key: 'review',
      label: '审核',
      value: `${approved.length} 条通过`,
      hint: `${videos.filter((video) => video.stage === 'review').length} 条待审核`,
      to: latestVideo ? `/videos/${latestVideo.id}/review` : `/projects/${project.id}/videos`,
      done: approved.length > 0,
      icon: ShieldCheck,
    },
    {
      key: 'export',
      label: '导出',
      value: `${exports.filter((item) => item.status === 'completed').length} 条记录`,
      hint: '仅 JSON / SRT 为真实文件',
      to: latestVideo ? `/videos/${latestVideo.id}/review` : `/projects/${project.id}/videos`,
      done: exports.some((item) => item.status === 'completed'),
      icon: Library,
    },
  ];

  const handleSync = async () => {
    const result = await syncProjectKnowledge(project.id);
    pushToast({
      tone: 'success',
      title: '模拟同步完成',
      description: result?.message ?? '知识快照已更新。',
    });
  };

  return (
    <Page wide>
      <PageHeader
        eyebrow={
          <>
            <span className="size-1.5 rounded-full bg-accent" />
            Project · {project.demo ? 'Demo 工作区' : '工作区'}
          </>
        }
        title={
          <span className="flex items-center gap-3">
            <span
              className="grid size-10 place-items-center rounded-md border border-line bg-surface"
              style={{ color: project.brand.primary }}
            >
              <BrandMark mark={project.brand.logoMark} size={22} />
            </span>
            {project.name}
          </span>
        }
        description={project.description || '还没有项目描述。'}
        actions={
          <>
            <Link to={`/projects/${project.id}/settings`} className={buttonStyles({ variant: 'ghost' })}>
              品牌与设置
            </Link>
            <Link to={`/projects/${project.id}/knowledge`} className={buttonStyles({ variant: 'secondary' })}>
              <BookOpen size={14} />
              知识中心
            </Link>
            <Link to={`/projects/${project.id}/videos/new`} className={buttonStyles({ variant: 'primary' })}>
              <Plus size={14} />
              新建视频
            </Link>
          </>
        }
      />

      <div className="mt-4 flex flex-wrap items-center gap-x-4 gap-y-2 text-[11.5px] text-muted">
        <span className="flex items-center gap-1.5">
          <span className="size-1.5 rounded-full" style={{ background: project.brand.primary }} />
          {project.productName}
        </span>
        {project.website ? (
          <a
            href={project.website}
            target="_blank"
            rel="noreferrer"
            className="flex items-center gap-1.5 hover:text-accent"
          >
            <Globe2 size={12} />
            {project.website.replace(/^https?:\/\//, '')}
            <ExternalLink size={10} />
          </a>
        ) : null}
        <span>创建于 {formatDate(project.createdAt)}</span>
        <DemoBadge />
        <span className="ml-auto flex items-center gap-1.5 text-[10.5px] text-faint">
          <RefreshCw size={11} />
          最近同步 {project.sources[0]?.lastSyncedAt ? formatRelativeTime(project.sources[0].lastSyncedAt) : '尚未'}
        </span>
      </div>

      {pending.length > 0 ? (
        <Callout
          tone="ai"
          className="mt-4"
          title={`知识中心有 ${pending.length} 条待确认建议`}
          action={
            <Link
              to={`/projects/${project.id}/knowledge`}
              className={buttonStyles({ variant: 'ghost', size: 'sm', className: 'text-ai' })}
            >
              去确认 <ArrowRight size={11} />
            </Link>
          }
        >
          模拟 AI 建议不会自动写入知识库。接受前请检查依据与影响的视频。
        </Callout>
      ) : null}

      {stale > 0 ? (
        <Callout tone="warning" className="mt-2" title={`${stale} 条声明证据已过期`}>
          使用这些声明的视频会在审核阶段被阻断，需要在知识中心重新验证。
        </Callout>
      ) : null}

      <div className="mt-4 grid grid-cols-[minmax(0,1fr)] gap-4 xl:grid-cols-[1.55fr_1fr]">
        <Panel>
          <PanelHeader
            title="从知识到成片的当前进度"
            description="点任意阶段回到对应上下文；阶段状态来自真实的前端数据。"
            actions={
              <Button variant="ghost" size="sm" icon={<RefreshCw size={12} />} onClick={handleSync}>
                模拟同步
              </Button>
            }
          />
          <div className="grid grid-cols-1 divide-y divide-line border-t border-line sm:grid-cols-5 sm:divide-x sm:divide-y-0">
            {stages.map((stage, index) => (
              <Link
                key={stage.key}
                to={stage.to}
                className="group relative flex flex-col gap-2 p-4 transition-colors hover:bg-overlay/40"
              >
                <div className="flex items-center justify-between">
                  <span className="font-mono text-[9.5px] text-faint">0{index + 1}</span>
                  <span
                    className={cn(
                      'grid size-6 place-items-center rounded-full border',
                      stage.done
                        ? 'border-success/30 bg-success-soft text-success'
                        : 'border-line bg-raised text-faint',
                    )}
                  >
                    <stage.icon size={12} />
                  </span>
                </div>
                <div className="text-[11px] font-medium text-fg">{stage.label}</div>
                <div className="font-display text-[14px] text-fg">{stage.value}</div>
                <div className="text-[10px] leading-4 text-faint">{stage.hint}</div>
              </Link>
            ))}
          </div>
          {latestVideo && latestScene ? (
            <div className="border-t border-line p-3">
              <div className="flex items-center gap-3 rounded-md border border-line bg-ink/50 p-2">
                <div className="relative w-[164px] shrink-0 overflow-hidden rounded-sm border border-line">
                  <div className="aspect-[16/9]">
                    <ScenePreview
                      scene={latestScene}
                      project={project}
                      aspect="16:9"
                      showCaption={false}
                      showChrome={false}
                    />
                  </div>
                </div>
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <VideoStageBadge stage={latestVideo.stage} />
                    <span className="font-mono text-[9.5px] text-faint">
                      {totalDuration(latestVideo.scenes)}s · {latestVideo.scenes.length} 镜
                    </span>
                  </div>
                  <div className="mt-1.5 truncate text-[12px] font-medium text-fg">{latestVideo.title}</div>
                  <div className="mt-0.5 truncate text-[10.5px] text-faint">
                    最近更新 {formatRelativeTime(latestVideo.updatedAt)}
                  </div>
                </div>
                <Link
                  to={`/videos/${latestVideo.id}/director`}
                  className={buttonStyles({ variant: 'ghost', size: 'sm' })}
                >
                  打开 <ArrowRight size={11} />
                </Link>
              </div>
            </div>
          ) : null}
        </Panel>

        <Panel>
          <PanelHeader
            title="知识快照"
            description="来源、状态与人工确认共同决定声明是否可发布。"
            actions={
              <Link to={`/projects/${project.id}/knowledge`} className="text-[11px] text-muted hover:text-accent">
                管理 →
              </Link>
            }
          />
          <div className="space-y-2 border-t border-line p-3">
            {project.sources.map((source) => (
              <div
                key={source.id}
                className="flex items-center gap-2.5 rounded-md border border-line bg-raised/30 px-2.5 py-2"
              >
                <span className="grid size-6 shrink-0 place-items-center rounded-sm border border-line bg-overlay text-faint">
                  {source.kind === 'github' ? (
                    <GitPullRequest size={12} />
                  ) : source.kind === 'website' ? (
                    <Globe2 size={12} />
                  ) : (
                    <Link2 size={12} />
                  )}
                </span>
                <div className="min-w-0 flex-1">
                  <div className="truncate text-[11.5px] text-fg">{source.name}</div>
                  <div className="truncate text-[9.5px] text-faint">
                    {source.scope ?? source.detail}
                  </div>
                </div>
                <Badge tone={source.status === 'connected' ? 'success' : 'warn'} dot={false}>
                  {source.status === 'connected' ? '已连接' : source.status === 'error' ? '异常' : source.status}
                </Badge>
              </div>
            ))}
          </div>
          <div className="border-t border-line px-4 py-3">
            <div className="flex items-center justify-between text-[10.5px] text-faint">
              <span>功能目录</span>
              <span>{features.length} 个</span>
            </div>
            <div className="mt-2 space-y-1.5">
              {features.slice(0, 4).map((feature) => (
                <Link
                  key={feature.id}
                  to={`/projects/${project.id}/knowledge?feature=${feature.id}`}
                  className="flex items-center justify-between gap-2 rounded-sm px-1 py-1.5 text-[11.5px] transition-colors hover:bg-overlay/60"
                >
                  <span className="truncate text-muted">{feature.name}</span>
                  <FeatureStatusBadge status={feature.status} />
                </Link>
              ))}
            </div>
          </div>
        </Panel>
      </div>

      <div className="mt-4 grid grid-cols-[minmax(0,1fr)] gap-4 xl:grid-cols-[1.55fr_1fr]">
        <Panel>
          <PanelHeader
            title="视频工程"
            description="所有镜头与状态都在同一个工程模型里。"
            actions={
              <Link to={`/projects/${project.id}/videos`} className="text-[11px] text-muted hover:text-accent">
                管理全部 →
              </Link>
            }
          />
          <div className="divide-y divide-line border-t border-line">
            {videos.length === 0 ? (
              <EmptyState
                compact
                className="border-0"
                icon={<Clapperboard size={18} />}
                title="还没有视频工程"
                description="从已核验的功能开始，AI 导演会和你确认脚本后生成分镜。"
                action={
                  <Link to={`/projects/${project.id}/videos/new`} className={buttonStyles({ variant: 'primary', size: 'sm' })}>
                    <Plus size={13} /> 新建视频
                  </Link>
                }
              />
            ) : (
              videos.map((video) => (
                <div key={video.id} className="flex items-center gap-3 px-4 py-3">
                  <span className="font-mono text-[9.5px] text-faint">
                    {String(video.scenes.length).padStart(2, '0')}
                  </span>
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-[12px] font-medium text-fg">{video.title}</div>
                    <div className="mt-0.5 text-[10px] text-faint">
                      {totalDuration(video.scenes)}s · v{video.scriptVersion} · {formatRelativeTime(video.updatedAt)}
                    </div>
                  </div>
                  <VideoStageBadge stage={video.stage} />
                  <Link
                    to={`/videos/${video.id}/${video.stage === 'review' ? 'review' : 'director'}`}
                    className={buttonStyles({ variant: 'ghost', size: 'sm' })}
                  >
                    打开 <ArrowRight size={11} />
                  </Link>
                </div>
              ))
            )}
          </div>
        </Panel>

        <Panel>
          <PanelHeader
            title="合并记录与 Release"
            description="内部改动不建议对外宣传。"
            actions={<Badge tone="outline" dot={false}>{pullRequests.length} PR</Badge>}
          />
          <div className="divide-y divide-line border-t border-line">
            {pullRequests.slice(0, 4).map((pr) => (
              <div key={pr.id} className="px-4 py-2.5">
                <div className="flex items-center gap-2">
                  <span className="font-mono text-[10px] text-faint">#{pr.number}</span>
                  <span className="truncate text-[11.5px] text-fg">{pr.title}</span>
                  {pr.kind === 'internal' ? (
                    <Badge tone="warn" className="ml-auto shrink-0">
                      内部
                    </Badge>
                  ) : null}
                </div>
                <div className="mt-0.5 text-[9.5px] text-faint">
                  {pr.author} · {formatDate(pr.mergedAt)}
                </div>
              </div>
            ))}
            {releases[0] ? (
              <div className="px-4 py-2.5">
                <div className="flex items-center gap-2 text-[11px] text-muted">
                  <TagIcon />
                  {releases[0].version} · {releases[0].name}
                </div>
                <p className="mt-1 text-[10.5px] leading-4 text-faint">{releases[0].highlight}</p>
              </div>
            ) : null}
            {pullRequests.length === 0 ? (
              <div className="px-4 py-6 text-center text-[11px] text-faint">
                该项目没有 GitHub 合并记录。
              </div>
            ) : null}
          </div>
        </Panel>
      </div>
    </Page>
  );
}

function TagIcon() {
  return (
    <span className="grid size-4 place-items-center rounded-sm border border-line text-[8px] text-faint">
      R
    </span>
  );
}
