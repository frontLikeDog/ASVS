import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  BookOpen,
  Clapperboard,
  Film,
  FolderKanban,
  LayoutDashboard,
  Plus,
  Search,
  Sparkles,
} from 'lucide-react';
import { Dialog, DialogContent, cn } from '@asvs/ui';
import { useStudioStore, useUiStore } from '@asvs/state';

interface Command {
  id: string;
  label: string;
  hint?: string;
  group: string;
  icon: ReactNode;
  to: string;
  keywords: string;
}

export function CommandPalette() {
  const navigate = useNavigate();
  const open = useUiStore((state) => state.commandOpen);
  const setOpen = useUiStore((state) => state.setCommandOpen);
  const projects = useStudioStore((state) => state.projects);
  const features = useStudioStore((state) => state.features);
  const videos = useStudioStore((state) => state.videos);
  const lastProjectId = useUiStore((state) => state.lastProjectId);
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);

  const currentProject =
    projects.find((project) => project.id === lastProjectId) ?? projects[0];

  const commands = useMemo<Command[]>(() => {
    const items: Command[] = [
      {
        id: 'nav-dashboard',
        label: '概览',
        group: '页面',
        icon: <LayoutDashboard size={15} />,
        to: '/',
        keywords: 'dashboard 工作台 首页',
      },
      {
        id: 'nav-projects',
        label: '全部项目',
        group: '页面',
        icon: <FolderKanban size={15} />,
        to: '/projects',
        keywords: 'projects 项目',
      },
      {
        id: 'nav-videos',
        label: '视频库',
        group: '页面',
        icon: <Film size={15} />,
        to: '/videos',
        keywords: 'videos 视频 成片',
      },
      {
        id: 'action-new-project',
        label: '新建视频项目',
        hint: '六步入门',
        group: '操作',
        icon: <Plus size={15} />,
        to: '/onboarding',
        keywords: 'new project onboarding 新建 项目',
      },
    ];
    if (currentProject) {
      items.push(
        {
          id: 'action-knowledge',
          label: '打开知识中心',
          hint: currentProject.name,
          group: '操作',
          icon: <BookOpen size={15} />,
          to: `/projects/${currentProject.id}/knowledge`,
          keywords: 'knowledge 功能 证据 claim',
        },
        {
          id: 'action-new-video',
          label: '创建一个新视频',
          hint: currentProject.name,
          group: '操作',
          icon: <Clapperboard size={15} />,
          to: `/projects/${currentProject.id}/videos/new`,
          keywords: 'new video 新建 视频 director',
        },
      );
    }
    projects.forEach((project) => {
      items.push({
        id: `project-${project.id}`,
        label: project.name,
        hint: project.productName,
        group: '项目',
        icon: <FolderKanban size={15} />,
        to: `/projects/${project.id}`,
        keywords: `${project.name} ${project.productName} ${project.description}`,
      });
    });
    features.forEach((feature) => {
      const project = projects.find((item) => item.id === feature.projectId);
      items.push({
        id: `feature-${feature.id}`,
        label: feature.name,
        hint: `${project?.name ?? ''} · 功能`,
        group: '功能',
        icon: <BookOpen size={15} />,
        to: `/projects/${feature.projectId}/knowledge?feature=${feature.id}`,
        keywords: `${feature.name} ${feature.summary} ${feature.category} ${feature.tags.join(' ')}`,
      });
    });
    videos.forEach((video) => {
      const project = projects.find((item) => item.id === video.projectId);
      items.push({
        id: `video-${video.id}`,
        label: video.title,
        hint: `${project?.name ?? ''} · 视频`,
        group: '视频',
        icon: <Sparkles size={15} />,
        to: `/videos/${video.id}/director`,
        keywords: `${video.title} ${video.brief.objective} ${video.brief.audience}`,
      });
    });
    return items;
  }, [projects, features, videos, currentProject]);

  const filtered = useMemo(() => {
    const term = query.trim().toLowerCase();
    if (!term) return commands.slice(0, 14);
    return commands
      .filter((command) => `${command.label} ${command.hint ?? ''} ${command.keywords}`.toLowerCase().includes(term))
      .slice(0, 18);
  }, [commands, query]);

  const grouped = useMemo(() => {
    const map = new Map<string, { command: Command; index: number }[]>();
    filtered.forEach((command, index) => {
      const list = map.get(command.group) ?? [];
      list.push({ command, index });
      map.set(command.group, list);
    });
    return Array.from(map.entries());
  }, [filtered]);

  useEffect(() => {
    if (open) {
      setQuery('');
      setActive(0);
    }
  }, [open]);

  useEffect(() => {
    setActive(0);
  }, [query]);

  const selected = filtered[active];

  const go = (command: Command) => {
    setOpen(false);
    navigate(command.to);
  };

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent
        title="快速跳转"
        description="搜索项目、功能、视频，或直接执行一个动作。"
        size="lg"
        className="top-[16%] translate-y-0"
      >
        <div className="-mx-5 -mt-4 border-b border-line">
          <div className="flex items-center gap-2.5 px-5 py-3">
            <Search size={16} className="text-faint" />
            <input
              autoFocus
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'ArrowDown') {
                  event.preventDefault();
                  setActive((value) => Math.min(filtered.length - 1, value + 1));
                }
                if (event.key === 'ArrowUp') {
                  event.preventDefault();
                  setActive((value) => Math.max(0, value - 1));
                }
                if (event.key === 'Enter' && selected) {
                  event.preventDefault();
                  go(selected);
                }
              }}
              placeholder="输入功能名、视频标题或动作…"
              aria-label="搜索"
              className="h-8 flex-1 bg-transparent text-[14px] text-fg outline-none placeholder:text-faint"
            />
            <kbd className="rounded border border-line px-1.5 py-0.5 font-mono text-[9.5px] text-faint">
              Esc
            </kbd>
          </div>
        </div>
        <div ref={listRef} className="mt-2 max-h-[46vh] overflow-y-auto pb-1">
          {filtered.length === 0 ? (
            <div className="py-10 text-center text-[12.5px] text-muted">
              没有匹配「{query}」的结果。试试功能名称或项目名称。
            </div>
          ) : (
            grouped.map(([group, entries]) => (
              <div key={group} className="mb-2">
                <div className="px-1 py-1.5 text-[9.5px] font-semibold uppercase tracking-[0.14em] text-faint">
                  {group}
                </div>
                {entries.map(({ command, index }) => (
                  <button
                    key={command.id}
                    type="button"
                    onMouseEnter={() => setActive(index)}
                    onClick={() => go(command)}
                    className={cn(
                      'flex w-full items-center gap-2.5 rounded-sm px-2.5 py-2 text-left transition-colors',
                      index === active ? 'bg-overlay text-fg' : 'text-muted hover:bg-overlay/60',
                    )}
                  >
                    <span className={cn(index === active ? 'text-accent' : 'text-faint')}>{command.icon}</span>
                    <span className="min-w-0 flex-1 truncate text-[12.5px]">{command.label}</span>
                    {command.hint ? (
                      <span className="max-w-[220px] shrink-0 truncate text-[10.5px] text-faint">
                        {command.hint}
                      </span>
                    ) : null}
                  </button>
                ))}
              </div>
            ))
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
