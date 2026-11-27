import { describe, expect, it, vi } from 'vitest';
import type {
  ClaimCandidateV1,
  ClaimVerificationRecordV1,
  GitHubConnectionStatus,
  GitHubRepositoryMetadata,
  GitHubWriteProbeResult,
  KnowledgeSnapshotSummaryV1,
  KnowledgeSnapshotV1,
  PRChangeCandidateV1,
  PRDiscoveryReportV1,
  StalenessRefreshResultV1,
} from '@asvs/domain';
import {
  HttpGitHubKnowledgeClient,
  KnowledgeHttpError,
} from './http-github-knowledge-client';

const ISO = '2026-11-27T12:00:00.000Z';
const COMMIT = '1111111111111111111111111111111111111111';
const SNAP_ID = 'snap_11111111111111111111111111111111';
const CAND_ID = 'prc_0000000000000101';
const CLAIM_ID = 'claim_0000000000000101';
const EVD_ID = 'evd_0000000000000101';
const VRF_ID = 'vrf_0000000000000101';
const REPO = { owner: 'acme', repo: 'livenotes' } as const;

function jsonResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as Response;
}

const STATUS: GitHubConnectionStatus = {
  configured: true,
  mode: 'github_app',
  connected: true,
  readOnly: true,
  appId: '123',
  installationId: '456',
  repo: 'acme/livenotes',
  repositorySelection: 'selected',
  accessibleRepositories: ['acme/livenotes'],
  permissions: { contents: 'read', metadata: 'read', pull_requests: 'read' },
  writePermissions: [],
  checkedAt: ISO,
};

const REPO_META: GitHubRepositoryMetadata = {
  id: 1,
  owner: 'acme',
  name: 'livenotes',
  fullName: 'acme/livenotes',
  description: 'demo',
  private: false,
  defaultBranch: 'main',
  htmlUrl: 'https://github.com/acme/livenotes',
  pushedAt: ISO,
  updatedAt: ISO,
};

const PROBE: GitHubWriteProbeResult = {
  repo: 'acme/livenotes',
  readOnlyToken: true,
  writeBlocked: true,
  statusCode: 403,
  detail: 'blocked',
  writePermissions: [],
  checkedAt: ISO,
};

const STATS = {
  mode: 'cold' as const,
  totalFiles: 1,
  indexedFiles: 1,
  reusedFiles: 0,
  removedFiles: 0,
  skippedFiles: 0,
  fetchedFiles: 1,
  durationMs: 12,
};

const SNAPSHOT: KnowledgeSnapshotV1 = {
  schemaVersion: '1',
  id: SNAP_ID,
  repo: 'acme/livenotes',
  branch: 'main',
  gitCommitSha: COMMIT,
  indexedAt: ISO,
  sourceDigests: { 'README.md': 'a'.repeat(64) },
  files: [],
  skipped: [],
  entrypoints: [],
  stats: STATS,
};

const SNAP_SUMMARY: KnowledgeSnapshotSummaryV1 = {
  id: SNAP_ID,
  repo: 'acme/livenotes',
  branch: 'main',
  gitCommitSha: COMMIT,
  indexedAt: ISO,
  stats: STATS,
};

const CLAIM: ClaimCandidateV1 = {
  schemaVersion: '1',
  id: CLAIM_ID,
  candidateId: CAND_ID,
  repo: 'acme/livenotes',
  pullNumber: 101,
  statement: '支持导出 CSV',
  audience: '用户',
  status: 'proposed',
  eligibility: 'blocked_unverified',
  verification: {
    commitSha: COMMIT,
    snapshotId: SNAP_ID,
    environmentId: 'unverified',
    verifiedAt: ISO,
    validityScope: 'unverified',
    deployed: false,
  },
  evidenceIds: [EVD_ID],
  blockers: ['缺少运行态证据'],
  guidance: '补齐证据',
};

const CANDIDATE: PRChangeCandidateV1 = {
  schemaVersion: '1',
  id: CAND_ID,
  repo: 'acme/livenotes',
  pullNumber: 101,
  title: 'feat: csv',
  author: 'alice',
  state: 'closed',
  draft: false,
  merged: true,
  mergedAt: ISO,
  baseBranch: 'main',
  headBranch: 'feat/csv',
  headSha: COMMIT,
  mergeCommitSha: COMMIT,
  htmlUrl: 'https://github.com/acme/livenotes/pull/101',
  labels: [],
  classification: 'user_facing_feature',
  promotable: true,
  confidence: 90,
  rationale: ['feat'],
  snapshotId: SNAP_ID,
  changedFiles: [],
  diffStats: {
    filesChanged: 1,
    additions: 10,
    deletions: 0,
    userFacingFiles: 1,
    internalFiles: 0,
    renamedOnlyFiles: 0,
  },
  claims: [CLAIM],
  evidence: [
    {
      id: EVD_ID,
      kind: 'source',
      status: 'valid',
      title: '源码',
      detail: 'src/a.tsx',
      filePath: 'src/a.tsx',
      sourceDigest: 'a'.repeat(64),
      commitSha: COMMIT,
      snapshotId: SNAP_ID,
      capturedAt: ISO,
    },
  ],
  analyzedAt: ISO,
};

const REPORT: PRDiscoveryReportV1 = {
  schemaVersion: '1',
  repo: 'acme/livenotes',
  branch: 'main',
  snapshotId: SNAP_ID,
  requestedState: 'closed',
  analyzedAt: ISO,
  summary: {
    analyzed: 1,
    userFacingFeature: 1,
    userFacingImprovement: 0,
    internal: 0,
    ambiguous: 0,
    claims: 1,
    claimsBlockedUnverified: 1,
    claimsBlockedStale: 0,
    claimsPublishable: 0,
  },
  errors: [],
  candidates: [CANDIDATE],
};

const VRF_RECORD: ClaimVerificationRecordV1 = {
  schemaVersion: '1',
  id: VRF_ID,
  repo: 'acme/livenotes',
  candidateId: CAND_ID,
  claimId: CLAIM_ID,
  evidence: {
    id: EVD_ID,
    kind: 'runtime',
    status: 'valid',
    title: '运行态证据',
    detail: 'staging ok',
    environmentId: 'staging',
    commitSha: COMMIT,
    capturedAt: ISO,
  },
  input: { kind: 'runtime', environmentId: 'staging', note: 'staging ok' },
  recordedAt: ISO,
};

const STALENESS: StalenessRefreshResultV1 = {
  schemaVersion: '1',
  repo: 'acme/livenotes',
  snapshotId: SNAP_ID,
  gitCommitSha: COMMIT,
  branch: 'main',
  refreshedAt: ISO,
  candidatesScanned: 1,
  candidatesChanged: 0,
  evidenceMarkedStale: 0,
  claimsMarkedStale: [],
  staleFiles: [],
};

describe('HttpGitHubKnowledgeClient', () => {
  it('正确编码查询参数并校验 4A/4B/4C 返回体', async () => {
    const fetchImpl = vi.fn(async (url: string | URL) => {
      const s = String(url);
      if (s.startsWith('/api/v1/github/status')) return jsonResponse(STATUS);
      if (s === '/api/v1/github/repos/acme/livenotes') return jsonResponse(REPO_META);
      if (s.endsWith('/verify-readonly')) return jsonResponse(PROBE);
      if (s.endsWith('/index')) return jsonResponse({ repo: 'acme/livenotes', snapshot: SNAPSHOT }, 201);
      if (s.includes('/snapshots?')) return jsonResponse({ repo: 'acme/livenotes', count: 1, snapshots: [SNAP_SUMMARY] });
      if (s.endsWith(`/snapshots/${SNAP_ID}`)) return jsonResponse(SNAPSHOT);
      if (s.endsWith('/discover')) return jsonResponse({ repo: 'acme/livenotes', report: REPORT }, 201);
      if (s.includes('/candidates?')) return jsonResponse({ repo: 'acme/livenotes', count: 1, candidates: [CANDIDATE] });
      if (s.endsWith(`/candidates/${CAND_ID}`)) return jsonResponse(CANDIDATE);
      if (s.endsWith(`/claims/${CLAIM_ID}/verify`)) return jsonResponse({ claim: CLAIM });
      if (s.endsWith(`/claims/${CLAIM_ID}/verifications`)) {
        return jsonResponse({ repo: 'acme/livenotes', claimId: CLAIM_ID, count: 1, verifications: [VRF_RECORD] });
      }
      if (s.endsWith('/candidates/refresh-staleness')) return jsonResponse(STALENESS);
      return jsonResponse({}, 404);
    });

    const client = new HttpGitHubKnowledgeClient({
      baseUrl: '/api/',
      fetchImpl: fetchImpl as unknown as typeof fetch,
      timeoutMs: 0,
      longTimeoutMs: 0,
    });

    await expect(client.getStatus(REPO)).resolves.toEqual(STATUS);
    await expect(client.getRepository(REPO)).resolves.toEqual(REPO_META);
    await expect(client.verifyReadOnly(REPO)).resolves.toEqual(PROBE);
    await expect(client.indexRepository(REPO, { branch: 'main' })).resolves.toEqual(SNAPSHOT);
    await expect(client.listSnapshots(REPO, { branch: 'main', limit: 10 })).resolves.toEqual([
      SNAP_SUMMARY,
    ]);
    await expect(client.getSnapshot(REPO, SNAP_ID)).resolves.toEqual(SNAPSHOT);
    await expect(client.discoverPullRequests(REPO, { state: 'closed' })).resolves.toEqual(REPORT);
    await expect(client.listCandidates(REPO, { classification: 'user_facing_feature' })).resolves.toEqual([
      CANDIDATE,
    ]);
    await expect(client.getCandidate(REPO, CAND_ID)).resolves.toEqual(CANDIDATE);
    await expect(
      client.recordVerification(REPO, CLAIM_ID, {
        kind: 'runtime',
        environmentId: 'staging',
        note: 'ok',
      }),
    ).resolves.toEqual(CLAIM);
    await expect(client.listVerifications(REPO, CLAIM_ID)).resolves.toEqual([VRF_RECORD]);
    await expect(client.refreshStaleness(REPO, { branch: 'main' })).resolves.toEqual(STALENESS);
  });

  it('404 在 getSnapshot / getCandidate 上返回 null，503/400/网络失败映射为 KnowledgeHttpError', async () => {
    const fetchImpl = vi.fn(async (url: string | URL) => {
      const s = String(url);
      if (s.includes('/snapshots/')) return jsonResponse({ error: { code: 'not_found' } }, 404);
      if (s.includes('/candidates/')) return jsonResponse({ error: { code: 'not_found' } }, 404);
      if (s.endsWith('/index')) {
        return jsonResponse(
          { error: { code: 'github_not_configured', message: '未配置凭证' } },
          503,
        );
      }
      throw new TypeError('connect ECONNREFUSED');
    });

    const client = new HttpGitHubKnowledgeClient({
      fetchImpl: fetchImpl as unknown as typeof fetch,
      timeoutMs: 0,
      longTimeoutMs: 0,
    });

    await expect(client.getSnapshot(REPO, SNAP_ID)).resolves.toBeNull();
    await expect(client.getCandidate(REPO, CAND_ID)).resolves.toBeNull();

    await expect(client.indexRepository(REPO)).rejects.toMatchObject({
      name: 'KnowledgeHttpError',
      status: 503,
      code: 'github_not_configured',
      message: '未配置凭证',
    });

    await expect(client.getStatus()).rejects.toBeInstanceOf(KnowledgeHttpError);
    await expect(client.getStatus()).rejects.toMatchObject({
      status: 0,
      code: 'api_unreachable',
    });
  });
});
