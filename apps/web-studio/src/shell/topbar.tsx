import { Link, useLocation } from 'react-router-dom';
import type { Project, VideoProject } from '@asvs/domain';
import { ChevronRight, Menu, Moon, PanelLeftClose, PanelLeftOpen, Plus, Search, Sun } from 'lucide-react';
import { Badge, IconButton, Kbd, buttonStyles, cn } from '@asvs/ui';
import { useUiStore } from '@asvs/state';

const PAGE_LABELS: Record<string, string> = {
  knowledge: '知识中心',
  videos: '视频工程',
  settings: '品牌与设置',
  director: 'AI 导演',
  storyboard: '分镜剧本',
  editor: '视频剪辑',
  production: '生产监控',
  review: '审核与导出',
  new: '新建视频',
};

export function Topbar({
  onOpenMobile,
  onOpenDemo,
  onOpenCommand,
  collapsed,
  onToggleCollapsed,
  currentProject,
  currentVideo,
}: {
  onOpenMobile: () => void;
  onOpenDemo: () => void;
  onOpenCommand: () => void;
  collapsed: boolean;
  onToggleCollapsed: () => void;
  currentProject?: Project;
  currentVideo?: VideoProject;
}) {
  const { pathname } = useLocation();
  const theme = useUiStore((state) => state.theme);
  const toggleTheme = useUiStore((state) => state.toggleTheme);
  const resolvedProject = currentProject;
  const video = currentVideo;

  const crumbs: { label: string; to?: string }[] = [{ label: '工作台', to: '/' }];
  if (pathname.startsWith('/onboarding')) {
    crumbs.push({ label: '新建项目' });
  } else if (pathname.startsWith('/projects')) {
    if (pathname === '/projects') {
      crumbs.push({ label: '项目' });
    } else if (resolvedProject) {
      crumbs.push({ label: resolvedProject.name, to: `/projects/${resolvedProject.id}` });
      const section = pathname.split('/')[3];
      if (section === 'videos') {
        crumbs.push({ label: '视频工程', to: `/projects/${resolvedProject.id}/videos` });
        if (pathname.endsWith('/new')) crumbs.push({ label: '新建视频' });
      } else if (section) {
        crumbs.push({ label: PAGE_LABELS[section] ?? section });
      } else {
        crumbs.push({ label: '项目总览' });
      }
    }
  } else if (pathname.startsWith('/videos')) {
    if (pathname === '/videos') {
      crumbs.push({ label: '视频库' });
    } else if (video) {
      if (resolvedProject) {
        crumbs.push({ label: resolvedProject.name, to: `/projects/${resolvedProject.id}` });
      }
      crumbs.push({ label: video.title, to: `/videos/${video.id}/director` });
      const section = pathname.split('/')[3];
      if (section) crumbs.push({ label: PAGE_LABELS[section] ?? section });
    }
  }

  return (
    <header className="sticky top-0 z-30 flex h-14 shrink-0 items-center gap-2 border-b border-line bg-ink/85 px-3 backdrop-blur-md lg:px-4">
      <IconButton label="打开导航" className="md:hidden" onClick={onOpenMobile}>
        <Menu size={17} />
      </IconButton>
      <IconButton
        label={collapsed ? '展开侧栏' : '收起侧栏'}
        className="hidden md:inline-flex"
        onClick={onToggleCollapsed}
      >
        {collapsed ? <PanelLeftOpen size={16} /> : <PanelLeftClose size={16} />}
      </IconButton>

      <nav className="flex min-w-0 items-center gap-1.5 text-[12px]" aria-label="面包屑">
        {crumbs.map((crumb, index) => (
          <span key={`${crumb.label}-${index}`} className="flex min-w-0 items-center gap-1.5">
            {index > 0 ? <ChevronRight size={12} className="shrink-0 text-faint" aria-hidden /> : null}
            {crumb.to && index < crumbs.length - 1 ? (
              <Link
                to={crumb.to}
                className="max-w-[140px] truncate text-muted transition-colors hover:text-fg"
              >
                {crumb.label}
              </Link>
            ) : (
              <span
                className={cn(
                  'max-w-[220px] truncate',
                  index === crumbs.length - 1 ? 'font-medium text-fg' : 'text-muted',
                )}
              >
                {crumb.label}
              </span>
            )}
          </span>
        ))}
      </nav>

      <div className="ml-auto flex items-center gap-1.5">
        <button
          type="button"
          onClick={onOpenCommand}
          className="hidden h-8 items-center gap-2 rounded-sm border border-line bg-raised/50 px-2.5 text-[12px] text-faint transition-colors hover:border-line-strong hover:text-muted sm:flex"
        >
          <Search size={13} />
          <span className="hidden lg:inline">搜索项目、功能、视频</span>
          <Kbd>Ctrl K</Kbd>
        </button>
        <IconButton label="搜索" className="sm:hidden" onClick={onOpenCommand}>
          <Search size={16} />
        </IconButton>

        <button type="button" onClick={onOpenDemo} className="hidden items-center gap-1.5 md:flex" title="查看模拟与真实能力说明">
          <Badge tone="outline" dot={false} className="italic">
            Demo
          </Badge>
        </button>

        <IconButton label={theme === 'dark' ? '切换到浅色模式' : '切换到深色模式'} onClick={toggleTheme}>
          {theme === 'dark' ? <Sun size={16} /> : <Moon size={16} />}
        </IconButton>

        {resolvedProject ? (
          <Link
            to={`/projects/${resolvedProject.id}/videos/new`}
            className={buttonStyles({ variant: 'primary', size: 'md', className: 'ml-1' })}
          >
            <Plus size={15} />
            <span className="hidden sm:inline">新建视频</span>
          </Link>
        ) : (
          <Link to="/onboarding" className={buttonStyles({ variant: 'primary', size: 'md', className: 'ml-1' })}>
            <Plus size={15} />
            新建项目
          </Link>
        )}
      </div>
    </header>
  );
}
