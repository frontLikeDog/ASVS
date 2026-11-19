import { useMemo, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import type { VideoProject, VideoStage } from '@asvs/domain';
import {
  VIDEO_MODE_INFO,
  formatDuration,
  formatRelativeTime,
  orderedScenes,
  totalDuration,
} from '@asvs/domain';
import {
  ArrowRight,
  Clapperboard,
  Clock3,
  Film,
  ListFilter,
  Pencil,
  Plus,
  Search,
  Sparkles,
  Trash2,
  Video,
} from 'lucide-react';
import {
  Badge,
  Button,
  Dialog,
  DialogContent,
  EmptyState,
  Field,
  Input,
  Page,
  PageHeader,
  Panel,
  ScenePreview,
  VideoStageBadge,
  buttonStyles,
  cn,
} from '@asvs/ui';
import { useStudioStore, useUiStore } from '@asvs/state';
import { useShallow } from 'zustand/react/shallow';
import { NotFoundInline } from './not-found-inline';

const STAGE_FILTERS: { value: 'all' | 'planning' | 'producing' | 'review' | 'approved'; label: string }[] = [
  { value: 'all', label: '全部' },
  { value: 'planning', label: '策划中' },
  { value: 'producing', label: '生产中' },
  { value: 'review', label: '待审核' },
  { value: 'approved', label: '已通过' },
];

export function VideosPage() {
  const { projectId = '' } = useParams();
  const project = useStudioStore((state) => state.projects.find((item) => item.id === projectId));
  const videos = useStudioStore(
    useShallow((state) => state.videos.filter((video) => video.projectId === projectId)),
  );
  const features = useStudioStore(
    useShallow((state) => state.features.filter((item) => item.projectId === projectId)),
  );
  const runs = useStudioStore(
    useShallow((state) => state.runs.filter((run) => run.projectId === projectId)),
  );
  const renameVideo = useStudioStore((state) => state.renameVideo);
  const deleteVideo = useStudioStore((state) => state.deleteVideo);
  const pushToast = useUiStore((state) => state.pushToast);

  const [query, setQuery] = useState('');
  const [stageFilter, setStageFilter] = useState<(typeof STAGE_FILTERS)[number]['value']>('all');
  const [renaming, setRenaming] = useState<VideoProject | null>(null);
  const [renameDraft, setRenameDraft] = useState('');
  const [deleting, setDeleting] = useState<VideoProject | null>(null);

  const filtered = useMemo(() => {
    const term = query.trim().toLowerCase();
    return videos
      .filter((video) => {
        if (stageFilter === 'planning') {
          return ['draft', 'planning', 'script_review', 'storyboard_ready'].includes(video.stage);
        }
        if (stageFilter === 'producing') return video.stage === 'producing';
        if (stageFilter === 'review') return ['review', 'changes_requested'].includes(video.stage);
        if (stageFilter === 'approved') return ['approved', 'exported'].includes(video.stage);
        return true;
      })
      .filter((video) =>
        term ? `${video.title} ${VIDEO_MODE_INFO[video.mode].label}`.toLowerCase().includes(term) : true,
      )
      .sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime());
  }, [videos, query, stageFilter]);

  if (!project) return <NotFoundInline label="项目不存在或已被删除。" />;

  const totalSeconds = videos.reduce((sum, video) => sum + totalDuration(video.scenes), 0);
  const inReview = videos.filter((video) => video.stage === 'review' || video.stage === 'changes_requested').length;
  const approved = videos.filter((video) => video.stage === 'approved' || video.stage === 'exported').length;

  return (
    <Page wide>
      <PageHeader
        eyebrow={
          <>
            <span className="size-1.5 rounded-full bg-accent" />
            {project.name} · Video library
          </>
        }
        title="视频工程"
        description="每条视频都绑定固定的知识快照、脚本版本与生产记录。"
        actions={
          <>
            <Link to={`/projects/${project.id}/knowledge`} className={buttonStyles({ variant: 'ghost' })}>
              查看知识
            </Link>
            <Link to={`/projects/${project.id}/videos/new`} className={buttonStyles({ variant: 'primary' })}>
              <Plus size={14} /> 新建视频
            </Link>
          </>
        }
      />

      <div className="mt-5 grid grid-cols-2 divide-x divide-line rounded-lg border border-line bg-surface/50 sm:grid-cols-4">
        <LibraryStat icon={Film} label="视频工程" value={`${videos.length}`} hint={`${project.name}`} />
        <LibraryStat icon={Clock3} label="总时长" value={formatDuration(totalSeconds)} hint="所有镜头累计" />
        <LibraryStat icon={ListFilter} label="待审核" value={`${inReview}`} hint={inReview > 0 ? '需要你的决定' : '没有积压'} tone={inReview > 0 ? 'warn' : 'default'} />
        <LibraryStat icon={Sparkles} label="已通过" value={`${approved}`} hint={`${runs.filter((run) => run.status === 'succeeded').length} 次成功生产`} tone={approved > 0 ? 'accent' : 'default'} />
      </div>

      <div className="mt-5 flex flex-wrap items-center gap-2">
        <div className="relative min-w-[200px] flex-1 sm:max-w-[300px]">
          <Search size={13} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-faint" />
          <Input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="搜索视频标题或类型…"
            className="h-8 pl-8 text-[12px]"
            aria-label="搜索视频"
          />
        </div>
        <div className="flex flex-wrap gap-1">
          {STAGE_FILTERS.map((item) => (
            <button
              key={item.value}
              type="button"
              onClick={() => setStageFilter(item.value)}
              className={cn(
                'rounded-full border px-2.5 py-1 text-[10.5px] transition-colors',
                stageFilter === item.value
                  ? 'border-accent/40 bg-accent-soft text-accent'
                  : 'border-line text-faint hover:text-fg',
              )}
            >
              {item.label}
            </button>
          ))}
        </div>
        <span className="ml-auto text-[10px] text-faint">{filtered.length} 条结果</span>
      </div>

      {filtered.length === 0 ? (
        <EmptyState
          className="mt-6"
          icon={videos.length === 0 ? <Clapperboard size={22} /> : <Search size={20} />}
          title={videos.length === 0 ? '从第一个视频开始' : '没有匹配的视频'}
          description={
            videos.length === 0
              ? '选择视频类型与目标，AI 导演会基于已核验知识生成可编辑的脚本与分镜。'
              : '换个关键词或阶段筛选试试。'
          }
          action={
            videos.length === 0 ? (
              <Link to={`/projects/${project.id}/videos/new`} className={buttonStyles({ variant: 'primary' })}>
                <Sparkles size={14} /> 创建视频
              </Link>
            ) : (
              <Button variant="secondary" onClick={() => { setQuery(''); setStageFilter('all'); }}>
                清除筛选
              </Button>
            )
          }
        />
      ) : (
        <div className="mt-4 grid gap-4 lg:grid-cols-2 2xl:grid-cols-3">
          {filtered.map((video) => {
            const scenes = orderedScenes(video.scenes);
            const scene =
              scenes.find((item) => item.visualType === 'real_demo') ?? scenes[0];
            const feature = scene?.featureId
              ? features.find((item) => item.id === scene.featureId)
              : undefined;
            const run = runs
              .filter((item) => item.videoId === video.id)
              .sort((a, b) => new Date(b.startedAt).getTime() - new Date(a.startedAt).getTime())[0];
            return (
              <Panel key={video.id} className="group overflow-hidden">
                <Link
                  to={videoRoute(video)}
                  className="relative block aspect-[16/8.5] overflow-hidden border-b border-line bg-ink"
                >
                  {scene ? (
                    <ScenePreview
                      scene={scene}
                      project={project}
                      feature={feature}
                      aspect={video.brief.aspect}
                      showCaption={false}
                      showChrome={false}
                    />
                  ) : (
                    <div className="dot-grid absolute inset-0 grid place-items-center bg-raised">
                      <Clapperboard size={26} className="text-faint" />
                    </div>
                  )}
                  <div className="absolute inset-0 bg-gradient-to-t from-black/70 via-transparent to-black/10" />
                  <div className="absolute inset-x-3 bottom-2.5 flex items-end justify-between gap-2">
                    <div className="flex items-center gap-1.5">
                      <Badge tone="outline" dot={false} className="border-white/20 bg-black/25 text-white/75">
                        {video.brief.aspect}
                      </Badge>
                      <Badge tone="outline" dot={false} className="border-white/20 bg-black/25 text-white/75">
                        {formatDuration(totalDuration(video.scenes))}
                      </Badge>
                      <Badge tone="outline" dot={false} className="border-white/20 bg-black/25 text-white/75">
                        {scenes.length} 镜
                      </Badge>
                    </div>
                    <span className="rounded-sm border border-white/20 bg-black/30 px-1.5 py-0.5 text-[9px] text-white/65">
                      模拟预览
                    </span>
                  </div>
                </Link>
                <div className="p-3.5">
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0">
                      <Link to={videoRoute(video)} className="block truncate text-[13px] font-medium text-fg hover:text-accent">
                        {video.title}
                      </Link>
                      <div className="mt-1 flex flex-wrap items-center gap-2 text-[10px] text-faint">
                        <span>{VIDEO_MODE_INFO[video.mode].label}</span>
                        <span>·</span>
                        <span>v{video.scriptVersion}</span>
                        <span>·</span>
                        <span>{formatRelativeTime(video.updatedAt)}</span>
                      </div>
                    </div>
                    <VideoStageBadge stage={video.stage} />
                  </div>

                  <div className="mt-3 flex items-center gap-2 border-t border-line pt-2.5">
                    <div className="min-w-0 flex-1 text-[10px] text-faint">
                      {run ? (
                        <span className="flex items-center gap-1.5">
                          <span
                            className={cn(
                              'size-1.5 rounded-full',
                              run.status === 'succeeded'
                                ? 'bg-success'
                                : run.status === 'failed'
                                  ? 'bg-danger'
                                  : 'bg-warn',
                            )}
                          />
                          最近生产：{runStatusLabel(run.status)}
                        </span>
                      ) : (
                        <span>还没有生产记录</span>
                      )}
                    </div>
                    <Link to={videoRoute(video)} className={buttonStyles({ variant: 'ghost', size: 'sm' })}>
                      打开 <ArrowRight size={11} />
                    </Link>
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      aria-label="重命名视频"
                      onClick={() => { setRenaming(video); setRenameDraft(video.title); }}
                    >
                      <Pencil size={12} />
                    </Button>
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      aria-label="删除视频"
                      onClick={() => setDeleting(video)}
                    >
                      <Trash2 size={12} />
                    </Button>
                  </div>
                </div>
              </Panel>
            );
          })}

          <Link
            to={`/projects/${project.id}/videos/new`}
            className="flex min-h-[230px] flex-col items-center justify-center rounded-lg border border-dashed border-line-strong text-center transition-colors hover:border-accent/40 hover:bg-accent-soft/20"
          >
            <span className="grid size-9 place-items-center rounded-md border border-line bg-raised text-muted">
              <Plus size={17} />
            </span>
            <span className="mt-2.5 text-[12px] font-medium text-fg">新视频</span>
            <span className="mt-1 max-w-[190px] text-[10.5px] leading-4 text-faint">
              从已核验功能或 Release 开始
            </span>
          </Link>
        </div>
      )}

      <div className="mt-5 flex items-center gap-2 text-[10.5px] text-faint">
        <Video size={11} />
        所有视频画面为 DOM 模拟预览，不会生成真实媒体文件；工程数据会持久化在本机浏览器。
      </div>

      <Dialog open={Boolean(renaming)} onOpenChange={(open) => { if (!open) setRenaming(null); }}>
        <DialogContent
          title="重命名视频"
          description="改名不会改变脚本、镜头或审核状态。"
          size="sm"
          footer={
            <>
              <Button variant="ghost" onClick={() => setRenaming(null)}>取消</Button>
              <Button
                variant="primary"
                disabled={!renameDraft.trim()}
                onClick={() => {
                  if (!renaming) return;
                  renameVideo(renaming.id, renameDraft.trim());
                  setRenaming(null);
                  pushToast({ tone: 'success', title: '视频已重命名', description: renameDraft.trim() });
                }}
              >
                保存名称
              </Button>
            </>
          }
        >
          <Field label="视频标题" required>
            <Input
              value={renameDraft}
              onChange={(event) => setRenameDraft(event.target.value)}
              autoFocus
              maxLength={80}
              onKeyDown={(event) => {
                if (event.key === 'Enter' && renameDraft.trim() && renaming) {
                  renameVideo(renaming.id, renameDraft.trim());
                  setRenaming(null);
                  pushToast({ tone: 'success', title: '视频已重命名' });
                }
              }}
            />
          </Field>
        </DialogContent>
      </Dialog>

      <Dialog open={Boolean(deleting)} onOpenChange={(open) => { if (!open) setDeleting(null); }}>
        <DialogContent
          title="删除这条视频？"
          description="脚本、分镜与本地历史会一起删除。知识库不受影响。"
          size="sm"
          footer={
            <>
              <Button variant="ghost" onClick={() => setDeleting(null)}>保留视频</Button>
              <Button
                variant="danger"
                onClick={() => {
                  if (!deleting) return;
                  deleteVideo(deleting.id);
                  pushToast({ tone: 'info', title: '视频已删除', description: deleting.title });
                  setDeleting(null);
                }}
              >
                确认删除
              </Button>
            </>
          }
        >
          <div className="rounded-md border border-danger/20 bg-danger-soft/40 px-3 py-2.5 text-[11.5px] text-muted">
            <div className="font-medium text-fg">{deleting?.title}</div>
            <div className="mt-1 text-[10.5px] text-faint">
              {deleting ? `${deleting.scenes.length} 个镜头 · v${deleting.scriptVersion}` : ''}
            </div>
          </div>
        </DialogContent>
      </Dialog>
    </Page>
  );
}

function LibraryStat({
  icon: Icon,
  label,
  value,
  hint,
  tone = 'default',
}: {
  icon: typeof Film;
  label: string;
  value: string;
  hint: string;
  tone?: 'default' | 'warn' | 'accent';
}) {
  return (
    <div className="flex items-start gap-2.5 p-3.5">
      <span
        className={cn(
          'mt-0.5 grid size-7 shrink-0 place-items-center rounded-sm border',
          tone === 'warn'
            ? 'border-warn/25 bg-warn-soft text-warn'
            : tone === 'accent'
              ? 'border-accent/25 bg-accent-soft text-accent'
              : 'border-line bg-overlay text-faint',
        )}
      >
        <Icon size={13} />
      </span>
      <div className="min-w-0">
        <div className="text-[9.5px] uppercase tracking-wide text-faint">{label}</div>
        <div className="font-display text-[18px] leading-6 text-fg">{value}</div>
        <div className="truncate text-[9.5px] text-faint">{hint}</div>
      </div>
    </div>
  );
}

function videoRoute(video: VideoProject): string {
  const stage: VideoStage = video.stage;
  if (['draft', 'planning', 'script_review'].includes(stage)) return `/videos/${video.id}/director`;
  if (stage === 'storyboard_ready') return `/videos/${video.id}/storyboard`;
  if (stage === 'producing') return `/videos/${video.id}/production`;
  return `/videos/${video.id}/review`;
}

function runStatusLabel(status: string): string {
  if (status === 'succeeded') return '成功';
  if (status === 'failed') return '失败，可重试';
  if (status === 'awaiting_approval') return '等待人工确认';
  if (status === 'running') return '运行中';
  if (status === 'paused') return '已暂停';
  if (status === 'cancelled') return '已取消';
  return status;
}
