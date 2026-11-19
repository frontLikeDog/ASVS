import { createBrowserRouter, Navigate } from 'react-router-dom';
import {
  AllVideosPage,
  DashboardPage,
  DirectorPage,
  EditorPage,
  KnowledgePage,
  OnboardingPage,
  ProductionPage,
  ProjectOverviewPage,
  ProjectsPage,
  ReviewPage,
  SettingsPage,
  StoryboardPage,
  VideoWizardPage,
  VideosPage,
} from './route-pages';
import { AppShell } from './shell/app-shell';
import { NotFoundPage } from './not-found-page';
import { RouteErrorPage } from './route-error';
import { VideoRedirect } from './video-redirect';

export const router = createBrowserRouter([
  {
    path: '/',
    element: <AppShell />,
    errorElement: <RouteErrorPage />,
    children: [
      { index: true, element: <DashboardPage /> },
      { path: 'projects', element: <ProjectsPage /> },
      { path: 'onboarding', element: <OnboardingPage /> },
      { path: 'videos', element: <AllVideosPage /> },
      { path: 'projects/new', element: <Navigate to="/onboarding" replace /> },
      { path: 'projects/:projectId', element: <ProjectOverviewPage /> },
      { path: 'projects/:projectId/knowledge', element: <KnowledgePage /> },
      { path: 'projects/:projectId/videos', element: <VideosPage /> },
      { path: 'projects/:projectId/videos/new', element: <VideoWizardPage /> },
      { path: 'projects/:projectId/settings', element: <SettingsPage /> },
      { path: 'videos/:videoId', element: <VideoRedirect /> },
      { path: 'videos/:videoId/director', element: <DirectorPage /> },
      { path: 'videos/:videoId/storyboard', element: <StoryboardPage /> },
      { path: 'videos/:videoId/editor', element: <EditorPage /> },
      { path: 'videos/:videoId/production', element: <ProductionPage /> },
      { path: 'videos/:videoId/review', element: <ReviewPage /> },
      { path: '*', element: <NotFoundPage /> },
    ],
  },
]);
