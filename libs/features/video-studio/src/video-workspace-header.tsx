import { useState } from 'react';
import { Link } from 'react-router-dom';
import type { Project, VideoProject } from '@asvs/domain';
import { VIDEO_MODE_INFO, formatRelativeTime, totalDuration } from '@asvs/domain';
import {
  ArrowLeft,
  Clapperboard,
  Film,
  GitBranch,
  Pencil,
  Play,
  ScrollText,
  ShieldCheck,
  Workflow,
} from 'lucide-react';
import {
  Badge,
  Button,
  DemoBadge,
  Field,
  Input,
  Dialog,
  DialogContent,
  VideoStageBadge,
  cn,
} from '@asvs/ui';
import { useStudioStore, useUiStore } from '@asvs/state';

export type VideoWorkspaceTab = 'director' | 'storyboard' | 'editor' | 'production' | 'review';

const TABS: { key: VideoWorkspaceTab; label: string; icon: typeof Play; hint: string }[] = [
  { key: 'director', label: 'AI 导演', icon: ScrollText, hint: '目标与脚本' },
  { key: 'storyboard', label: '分镜工作室', icon: Clapperboard, hint: '镜头与顺序' },
  { key: 'editor', label: '视频编辑器', icon: Play, hint: '时间线与字幕' },
  { key: 'production', label: '生产监控', icon: Workflow, hint: '模拟 DAG' },
  { key: 'review', label: '审核与导出', icon: ShieldCheck, hint: '检查与交付' },
];

export function VideoWorkspaceHeader({
  video,
  project,
  active,
  actions,
}: {
  video: VideoProject;
  project: Project;
  active: VideoWorkspaceTab;
  actions?: React.ReactNode;
}) {
  const renameVideo = useStudioStore((state) => state.renameVideo);
  const pushToast = useUiStore((state) => state.pushToast);
  const [renaming, setRenaming] = useState(false);
  const [title, setTitle] = useState(video.title);

  const meta = VIDEO_MODE_INFO[video.mode];

  return (
    <>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[10.5px] text-faint">
        <Link to={`/projects/${project.id}/videos`} className="flex items-center gap-1 hover:text-accent">
          <ArrowLeft size={11} />
          {project.name}
        </Link>
        <span className="text-line-strong">/</span>
        <span className="flex items-center gap-1">
          <Film size={11} />
          视频工程
        </span>
        <span className="text-line-strong">/</span>
        <span className="font-mono text-[9.5px]">{video.id}</span>
        <DemoBadge className="ml-1" />
      </div>

      <div className="mt-2 flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              className="group flex min-w-0 items-center gap-2 text-left"
              onClick={() => { setTitle(video.title); setRenaming(true); }}
              title="重命名视频"
            >
              <h1 className="truncate font-display text-[24px] font-medium leading-8 tracking-[-0.025em] text-fg">
                {video.title}
              </h1>
              <Pencil size={12} className="shrink-0 text-faint opacity-0 transition-opacity group-hover:opacity-100" />
            </button>
            <VideoStageBadge stage={video.stage} />
          </div>
          <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-[10.5px] text-muted">
            <span>{meta.label}</span>
            <span>·</span>
            <span className="font-mono">v{video.scriptVersion}</span>
            <span>·</span>
            <span>{video.brief.aspect}</span>
            <span>·</span>
            <span>{totalDuration(video.scenes)} 秒</span>
            <span>·</span>
            <span className="flex items-center gap-1">
              <GitBranch size={10} />
              {project.sources[0]?.scope ?? 'main'}
            </span>
            <span>·</span>
            <span>更新于 {formatRelativeTime(video.updatedAt)}</span>
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {actions}
          <Badge tone="outline" dot={false}>{video.scenes.length} 个镜头</Badge>
        </div>
      </div>

      <nav aria-label="视频工程阶段" className="mt-4 flex gap-1 overflow-x-auto border-b border-line pb-0">
        {TABS.map((tab) => {
          const Icon = tab.icon;
          const isActive = active === tab.key;
          return (
            <Link
              key={tab.key}
              to={`/videos/${video.id}/${tab.key}`}
              aria-current={isActive ? 'page' : undefined}
              className={cn(
                'group relative flex shrink-0 items-center gap-2 rounded-t-sm px-3 py-2.5 text-[11.5px] transition-colors',
                isActive
                  ? 'text-fg after:absolute after:inset-x-2 after:bottom-0 after:h-[2px] after:rounded-full after:bg-accent'
                  : 'text-faint hover:bg-overlay/40 hover:text-muted',
              )}
            >
              <Icon size={13} className={isActive ? 'text-accent' : ''} />
              <span className="font-medium">{tab.label}</span>
              <span className="hidden text-[9px] text-faint lg:inline">{tab.hint}</span>
            </Link>
          );
        })}
      </nav>

      <Dialog open={renaming} onOpenChange={setRenaming}>
        <DialogContent
          title="重命名视频"
          size="sm"
          footer={
            <>
              <Button variant="ghost" onClick={() => setRenaming(false)}>取消</Button>
              <Button
                variant="primary"
                disabled={!title.trim()}
                onClick={() => {
                  renameVideo(video.id, title.trim());
                  setRenaming(false);
                  pushToast({ tone: 'success', title: '视频已重命名' });
                }}
              >
                保存
              </Button>
            </>
          }
        >
          <Field label="视频标题" required>
            <Input value={title} maxLength={80} onChange={(event) => setTitle(event.target.value)} autoFocus />
          </Field>
        </DialogContent>
      </Dialog>
    </>
  );
}
