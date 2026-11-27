import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  PR_CHANGE_CLASSIFICATIONS,
  claimCandidateIdSchema,
  claimVerificationInputV1Schema,
  formatGitHubRepoRef,
  githubRepoRefSchema,
  knowledgeSnapshotIdSchema,
  prCandidateIdSchema,
  type GitHubRepoRef,
} from '@asvs/domain';
import type { PRDiscoveryPort } from '@asvs/ports';
import { GitHubApiError } from '../github/redact';
import { PRDiscoveryError } from '../knowledge/pr-discovery-service';

const discoverBodySchema = z
  .object({
    state: z.enum(['open', 'closed', 'all']).optional(),
    limit: z.number().int().min(1).max(50).optional(),
    pullNumbers: z.array(z.number().int().positive()).max(50).optional(),
    branch: z.string().trim().min(1).max(255).optional(),
    snapshotId: knowledgeSnapshotIdSchema.optional(),
  })
  .strict()
  .optional();

const listQuerySchema = z.object({
  classification: z.enum(PR_CHANGE_CLASSIFICATIONS).optional(),
  pullNumber: z.coerce.number().int().positive().optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
});

const refreshBodySchema = z
  .object({
    branch: z.string().trim().min(1).max(255).optional(),
    snapshotId: knowledgeSnapshotIdSchema.optional(),
  })
  .strict()
  .optional();

function parseRepoParams(params: { owner: string; repo: string }): GitHubRepoRef {
  const parsed = githubRepoRefSchema.safeParse(params);
  if (!parsed.success) {
    throw new GitHubApiError({
      code: 'invalid_github_request',
      httpStatus: 400,
      message: 'GitHub 仓库 owner/repo 参数格式无效。',
    });
  }
  return parsed.data;
}

function parseCandidateId(raw: string): string {
  const parsed = prCandidateIdSchema.safeParse(raw);
  if (!parsed.success) {
    throw new GitHubApiError({
      code: 'invalid_github_request',
      httpStatus: 400,
      message: '候选 ID 格式无效（应为 prc_ 加 16 位小写十六进制）。',
    });
  }
  return parsed.data;
}

function parseClaimId(raw: string): string {
  const parsed = claimCandidateIdSchema.safeParse(raw);
  if (!parsed.success) {
    throw new GitHubApiError({
      code: 'invalid_github_request',
      httpStatus: 400,
      message: 'Claim ID 格式无效（应为 claim_ 加 16 位小写十六进制）。',
    });
  }
  return parsed.data;
}

/**
 * Step 4C HTTP surface. Discover is the only route that needs GitHub
 * credentials (503 when unconfigured); reading candidates, recording evidence
 * and refreshing staleness operate on local SQLite and stay available.
 */
export function registerPRDiscoveryRoutes(
  app: FastifyInstance,
  discovery: PRDiscoveryPort,
): void {
  app.post<{ Params: { owner: string; repo: string } }>(
    '/v1/github/repos/:owner/:repo/discover',
    async (request, reply) => {
      const repo = parseRepoParams(request.params);
      const body = discoverBodySchema.safeParse(request.body ?? undefined);
      if (!body.success) {
        throw new GitHubApiError({
          code: 'invalid_github_request',
          httpStatus: 400,
          message:
            '发现请求体无效（仅支持 state / limit / pullNumbers / branch / snapshotId）。',
          details: { issues: body.error.issues },
        });
      }

      const report = await discovery.analyzePullRequests(repo, body.data);
      // 201: the run created or refreshed candidate analyses for this repo.
      return reply.code(201).send({ repo: formatGitHubRepoRef(repo), report });
    },
  );

  app.get<{ Params: { owner: string; repo: string } }>(
    '/v1/github/repos/:owner/:repo/candidates',
    async (request) => {
      const repo = parseRepoParams(request.params);
      const query = listQuerySchema.safeParse(request.query);
      if (!query.success) {
        throw new GitHubApiError({
          code: 'invalid_github_request',
          httpStatus: 400,
          message: '候选查询参数无效（classification / pullNumber / limit）。',
        });
      }

      const candidates = await discovery.listCandidates(repo, query.data);
      return { repo: formatGitHubRepoRef(repo), count: candidates.length, candidates };
    },
  );

  // Static segment first: `/refresh-staleness` must never be captured as a
  // candidate id, and candidate ids are validated to fail closed anyway.
  app.post<{ Params: { owner: string; repo: string } }>(
    '/v1/github/repos/:owner/:repo/candidates/refresh-staleness',
    async (request) => {
      const repo = parseRepoParams(request.params);
      const body = refreshBodySchema.safeParse(request.body ?? undefined);
      if (!body.success) {
        throw new GitHubApiError({
          code: 'invalid_github_request',
          httpStatus: 400,
          message: '过期刷新请求体无效（仅支持 branch 与 snapshotId）。',
          details: { issues: body.error.issues },
        });
      }

      return discovery.refreshStaleness(repo, body.data);
    },
  );

  app.get<{ Params: { owner: string; repo: string; candidateId: string } }>(
    '/v1/github/repos/:owner/:repo/candidates/:candidateId',
    async (request, reply) => {
      const repo = parseRepoParams(request.params);
      const candidateId = parseCandidateId(request.params.candidateId);

      const candidate = await discovery.getCandidate(repo, candidateId);
      if (!candidate) {
        return reply.code(404).send({
          error: { code: 'not_found', message: `候选 ${candidateId} 不存在。` },
        });
      }
      return candidate;
    },
  );

  app.post<{ Params: { owner: string; repo: string; claimId: string } }>(
    '/v1/github/repos/:owner/:repo/claims/:claimId/verify',
    async (request) => {
      const repo = parseRepoParams(request.params);
      const claimId = parseClaimId(request.params.claimId);

      const body = claimVerificationInputV1Schema.safeParse(request.body);
      if (!body.success) {
        throw new GitHubApiError({
          code: 'invalid_github_request',
          httpStatus: 400,
          message:
            '核验请求体无效：kind 需为 test / runtime / release / human；runtime 必须带 environmentId，release 必须带 releaseTag，human 必须带 decision，verifiedAt 需为 ISO-8601。',
          details: { issues: body.error.issues },
        });
      }

      const claim = await discovery.recordVerification(repo, claimId, body.data);
      if (!claim) {
        throw new PRDiscoveryError(
          'claim_not_found',
          404,
          `Claim ${claimId} 不存在；请先发现该仓库的 PR 候选。`,
        );
      }
      return { claim };
    },
  );

  app.get<{ Params: { owner: string; repo: string; claimId: string } }>(
    '/v1/github/repos/:owner/:repo/claims/:claimId/verifications',
    async (request) => {
      const repo = parseRepoParams(request.params);
      const claimId = parseClaimId(request.params.claimId);

      const verifications = await discovery.listVerifications(repo, claimId);
      if (!verifications) {
        throw new PRDiscoveryError(
          'claim_not_found',
          404,
          `Claim ${claimId} 不存在；请先发现该仓库的 PR 候选。`,
        );
      }
      return {
        repo: formatGitHubRepoRef(repo),
        claimId,
        count: verifications.length,
        verifications,
      };
    },
  );
}
