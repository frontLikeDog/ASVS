import { beforeEach, describe, expect, it } from 'vitest';
import type { PRChangeCandidateV1, Scene, VideoProject } from '@asvs/domain';
import { orderedScenes, studioSnapshotSchema, totalDuration } from '@asvs/domain';
import {
  STUDIO_PERSIST_VERSION,
  migratePersistedStudioState,
  useStudioStore,
} from './studio-store';
import {
  createRealGitHubProject,
  promotePRCandidate,
  reconcileDiscoveryCandidates,
} from './github-knowledge-actions';

const RELEASE_VIDEO = 'vid_lumen_release';
const TUTORIAL_VIDEO = 'vid_lumen_tutorial';

function store() {
  return useStudioStore.getState();
}

beforeEach(() => {
  localStorage.clear();
  store().resetDemoData();
});

describe('工作区种子与持久化数据', () => {
  it('默认加载两个演示项目与视频模板', () => {
    const state = store();
    expect(state.projects.map((project) => project.id)).toEqual(['proj_lumen', 'proj_pulse']);
    expect(state.videos.length).toBeGreaterThanOrEqual(2);
    expect(state.templates.length).toBeGreaterThan(0);

    const persisted = JSON.parse(localStorage.getItem('asvs.studio.v1') ?? '{}');
    expect(persisted.state.videos).toBeDefined();
    expect(persisted.state.history).toBeUndefined();
  });
});

describe('本地工作区迁移链', () => {
  function stripV2Fields(
    videos: VideoProject[],
  ): Array<Omit<VideoProject, 'fps'> & { fps?: number }> {
    return videos.map((video) => {
      const clone = structuredClone(video) as unknown as Omit<VideoProject, 'fps'> & {
        fps?: number;
      };
      delete clone.fps;
      clone.scenes.forEach((scene) => {
        const legacy = scene as unknown as Omit<
          Scene,
          'revision' | 'durationFrames' | 'visual'
        > & {
          revision?: number;
          durationFrames?: number;
          visual?: Scene['visual'];
        };
        delete legacy.revision;
        delete legacy.durationFrames;
        delete legacy.visual;
      });
      return clone;
    });
  }

  it('v1 快照迁移到 v2 后补齐 fps、revision、durationFrames 与 visual', () => {
    const state = store();
    const persisted = {
      projects: state.projects,
      features: state.features,
      claims: state.claims,
      evidence: state.evidence,
      pullRequests: state.pullRequests,
      releases: state.releases,
      suggestions: state.suggestions,
      assets: state.assets,
      templates: state.templates,
      videos: stripV2Fields(state.videos),
      runs: state.runs,
      exports: state.exports,
      activity: state.activity,
    };

    const migrated = migratePersistedStudioState(persisted, 1) as typeof persisted;
    const parsed = studioSnapshotSchema.parse(migrated);

    expect(parsed.videos.length).toBe(persisted.videos.length);
    for (const video of parsed.videos) {
      expect(video.fps).toBe(30);
      for (const scene of video.scenes) {
        expect(scene.revision).toBe(1);
        expect(scene.durationFrames).toBe(Math.max(1, Math.round(scene.durationSec * video.fps)));
        expect(scene.visual).toBeDefined();
        expect(scene.visual?.type).toBe(
          scene.visualType === 'motion'
            ? 'motion_graphics'
            : scene.visualType === 'generated'
              ? 'generated_visual'
              : scene.visualType,
        );
      }
    }
  });

  it('已经是 v2 的快照不会被二次迁移', () => {
    const persisted = { videos: store().videos };
    expect(migratePersistedStudioState(persisted, STUDIO_PERSIST_VERSION)).toBe(persisted);
  });

  it('形状损坏的快照不抛错，留给 merge 回退到种子', () => {
    expect(() => migratePersistedStudioState({ videos: 'broken' }, 1)).not.toThrow();
    expect(migratePersistedStudioState(null, 1)).toBeNull();
  });
});

describe('镜头编辑历史', () => {
  it('修改字幕后可撤销与重做', () => {
    const video = store().videos.find((item) => item.id === RELEASE_VIDEO)!;
    const scene = orderedScenes(video.scenes)[0]!;
    const original = scene.caption;

    store().updateScene(RELEASE_VIDEO, scene.id, { caption: '新的字幕内容' });
    expect(
      store().videos.find((item) => item.id === RELEASE_VIDEO)!.scenes.find(
        (item) => item.id === scene.id,
      )!.caption,
    ).toBe('新的字幕内容');
    expect(store().history[RELEASE_VIDEO]?.past.length).toBeGreaterThan(0);

    store().undoVideo(RELEASE_VIDEO);
    expect(
      store().videos.find((item) => item.id === RELEASE_VIDEO)!.scenes.find(
        (item) => item.id === scene.id,
      )!.caption,
    ).toBe(original);

    store().redoVideo(RELEASE_VIDEO);
    expect(
      store().videos.find((item) => item.id === RELEASE_VIDEO)!.scenes.find(
        (item) => item.id === scene.id,
      )!.caption,
    ).toBe('新的字幕内容');
  });

  it('重排镜头会重写 order 并可按历史恢复', () => {
    const before = orderedScenes(
      store().videos.find((item) => item.id === TUTORIAL_VIDEO)!.scenes,
    );
    const reversed = [...before].reverse().map((scene) => scene.id);

    store().reorderScenes(TUTORIAL_VIDEO, reversed);
    const after = orderedScenes(
      store().videos.find((item) => item.id === TUTORIAL_VIDEO)!.scenes,
    );

    expect(after.map((scene) => scene.id)).toEqual(reversed);
    expect(after.map((scene) => scene.order)).toEqual(reversed.map((_, index) => index));

    store().undoVideo(TUTORIAL_VIDEO);
    const restored = orderedScenes(
      store().videos.find((item) => item.id === TUTORIAL_VIDEO)!.scenes,
    );
    expect(restored.map((scene) => scene.id)).toEqual(before.map((scene) => scene.id));
  });

  it('修改 Brief 时长会同步缩放场景并写回实际总时长', () => {
    store().updateBrief(TUTORIAL_VIDEO, { durationSec: 20 });
    const video = store().videos.find((item) => item.id === TUTORIAL_VIDEO)!;

    expect(totalDuration(video.scenes)).toBeCloseTo(20, 5);
    expect(video.brief.durationSec).toBeCloseTo(20, 5);
  });
});

describe('AI 导演接入状态', () => {
  it('导演命令修改真实工程并写入对话历史', async () => {
    const before = store().videos.find((item) => item.id === RELEASE_VIDEO)!;
    const result = await store().sendDirectorCommand(RELEASE_VIDEO, '把视频缩短到 24 秒');

    expect(result?.recognized).toBe(true);
    const after = store().videos.find((item) => item.id === RELEASE_VIDEO)!;
    expect(totalDuration(after.scenes)).toBeCloseTo(24, 5);
    expect(after.directorMessages.length).toBe(before.directorMessages.length + 2);
    expect(after.directorMessages.at(-1)?.role).toBe('assistant');
    expect(after.directorMessages.at(-1)?.changes?.length).toBeGreaterThan(0);
  });

  it('无法识别的命令只追加对话，不修改工程', async () => {
    const before = store().videos.find((item) => item.id === RELEASE_VIDEO)!;
    const result = await store().sendDirectorCommand(RELEASE_VIDEO, '换成真人出镜');
    const after = store().videos.find((item) => item.id === RELEASE_VIDEO)!;

    expect(result?.recognized).toBe(false);
    expect(after.scenes).toEqual(before.scenes);
    expect(after.directorMessages.at(-1)?.text).toContain('无法');
  });
});

describe('审核、导出与品牌失效', () => {
  it('没有成功生产运行时不能批准', () => {
    const result = store().approveVideo(TUTORIAL_VIDEO);
    expect(result.ok).toBe(false);
    expect(result.message).toContain('检查未通过');
  });

  it('未审核通过的视频不能导出', () => {
    const result = store().startExport(RELEASE_VIDEO, {
      format: 'json',
      aspect: '16:9',
      resolution: '1920×1080',
    });
    expect(result.ok).toBe(false);
    expect(result.message).toContain('只有已通过审核');
  });

  it('更新品牌会让已通过审核的视频回到待修改', () => {
    useStudioStore.setState((state) => ({
      videos: state.videos.map((video) =>
        video.id === RELEASE_VIDEO
          ? {
              ...video,
              stage: 'approved' as const,
              review: { status: 'approved' as const, decidedAt: '2026-11-14T00:00:00.000Z' },
            }
          : video,
      ),
    }));
    const project = store().projects.find((item) => item.id === 'proj_lumen')!;

    store().updateBrand('proj_lumen', { ...project.brand, primary: '#7C9CFF' });

    const video = store().videos.find((item) => item.id === RELEASE_VIDEO)!;
    expect(video.stage).toBe('changes_requested');
    expect(video.review?.status).toBe('pending');
    expect(video.review?.note).toContain('品牌资产已更新');
  });
});

describe('Step 4D 真实 GitHub 知识投影与过期失效', () => {
  const COMMIT_1 = '1111111111111111111111111111111111111111';
  const SNAP_1 = 'snap_11111111111111111111111111111111';
  const ISO_1 = '2026-11-27T10:00:00.000Z';

  function featureCandidate(overrides: Partial<PRChangeCandidateV1> = {}): PRChangeCandidateV1 {
    return {
      schemaVersion: '1',
      id: 'prc_0000000000000201',
      repo: 'acme/livenotes',
      pullNumber: 201,
      title: 'feat: add share link',
      author: 'alice',
      state: 'closed',
      draft: false,
      merged: true,
      mergedAt: ISO_1,
      baseBranch: 'main',
      headBranch: 'feat/share',
      headSha: COMMIT_1,
      mergeCommitSha: COMMIT_1,
      htmlUrl: 'https://github.com/acme/livenotes/pull/201',
      labels: ['feature'],
      classification: 'user_facing_feature',
      promotable: true,
      confidence: 88,
      rationale: ['feat 前缀'],
      snapshotId: SNAP_1,
      changedFiles: [
        {
          path: 'src/ui/share.tsx',
          status: 'modified',
          additions: 15,
          deletions: 2,
          category: 'ui',
        },
      ],
      diffStats: {
        filesChanged: 1,
        additions: 15,
        deletions: 2,
        userFacingFiles: 1,
        internalFiles: 0,
        renamedOnlyFiles: 0,
      },
      claims: [
        {
          schemaVersion: '1',
          id: 'claim_0000000000000201',
          candidateId: 'prc_0000000000000201',
          repo: 'acme/livenotes',
          pullNumber: 201,
          statement: '支持生成只读分享链接',
          audience: '所有产品用户',
          status: 'proposed',
          eligibility: 'blocked_unverified',
          verification: {
            commitSha: COMMIT_1,
            snapshotId: SNAP_1,
            environmentId: 'unverified',
            verifiedAt: ISO_1,
            validityScope: 'unverified',
            deployed: false,
          },
          evidenceIds: ['evd_0000000000000201'],
          blockers: ['缺少运行态证据'],
          guidance: '待验证',
        },
      ],
      evidence: [
        {
          id: 'evd_0000000000000201',
          kind: 'source',
          status: 'valid',
          title: '源码证据',
          detail: 'src/ui/share.tsx',
          filePath: 'src/ui/share.tsx',
          sourceDigest: 'a'.repeat(64),
          commitSha: COMMIT_1,
          snapshotId: SNAP_1,
          capturedAt: ISO_1,
        },
      ],
      analyzedAt: ISO_1,
      ...overrides,
    };
  }

  it('创建真实 GitHub 项目、AC-02 拒绝内部重构、写入可推广功能并在 AC-09 过期时失效已批准视频', () => {
    const projectId = createRealGitHubProject({
      name: 'LiveNotes Real',
      productName: 'LiveNotes',
      description: '真实仓库接入测试',
      website: '',
      methods: ['github'],
      githubRepo: 'acme/livenotes',
      branch: 'main',
      demoUrl: '',
      docs: [],
      resetStrategy: 'fixture',
      brand: store().projects[0]!.brand,
      defaultAspect: '16:9',
      defaultLanguage: 'zh-CN',
      templateId: 'tpl_signal',
      connections: {},
    });

    const project = store().projects.find((item) => item.id === projectId)!;
    expect(project.demo).toBe(false);
    expect(project.sources[0]!.demo).toBe(false);

    const internal: PRChangeCandidateV1 = {
      ...featureCandidate(),
      id: 'prc_0000000000000202',
      pullNumber: 202,
      title: 'refactor: cleanup',
      classification: 'internal_non_promotable',
      promotable: false,
      claims: [],
      evidence: [],
    };
    const rejected = promotePRCandidate(projectId, internal);
    expect(rejected.ok).toBe(false);

    const candidate = featureCandidate();
    const promoted = promotePRCandidate(projectId, candidate);
    expect(promoted.ok).toBe(true);

    const projClaim = store().claims.find((item) => item.projectId === projectId)!;
    expect(projClaim.demo).toBe(false);
    expect(projClaim.eligibility).toBe('blocked_unverified');

    const publishableCandidate = featureCandidate({
      claims: [
        {
          ...candidate.claims[0]!,
          status: 'verified',
          eligibility: 'publishable',
          blockers: [],
          verification: {
            ...candidate.claims[0]!.verification,
            environmentId: 'production',
            deployed: true,
            validityScope: 'production_runtime_approved',
          },
        },
      ],
    });
    reconcileDiscoveryCandidates(projectId, [publishableCandidate], {
      snapshotId: SNAP_1,
      commitSha: COMMIT_1,
    });
    expect(store().claims.find((item) => item.id === projClaim.id)!.eligibility).toBe('publishable');

    const vidId = store().createVideo({
      projectId,
      title: '分享功能发布',
      mode: 'release_video',
      brief: {
        objective: '介绍分享链接',
        audience: '用户',
        featureIds: [promoted.featureId!],
        durationSec: 20,
        aspect: '16:9',
        language: 'zh-CN',
        tone: 'confident',
        style: 'editorial',
        templateId: 'tpl_signal',
        useRealCapture: false,
        useGeneratedVisuals: false,
        cta: '试用',
        bannedPhrases: [],
      },
    });
    useStudioStore.setState((state) => ({
      videos: state.videos.map((v) =>
        v.id === vidId
          ? {
              ...v,
              stage: 'approved',
              review: { status: 'approved', decidedAt: ISO_1 },
            }
          : v,
      ),
    }));

    const staleCandidate = featureCandidate({
      claims: [
        {
          ...candidate.claims[0]!,
          status: 'stale',
          eligibility: 'blocked_stale',
          blockers: ['文件变更'],
        },
      ],
      evidence: [
        {
          ...candidate.evidence[0]!,
          status: 'stale',
        },
      ],
    });
    const summary = reconcileDiscoveryCandidates(projectId, [staleCandidate]);
    expect(summary.staleClaims).toBe(1);
    expect(summary.invalidatedVideoIds).toEqual([vidId]);

    const updatedVideo = store().videos.find((v) => v.id === vidId)!;
    expect(updatedVideo.stage).toBe('changes_requested');
    expect(updatedVideo.review?.status).toBe('pending');
  });
});
