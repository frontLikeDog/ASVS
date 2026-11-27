// @vitest-environment node
import { afterEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type {
  ClaimVerificationInputV1,
  ClaimVerificationRecordV1,
  GitHubRepoRef,
  PRChangeCandidateV1,
  PRDiscoveryReportV1,
  StalenessRefreshResultV1,
} from '@asvs/domain';
import type { PRDiscoveryPort, AnalyzePullRequestsOptions } from '@asvs/ports';
import { buildApp } from '../app';

const REPO: GitHubRepoRef = { owner: 'frontLikeDog', repo: 'livenotes' };
const FULL_REPO = 'frontLikeDog/livenotes';
const CANDIDATE_ID = `prc_${'a'.repeat(16)}`;
const CLAIM_ID = `claim_${'b'.repeat(16)}`;
const EVIDENCE_ID = `evd_${'c'.repeat(16)}`;
const SNAPSHOT_ID = `snap_${'d'.repeat(32)}`;
const COMMIT = '1'.repeat(40);
const ANALYZED_AT = '2026-11-27T10:00:00.000Z';

let app: FastifyInstance | undefined;

afterEach(async () => {
  await app?.close();
  app = undefined;
});

function buildCandidate(overrides: Partial<PRChangeCandidateV1> = {}): PRChangeCandidateV1 {
  return {
    schemaVersion: '1',
    id: CANDIDATE_ID,
    repo: FULL_REPO,
    pullNumber: 12,
    title: 'feat: 支持增量同步',
    author: 'frontLikeDog',
    state: 'closed',
    draft: false,
    merged: true,
    mergedAt: '2026-11-26T08:00:00.000Z',
    baseBranch: 'main',
    headBranch: 'feat/sync',
    headSha: COMMIT,
    mergeCommitSha: '2'.repeat(40),
    htmlUrl: 'https://github.com/frontLikeDog/livenotes/pull/12',
    labels: [],
    classification: 'user_facing_feature',
    promotable: true,
    confidence: 85,
    rationale: ['Conventional 前缀 feat 表明用户可感知的新功能'],
    snapshotId: SNAPSHOT_ID,
    changedFiles: [
      {
        path: 'libs/features/notes/src/sync.tsx',
        status: 'modified',
        additions: 5,
        deletions: 1,
        category: 'ui',
      },
    ],
    diffStats: {
      filesChanged: 1,
      additions: 5,
      deletions: 1,
      userFacingFiles: 1,
      internalFiles: 0,
      renamedOnlyFiles: 0,
    },
    claims: [
      {
        schemaVersion: '1',
        id: CLAIM_ID,
        candidateId: CANDIDATE_ID,
        repo: FULL_REPO,
        pullNumber: 12,
        statement: '支持增量同步',
        audience: '现有用户',
        status: 'proposed',
        eligibility: 'blocked_unverified',
        verification: {
          commitSha: '2'.repeat(40),
          snapshotId: SNAPSHOT_ID,
          environmentId: 'unverified',
          verifiedAt: '2026-11-26T08:00:00.000Z',
          validityScope: 'unverified',
          deployed: false,
        },
        evidenceIds: [EVIDENCE_ID],
        blockers: ['未命中 Release，也没有任何真实环境的运行态证据；禁止声称「已上线」。'],
        guidance: '可以描述该变更已合并，但不得表述为「已上线 / 已可用」。',
      },
    ],
    evidence: [
      {
        id: EVIDENCE_ID,
        kind: 'source',
        status: 'valid',
        title: 'libs/features/notes/src/sync.tsx',
        detail: 'PR #12 modified 变更（ui），已绑定 4B SHA256 指纹',
        filePath: 'libs/features/notes/src/sync.tsx',
        sourceDigest: 'e'.repeat(64),
        commitSha: '2'.repeat(40),
        snapshotId: SNAPSHOT_ID,
        capturedAt: '2026-11-26T08:00:00.000Z',
      },
    ],
    analyzedAt: ANALYZED_AT,
    ...overrides,
  };
}

function buildReport(candidates: PRChangeCandidateV1[]): PRDiscoveryReportV1 {
  return {
    schemaVersion: '1',
    repo: FULL_REPO,
    branch: 'main',
    snapshotId: SNAPSHOT_ID,
    requestedState: 'closed',
    analyzedAt: ANALYZED_AT,
    summary: {
      analyzed: candidates.length,
      userFacingFeature: candidates.filter((item) => item.classification === 'user_facing_feature')
        .length,
      userFacingImprovement: 0,
      internal: 0,
      ambiguous: 0,
      claims: candidates.flatMap((item) => item.claims).length,
      claimsBlockedUnverified: 1,
      claimsBlockedStale: 0,
      claimsPublishable: 0,
    },
    errors: [],
    candidates,
  };
}

function buildStaleness(): StalenessRefreshResultV1 {
  return {
    schemaVersion: '1',
    repo: FULL_REPO,
    snapshotId: SNAPSHOT_ID,
    gitCommitSha: COMMIT,
    branch: 'main',
    refreshedAt: ANALYZED_AT,
    candidatesScanned: 1,
    candidatesChanged: 1,
    evidenceMarkedStale: 1,
    claimsMarkedStale: [CLAIM_ID],
    staleFiles: ['libs/features/notes/src/sync.tsx'],
  };
}

function createStubDiscovery(
  overrides: Partial<PRDiscoveryPort> = {},
): PRDiscoveryPort {
  const candidate = buildCandidate();
  return {
    analyzePullRequests: async () => buildReport([candidate]),
    listCandidates: async () => [candidate],
    getCandidate: async (_repo, candidateId) =>
      candidateId === CANDIDATE_ID ? candidate : null,
    recordVerification: async (
      _repo: GitHubRepoRef,
      claimId: string,
      _input: ClaimVerificationInputV1,
    ) => (claimId === CLAIM_ID ? candidate.claims[0] ?? null : null),
    listVerifications: async (_repo: GitHubRepoRef, claimId: string): Promise<ClaimVerificationRecordV1[] | null> =>
      claimId === CLAIM_ID
        ? [
            {
              schemaVersion: '1',
              id: `vrf_${'1'.repeat(16)}`,
              repo: FULL_REPO,
              candidateId: CANDIDATE_ID,
              claimId: CLAIM_ID,
              evidence: {
                id: `evd_${'1'.repeat(16)}`,
                kind: 'human',
                status: 'valid',
                title: '人工核验',
                detail: '批准发布',
                decision: 'approve',
                actor: 'pm-lin',
                capturedAt: ANALYZED_AT,
              },
              input: {
                kind: 'human',
                note: '批准发布',
                actor: 'pm-lin',
                decision: 'approve',
              },
              recordedAt: ANALYZED_AT,
            },
          ]
        : null,
    refreshStaleness: async () => buildStaleness(),
    ...overrides,
  };
}

describe('PR 发现路由', () => {
  it('未配置 GitHub：发现返回 503，本地读取与刷新仍可用', async () => {
    const built = await buildApp({ dbPath: ':memory:' });
    app = built.app;

    const discover = await app.inject({
      method: 'POST',
      url: '/v1/github/repos/frontLikeDog/livenotes/discover',
      payload: {},
    });
    expect(discover.statusCode).toBe(503);
    expect(discover.json().error.code).toBe('github_not_configured');

    const list = await app.inject({
      method: 'GET',
      url: '/v1/github/repos/frontLikeDog/livenotes/candidates',
    });
    expect(list.statusCode).toBe(200);
    expect(list.json()).toMatchObject({ repo: FULL_REPO, count: 0, candidates: [] });

    // Refreshing without any snapshot is an explicit 404, never a fake success.
    const refresh = await app.inject({
      method: 'POST',
      url: '/v1/github/repos/frontLikeDog/livenotes/candidates/refresh-staleness',
      payload: {},
    });
    expect(refresh.statusCode).toBe(404);
    expect(refresh.json().error.code).toBe('snapshot_not_found');
  });

  it('发现请求转发参数并返回 201 + 报告', async () => {
    const calls: Array<{ repo: GitHubRepoRef; options: AnalyzePullRequestsOptions | undefined }> =
      [];
    const built = await buildApp({
      dbPath: ':memory:',
      prDiscovery: createStubDiscovery({
        analyzePullRequests: async (repo, options) => {
          calls.push({ repo, options });
          return buildReport([buildCandidate()]);
        },
      }),
    });
    app = built.app;

    const response = await app.inject({
      method: 'POST',
      url: '/v1/github/repos/frontLikeDog/livenotes/discover',
      payload: {
        state: 'all',
        limit: 5,
        pullNumbers: [12],
        branch: 'main',
        snapshotId: SNAPSHOT_ID,
      },
    });

    expect(response.statusCode).toBe(201);
    expect(response.json()).toMatchObject({
      repo: FULL_REPO,
      report: { summary: { analyzed: 1, claims: 1 }, candidates: [{ pullNumber: 12 }] },
    });
    expect(calls).toEqual([
      {
        repo: REPO,
        options: {
          state: 'all',
          limit: 5,
          pullNumbers: [12],
          branch: 'main',
          snapshotId: SNAPSHOT_ID,
        },
      },
    ]);

    const noBody = await app.inject({
      method: 'POST',
      url: '/v1/github/repos/frontLikeDog/livenotes/discover',
    });
    expect(noBody.statusCode).toBe(201);
    expect(calls[1]?.options).toBeUndefined();
  });

  it('拒绝非法发现请求体与非法仓库 / 快照 ID', async () => {
    const built = await buildApp({ dbPath: ':memory:', prDiscovery: createStubDiscovery() });
    app = built.app;

    const extraField = await app.inject({
      method: 'POST',
      url: '/v1/github/repos/frontLikeDog/livenotes/discover',
      payload: { limit: 5, unknown: true },
    });
    expect(extraField.statusCode).toBe(400);
    expect(extraField.json().error.code).toBe('invalid_github_request');

    const badLimit = await app.inject({
      method: 'POST',
      url: '/v1/github/repos/frontLikeDog/livenotes/discover',
      payload: { limit: 500 },
    });
    expect(badLimit.statusCode).toBe(400);

    const badSnapshot = await app.inject({
      method: 'POST',
      url: '/v1/github/repos/frontLikeDog/livenotes/discover',
      payload: { snapshotId: 'not-a-snapshot' },
    });
    expect(badSnapshot.statusCode).toBe(400);

    const badRepo = await app.inject({
      method: 'POST',
      url: '/v1/github/repos/frontLikeDog/a..b/discover',
      payload: {},
    });
    expect(badRepo.statusCode).toBe(400);
  });

  it('按分类 / PR 编号 / limit 列出候选', async () => {
    const seen: unknown[] = [];
    const built = await buildApp({
      dbPath: ':memory:',
      prDiscovery: createStubDiscovery({
        listCandidates: async (_repo, options) => {
          seen.push(options ?? {});
          return [buildCandidate()];
        },
      }),
    });
    app = built.app;

    const response = await app.inject({
      method: 'GET',
      url: '/v1/github/repos/frontLikeDog/livenotes/candidates?classification=user_facing_feature&pullNumber=12&limit=5',
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ count: 1, candidates: [{ id: CANDIDATE_ID }] });
    expect(seen).toEqual([{ classification: 'user_facing_feature', pullNumber: 12, limit: 5 }]);

    const badClassification = await app.inject({
      method: 'GET',
      url: '/v1/github/repos/frontLikeDog/livenotes/candidates?classification=nope',
    });
    expect(badClassification.statusCode).toBe(400);

    const badLimit = await app.inject({
      method: 'GET',
      url: '/v1/github/repos/frontLikeDog/livenotes/candidates?limit=1000',
    });
    expect(badLimit.statusCode).toBe(400);
  });

  it('读取单个候选：200 / 400 / 404', async () => {
    const built = await buildApp({ dbPath: ':memory:', prDiscovery: createStubDiscovery() });
    app = built.app;

    const found = await app.inject({
      method: 'GET',
      url: `/v1/github/repos/frontLikeDog/livenotes/candidates/${CANDIDATE_ID}`,
    });
    expect(found.statusCode).toBe(200);
    expect(found.json()).toMatchObject({ id: CANDIDATE_ID, claims: [{ id: CLAIM_ID }] });

    const invalid = await app.inject({
      method: 'GET',
      url: '/v1/github/repos/frontLikeDog/livenotes/candidates/not-a-candidate',
    });
    expect(invalid.statusCode).toBe(400);
    expect(invalid.json().error.code).toBe('invalid_github_request');

    const unknown = await app.inject({
      method: 'GET',
      url: `/v1/github/repos/frontLikeDog/livenotes/candidates/prc_${'f'.repeat(16)}`,
    });
    expect(unknown.statusCode).toBe(404);
    expect(unknown.json().error.code).toBe('not_found');
  });

  it('录入核验证据：200 / 400 / 404，并拒绝 source 之外的非法组合', async () => {
    const recorded: Array<{ claimId: string; input: ClaimVerificationInputV1 }> = [];
    const built = await buildApp({
      dbPath: ':memory:',
      prDiscovery: createStubDiscovery({
        recordVerification: async (_repo, claimId, input) => {
          recorded.push({ claimId, input });
          if (claimId !== CLAIM_ID) return null;
          const claim = buildCandidate().claims[0]!;
          return { ...claim, eligibility: 'needs_qualification' };
        },
      }),
    });
    app = built.app;

    const ok = await app.inject({
      method: 'POST',
      url: `/v1/github/repos/frontLikeDog/livenotes/claims/${CLAIM_ID}/verify`,
      payload: {
        kind: 'runtime',
        note: 'staging 验收通过',
        environmentId: 'STAGING',
      },
    });
    expect(ok.statusCode).toBe(200);
    expect(ok.json().claim.eligibility).toBe('needs_qualification');
    // Environment ids are normalized to lower case before they reach the port.
    expect(recorded[0]?.input.environmentId).toBe('staging');

    const missingEnv = await app.inject({
      method: 'POST',
      url: `/v1/github/repos/frontLikeDog/livenotes/claims/${CLAIM_ID}/verify`,
      payload: { kind: 'runtime', note: '缺少环境' },
    });
    expect(missingEnv.statusCode).toBe(400);
    expect(missingEnv.json().error.code).toBe('invalid_github_request');

    const sourceRejected = await app.inject({
      method: 'POST',
      url: `/v1/github/repos/frontLikeDog/livenotes/claims/${CLAIM_ID}/verify`,
      payload: { kind: 'source', note: '伪造源码证据' },
    });
    expect(sourceRejected.statusCode).toBe(400);

    const decisionOnTest = await app.inject({
      method: 'POST',
      url: `/v1/github/repos/frontLikeDog/livenotes/claims/${CLAIM_ID}/verify`,
      payload: { kind: 'test', note: 'x', decision: 'approve' },
    });
    expect(decisionOnTest.statusCode).toBe(400);

    const unknownClaim = await app.inject({
      method: 'POST',
      url: `/v1/github/repos/frontLikeDog/livenotes/claims/claim_${'f'.repeat(16)}/verify`,
      payload: { kind: 'human', note: '批准', decision: 'approve' },
    });
    expect(unknownClaim.statusCode).toBe(404);
    expect(unknownClaim.json().error.code).toBe('claim_not_found');

    const invalidClaimId = await app.inject({
      method: 'POST',
      url: '/v1/github/repos/frontLikeDog/livenotes/claims/not-a-claim/verify',
      payload: { kind: 'human', note: '批准', decision: 'approve' },
    });
    expect(invalidClaimId.statusCode).toBe(400);

    const humanMissingDecision = await app.inject({
      method: 'POST',
      url: `/v1/github/repos/frontLikeDog/livenotes/claims/${CLAIM_ID}/verify`,
      payload: { kind: 'human', note: '忘记填决定' },
    });
    expect(humanMissingDecision.statusCode).toBe(400);

    const badVerifiedAt = await app.inject({
      method: 'POST',
      url: `/v1/github/repos/frontLikeDog/livenotes/claims/${CLAIM_ID}/verify`,
      payload: { kind: 'test', note: '非法时间', verifiedAt: '9999-zz' },
    });
    expect(badVerifiedAt.statusCode).toBe(400);
  });

  it('查询 Claim 核验审计历史：200 / 400 / 404', async () => {
    const built = await buildApp({ dbPath: ':memory:', prDiscovery: createStubDiscovery() });
    app = built.app;

    const ok = await app.inject({
      method: 'GET',
      url: `/v1/github/repos/frontLikeDog/livenotes/claims/${CLAIM_ID}/verifications`,
    });
    expect(ok.statusCode).toBe(200);
    expect(ok.json()).toMatchObject({
      repo: FULL_REPO,
      claimId: CLAIM_ID,
      count: 1,
      verifications: [{ evidence: { actor: 'pm-lin', decision: 'approve' } }],
    });

    const badId = await app.inject({
      method: 'GET',
      url: '/v1/github/repos/frontLikeDog/livenotes/claims/not-a-claim/verifications',
    });
    expect(badId.statusCode).toBe(400);

    const missing = await app.inject({
      method: 'GET',
      url: `/v1/github/repos/frontLikeDog/livenotes/claims/claim_${'f'.repeat(16)}/verifications`,
    });
    expect(missing.statusCode).toBe(404);
    expect(missing.json().error.code).toBe('claim_not_found');
  });

  it('刷新过期状态：200 汇总，非法请求体 400', async () => {
    const built = await buildApp({ dbPath: ':memory:', prDiscovery: createStubDiscovery() });
    app = built.app;

    const response = await app.inject({
      method: 'POST',
      url: '/v1/github/repos/frontLikeDog/livenotes/candidates/refresh-staleness',
      payload: { branch: 'main' },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      snapshotId: SNAPSHOT_ID,
      evidenceMarkedStale: 1,
      claimsMarkedStale: [CLAIM_ID],
    });

    const invalid = await app.inject({
      method: 'POST',
      url: '/v1/github/repos/frontLikeDog/livenotes/candidates/refresh-staleness',
      payload: { snapshotId: 'nope' },
    });
    expect(invalid.statusCode).toBe(400);

    // The static segment must win over `:candidateId`.
    const asCandidate = await app.inject({
      method: 'GET',
      url: '/v1/github/repos/frontLikeDog/livenotes/candidates/refresh-staleness',
    });
    expect(asCandidate.statusCode).toBe(400);
  });
});
