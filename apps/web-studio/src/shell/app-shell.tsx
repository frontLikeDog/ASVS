import { Suspense, useEffect, useState } from 'react';
import { Link, Outlet, useLocation } from 'react-router-dom';
import { useStudioStore, useUiStore } from '@asvs/state';
import { TooltipProvider } from '@asvs/ui';
import { Sidebar } from './sidebar';
import { Topbar } from './topbar';
import { CommandPalette } from './command-palette';
import { DemoDialog } from './demo-dialog';
import { Toaster } from './toaster';
import { RouteLoading } from '../route-loading';
import { useMediaQuery } from '../lib/use-media-query';

export function AppShell() {
  const { pathname } = useLocation();
  const projects = useStudioStore((state) => state.projects);
  const videos = useStudioStore((state) => state.videos);
  const theme = useUiStore((state) => state.theme);
  const sidebarCollapsed = useUiStore((state) => state.sidebarCollapsed);
  const sidebarUserPref = useUiStore((state) => state.sidebarUserPref);
  const setSidebarCollapsed = useUiStore((state) => state.setSidebarCollapsed);
  const lastProjectId = useUiStore((state) => state.lastProjectId);
  const setLastProjectId = useUiStore((state) => state.setLastProjectId);
  const setCommandOpen = useUiStore((state) => state.setCommandOpen);
  const [mobileOpen, setMobileOpen] = useState(false);
  const [demoOpen, setDemoOpen] = useState(false);
  const isMobile = useMediaQuery('(max-width: 767px)');
  const isTablet = useMediaQuery('(min-width: 768px) and (max-width: 1179px)');

  const parts = pathname.split('/').filter(Boolean);
  const urlProjectId = parts[0] === 'projects' ? parts[1] : undefined;
  const urlVideoId = parts[0] === 'videos' ? parts[1] : undefined;
  const currentVideo = urlVideoId ? videos.find((video) => video.id === urlVideoId) : undefined;
  const projectFromVideo = currentVideo
    ? projects.find((project) => project.id === currentVideo.projectId)
    : undefined;
  const currentProject =
    projects.find((project) => project.id === urlProjectId) ??
    projectFromVideo ??
    projects.find((project) => project.id === lastProjectId) ??
    projects[0];

  const activeProjectId = urlProjectId ?? projectFromVideo?.id;
  useEffect(() => {
    if (activeProjectId && activeProjectId !== lastProjectId) setLastProjectId(activeProjectId);
  }, [activeProjectId, lastProjectId, setLastProjectId]);

  useEffect(() => {
    setMobileOpen(false);
  }, [pathname]);

  useEffect(() => {
    const root = document.documentElement;
    root.setAttribute('data-theme', theme);
    const meta = document.querySelector('meta[name="theme-color"]');
    meta?.setAttribute('content', theme === 'dark' ? '#08090b' : '#f4f2ec');
  }, [theme]);

  useEffect(() => {
    const interval = window.setInterval(() => {
      useStudioStore.getState().tickExports(400);
    }, 400);
    return () => window.clearInterval(interval);
  }, []);

  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault();
        setCommandOpen(true);
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [setCommandOpen]);

  // Tablet starts collapsed to protect content width, but the user's explicit
  // toggle must win — otherwise the topbar toggle is a dead control at 768–1179px.
  const collapsed = !isMobile && (sidebarCollapsed || (isTablet && !sidebarUserPref));

  return (
    <TooltipProvider>
      <div className="flex h-dvh overflow-hidden bg-ink text-fg">
        <a
          href="#main-content"
          className="sr-only z-[100] rounded-sm bg-accent px-3 py-2 text-on-accent focus:not-sr-only focus:fixed focus:left-3 focus:top-3"
        >
          跳到主要内容
        </a>
        <Sidebar
          projects={projects}
          currentProject={currentProject}
          currentVideo={currentVideo}
          collapsed={collapsed}
          mobileOpen={mobileOpen}
          onCloseMobile={() => setMobileOpen(false)}
          onOpenDemo={() => setDemoOpen(true)}
        />
        <div className="flex min-w-0 flex-1 flex-col">
          <Topbar
            currentProject={currentProject}
            currentVideo={currentVideo}
            collapsed={collapsed}
            onOpenMobile={() => setMobileOpen(true)}
            onOpenDemo={() => setDemoOpen(true)}
            onOpenCommand={() => setCommandOpen(true)}
            onToggleCollapsed={() => setSidebarCollapsed(!collapsed)}
          />
          <main id="main-content" className="app-toplight min-h-0 flex-1 overflow-y-auto">
            <Suspense fallback={<RouteLoading />}>
              <Outlet />
            </Suspense>
          </main>
        </div>
        <CommandPalette />
        <DemoDialog open={demoOpen} onOpenChange={setDemoOpen} />
        <Toaster />
      </div>
    </TooltipProvider>
  );
}
