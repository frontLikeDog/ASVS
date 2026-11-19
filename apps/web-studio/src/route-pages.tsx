import { lazy } from 'react';

/**
 * Route-level code splitting. Every routable page is loaded on demand so the
 * initial shell only ships the workspace chrome. Editor / Production / Review
 * are the heaviest pages and are each their own chunk.
 */
export const DashboardPage = lazy(() =>
  import('@asvs/features-project/dashboard-page').then((module) => ({
    default: module.DashboardPage,
  })),
);

export const ProjectsPage = lazy(() =>
  import('@asvs/features-project/projects-page').then((module) => ({
    default: module.ProjectsPage,
  })),
);

export const OnboardingPage = lazy(() =>
  import('@asvs/features-project/onboarding-page').then((module) => ({
    default: module.OnboardingPage,
  })),
);

export const ProjectOverviewPage = lazy(() =>
  import('@asvs/features-project/project-overview-page').then((module) => ({
    default: module.ProjectOverviewPage,
  })),
);

export const KnowledgePage = lazy(() =>
  import('@asvs/features-project/knowledge-page').then((module) => ({
    default: module.KnowledgePage,
  })),
);

export const VideosPage = lazy(() =>
  import('@asvs/features-project/videos-page').then((module) => ({
    default: module.VideosPage,
  })),
);

export const AllVideosPage = lazy(() =>
  import('@asvs/features-project/all-videos-page').then((module) => ({
    default: module.AllVideosPage,
  })),
);

export const SettingsPage = lazy(() =>
  import('@asvs/features-project/settings-page').then((module) => ({
    default: module.SettingsPage,
  })),
);

export const VideoWizardPage = lazy(() =>
  import('@asvs/features-video/video-wizard-page').then((module) => ({
    default: module.VideoWizardPage,
  })),
);

export const DirectorPage = lazy(() =>
  import('@asvs/features-video/director-page').then((module) => ({
    default: module.DirectorPage,
  })),
);

export const StoryboardPage = lazy(() =>
  import('@asvs/features-video/storyboard-page').then((module) => ({
    default: module.StoryboardPage,
  })),
);

export const EditorPage = lazy(() =>
  import('@asvs/features-video/editor-page').then((module) => ({
    default: module.EditorPage,
  })),
);

export const ProductionPage = lazy(() =>
  import('@asvs/features-production/production-page').then((module) => ({
    default: module.ProductionPage,
  })),
);

export const ReviewPage = lazy(() =>
  import('@asvs/features-production/review-page').then((module) => ({
    default: module.ReviewPage,
  })),
);
