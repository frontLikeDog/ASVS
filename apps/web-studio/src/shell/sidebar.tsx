import type { ReactNode } from 'react';
import { NavLink, useNavigate } from 'react-router-dom';
import type { Project, VideoProject } from '@asvs/domain';
import {
  BookOpen,
  ChevronDown,
  Clapperboard,
  FolderKanban,
  LayoutDashboard,
  Library,
  Moon,
  Palette,
  Plus,
  Settings2,
  ShieldCheck,
  Sparkles,
  Sun,
  Workflow,
  Scissors,
  LayoutGrid,
  Database,
} from 'lucide-react';
import {
  BrandMark,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuTrigger,
  StudioLogo,
  Tooltip,
  cn,
} from '@asvs/ui';
import { useUiStore } from '@asvs/state';

const VIDEO_NAV = [
  { suffix: 'director', label: 'AI 导演', icon: Sparkles },
  { suffix: 'storyboard', label: '分镜剧本', icon: LayoutGrid },
  { suffix: 'editor', label: '视频剪辑', icon: Scissors },
  { suffix: 'production', label: '生产监控', icon: Workflow },
  { suffix: 'review', label: '审核导出', icon: ShieldCheck },
];

interface SidebarProps {
  projects: Project[];
  currentProject?: Project;
  currentVideo?: VideoProject;
  collapsed: boolean;
  mobileOpen: boolean;
  onCloseMobile: () => void;
  onOpenDemo: () => void;
}

export function Sidebar({
  projects,
  currentProject,
  currentVideo,
  collapsed,
  mobileOpen,
  onCloseMobile,
  onOpenDemo,
}: SidebarProps) {
  const navigate = useNavigate();
  const theme = useUiStore((state) => state.theme);
  const toggleTheme = useUiStore((state) => state.toggleTheme);

  return (
    <>
      {mobileOpen ? (
        <button
          type="button"
          aria-label="关闭导航"
          className="fixed inset-0 z-40 bg-black/60 backdrop-blur-[2px] md:hidden"
          onClick={onCloseMobile}
        />
      ) : null}
      <aside
        className={cn(
          'fixed inset-y-0 left-0 z-50 flex shrink-0 flex-col border-r border-line bg-surface/95 backdrop-blur-md transition-[transform,width] duration-200 md:static md:z-auto md:translate-x-0',
          mobileOpen ? 'translate-x-0' : '-translate-x-full',
        )}
        style={{ width: collapsed ? 68 : 238 }}
      >
        <div className={cn('flex h-14 items-center border-b border-line', collapsed ? 'justify-center px-2' : 'justify-between px-4')}>
          <NavLink to="/" className="flex items-center gap-2" aria-label="ASVS · 回到工作台">
            <StudioLogo compact={collapsed} />
          </NavLink>
          {!collapsed ? (
            <span className="rounded border border-line px-1.5 py-0.5 font-mono text-[9px] uppercase tracking-[0.12em] text-faint">
              studio
            </span>
          ) : null}
        </div>

        <div className={cn('border-b border-line', collapsed ? 'p-2' : 'p-3')}>
          {currentProject ? (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <button
                  type="button"
                  className={cn(
                    'flex w-full items-center rounded-md border border-line bg-raised/60 text-left transition-colors hover:border-line-strong hover:bg-raised',
                    collapsed ? 'justify-center p-2' : 'gap-2.5 px-2.5 py-2',
                  )}
                >
                  <span
                    className="grid size-7 shrink-0 place-items-center rounded-sm border border-line bg-ink"
                    style={{ color: currentProject.brand.primary }}
                  >
                    <BrandMark
                      mark={currentProject.brand.logoMark}
                      size={15}
                      title={currentProject.brand.logoText}
                    />
                  </span>
                  <span className="sr-only">切换项目</span>
                  {!collapsed ? (
                    <>
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-[12.5px] font-medium text-fg">
                          {currentProject.name}
                        </span>
                        <span className="block truncate text-[10.5px] text-faint">
                          {currentProject.productName}
                        </span>
                      </span>
                      <ChevronDown size={13} className="shrink-0 text-faint" />
                    </>
                  ) : null}
                </button>
              </DropdownMenuTrigger>
              <DropdownMenuContent
                align="start"
                items={[
                  ...projects.map((project) => ({
                    key: project.id,
                    label: (
                      <span className="flex min-w-0 items-center justify-between gap-3">
                        <span className="truncate">{project.name}</span>
                        {project.id === currentProject.id ? (
                          <span className="size-1.5 rounded-full bg-accent" aria-label="当前项目" />
                        ) : null}
                      </span>
                    ),
                    onSelect: () => navigate(`/projects/${project.id}`),
                  })),
                  {
                    key: 'new',
                    label: '新建视频项目',
                    icon: <Plus size={14} />,
                    separatorBefore: true,
                    onSelect: () => navigate('/onboarding'),
                  },
                  {
                    key: 'all',
                    label: '查看全部项目',
                    icon: <FolderKanban size={14} />,
                    onSelect: () => navigate('/projects'),
                  },
                ]}
              />
            </DropdownMenu>
          ) : (
            <NavLink
              to="/onboarding"
              className={cn(
                'flex items-center rounded-md border border-dashed border-line-strong text-muted transition-colors hover:border-accent/40 hover:text-fg',
                collapsed ? 'justify-center p-2' : 'gap-2 px-2.5 py-2 text-[12px]',
              )}
            >
              <Plus size={14} />
              {!collapsed ? '新建项目' : null}
            </NavLink>
          )}
        </div>

        <nav className="min-h-0 flex-1 overflow-y-auto px-2 py-3" aria-label="主导航">
          <NavSection label="工作台" collapsed={collapsed}>
            <NavItem to="/" icon={<LayoutDashboard size={16} />} label="概览" end collapsed={collapsed} onNavigate={onCloseMobile} />
            <NavItem to="/projects" icon={<FolderKanban size={16} />} label="项目" collapsed={collapsed} onNavigate={onCloseMobile} />
            <NavItem to="/videos" icon={<Library size={16} />} label="视频库" collapsed={collapsed} onNavigate={onCloseMobile} />
          </NavSection>

          {currentProject ? (
            <NavSection label="当前项目" collapsed={collapsed}>
              <NavItem
                to={`/projects/${currentProject.id}`}
                icon={<Database size={16} />}
                label="项目总览"
                end
                collapsed={collapsed}
                onNavigate={onCloseMobile}
              />
              <NavItem
                to={`/projects/${currentProject.id}/knowledge`}
                icon={<BookOpen size={16} />}
                label="知识中心"
                collapsed={collapsed}
                onNavigate={onCloseMobile}
              />
              <NavItem
                to={`/projects/${currentProject.id}/videos`}
                icon={<Clapperboard size={16} />}
                label="视频工程"
                collapsed={collapsed}
                onNavigate={onCloseMobile}
              />
              <NavItem
                to={`/projects/${currentProject.id}/settings`}
                icon={<Palette size={16} />}
                label="品牌与设置"
                collapsed={collapsed}
                onNavigate={onCloseMobile}
              />
            </NavSection>
          ) : null}

          {currentVideo ? (
            <NavSection label={currentVideo.title} collapsed={collapsed} truncate>
              {VIDEO_NAV.map((item) => (
                <NavItem
                  key={item.suffix}
                  to={`/videos/${currentVideo.id}/${item.suffix}`}
                  icon={<item.icon size={16} />}
                  label={item.label}
                  collapsed={collapsed}
                  onNavigate={onCloseMobile}
                />
              ))}
            </NavSection>
          ) : null}
        </nav>

        <div className={cn('space-y-1 border-t border-line p-2', collapsed && 'flex flex-col items-center')}>
          <button
            type="button"
            onClick={onOpenDemo}
            className={cn(
              'flex w-full items-center rounded-sm text-[11.5px] text-muted transition-colors hover:bg-overlay hover:text-fg',
              collapsed ? 'justify-center p-2' : 'gap-2 px-2.5 py-2',
            )}
            title="模拟与真实能力说明"
          >
            <Settings2 size={14} className="shrink-0" />
            {!collapsed ? <span>模拟能力说明</span> : null}
            {!collapsed ? (
              <span className="ml-auto rounded-full border border-line px-1.5 py-px text-[9px] uppercase tracking-wide text-faint">
                demo
              </span>
            ) : null}
          </button>
          <button
            type="button"
            onClick={toggleTheme}
            className={cn(
              'flex w-full items-center rounded-sm text-[11.5px] text-muted transition-colors hover:bg-overlay hover:text-fg',
              collapsed ? 'justify-center p-2' : 'gap-2 px-2.5 py-2',
            )}
            title={theme === 'dark' ? '切换到浅色模式' : '切换到深色模式'}
          >
            {theme === 'dark' ? <Sun size={14} /> : <Moon size={14} />}
            {!collapsed ? <span>{theme === 'dark' ? '浅色模式' : '深色模式'}</span> : null}
          </button>
          <div
            className={cn(
              'mt-1 flex items-center rounded-md border border-line bg-raised/40',
              collapsed ? 'justify-center p-1.5' : 'gap-2 px-2 py-1.5',
            )}
            title="本地演示工作区"
          >
            <span className="grid size-6 shrink-0 place-items-center rounded-full bg-overlay font-display text-[10px] text-muted">
              DS
            </span>
            {!collapsed ? (
              <div className="min-w-0">
                <div className="truncate text-[11px] text-fg">Demo Studio</div>
                <div className="truncate text-[9.5px] text-faint">本地演示 · 无登录</div>
              </div>
            ) : null}
          </div>
        </div>
      </aside>
    </>
  );
}

function NavSection({
  label,
  collapsed,
  truncate,
  children,
}: {
  label: string;
  collapsed: boolean;
  truncate?: boolean;
  children: ReactNode;
}) {
  return (
    <div className="mb-4">
      {!collapsed ? (
        <div
          className={cn(
            'mb-1 px-2.5 text-[9.5px] font-semibold uppercase tracking-[0.14em] text-faint',
            truncate && 'truncate',
          )}
          title={label}
        >
          {label}
        </div>
      ) : (
        <div className="mx-auto mb-2 h-px w-5 bg-line" />
      )}
      <div className="space-y-0.5">{children}</div>
    </div>
  );
}

function NavItem({
  to,
  icon,
  label,
  end,
  collapsed,
  onNavigate,
  disabled,
  hint,
}: {
  to: string;
  icon: ReactNode;
  label: string;
  end?: boolean;
  collapsed: boolean;
  onNavigate: () => void;
  disabled?: boolean;
  hint?: string;
}) {
  const content = (
    <NavLink
      to={to}
      end={end}
      onClick={onNavigate}
      aria-disabled={disabled}
      className={({ isActive }) =>
        cn(
          'group relative flex h-8 items-center rounded-sm text-[12px] transition-colors',
          collapsed ? 'justify-center px-0' : 'gap-2.5 px-2.5',
          disabled && 'pointer-events-none opacity-40',
          isActive
            ? 'bg-overlay text-fg'
            : 'text-muted hover:bg-overlay/60 hover:text-fg',
        )
      }
    >
      {({ isActive }) => (
        <>
          {isActive ? (
            <span className="absolute left-0 top-1/2 h-4 w-[2px] -translate-y-1/2 rounded-full bg-accent" />
          ) : null}
          <span className={cn('shrink-0', isActive ? 'text-accent' : 'text-faint')}>{icon}</span>
          {!collapsed ? <span className="truncate">{label}</span> : null}
          {!collapsed && hint ? (
            <span className="ml-auto text-[9px] uppercase tracking-wide text-faint">{hint}</span>
          ) : null}
        </>
      )}
    </NavLink>
  );

  if (collapsed) {
    return (
      <Tooltip label={label} side="right">
        {content}
      </Tooltip>
    );
  }
  return content;
}
