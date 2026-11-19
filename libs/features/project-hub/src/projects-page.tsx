import { Link } from 'react-router-dom';
import type { Project } from '@asvs/domain';
import { formatRelativeTime, orderedScenes } from '@asvs/domain';
import { ArrowRight, BookOpen, Clapperboard, FolderKanban, Plus, Sparkles } from 'lucide-react';
import {
  Badge,
  BrandMark,
  DemoBadge,
  Page,
  PageHeader,
  Panel,
  ScenePreview,
  buttonStyles,
} from '@asvs/ui';
import { useStudioStore } from '@asvs/state';

export function ProjectsPage() {
  const projects = useStudioStore((state) => state.projects);
  const features = useStudioStore((state) => state.features);
  const claims = useStudioStore((state) => state.claims);
  const videos = useStudioStore((state) => state.videos);

  return (
    <Page wide>
      <PageHeader
        eyebrow={
          <>
            <span className="size-1.5 rounded-full bg-accent" />
            Workspace · {projects.length} 个项目
          </>
        }
        title="项目"
        description="每个项目有自己的知识快照、品牌套件与视频工程。项目之间互不影响。"
        actions={
          <Link to="/onboarding" className={buttonStyles({ variant: 'primary' })}>
            <Plus size={15} /> 新建项目
          </Link>
        }
      />

      <div className="mt-7 grid gap-4 lg:grid-cols-2">
        {projects.map((project) => {
          const projectFeatures = features.filter((feature) => feature.projectId === project.id);
          const projectClaims = claims.filter((claim) => claim.projectId === project.id);
          const verified = projectClaims.filter((claim) => claim.status === 'verified').length;
          const projectVideos = videos
            .filter((video) => video.projectId === project.id)
            .sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime());
          const latestVideo = projectVideos[0];
          const scene = latestVideo
            ? orderedScenes(latestVideo.scenes).find((item) => item.visualType === 'real_demo') ??
              orderedScenes(latestVideo.scenes)[0]
            : undefined;
          const feature = scene?.featureId
            ? features.find((item) => item.id === scene.featureId)
            : undefined;
          return (
            <Panel key={project.id} className="group overflow-hidden transition-colors hover:border-line-strong">
              <div className="relative aspect-[16/7] overflow-hidden bg-ink">
                {latestVideo && scene ? (
                  <ScenePreview
                    scene={scene}
                    project={project}
                    feature={feature}
                    aspect="16:9"
                    showCaption={false}
                    showChrome={false}
                  />
                ) : (
                  <ProjectPoster project={project} />
                )}
                <div className="absolute inset-0 bg-gradient-to-t from-black/80 via-black/20 to-black/10" />
                <div className="absolute inset-x-0 bottom-0 flex items-end justify-between gap-4 p-4">
                  <div className="min-w-0">
                    <div className="flex items-center gap-2">
                      <span
                        className="grid size-7 place-items-center rounded-sm border border-white/20 bg-black/30"
                        style={{ color: project.brand.primary }}
                      >
                        <BrandMark mark={project.brand.logoMark} size={15} />
                      </span>
                      <span className="truncate font-display text-[17px] font-medium text-white">
                        {project.name}
                      </span>
                      <DemoBadge className="border-white/20 text-white/60" />
                    </div>
                    <div className="mt-1.5 text-[11px] text-white/55">
                      {project.productName} · {project.sources.length} 个模拟来源
                    </div>
                  </div>
                  {latestVideo ? (
                    <Badge tone="outline" dot={false} className="border-white/25 text-white/65">
                      {projectVideos.length} 条视频
                    </Badge>
                  ) : null}
                </div>
              </div>

              <div className="p-4">
                <p className="line-clamp-2 min-h-[40px] text-[12.5px] leading-5 text-muted">
                  {project.description || '还没有项目描述。'}
                </p>
                <div className="mt-3 grid grid-cols-3 divide-x divide-line border-y border-line py-2.5 text-center">
                  <div>
                    <div className="font-display text-[17px] text-fg">{projectFeatures.length}</div>
                    <div className="text-[9.5px] uppercase tracking-wide text-faint">功能</div>
                  </div>
                  <div>
                    <div className="font-display text-[17px] text-fg">
                      {verified}
                      <span className="text-[11px] text-faint">/{projectClaims.length}</span>
                    </div>
                    <div className="text-[9.5px] uppercase tracking-wide text-faint">已核验声明</div>
                  </div>
                  <div>
                    <div className="font-display text-[17px] text-fg">{projectVideos.length}</div>
                    <div className="text-[9.5px] uppercase tracking-wide text-faint">视频工程</div>
                  </div>
                </div>
                <div className="mt-3 flex items-center justify-between gap-3">
                  <span className="truncate text-[10.5px] text-faint">
                    {latestVideo
                      ? `最近更新 ${formatRelativeTime(latestVideo.updatedAt)} · ${latestVideo.title}`
                      : '尚无视频工程'}
                  </span>
                  <div className="flex shrink-0 items-center gap-1">
                    <Link
                      to={`/projects/${project.id}/knowledge`}
                      className={buttonStyles({ variant: 'ghost', size: 'sm' })}
                    >
                      <BookOpen size={13} />
                      知识
                    </Link>
                    <Link
                      to={`/projects/${project.id}/videos/new`}
                      className={buttonStyles({ variant: 'ghost', size: 'sm' })}
                    >
                      <Clapperboard size={13} />
                      新视频
                    </Link>
                    <Link
                      to={`/projects/${project.id}`}
                      className={buttonStyles({ variant: 'secondary', size: 'sm' })}
                    >
                      打开
                      <ArrowRight size={12} />
                    </Link>
                  </div>
                </div>
              </div>
            </Panel>
          );
        })}

        <Link
          to="/onboarding"
          className="group flex min-h-[280px] flex-col items-center justify-center rounded-lg border border-dashed border-line-strong bg-transparent p-6 text-center transition-colors hover:border-accent/40 hover:bg-accent-soft/20"
        >
          <span className="grid size-10 place-items-center rounded-md border border-line bg-raised text-muted transition-colors group-hover:border-accent/30 group-hover:text-accent">
            <Plus size={18} />
          </span>
          <span className="mt-3 font-display text-[15px] font-medium text-fg">新建视频项目</span>
          <span className="mt-1 max-w-[240px] text-[12px] leading-5 text-muted">
            用六步接入模拟知识来源，生成第一批功能与声明。
          </span>
          <span className="mt-3 flex items-center gap-1 text-[11.5px] text-faint">
            <Sparkles size={12} />
            支持 GitHub / 网址 / 文档 / 组合
          </span>
        </Link>
      </div>

      <div className="mt-6 flex items-center gap-2 text-[10.5px] text-faint">
        <FolderKanban size={11} />
        这些项目是固定的本地演示数据。重置后可以恢复初始状态。
      </div>
    </Page>
  );
}

function ProjectPoster({ project }: { project: Project }) {
  return (
    <div
      className="absolute inset-0"
      style={{
        background: `
          radial-gradient(60% 80% at 20% 20%, ${project.brand.primary}55, transparent 70%),
          radial-gradient(50% 70% at 85% 80%, ${project.brand.secondary}44, transparent 70%),
          #0c0e12
        `,
      }}
    >
      <div className="dot-grid absolute inset-0 opacity-30" />
      <div className="absolute left-5 top-5 flex items-center gap-2 text-white/80">
        <BrandMark mark={project.brand.logoMark} size={26} />
        <span className="font-display text-[12px] uppercase tracking-[0.16em]">
          {project.brand.logoText}
        </span>
      </div>
      <div className="absolute left-5 top-1/2 max-w-[70%] -translate-y-1/2">
        <div className="text-[10px] uppercase tracking-[0.18em] text-white/45">Product workspace</div>
        <div className="mt-2 font-display text-[22px] leading-7 text-white">{project.productName}</div>
        <div className="mt-1 text-[11px] text-white/50">知识已就绪，等待第一条视频。</div>
      </div>
    </div>
  );
}
