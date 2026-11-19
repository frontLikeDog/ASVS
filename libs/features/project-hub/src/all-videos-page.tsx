import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import type { Feature, Project, VideoProject } from '@asvs/domain';
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
  Plus,
  Search,
  ShieldCheck,
  Sparkles,
  Video,
} from 'lucide-react';
import {
  Badge,
  EmptyState,
  Input,
  Page,
  PageHeader,
  Panel,
  ScenePreview,
  Select,
  VideoStageBadge,
  buttonStyles,
  cn,
} from '@asvs/ui';
import { useStudioStore } from '@asvs/state';

type StageFilter = 'all' | 'planning' | 'producing' | 'review' | 'approved';

const STAGE_FILTERS: { value: StageFilter; label: string }[] = [
  { value: 'all', label: '全部' },
  { value: 'planning', label: '策划中' },
  { value: 'producing', label: '生产中' },
  { value: 'review', label: '待审核' },
  { value: 'approved', label: '已通过' },
];

export function AllVideosPage() {
  const projects = useStudioStore((state) => state.projects);
  const videos = useStudioStore((state) => state.videos);
  const features = useStudioStore((state) => state.features);
  const runs = useStudioStore((state) => state.runs);
  const [query, setQuery] = useState('');
  const [projectFilter, setProjectFilter] = useState('all');
  const [stageFilter, setStageFilter] = useState<StageFilter>('all');
  const [newVideoProjectId, setNewVideoProjectId] = useState(projects[0]?.id ?? '');

  const filtered = useMemo(() => {
    const term = query.trim().toLowerCase();
    return [...videos]
      .filter((video) => (projectFilter === 'all' ? true : video.projectId === projectFilter))
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
        term
          ? `${video.title} ${video.brief.objective} ${video.brief.audience}`.toLowerCase().includes(term)
          : true,
      )
      .sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime());
  }, [videos, query, projectFilter, stageFilter]);

  const inReview = videos.filter((video) => ['review', 'changes_requested'].includes(video.stage)).length;
  const approved = videos.filter((video) => ['approved', 'exported'].includes(video.stage)).length;
  const totalSeconds = videos.reduce((sum, video) => sum + totalDuration(video.scenes), 0);

  return (
    <Page wide>
      <PageHeader
        eyebrow={
          <>
            <span className="size-1.5 rounded-full bg-accent" />
            Workspace · {videos.length} 个视频工程
          </>
        }
        title="视频库"
        description="跨项目查看所有脚本、分镜、生产状态与审核结果。"
        actions={
          <div className="flex flex-wrap items-center gap-2">
            <Select
              value={newVideoProjectId}
              onChange={(event) => setNewVideoProjectId(event.target.value)}
              wrapperClassName="w-[160px]"
              aria-label="选择新建视频的项目"
              className="h-8 text-[11px]"
            >
              {projects.map((project) => (
                <option key={project.id} value={project.id}>
                  {project.name}
                </option>
              ))}
            </Select>
            <Link
              to={newVideoProjectId ? `/projects/${newVideoProjectId}/videos/new` : '/onboarding'}
              className={buttonStyles({ variant: 'primary' })}
            >
              <Plus size={14} /> 新建视频
            </Link>
          </div>
        }
      />

      <div className="mt-5 grid grid-cols-2 divide-x divide-line rounded-lg border border-line bg-surface/50 sm:grid-cols-4">
        <Stat icon={Film} label="视频工程" value={`${videos.length}`} hint={`${projects.length} 个项目`} />
        <Stat icon={Clock3} label="总时长" value={formatDuration(totalSeconds)} hint="所有镜头累计" />
        <Stat icon={ShieldCheck} label="待审核" value={`${inReview}`} hint="含退回修改" tone={inReview > 0 ? 'warn' : 'default'} />
        <Stat icon={Sparkles} label="已通过" value={`${approved}`} hint={`${runs.filter((run) => run.status === 'succeeded').length} 次成功生产`} tone={approved > 0 ? 'accent' : 'default'} />
      </div>

      <div className="mt-5 flex flex-wrap items-center gap-2">
        <div className="relative min-w-[200px] flex-1 sm:max-w-[280px]">
          <Search size={13} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-faint" />
          <Input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="搜索标题、目标或受众…"
            className="h-8 pl-8 text-[12px]"
            aria-label="搜索视频"
          />
        </div>
        <Select
          value={projectFilter}
          onChange={(event) => setProjectFilter(event.target.value)}
          wrapperClassName="w-[160px]"
          className="h-8 text-[11px]"
          aria-label="按项目筛选"
        >
          <option value="all">全部项目</option>
          {projects.map((project) => (
            <option key={project.id} value={project.id}>
              {project.name}
            </option>
          ))}
        </Select>
        <div className="flex flex-wrap gap-1">
          {STAGE_FILTERS.map((filter) => (
            <button
              key={filter.value}
              type="button"
              onClick={() => setStageFilter(filter.value)}
              className={cn(
                'rounded-full border px-2.5 py-1 text-[10.5px] transition-colors',
                stageFilter === filter.value
                  ? 'border-accent/40 bg-accent-soft text-accent'
                  : 'border-line text-faint hover:text-fg',
              )}
            >
              {filter.label}
            </button>
          ))}
        </div>
        <span className="ml-auto text-[10px] text-faint">{filtered.length} 条结果</span>
      </div>

      {filtered.length === 0 ? (
        <EmptyState
          className="mt-6"
          icon={<Clapperboard size={22} />}
          title={videos.length === 0 ? '还没有视频工程' : '没有匹配的视频'}
          description={
            videos.length === 0
              ? '从某个项目的知识中心或视频工程页创建第一条视频。'
              : '调整项目、阶段或搜索关键词。'
          }
          action={
            videos.length === 0 ? (
              <Link to="/projects" className={buttonStyles({ variant: 'primary' })}>
                选择项目 <ArrowRight size={13} />
              </Link>
            ) : (
              <button
                type="button"
                className={buttonStyles({ variant: 'secondary' })}
                onClick={() => { setQuery(''); setProjectFilter('all'); setStageFilter('all'); }}
              >
                清除筛选
              </button>
            )
          }
        />
      ) : (
        <Panel className="mt-4 overflow-hidden">
          <div className="hidden items-center gap-3 border-b border-line px-4 py-2 text-[9px] uppercase tracking-wide text-faint md:flex">
            <span className="w-[104px]">Preview</span>
            <span className="min-w-0 flex-1">视频 / 项目</span>
            <span className="w-[92px]">类型</span>
            <span className="w-[80px]">时长</span>
            <span className="w-[108px]">阶段</span>
            <span className="w-[86px]">更新</span>
            <span className="w-[72px]" />
          </div>
          <div className="divide-y divide-line">
            {filtered.map((video) => (
              <VideoRow
                key={video.id}
                video={video}
                projectName={projects.find((project) => project.id === video.projectId)?.name ?? '未知项目'}
                projects={projects}
                features={features}
              />
            ))}
          </div>
        </Panel>
      )}

      <div className="mt-4 flex items-center gap-2 text-[10px] text-faint">
        <Video size={11} />
        所有预览为 DOM 模拟；审核通过的视频才可导出，媒体导出仍为模拟状态。
      </div>
    </Page>
  );
}

function VideoRow({
  video,
  projectName,
  projects,
  features,
}: {
  video: VideoProject;
  projectName: string;
  projects: Project[];
  features: Feature[];
}) {
  const project = projects.find((item) => item.id === video.projectId);
  const scenes = orderedScenes(video.scenes);
  const scene = scenes.find((item) => item.visualType === 'real_demo') ?? scenes[0];
  const feature = scene?.featureId ? features.find((item) => item.id === scene.featureId) : undefined;

  if (!project) return null;

  return (
    <div className="flex flex-wrap items-center gap-3 px-4 py-3 md:flex-nowrap">
      <Link
        to={stageRoute(video)}
        className="relative w-[104px] shrink-0 overflow-hidden rounded-sm border border-line bg-ink"
      >
        <div className="aspect-video">
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
            <div className="grid h-full place-items-center text-faint"><Film size={16} /></div>
          )}
        </div>
      </Link>
      <div className="min-w-0 flex-1">
        <Link to={stageRoute(video)} className="block truncate text-[12px] font-medium text-fg hover:text-accent">
          {video.title}
        </Link>
        <div className="mt-0.5 flex flex-wrap items-center gap-1.5 text-[9.5px] text-faint">
          <span>{projectName}</span>
          <span>·</span>
          <span className="font-mono">v{video.scriptVersion}</span>
          <span>·</span>
          <span>{video.brief.aspect}</span>
          <span>·</span>
          <span>{video.scenes.length} 镜</span>
        </div>
      </div>
      <span className="hidden w-[92px] shrink-0 text-[10px] text-muted md:block">
        {VIDEO_MODE_INFO[video.mode].shortLabel}
      </span>
      <span className="hidden w-[80px] shrink-0 font-mono text-[10px] text-muted md:block">
        {totalDuration(video.scenes)}s
      </span>
      <span className="w-[108px] shrink-0">
        <VideoStageBadge stage={video.stage} />
      </span>
      <span className="hidden w-[86px] shrink-0 text-[9.5px] text-faint md:block">
        {formatRelativeTime(video.updatedAt)}
      </span>
      <Link to={stageRoute(video)} className={buttonStyles({ variant: 'ghost', size: 'sm', className: 'shrink-0' })}>
        打开 <ArrowRight size={10} />
      </Link>
      <Badge tone="outline" dot={false} className="md:hidden">{VIDEO_MODE_INFO[video.mode].shortLabel}</Badge>
    </div>
  );
}

function Stat({
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

function stageRoute(video: VideoProject): string {
  if (['draft', 'planning', 'script_review'].includes(video.stage)) return `/videos/${video.id}/director`;
  if (video.stage === 'storyboard_ready') return `/videos/${video.id}/storyboard`;
  if (video.stage === 'producing') return `/videos/${video.id}/production`;
  return `/videos/${video.id}/review`;
}
