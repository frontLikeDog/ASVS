// @vitest-environment node
import { createHash } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import type { DatabaseSync } from 'node:sqlite';
import type {
  GitHubConnectionStatus,
  GitHubPullRequestFile,
  GitHubPullRequestSummary,
  GitHubReleaseSummary,
  GitHubRepoRef,
  KnowledgeSnapshotV1,
} from '@asvs/domain';
import type { GitHubReadOnlyPort, GitHubTreeEntry } from '@asvs/ports';
import { openDatabase } from '../db/database';
import { SqliteKnowledgeSnapshotStore } from '../db/knowledge-store';
import { SqlitePRDiscoveryStore } from '../db/pr-discovery-store';
import { PRDiscoveryError, PRDiscoveryService } from './pr-discovery-service';

const REPO: GitHubRepoRef = { owner: 'frontLikeDog', repo: 'livenotes' };
const FULL_REPO = 'frontLikeDog/livenotes';
const COMMIT = '1'.repeat(40);
const MERGE_12 = '2'.repeat(40);
const MERGE_13 = '3'.repeat(40);
const MERGE_14 = '4'.repeat(40);
const MERGE_15 = '5'.repeat(40);
const SNAPSHOT_ID = `snap_${'a'.repeat(32)}`;
const NEXT_SNAPSHOT_ID = `snap_${'b'.repeat(32)}`;

function digest(content: string): string {
  return createHash('sha256').update(content).digest('hex');
}

function pr(
  number: number,
  title: string,
  mergeCommitSha: string,
  overrides: Partial<GitHubPullRequestSummary> = {},
): GitHubPullRequestSummary {
  return {
    id: 1000 + number,
    number,
    title,
    body: null,
    state: 'closed',
    draft: false,
    merged: true,
    mergedAt: '2026-11-26T08:00:00.000Z',
    createdAt: '2026-11-24T08:00:00.000Z',
    updatedAt: '2026-11-26T08:00:00.000Z',
    author: 'frontLikeDog',
    labels: [],
    headSha: COMMIT,
    baseBranch: 'main',
    headBranch: `feat/pr-${number}`,
    mergeCommitSha,
    htmlUrl: `https://github.com/frontLikeDog/livenotes/pull/${number}`,
    ...overrides,
  };
}

function file(
  filename: string,
  overrides: Partial<GitHubPullRequestFile> = {},
): GitHubPullRequestFile {
  return { filename, status: 'modified', additions: 12, deletions: 3, changes: 15, ...overrides };
}

const PULLS: GitHubPullRequestSummary[] = [
  pr(12, 'feat(notes): 支持增量同步', MERGE_12),
  pr(13, 'refactor(notes): 拆分同步模块', MERGE_13),
  pr(14, 'move note files', MERGE_14),
  pr(15, 'Note sync polish', MERGE_15),
];

const FILES: Record<number, GitHubPullRequestFile[]> = {
  12: [
    file('libs/features/notes/src/sync-panel.tsx'),
    file('apps/api/src/routes/notes.ts'),
    file('libs/features/notes/src/sync-panel.test.tsx'),
  ],
  13: [
    file('libs/features/notes/src/sync-panel.tsx'),
    file('libs/features/notes/src/sync-panel-store.ts'),
  ],
  14: [
    file('libs/features/notes/src/panel/index.tsx', {
      status: 'renamed',
      previousFilename: 'libs/features/notes/src/sync-panel.tsx',
      additions: 0,
      deletions: 0,
    }),
  ],
  15: [file('libs/features/notes/src/polish.tsx')],
};

const RELEASES: GitHubReleaseSummary[] = [];

function buildSnapshot(
  id: string,
  digests: Record<string, string>,
  overrides: Partial<KnowledgeSnapshotV1> = {},
): KnowledgeSnapshotV1 {
  const paths = Object.keys(digests);
  return {
    schemaVersion: '1',
    id,
    repo: FULL_REPO,
    branch: 'main',
    gitCommitSha: COMMIT,
    indexedAt: '2026-11-27T09:00:00.000Z',
    sourceDigests: digests,
    files: paths.map((path) => ({
      path,
      language: path.endsWith('.tsx') ? 'typescript' : 'typescript',
      byteSize: 100,
      lineCount: 10,
      blobSha: '6'.repeat(40),
      headings: [],
      symbols:
        path === 'apps/api/src/routes/notes.ts'
          ? [{ name: 'listNotes', kind: 'route' as const, line: 4 }]
          : [],
      entrypoints: [],
    })),
    skipped: [],
    entrypoints: [],
    stats: {
      mode: 'cold',
      totalFiles: paths.length,
      indexedFiles: paths.length,
      reusedFiles: 0,
      removedFiles: 0,
      skippedFiles: 0,
      fetchedFiles: paths.length,
      durationMs: 5,
    },
    ...overrides,
  };
}

interface FakeGitHubState {
  pulls: GitHubPullRequestSummary[];
  files: Record<number, GitHubPullRequestFile[]>;
  releases: GitHubReleaseSummary[];
  configured: boolean;
  fileFailures: Set<number>;
}

function createFakeGitHub(state: FakeGitHubState): GitHubReadOnlyPort {
  return {
    isConfigured: () => state.configured,
    getDefaultRepo: () => REPO,
    checkConnection: async (): Promise<GitHubConnectionStatus> => ({
      configured: state.configured,
      mode: 'github_app',
      connected: state.configured,
      readOnly: true,
      accessibleRepositories: [FULL_REPO],
      permissions: { contents: 'read', metadata: 'read' },
      writePermissions: [],
      checkedAt: '2026-11-27T09:00:00.000Z',
    }),
    getRepository: async (repo) => ({
      id: 1,
      owner: repo.owner,
      name: repo.repo,
      fullName: FULL_REPO,
      description: null,
      private: true,
      defaultBranch: 'main',
      htmlUrl: `https://github.com/${FULL_REPO}`,
      pushedAt: null,
      updatedAt: null,
    }),
    listPullRequests: async (_repo, options) => {
      const selected = options?.state === 'open' ? [] : state.pulls;
      return selected.slice(0, options?.limit ?? selected.length);
    },
    listPullRequestFiles: async (_repo, pullNumber) => {
      if (state.fileFailures.has(pullNumber)) {
        throw new Error(`模拟 GitHub 读取 PR #${pullNumber} 文件失败`);
      }
      return state.files[pullNumber] ?? [];
    },
    listReleases: async () => state.releases,
    getFileContent: async () => null,
    getCommit: async () => ({ sha: COMMIT, treeSha: COMMIT, commitAt: null, message: null }),
    getRepositoryTree: async (): Promise<GitHubTreeEntry[]> => [],
    probeWriteBlocked: async () => ({
      repo: FULL_REPO,
      readOnlyToken: true,
      writeBlocked: true,
      statusCode: 403,
      detail: 'blocked',
      writePermissions: [],
      checkedAt: '2026-11-27T09:00:00.000Z',
    }),
  };
}

interface Harness {
  db: DatabaseSync;
  knowledgeStore: SqliteKnowledgeSnapshotStore;
  discoveryStore: SqlitePRDiscoveryStore;
  service: PRDiscoveryService;
  github: FakeGitHubState;
}

let harness: Harness | undefined;

function buildHarness(options: { configured?: boolean } = {}): Harness {
  const db = openDatabase(':memory:');
  const knowledgeStore = new SqliteKnowledgeSnapshotStore(db);
  const discoveryStore = new SqlitePRDiscoveryStore(db);
  let tick = 0;
  let verificationCounter = 0;
  const github: FakeGitHubState = {
    pulls: PULLS,
    files: FILES,
    releases: RELEASES,
    configured: options.configured ?? true,
    fileFailures: new Set(),
  };
  const service = new PRDiscoveryService({
    github: createFakeGitHub(github),
    knowledgeStore,
    store: discoveryStore,
    now: () => new Date(Date.UTC(2026, 10, 27, 10, 0, 0, tick++)),
    newVerificationId: () => `vrf_${String(++verificationCounter).padStart(16, '0')}`,
  });
  harness = { db, knowledgeStore, discoveryStore, service, github };
  return harness;
}

afterEach(() => {
  harness?.db.close();
  harness = undefined;
});

const BASE_DIGESTS = {
  'libs/features/notes/src/sync-panel.tsx': digest('sync panel v1'),
  'apps/api/src/routes/notes.ts': digest('notes route v1'),
  'libs/features/notes/src/sync-panel-store.ts': digest('store v1'),
  'libs/features/notes/src/polish.tsx': digest('polish v1'),
};

describe('PR 发现 · 分类与持久化', () => {
  it('AC-02：内部/重命名/未定 PR 零 Claim，只有 feat 产生待验证候选', async () => {
    const { service, knowledgeStore, discoveryStore } = buildHarness();
    knowledgeStore.insert(buildSnapshot(SNAPSHOT_ID, BASE_DIGESTS));

    const report = await service.analyzePullRequests(REPO);

    expect(report.summary).toMatchObject({
      analyzed: 4,
      userFacingFeature: 1,
      internal: 2,
      ambiguous: 1,
      claims: 1,
      claimsBlockedUnverified: 1,
    });
    expect(report.snapshotId).toBe(SNAPSHOT_ID);

    const byNumber = new Map(report.candidates.map((candidate) => [candidate.pullNumber, candidate]));
    expect(byNumber.get(12)?.classification).toBe('user_facing_feature');
    expect(byNumber.get(13)?.classification).toBe('internal_non_promotable');
    expect(byNumber.get(14)?.classification).toBe('internal_non_promotable');
    expect(byNumber.get(15)?.classification).toBe('ambiguous_needs_review');
    for (const number of [13, 14, 15]) {
      expect(byNumber.get(number)?.promotable).toBe(false);
      expect(byNumber.get(number)?.claims).toEqual([]);
    }

    const feature = byNumber.get(12)!;
    expect(feature.claims).toHaveLength(1);
    const claim = feature.claims[0]!;
    expect(claim.statement).toBe('支持增量同步');
    expect(claim.eligibility).toBe('blocked_unverified');
    expect(claim.verification.deployed).toBe(false);
    expect(claim.evidenceIds.length).toBeGreaterThan(0);

    // Persisted and queryable with filters.
    const stored = await service.getCandidate(REPO, feature.id);
    expect(stored?.pullNumber).toBe(12);
    const internal = await service.listCandidates(REPO, {
      classification: 'internal_non_promotable',
    });
    expect(internal.map((candidate) => candidate.pullNumber).sort()).toEqual([13, 14]);
    const single = await service.listCandidates(REPO, { pullNumber: 15 });
    expect(single).toHaveLength(1);
    expect(discoveryStore.getByPullNumber(FULL_REPO, 12)?.id).toBe(feature.id);
  });

  it('未配置 GitHub 时发现请求 fail closed（503 语义）', async () => {
    const { service } = buildHarness({ configured: false });
    await expect(service.analyzePullRequests(REPO)).rejects.toMatchObject({
      code: 'github_not_configured',
      httpStatus: 503,
    });
  });

  it('单个 PR 文件读取失败不会拖垮整体发现，错误如实上报', async () => {
    const { service, knowledgeStore, github } = buildHarness();
    knowledgeStore.insert(buildSnapshot(SNAPSHOT_ID, BASE_DIGESTS));
    github.fileFailures.add(13);

    const report = await service.analyzePullRequests(REPO);
    expect(report.summary.analyzed).toBe(3);
    expect(report.errors).toEqual([
      { pullNumber: 13, message: expect.stringContaining('模拟 GitHub 读取 PR #13 文件失败') },
    ]);
  });

  it('只分析指定 PR 编号，并如实报告缺失编号', async () => {
    const { service, knowledgeStore } = buildHarness();
    knowledgeStore.insert(buildSnapshot(SNAPSHOT_ID, BASE_DIGESTS));

    const report = await service.analyzePullRequests(REPO, { pullNumbers: [12, 99] });
    expect(report.candidates.map((candidate) => candidate.pullNumber)).toEqual([12]);
    expect(report.errors).toEqual([
      { pullNumber: 99, message: expect.stringContaining('未出现在 GitHub 返回的列表') },
    ]);
  });
});

describe('Claim 核验与发布守门（AC-03）', () => {
  it('测试 → staging → 生产 + 人工批准，逐级放行；驳回后阻断', async () => {
    const { service, knowledgeStore } = buildHarness();
    knowledgeStore.insert(buildSnapshot(SNAPSHOT_ID, BASE_DIGESTS));
    const report = await service.analyzePullRequests(REPO, { pullNumbers: [12] });
    const claimId = report.candidates[0]!.claims[0]!.id;

    // 1. Test evidence alone never proves deployment.
    const afterTest = await service.recordVerification(REPO, claimId, {
      kind: 'test',
      note: 'CI 单元测试与 E2E 全部通过',
      testRunId: 'gha-run-100',
    });
    expect(afterTest?.eligibility).toBe('blocked_unverified');
    expect(afterTest?.verification.testRunId).toBeUndefined();
    expect(afterTest?.evidenceIds).toHaveLength(3);

    // 2. Staging runtime: publishable only with an explicit scope qualifier.
    const afterStaging = await service.recordVerification(REPO, claimId, {
      kind: 'runtime',
      note: '在 staging 完整走通笔记同步',
      environmentId: 'staging',
    });
    expect(afterStaging?.eligibility).toBe('needs_qualification');
    expect(afterStaging?.verification.environmentId).toBe('staging');
    expect(afterStaging?.guidance).toContain('仅 staging');

    // 3. Human approval while still staging: still qualified, not publishable.
    const afterApproval = await service.recordVerification(REPO, claimId, {
      kind: 'human',
      note: '产品负责人已审阅文案与演示范围',
      decision: 'approve',
    });
    expect(afterApproval?.eligibility).toBe('needs_qualification');

    // 4. Production runtime + existing approval: publishable.
    const afterProduction = await service.recordVerification(REPO, claimId, {
      kind: 'runtime',
      note: '生产环境真实操作成功',
      environmentId: 'production',
      testRunId: 'manual-run-7',
    });
    expect(afterProduction?.eligibility).toBe('publishable');
    expect(afterProduction?.status).toBe('verified');
    expect(afterProduction?.verification.validityScope).toBe('production_runtime_approved');

    // 5. A later human rejection wins and blocks publication.
    const afterReject = await service.recordVerification(REPO, claimId, {
      kind: 'human',
      note: '复核发现文案夸大，驳回',
      decision: 'reject',
    });
    expect(afterReject?.eligibility).toBe('blocked_rejected');
    expect(afterReject?.status).toBe('rejected');

    // The audit trail is append-only and complete.
    const { discoveryStore } = harness!;
    const records = discoveryStore.listVerifications(FULL_REPO, claimId);
    expect(records.map((record) => record.evidence.kind)).toEqual([
      'test',
      'runtime',
      'human',
      'runtime',
      'human',
    ]);

    // Reloading from SQLite preserves the computed state.
    const persisted = await service.getCandidate(REPO, report.candidates[0]!.id);
    expect(persisted?.claims[0]?.eligibility).toBe('blocked_rejected');
  });

  it('未知 Claim 返回 null；非法输入被 Zod 拒绝', async () => {
    const { service, knowledgeStore } = buildHarness();
    knowledgeStore.insert(buildSnapshot(SNAPSHOT_ID, BASE_DIGESTS));
    await service.analyzePullRequests(REPO, { pullNumbers: [12] });

    expect(
      await service.recordVerification(REPO, `claim_${'f'.repeat(16)}`, {
        kind: 'human',
        note: 'x',
      }),
    ).toBeNull();

    await expect(
      service.recordVerification(REPO, `claim_${'f'.repeat(16)}`, {
        kind: 'runtime',
        note: '缺少环境',
      }),
    ).rejects.toThrow();
  });

  it('重新分析保留已录入的核验证据，不会把发布状态打回原点', async () => {
    const { service, knowledgeStore } = buildHarness();
    knowledgeStore.insert(buildSnapshot(SNAPSHOT_ID, BASE_DIGESTS));
    const first = await service.analyzePullRequests(REPO, { pullNumbers: [12] });
    const claimId = first.candidates[0]!.claims[0]!.id;

    await service.recordVerification(REPO, claimId, {
      kind: 'runtime',
      note: 'staging 验收通过',
      environmentId: 'staging',
    });
    await service.recordVerification(REPO, claimId, {
      kind: 'human',
      note: '批准在限定范围发布',
      decision: 'approve',
    });

    const second = await service.analyzePullRequests(REPO, { pullNumbers: [12] });
    const claim = second.candidates[0]!.claims[0]!;
    expect(claim.id).toBe(claimId);
    expect(claim.eligibility).toBe('needs_qualification');
    expect(claim.verification.environmentId).toBe('staging');
    expect(claim.evidenceIds).toHaveLength(4);
  });
});

describe('AC-09 过期传播', () => {
  it('新快照中引用文件 digest 变化：证据与 Claim 标记 stale', async () => {
    const { service, knowledgeStore } = buildHarness();
    knowledgeStore.insert(buildSnapshot(SNAPSHOT_ID, BASE_DIGESTS));
    const report = await service.analyzePullRequests(REPO, { pullNumbers: [12] });
    const candidateId = report.candidates[0]!.id;

    knowledgeStore.insert(
      buildSnapshot(NEXT_SNAPSHOT_ID, {
        ...BASE_DIGESTS,
        'libs/features/notes/src/sync-panel.tsx': digest('sync panel v2'),
      }),
    );

    const result = await service.refreshStaleness(REPO);
    expect(result).toMatchObject({
      snapshotId: NEXT_SNAPSHOT_ID,
      candidatesScanned: 1,
      candidatesChanged: 1,
      evidenceMarkedStale: 1,
      staleFiles: ['libs/features/notes/src/sync-panel.tsx'],
    });
    expect(result.claimsMarkedStale).toHaveLength(1);

    const updated = await service.getCandidate(REPO, candidateId);
    expect(updated?.claims[0]?.status).toBe('stale');
    expect(updated?.claims[0]?.eligibility).toBe('blocked_stale');
    expect(
      updated?.evidence.find(
        (item) => item.filePath === 'libs/features/notes/src/sync-panel.tsx',
      )?.status,
    ).toBe('stale');

    // Repeated refresh is idempotent: already-stale evidence is left alone.
    const again = await service.refreshStaleness(REPO);
    expect(again.evidenceMarkedStale).toBe(0);
    expect(again.candidatesChanged).toBe(0);
  });

  it('没有可用快照时刷新明确失败，而不是假装成功', async () => {
    const { service } = buildHarness();
    await expect(service.refreshStaleness(REPO)).rejects.toBeInstanceOf(PRDiscoveryError);
    await expect(service.refreshStaleness(REPO)).rejects.toMatchObject({
      code: 'snapshot_not_found',
      httpStatus: 404,
    });
  });

  it('指定不存在的快照 ID 时返回 404 语义', async () => {
    const { service } = buildHarness();
    await expect(
      service.analyzePullRequests(REPO, { snapshotId: `snap_${'f'.repeat(32)}` }),
    ).rejects.toMatchObject({ code: 'snapshot_not_found', httpStatus: 404 });
  });
});
