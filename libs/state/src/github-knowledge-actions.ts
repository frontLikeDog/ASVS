import {
  projectCandidateTimeline,
  promoteCandidateToKnowledge,
  reconcileCandidatesIntoSnapshot,
  type ActivityEvent,
  type KnowledgeSnapshotV1,
  type OnboardingDraft,
  type PRChangeCandidateV1,
  type Project,
  type SourceConnection,
} from '@asvs/domain';
import { getStudioServices } from './services';
import { useStudioStore, type StudioData } from './studio-store';

const ACTIVITY_LIMIT = 80;

function nowIso(): string {
  return getStudioServices().clock.nowIso();
}

function newId(prefix: string): string {
  return getStudioServices().clock.newId(prefix);
}

function appendActivity(
  state: Pick<StudioData, 'activity'>,
  event: Omit<ActivityEvent, 'id' | 'at'>,
): ActivityEvent[] {
  return [{ ...event, id: newId('act'), at: nowIso() }, ...state.activity].slice(
    0,
    ACTIVITY_LIMIT,
  );
}

export function createRealGitHubProject(
  draft: OnboardingDraft,
  initial?: {
    snapshot?: KnowledgeSnapshotV1;
    candidates?: PRChangeCandidateV1[];
    readOnlyVerifiedAt?: string;
  },
): string {
  const timestamp = nowIso();
  const projectId = newId('proj');
  const name = draft.name.trim() || `${draft.productName.trim() || '新产品'} 视频项目`;
  const branch = draft.branch.trim() || 'main';
  const repoName = draft.githubRepo.trim();

  const sources: SourceConnection[] = draft.methods.map((kind) => {
    if (kind === 'github') {
      const existing = draft.connections.github;
      return {
        id: existing?.id || newId('src'),
        kind: 'github',
        name: repoName,
        detail:
          existing?.detail ||
          `只读 GitHub App · 分支 ${branch}${
            initial?.snapshot ? ` · 快照 ${initial.snapshot.id}` : ''
          }`,
        status: 'connected',
        scope: branch,
        lastSyncedAt: initial?.snapshot?.indexedAt ?? timestamp,
        ...(initial?.snapshot?.id ? { lastSnapshotId: initial.snapshot.id } : {}),
        ...(initial?.snapshot?.gitCommitSha
          ? { lastCommitSha: initial.snapshot.gitCommitSha }
          : {}),
        ...(initial?.readOnlyVerifiedAt
          ? { readOnlyVerifiedAt: initial.readOnlyVerifiedAt }
          : {}),
        demo: false,
      };
    }
    const existing = draft.connections[kind];
    if (existing) {
      return { ...existing, lastSyncedAt: timestamp };
    }
    const value = kind === 'website' ? draft.demoUrl : draft.docs[0] ?? '';
    return {
      id: newId('src'),
      kind,
      name:
        kind === 'website'
          ? value || '演示站点'
          : `产品文档 · ${draft.docs.filter(Boolean).length} 个页面`,
      detail: '入门向导记录的辅助参考来源',
      status: 'connected',
      scope: value,
      lastSyncedAt: timestamp,
      demo: true,
    };
  });

  const currentTemplates = useStudioStore.getState().templates;
  const templateId = currentTemplates.some((template) => template.id === draft.templateId)
    ? draft.templateId
    : 'tpl_signal';

  const project: Project = {
    id: projectId,
    name,
    productName: draft.productName.trim() || name,
    description: draft.description.trim(),
    website: draft.website.trim(),
    stage: 'active',
    brand: draft.brand,
    sources,
    defaultAspect: draft.defaultAspect,
    defaultLanguage: draft.defaultLanguage,
    templateId,
    analysisCount: initial?.snapshot ? 1 : 0,
    createdAt: timestamp,
    updatedAt: timestamp,
    demo: false,
  };

  useStudioStore.setState((state) => {
    const candidates = initial?.candidates ?? [];
    const timeline =
      candidates.length > 0
        ? projectCandidateTimeline(
            projectId,
            candidates,
            state.pullRequests,
            state.releases,
            state.features,
          )
        : { pullRequests: state.pullRequests, releases: state.releases };
    return {
      projects: [project, ...state.projects],
      pullRequests: timeline.pullRequests,
      releases: timeline.releases,
      activity: appendActivity(state, {
        projectId,
        kind: 'project',
        title: `创建真实只读项目「${project.name}」`,
        detail: `已接入 ${repoName}（${branch}），发现 ${candidates.length} 个 PR 候选。`,
      }),
    };
  });
  return projectId;
}

export function attachRealGitHubSource(
  projectId: string,
  input: {
    repo: string;
    branch: string;
    detail?: string;
    readOnlyVerifiedAt?: string;
    lastSnapshotId?: string;
    lastCommitSha?: string;
  },
): void {
  const timestamp = nowIso();
  const repoName = input.repo.trim();
  const branch = input.branch.trim() || 'main';
  useStudioStore.setState((state) => {
    const project = state.projects.find((item) => item.id === projectId);
    if (!project) return state;
    const existingGithub = project.sources.find((source) => source.kind === 'github');
    const nextSource: SourceConnection = {
      id: existingGithub?.id ?? newId('src'),
      kind: 'github',
      name: repoName,
      detail: input.detail ?? `只读 GitHub App · 分支 ${branch}`,
      status: 'connected',
      scope: branch,
      lastSyncedAt: timestamp,
      ...(input.lastSnapshotId
        ? { lastSnapshotId: input.lastSnapshotId }
        : existingGithub?.lastSnapshotId
          ? { lastSnapshotId: existingGithub.lastSnapshotId }
          : {}),
      ...(input.lastCommitSha
        ? { lastCommitSha: input.lastCommitSha }
        : existingGithub?.lastCommitSha
          ? { lastCommitSha: existingGithub.lastCommitSha }
          : {}),
      ...(input.readOnlyVerifiedAt
        ? { readOnlyVerifiedAt: input.readOnlyVerifiedAt }
        : existingGithub?.readOnlyVerifiedAt
          ? { readOnlyVerifiedAt: existingGithub.readOnlyVerifiedAt }
          : {}),
      demo: false,
    };
    const otherSources = project.sources.filter((source) => source.kind !== 'github');
    return {
      projects: state.projects.map((item) =>
        item.id === projectId
          ? {
              ...item,
              demo: false,
              updatedAt: timestamp,
              sources: [nextSource, ...otherSources],
            }
          : item,
      ),
      activity: appendActivity(state, {
        projectId,
        kind: 'knowledge',
        title: `绑定真实仓库 ${repoName}`,
        detail: `分支 ${branch} · 只读 GitHub App 连接。`,
      }),
    };
  });
}

export function promotePRCandidate(
  projectId: string,
  candidate: PRChangeCandidateV1,
): { ok: boolean; featureId?: string; message: string } {
  const state = useStudioStore.getState();
  const project = state.projects.find((item) => item.id === projectId);
  if (!project) return { ok: false, message: '项目不存在。' };
  const timestamp = nowIso();
  const result = promoteCandidateToKnowledge({
    projectId,
    candidate,
    features: state.features,
    claims: state.claims,
    evidence: state.evidence,
    pullRequests: state.pullRequests,
    releases: state.releases,
    nowIso: timestamp,
  });
  if (!result.ok) {
    return { ok: false, message: result.reason };
  }
  useStudioStore.setState((current) => ({
    features: result.features,
    claims: result.claims,
    evidence: result.evidence,
    pullRequests: result.pullRequests,
    releases: result.releases,
    activity: appendActivity(current, {
      projectId,
      kind: 'knowledge',
      title: `写入功能目录：PR #${candidate.pullNumber}`,
      detail: `已采纳「${candidate.title}」，Claim 初始状态仍需按证据核验（AC-03）。`,
    }),
  }));
  return {
    ok: true,
    featureId: result.featureId,
    message: `已将 PR #${candidate.pullNumber} 写入功能目录。`,
  };
}

export function reconcileDiscoveryCandidates(
  projectId: string,
  candidates: PRChangeCandidateV1[],
  snapshotMeta?: {
    snapshotId?: string;
    commitSha?: string;
    branch?: string;
    syncedAt?: string;
  },
): { updatedClaims: number; staleClaims: number; invalidatedVideoIds: string[] } {
  const state = useStudioStore.getState();
  const timestamp = snapshotMeta?.syncedAt ?? nowIso();
  const reconciled = reconcileCandidatesIntoSnapshot({
    projectId,
    candidates,
    features: state.features,
    claims: state.claims,
    evidence: state.evidence,
    pullRequests: state.pullRequests,
    releases: state.releases,
    videos: state.videos,
    nowIso: timestamp,
  });

  useStudioStore.setState((current) => ({
    projects: current.projects.map((project) => {
      if (project.id !== projectId) return project;
      return {
        ...project,
        analysisCount: snapshotMeta ? project.analysisCount + 1 : project.analysisCount,
        updatedAt: timestamp,
        sources: project.sources.map((source) =>
          source.kind === 'github' && source.demo === false
            ? {
                ...source,
                lastSyncedAt: timestamp,
                ...(snapshotMeta?.branch ? { scope: snapshotMeta.branch } : {}),
                ...(snapshotMeta?.snapshotId ? { lastSnapshotId: snapshotMeta.snapshotId } : {}),
                ...(snapshotMeta?.commitSha ? { lastCommitSha: snapshotMeta.commitSha } : {}),
              }
            : source,
        ),
      };
    }),
    features: reconciled.features,
    claims: reconciled.claims,
    evidence: reconciled.evidence,
    pullRequests: reconciled.pullRequests,
    releases: reconciled.releases,
    videos: reconciled.videos,
    activity: appendActivity(current, {
      projectId,
      kind: 'knowledge',
      title: '同步真实 PR 发现与证据状态',
      detail:
        reconciled.summary.invalidatedVideoIds.length > 0
          ? `更新 ${reconciled.summary.updatedClaims} 条声明；${reconciled.summary.staleClaims} 条声明过期，已使 ${reconciled.summary.invalidatedVideoIds.length} 条已批准视频回到待修改（AC-09）。`
          : `同步 ${candidates.length} 个 PR 候选，更新 ${reconciled.summary.updatedClaims} 条声明。`,
    }),
  }));

  return reconciled.summary;
}
