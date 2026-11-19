import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import type {
  ActivityEvent,
  Asset,
  BrandKit,
  Claim,
  DirectorContext,
  DirectorResult,
  Evidence,
  ExportRecord,
  Feature,
  KnowledgeSuggestion,
  OnboardingDraft,
  ProductionRun,
  Project,
  PullRequest,
  Release,
  ReviewBundle,
  RunScenario,
  Scene,
  StudioSnapshot,
  VideoBrief,
  VideoMode,
  VideoProject,
  VideoStage,
  VideoTemplate,
} from '@asvs/domain';
import type { SyncKnowledgeResult } from '@asvs/mock-services';
import {
  DEFAULT_VIDEO_FPS,
  deriveSceneVisual,
  normalizeSceneOrder,
  orderedScenes,
  sceneDurationFrames,
  studioSnapshotSchema,
  syncBriefDuration,
  totalDuration,
  withTargetDuration,
} from '@asvs/domain';
import { createSeedSnapshot } from '@asvs/mock-data';
import {
  acceptSuggestion,
  approveProductionRun,
  buildReviewBundle,
  cancelProductionRun,
  createExportRecord,
  createProductionRun,
  createVideoPlan,
  delay,
  generateProjectKnowledge,
  interpretDirectorCommand,
  newId,
  nowIso,
  pauseProductionRun,
  rejectSuggestion,
  resumeProductionRun,
  retryProductionRun,
  reverifyClaim,
  setProductionSpeed,
  simulateConnection,
  syncKnowledge,
  tickExportRecord,
  tickProductionRun,
  type ExportConfig,
} from '@asvs/mock-services';

export interface VideoHistory {
  past: VideoProject[];
  future: VideoProject[];
}

export interface StudioData {
  projects: Project[];
  features: Feature[];
  claims: Claim[];
  evidence: Evidence[];
  pullRequests: PullRequest[];
  releases: Release[];
  suggestions: KnowledgeSuggestion[];
  assets: Asset[];
  templates: VideoTemplate[];
  videos: VideoProject[];
  runs: ProductionRun[];
  exports: ExportRecord[];
  activity: ActivityEvent[];
}

export interface CreateVideoInput {
  projectId: string;
  title: string;
  mode: VideoMode;
  brief: VideoBrief;
}

export interface ExportStartResult {
  ok: boolean;
  exportId?: string;
  message?: string;
}

export interface ReviewDecisionResult {
  ok: boolean;
  message: string;
}

/**
 * Persisted snapshot version. Bump this whenever `studioSnapshotSchema` gains
 * required fields and add a step to `migratePersistedStudioState`.
 */
export const STUDIO_PERSIST_VERSION = 2;

/**
 * Explicit v1 → v2 migration. v1 scenes only had the flat `visualType`; v2
 * adds the render IR (`visual`), `revision` and a frame cache, and videos get
 * an explicit `fps`. Never drop data here: unknown shapes are left untouched
 * so the `merge` validator can fall back to the seed instead of crashing.
 */
export function migratePersistedStudioState(persisted: unknown, fromVersion: number): unknown {
  if (!persisted || typeof persisted !== 'object') return persisted;
  if (fromVersion >= STUDIO_PERSIST_VERSION) return persisted;

  const candidate = persisted as Partial<StudioData> & Record<string, unknown>;
  if (!Array.isArray(candidate.videos)) return persisted;

  const videos = candidate.videos.map((video) => {
    const legacy = video as VideoProject & { fps?: number };
    const fps = legacy.fps ?? DEFAULT_VIDEO_FPS;
    return {
      ...legacy,
      fps,
      scenes: legacy.scenes.map((scene) => {
        const legacyScene = scene as Scene & {
          revision?: number;
          durationFrames?: number;
          visual?: Scene['visual'];
        };
        return {
          ...legacyScene,
          revision: legacyScene.revision ?? 1,
          durationFrames: legacyScene.durationFrames ?? sceneDurationFrames(legacyScene, fps),
          visual: legacyScene.visual ?? deriveSceneVisual(legacyScene),
        };
      }),
    };
  });

  return { ...candidate, videos };
}

export interface StudioState extends StudioData {
  history: Record<string, VideoHistory>;

  createProjectFromDraft: (draft: OnboardingDraft) => string;
  updateProject: (projectId: string, patch: Partial<Pick<Project, 'name' | 'productName' | 'description' | 'website' | 'defaultAspect' | 'defaultLanguage' | 'templateId'>>) => void;
  updateBrand: (projectId: string, brand: BrandKit) => void;
  testConnection: (input: { kind: 'github' | 'docs' | 'website'; value: string; branch?: string }) => Promise<ReturnType<typeof simulateConnection>>;
  syncProjectKnowledge: (projectId: string) => Promise<SyncKnowledgeResult | null>;
  acceptKnowledgeSuggestion: (suggestionId: string) => boolean;
  rejectKnowledgeSuggestion: (suggestionId: string) => void;
  reverifyClaim: (claimId: string) => boolean;
  updateFeature: (featureId: string, patch: Partial<Pick<Feature, 'name' | 'summary' | 'category' | 'status' | 'userConfirmed'>>) => void;

  createVideo: (input: CreateVideoInput) => string;
  renameVideo: (videoId: string, title: string) => void;
  deleteVideo: (videoId: string) => void;
  setVideoStage: (videoId: string, stage: VideoStage) => void;
  updateScene: (videoId: string, sceneId: string, patch: Partial<Scene>) => void;
  addScene: (videoId: string, afterSceneId?: string) => string | null;
  deleteScene: (videoId: string, sceneId: string) => boolean;
  reorderScenes: (videoId: string, orderedIds: string[]) => void;
  updateBrief: (videoId: string, patch: Partial<VideoBrief>) => void;
  sendDirectorCommand: (videoId: string, command: string, focusSceneId?: string) => Promise<DirectorResult | null>;
  undoVideo: (videoId: string) => void;
  redoVideo: (videoId: string) => void;

  startProduction: (videoId: string, scenario: RunScenario) => string | null;
  tickProduction: (runId: string, deltaMs: number) => void;
  pauseRun: (runId: string) => void;
  resumeRun: (runId: string) => void;
  cancelRun: (runId: string) => void;
  retryRun: (runId: string) => void;
  approveRun: (runId: string) => void;
  changeRunSpeed: (runId: string, speed: number) => void;

  approveVideo: (videoId: string, note?: string) => ReviewDecisionResult;
  requestVideoChanges: (videoId: string, note: string) => ReviewDecisionResult;

  startExport: (videoId: string, config: ExportConfig) => ExportStartResult;
  tickExports: (deltaMs: number) => void;
  resetDemoData: () => void;
}

const ACTIVITY_LIMIT = 80;
const HISTORY_LIMIT = 30;

function activity(
  state: Pick<StudioData, 'activity'>,
  event: Omit<ActivityEvent, 'id' | 'at'>,
): ActivityEvent[] {
  return [
    { ...event, id: newId('act'), at: nowIso() },
    ...state.activity,
  ].slice(0, ACTIVITY_LIMIT);
}

function findVideo(videos: VideoProject[], videoId: string): VideoProject | undefined {
  return videos.find((video) => video.id === videoId);
}

function replaceVideo(videos: VideoProject[], next: VideoProject): VideoProject[] {
  return videos.map((video) => (video.id === next.id ? next : video));
}

function pushHistory(
  history: Record<string, VideoHistory>,
  videoId: string,
  previous: VideoProject,
): Record<string, VideoHistory> {
  const entry = history[videoId] ?? { past: [], future: [] };
  return {
    ...history,
    [videoId]: {
      past: [...entry.past, previous].slice(-HISTORY_LIMIT),
      future: [],
    },
  };
}

/** Content changes invalidate an existing approval instead of silently keeping it. */
function withReviewInvalidation(video: VideoProject, next: VideoProject): VideoProject {
  if (video.review?.status === 'approved' || video.stage === 'approved' || video.stage === 'exported') {
    return {
      ...next,
      stage: video.stage === 'exported' ? 'approved' : 'changes_requested',
      review: {
        status: 'pending',
        note: '工程在审核后发生修改，需要重新运行生产并审核。',
      },
    };
  }
  return next;
}

function commitVideoEdit(
  state: StudioState,
  videoId: string,
  build: (video: VideoProject) => VideoProject,
): Partial<StudioState> | null {
  const video = findVideo(state.videos, videoId);
  if (!video) return null;
  const built = build(video);
  const next = withReviewInvalidation(video, {
    ...built,
    updatedAt: nowIso(),
  });
  return {
    videos: replaceVideo(state.videos, next),
    history: pushHistory(state.history, videoId, video),
  };
}

function buildBundle(state: StudioState, videoId: string): ReviewBundle | null {
  const video = findVideo(state.videos, videoId);
  if (!video) return null;
  const project = state.projects.find((item) => item.id === video.projectId);
  if (!project) return null;
  return buildReviewBundle({
    video,
    project,
    features: state.features.filter((feature) => feature.projectId === project.id),
    claims: state.claims.filter((claim) => claim.projectId === project.id),
    evidence: state.evidence.filter((item) => item.projectId === project.id),
    runs: state.runs.filter((run) => run.videoId === video.id),
  });
}

function resetDataFromSeed(): StudioData {
  const seed: StudioSnapshot = createSeedSnapshot();
  return {
    ...seed,
    activity: seed.activity.map((event) => ({ ...event })),
  };
}

export function selectReviewBundle(state: StudioState, videoId: string): ReviewBundle | null {
  return buildBundle(state, videoId);
}

export function selectDirectorContext(state: StudioState, projectId: string): DirectorContext {
  return {
    features: state.features.filter((feature) => feature.projectId === projectId),
    claims: state.claims.filter((claim) => claim.projectId === projectId),
    evidence: state.evidence.filter((item) => item.projectId === projectId),
    assets: state.assets.filter((asset) => asset.projectId === projectId),
  };
}

export function selectProjectFeatures(state: StudioState, projectId: string): Feature[] {
  return state.features.filter((feature) => feature.projectId === projectId);
}

export function selectProjectVideos(state: StudioState, projectId: string): VideoProject[] {
  return state.videos
    .filter((video) => video.projectId === projectId)
    .sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime());
}

export function canUndoVideo(state: StudioState, videoId: string): boolean {
  return (state.history[videoId]?.past.length ?? 0) > 0;
}

export function canRedoVideo(state: StudioState, videoId: string): boolean {
  return (state.history[videoId]?.future.length ?? 0) > 0;
}

export const useStudioStore = create<StudioState>()(
  persist(
    (set, get) => ({
      ...resetDataFromSeed(),
      history: {},

      createProjectFromDraft: (draft) => {
        const { project, knowledge } = generateProjectKnowledge(draft);
        set((state) => ({
          projects: [project, ...state.projects],
          features: [...knowledge.features, ...state.features],
          claims: [...knowledge.claims, ...state.claims],
          evidence: [...knowledge.evidence, ...state.evidence],
          pullRequests: [...(knowledge.pullRequests ?? []), ...state.pullRequests],
          releases: [...(knowledge.releases ?? []), ...state.releases],
          suggestions: [...knowledge.suggestions, ...state.suggestions],
          activity: activity(state, {
            projectId: project.id,
            kind: 'project',
            title: `创建项目「${project.name}」`,
            detail: `来自 ${project.sources.length} 个模拟来源，生成 ${knowledge.features.length} 个候选功能。`,
          }),
        }));
        return project.id;
      },

      updateProject: (projectId, patch) => {
        set((state) => ({
          projects: state.projects.map((project) =>
            project.id === projectId
              ? { ...project, ...patch, updatedAt: nowIso() }
              : project,
          ),
        }));
      },

      updateBrand: (projectId, brand) => {
        const timestamp = nowIso();
        set((state) => ({
          projects: state.projects.map((project) =>
            project.id === projectId ? { ...project, brand, updatedAt: timestamp } : project,
          ),
          videos: state.videos.map((video) => {
            if (video.projectId !== projectId) return video;
            if (video.review?.status === 'approved' || video.stage === 'approved' || video.stage === 'exported') {
              return {
                ...video,
                stage: 'changes_requested',
                review: {
                  status: 'pending',
                  note: '品牌资产已更新，需重新运行生产并审核。',
                },
                updatedAt: timestamp,
              };
            }
            return { ...video, updatedAt: timestamp };
          }),
          activity: activity(state, {
            projectId,
            kind: 'project',
            title: '品牌套件已更新',
            detail: '品牌字标 / 色彩 / 字体已在所有模拟预览中生效；已审核视频需要重新审核。',
          }),
        }));
      },

      testConnection: async (input) => {
        await delay(850);
        return simulateConnection(input);
      },

      syncProjectKnowledge: async (projectId) => {
        await delay(1100);
        const state = get();
        const project = state.projects.find((item) => item.id === projectId);
        if (!project) return null;
        const result = syncKnowledge({
          project,
          features: state.features.filter((feature) => feature.projectId === projectId),
          claims: state.claims.filter((claim) => claim.projectId === projectId),
          suggestions: state.suggestions.filter((suggestion) => suggestion.projectId === projectId),
        });
        set((current) => ({
          projects: current.projects.map((item) =>
            item.id === projectId ? result.project : item,
          ),
          suggestions: result.suggestion
            ? [result.suggestion, ...current.suggestions]
            : current.suggestions,
          activity: activity(current, {
            projectId,
            kind: 'knowledge',
            title: '知识同步完成',
            detail: result.message,
          }),
        }));
        return result;
      },

      acceptKnowledgeSuggestion: (suggestionId) => {
        const state = get();
        const suggestion = state.suggestions.find((item) => item.id === suggestionId);
        if (!suggestion || suggestion.status !== 'pending') return false;
        const resolution = acceptSuggestion(
          suggestion,
          state.features.filter((feature) => feature.projectId === suggestion.projectId),
          state.claims.filter((claim) => claim.projectId === suggestion.projectId),
        );
        if (!resolution) return false;

        set((current) => ({
          suggestions: current.suggestions.map((item) =>
            item.id === suggestionId ? resolution.suggestion : item,
          ),
          features: resolution.feature
            ? [resolution.feature, ...current.features.filter((item) => item.id !== resolution.feature!.id)]
            : current.features,
          claims: resolution.claim
            ? current.claims.map((item) => (item.id === resolution.claim!.id ? resolution.claim! : item))
            : current.claims,
          evidence: resolution.evidence
            ? [resolution.evidence, ...current.evidence]
            : current.evidence,
          activity: activity(current, {
            projectId: suggestion.projectId,
            kind: 'knowledge',
            title: '接受知识建议',
            detail: resolution.message,
          }),
        }));
        return true;
      },

      rejectKnowledgeSuggestion: (suggestionId) => {
        set((state) => {
          const suggestion = state.suggestions.find((item) => item.id === suggestionId);
          if (!suggestion) return state;
          return {
            suggestions: state.suggestions.map((item) =>
              item.id === suggestionId ? rejectSuggestion(item) : item,
            ),
            activity: activity(state, {
              projectId: suggestion.projectId,
              kind: 'knowledge',
              title: '拒绝知识建议',
              detail: suggestion.title,
            }),
          };
        });
      },

      reverifyClaim: (claimId) => {
        const state = get();
        const claim = state.claims.find((item) => item.id === claimId);
        if (!claim) return false;
        const feature = state.features.find((item) => item.id === claim.featureId);
        if (!feature) return false;
        const result = reverifyClaim(claim, feature);
        set((current) => ({
          claims: current.claims.map((item) => (item.id === claimId ? result.claim : item)),
          features: current.features.map((item) =>
            item.id === feature.id ? result.feature : item,
          ),
          evidence: [result.evidence, ...current.evidence],
          activity: activity(current, {
            projectId: claim.projectId,
            kind: 'knowledge',
            title: `重新验证「${feature.name}」`,
            detail: '模拟运行时证据已补充，声明状态更新为 verified。',
          }),
        }));
        return true;
      },

      updateFeature: (featureId, patch) => {
        set((state) => {
          const feature = state.features.find((item) => item.id === featureId);
          if (!feature) return state;
          return {
            features: state.features.map((item) =>
              item.id === featureId ? { ...item, ...patch, updatedAt: nowIso() } : item,
            ),
            activity: activity(state, {
              projectId: feature.projectId,
              kind: 'knowledge',
              title: `更新功能「${patch.name ?? feature.name}」`,
              detail: '知识变更会同步到依赖该功能的视频镜头与审核检查。',
            }),
          };
        });
      },

      createVideo: (input) => {
        const state = get();
        const project = state.projects.find((item) => item.id === input.projectId);
        if (!project) throw new Error('项目不存在');
        const release = state.releases
          .filter((item) => item.projectId === project.id)
          .sort((a, b) => new Date(b.releasedAt).getTime() - new Date(a.releasedAt).getTime())[0];
        const video = createVideoPlan({
          project,
          videoTitle: input.title,
          brief: input.brief,
          mode: input.mode,
          features: state.features.filter((feature) => feature.projectId === project.id),
          claims: state.claims.filter((claim) => claim.projectId === project.id),
          assets: state.assets.filter((asset) => asset.projectId === project.id),
          release: input.brief.releaseId ? release : undefined,
        });
        set((current) => ({
          videos: [video, ...current.videos],
          activity: activity(current, {
            projectId: project.id,
            videoId: video.id,
            kind: 'video',
            title: `创建视频「${video.title}」`,
            detail: `${video.scenes.length} 个镜头 / ${totalDuration(video.scenes)} 秒 · 等待脚本确认`,
          }),
        }));
        return video.id;
      },

      renameVideo: (videoId, title) => {
        set((state) => {
          const video = findVideo(state.videos, videoId);
          if (!video || !title.trim()) return state;
          return {
            videos: replaceVideo(state.videos, {
              ...video,
              title: title.trim(),
              updatedAt: nowIso(),
            }),
          };
        });
      },

      deleteVideo: (videoId) => {
        set((state) => {
          const video = findVideo(state.videos, videoId);
          if (!video) return state;
          const history = { ...state.history };
          delete history[videoId];
          return {
            videos: state.videos.filter((item) => item.id !== videoId),
            runs: state.runs.filter((run) => run.videoId !== videoId),
            exports: state.exports.filter((item) => item.videoId !== videoId),
            history,
            activity: activity(state, {
              projectId: video.projectId,
              kind: 'video',
              title: `删除视频「${video.title}」`,
              detail: '相关模拟生产与导出记录已一并移除。',
            }),
          };
        });
      },

      setVideoStage: (videoId, stage) => {
        set((state) => {
          const video = findVideo(state.videos, videoId);
          if (!video || video.stage === stage) return state;
          return {
            videos: replaceVideo(state.videos, { ...video, stage, updatedAt: nowIso() }),
          };
        });
      },

      updateScene: (videoId, sceneId, patch) => {
        set((state) => {
          const video = findVideo(state.videos, videoId);
          if (!video) return state;
          const scene = video.scenes.find((item) => item.id === sceneId);
          if (!scene) return state;
          let scenes = video.scenes.map((item) =>
            item.id === sceneId ? { ...item, ...patch } : item,
          );
          if (patch.durationSec !== undefined) {
            scenes = normalizeSceneOrder(scenes);
          }
          const changed = commitVideoEdit(state, videoId, (current) => {
            const nextScenes =
              patch.durationSec !== undefined ? scenes : current.scenes.map((item) => item.id === sceneId ? { ...item, ...patch } : item);
            return syncBriefDuration({ ...current, scenes: nextScenes });
          });
          return changed ?? state;
        });
      },

      addScene: (videoId, afterSceneId) => {
        const state = get();
        const video = findVideo(state.videos, videoId);
        if (!video) return null;
        const scenes = orderedScenes(video.scenes);
        const targetIndex = afterSceneId
          ? Math.max(0, scenes.findIndex((scene) => scene.id === afterSceneId))
          : scenes.length - 1;
        const previous = scenes[targetIndex];
        const scene: Scene = {
          id: newId('scene'),
          order: targetIndex + 1,
          revision: 1,
          title: '新镜头',
          intent: '补充一个可验证的产品瞬间',
          narration: '在这里补充旁白。',
          caption: '在这里补充字幕。',
          durationSec: 4,
          visualType: previous?.visualType === 'real_demo' ? 'real_demo' : 'motion',
          templateId: previous?.templateId ?? video.brief.templateId,
          featureId: previous?.featureId,
          claimIds: [],
          status: 'draft',
          look: previous?.look ?? 'clean',
          brightness: 1,
          vignette: false,
        };
        const nextScenes = normalizeSceneOrder([
          ...scenes.slice(0, targetIndex + 1),
          scene,
          ...scenes.slice(targetIndex + 1),
        ]);
        set((current) => {
          const currentVideo = findVideo(current.videos, videoId);
          if (!currentVideo) return current;
          const built = syncBriefDuration({ ...currentVideo, scenes: nextScenes });
          const changed = commitVideoEdit(current, videoId, () => built);
          return changed ?? current;
        });
        return scene.id;
      },

      deleteScene: (videoId, sceneId) => {
        const state = get();
        const video = findVideo(state.videos, videoId);
        if (!video || video.scenes.length <= 1) return false;
        const scenes = normalizeSceneOrder(video.scenes.filter((scene) => scene.id !== sceneId));
        set((current) => {
          const currentVideo = findVideo(current.videos, videoId);
          if (!currentVideo) return current;
          const built = syncBriefDuration({ ...currentVideo, scenes });
          const changed = commitVideoEdit(current, videoId, () => built);
          return changed ?? current;
        });
        return true;
      },

      reorderScenes: (videoId, orderedIds) => {
        set((state) => {
          const video = findVideo(state.videos, videoId);
          if (!video) return state;
          const map = new Map(video.scenes.map((scene) => [scene.id, scene]));
          const reordered = orderedIds
            .map((id) => map.get(id))
            .filter((scene): scene is Scene => Boolean(scene));
          video.scenes.forEach((scene) => {
            if (!orderedIds.includes(scene.id)) reordered.push(scene);
          });
          const nextScenes = normalizeSceneOrder(reordered);
          const changed = commitVideoEdit(state, videoId, (current) => ({
            ...current,
            scenes: nextScenes,
          }));
          return changed ?? state;
        });
      },

      updateBrief: (videoId, patch) => {
        set((state) => {
          const video = findVideo(state.videos, videoId);
          if (!video) return state;
          const nextBrief = { ...video.brief, ...patch };
          let scenes = video.scenes;
          if (patch.templateId && patch.templateId !== video.brief.templateId) {
            scenes = scenes.map((scene) => ({ ...scene, templateId: patch.templateId! }));
          }
          if (patch.durationSec !== undefined && patch.durationSec !== video.brief.durationSec) {
            scenes = withTargetDuration(scenes, patch.durationSec);
            nextBrief.durationSec = totalDuration(scenes);
          }
          const changed = commitVideoEdit(state, videoId, (current) => ({
            ...current,
            brief: nextBrief,
            scenes,
          }));
          return changed ?? state;
        });
      },

      sendDirectorCommand: async (videoId, command, focusSceneId) => {
        const text = command.trim();
        if (!text) return null;
        const state = get();
        const video = findVideo(state.videos, videoId);
        if (!video) return null;
        const project = state.projects.find((item) => item.id === video.projectId);
        if (!project) return null;

        const userMessage = {
          id: newId('dm'),
          role: 'user' as const,
          text,
          at: nowIso(),
        };
        set((current) => ({
          videos: replaceVideo(
            current.videos,
            { ...video, directorMessages: [...video.directorMessages, userMessage] },
          ),
        }));

        await delay(650);

        const freshState = get();
        const freshVideo = findVideo(freshState.videos, videoId);
        if (!freshVideo) return null;
        const result = interpretDirectorCommand({
          command: text,
          video: freshVideo,
          context: selectDirectorContext(freshState, project.id),
          focusSceneId,
        });

        if (!result.recognized || result.changes.length === 0) {
          const nextVideo: VideoProject = {
            ...freshVideo,
            directorMessages: [
              ...freshVideo.directorMessages,
              {
                id: newId('dm'),
                role: 'assistant',
                text: result.reply,
                at: nowIso(),
              },
            ],
          };
          set((current) => ({
            videos: replaceVideo(current.videos, nextVideo),
          }));
          return result;
        }

        const assistantMessage = {
          id: newId('dm'),
          role: 'assistant' as const,
          text: result.reply,
          at: nowIso(),
          changes: result.changes,
        };
        const nextVideo: VideoProject = {
          ...result.video,
          directorMessages: [...result.video.directorMessages, assistantMessage],
        };
        set((current) => {
          const changed = commitVideoEdit(current, videoId, () => nextVideo);
          if (!changed) return current;
          return {
            ...changed,
            activity: activity(current, {
              projectId: project.id,
              videoId,
              kind: 'video',
              title: 'AI 导演调整了脚本',
              detail: `${text.slice(0, 40)}${text.length > 40 ? '…' : ''} · ${result.changes
                .map((change) => change.label)
                .join('、')}`,
            }),
          };
        });
        return { ...result, video: nextVideo };
      },

      undoVideo: (videoId) => {
        set((state) => {
          const entry = state.history[videoId];
          const video = findVideo(state.videos, videoId);
          if (!entry || entry.past.length === 0 || !video) return state;
          const previous = entry.past[entry.past.length - 1]!;
          return {
            videos: replaceVideo(state.videos, previous),
            history: {
              ...state.history,
              [videoId]: {
                past: entry.past.slice(0, -1),
                future: [video, ...entry.future].slice(0, HISTORY_LIMIT),
              },
            },
          };
        });
      },

      redoVideo: (videoId) => {
        set((state) => {
          const entry = state.history[videoId];
          const video = findVideo(state.videos, videoId);
          if (!entry || entry.future.length === 0 || !video) return state;
          const next = entry.future[0]!;
          return {
            videos: replaceVideo(state.videos, next),
            history: {
              ...state.history,
              [videoId]: {
                past: [...entry.past, video].slice(-HISTORY_LIMIT),
                future: entry.future.slice(1),
              },
            },
          };
        });
      },

      startProduction: (videoId, scenario) => {
        const state = get();
        const video = findVideo(state.videos, videoId);
        if (!video) return null;
        const active = state.runs.find(
          (run) =>
            run.videoId === videoId &&
            ['queued', 'running', 'paused', 'awaiting_approval'].includes(run.status),
        );
        if (active) return active.id;
        const run = createProductionRun({ video, scenario });
        set((current) => ({
          runs: [run, ...current.runs],
          videos: replaceVideo(current.videos, { ...video, stage: 'producing' }),
          activity: activity(current, {
            projectId: video.projectId,
            videoId,
            kind: 'production',
            title: `开始模拟生产「${video.title}」`,
            detail: `${run.steps.length} 个确定性步骤 · 场景 ${scenario}`,
          }),
        }));
        return run.id;
      },

      tickProduction: (runId, deltaMs) => {
        set((state) => {
          const run = state.runs.find((item) => item.id === runId);
          if (!run) return state;
          const nextRun = tickProductionRun(run, deltaMs);
          if (nextRun === run) return state;
          let videos = state.videos;
          let nextActivity = state.activity;
          const video = findVideo(videos, run.videoId);
          if (video && run.status !== 'succeeded' && nextRun.status === 'succeeded') {
            const producedAt = nowIso();
            videos = replaceVideo(videos, {
              ...video,
              stage: 'review',
              producedAt,
              review: { status: 'pending' },
            });
            nextActivity = activity({ activity: nextActivity }, {
              projectId: video.projectId,
              videoId: video.id,
              kind: 'production',
              title: `模拟生产完成「${video.title}」`,
              detail: '工程已锁定本次生产版本，等待审核。未生成真实媒体文件。',
            });
          }
          if (video && run.status !== 'failed' && nextRun.status === 'failed') {
            videos = replaceVideo(videos, { ...video, stage: 'producing' });
            nextActivity = activity({ activity: nextActivity }, {
              projectId: video.projectId,
              videoId: video.id,
              kind: 'production',
              title: '模拟生产失败',
              detail: nextRun.failure?.message ?? '运行在录屏步骤失败。',
            });
          }
          return {
            runs: state.runs.map((item) => (item.id === runId ? nextRun : item)),
            videos,
            activity: nextActivity,
          };
        });
      },

      pauseRun: (runId) => {
        set((state) => ({
          runs: state.runs.map((run) => (run.id === runId ? pauseProductionRun(run) : run)),
        }));
      },

      resumeRun: (runId) => {
        set((state) => ({
          runs: state.runs.map((run) => (run.id === runId ? resumeProductionRun(run) : run)),
        }));
      },

      cancelRun: (runId) => {
        set((state) => {
          const run = state.runs.find((item) => item.id === runId);
          if (!run) return state;
          const nextRun = cancelProductionRun(run);
          let videos = state.videos;
          const video = findVideo(videos, run.videoId);
          if (video && ['running', 'paused', 'awaiting_approval'].includes(run.status)) {
            videos = replaceVideo(videos, { ...video, stage: 'storyboard_ready' });
          }
          return {
            runs: state.runs.map((item) => (item.id === runId ? nextRun : item)),
            videos,
            activity: activity(state, {
              projectId: run.projectId,
              videoId: run.videoId,
              kind: 'production',
              title: '取消模拟生产',
              detail: '未完成的步骤已跳过。',
            }),
          };
        });
      },

      retryRun: (runId) => {
        set((state) => {
          const run = state.runs.find((item) => item.id === runId);
          if (!run) return state;
          const nextRun = retryProductionRun(run);
          if (nextRun === run) return state;
          return {
            runs: state.runs.map((item) => (item.id === runId ? nextRun : item)),
            activity: activity(state, {
              projectId: run.projectId,
              videoId: run.videoId,
              kind: 'production',
              title: '重试失败步骤',
              detail: nextRun.failure ? '失败步骤已重置。' : '运行继续。',
            }),
          };
        });
      },

      approveRun: (runId) => {
        set((state) => {
          const run = state.runs.find((item) => item.id === runId);
          if (!run) return state;
          const nextRun = approveProductionRun(run);
          if (nextRun === run) return state;
          return {
            runs: state.runs.map((item) => (item.id === runId ? nextRun : item)),
            activity: activity(state, {
              projectId: run.projectId,
              videoId: run.videoId,
              kind: 'production',
              title: '批准生产 Gate',
              detail: 'Gate 2 通过，模拟录制步骤继续。',
            }),
          };
        });
      },

      changeRunSpeed: (runId, speed) => {
        set((state) => ({
          runs: state.runs.map((run) =>
            run.id === runId ? setProductionSpeed(run, speed) : run,
          ),
        }));
      },

      approveVideo: (videoId, note) => {
        const state = get();
        const bundle = buildBundle(state, videoId);
        const video = findVideo(state.videos, videoId);
        if (!video) return { ok: false, message: '视频不存在。' };
        if (!bundle) return { ok: false, message: '审核数据不完整。' };
        if (!bundle.canApprove) {
          return {
            ok: false,
            message: `仍有 ${bundle.failCount} 项检查未通过，不能批准。`,
          };
        }
        const decidedAt = nowIso();
        set((current) => ({
          videos: replaceVideo(current.videos, {
            ...video,
            stage: 'approved',
            review: { status: 'approved', note, decidedAt },
          }),
          activity: activity(current, {
            projectId: video.projectId,
            videoId,
            kind: 'review',
            title: `审核通过「${video.title}」`,
            detail: bundle.warnCount > 0 ? `通过，但有 ${bundle.warnCount} 项提醒已被记录。` : '全部检查通过。',
          }),
        }));
        return { ok: true, message: '已批准当前工程版本，可以导出。' };
      },

      requestVideoChanges: (videoId, note) => {
        const state = get();
        const video = findVideo(state.videos, videoId);
        if (!video) return { ok: false, message: '视频不存在。' };
        if (!note.trim()) return { ok: false, message: '请填写需要修改的内容。' };
        set((current) => ({
          videos: replaceVideo(current.videos, {
            ...video,
            stage: 'changes_requested',
            review: { status: 'changes_requested', note: note.trim(), decidedAt: nowIso() },
          }),
          activity: activity(current, {
            projectId: video.projectId,
            videoId,
            kind: 'review',
            title: `退回修改「${video.title}」`,
            detail: note.trim().slice(0, 80),
          }),
        }));
        return { ok: true, message: '已记录修改意见，视频回到待修改状态。' };
      },

      startExport: (videoId, config) => {
        const state = get();
        const video = findVideo(state.videos, videoId);
        if (!video) return { ok: false, message: '视频不存在。' };
        if (video.stage !== 'approved' && video.stage !== 'exported') {
          return { ok: false, message: '只有已通过审核的视频才能导出。' };
        }
        const record = createExportRecord({ video, config });
        set((current) => ({
          exports: [record, ...current.exports],
          videos:
            record.status === 'completed'
              ? replaceVideo(current.videos, { ...video, stage: 'exported' })
              : current.videos,
          activity: activity(current, {
            projectId: video.projectId,
            videoId,
            kind: 'export',
            title: record.simulated ? '开始模拟媒体导出' : '生成真实可下载文件',
            detail: record.note,
          }),
        }));
        return { ok: true, exportId: record.id };
      },

      tickExports: (deltaMs) => {
        set((state) => {
          if (!state.exports.some((record) => record.status === 'processing')) return state;
          let changed = false;
          const completed: ExportRecord[] = [];
          const exports = state.exports.map((record) => {
            const next = tickExportRecord(record, deltaMs);
            if (next !== record) changed = true;
            if (next.status === 'completed' && record.status !== 'completed') completed.push(next);
            return next;
          });
          if (!changed) return state;
          let videos = state.videos;
          let nextActivity = state.activity;
          completed.forEach((record) => {
            const video = findVideo(videos, record.videoId);
            if (video && record.simulated) {
              videos = replaceVideo(videos, { ...video, stage: 'exported' });
              nextActivity = activity({ activity: nextActivity }, {
                projectId: video.projectId,
                videoId: video.id,
                kind: 'export',
                title: '模拟导出完成',
                detail: '未生成真实 MP4/WebM 文件；可下载工程 JSON 与 SRT。',
              });
            }
          });
          return { exports, videos, activity: nextActivity };
        });
      },

      resetDemoData: () => {
        set({ ...resetDataFromSeed(), history: {} });
      },
    }),
    {
      name: 'asvs.studio.v1',
      version: STUDIO_PERSIST_VERSION,
      migrate: (persisted, version) => migratePersistedStudioState(persisted, version),
      partialize: (state) => {
        const { history: _history, ...rest } = state;
        return rest;
      },
      merge: (persisted, current) => {
        if (!persisted || typeof persisted !== 'object') return current;
        const candidate = persisted as Partial<StudioData>;
        try {
          studioSnapshotSchema.parse({
            projects: candidate.projects ?? [],
            features: candidate.features ?? [],
            claims: candidate.claims ?? [],
            evidence: candidate.evidence ?? [],
            pullRequests: candidate.pullRequests ?? [],
            releases: candidate.releases ?? [],
            suggestions: candidate.suggestions ?? [],
            assets: candidate.assets ?? [],
            templates: candidate.templates ?? [],
            videos: candidate.videos ?? [],
            runs: candidate.runs ?? [],
            exports: candidate.exports ?? [],
            activity: candidate.activity ?? [],
          });
          return {
            ...current,
            ...candidate,
            history: current.history,
          };
        } catch (error) {
          console.warn('丢弃无法校验的本地工作区快照', error);
          return current;
        }
      },
    },
  ),
);
