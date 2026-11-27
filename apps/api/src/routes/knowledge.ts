import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  formatGitHubRepoRef,
  githubRepoRefSchema,
  knowledgeSnapshotIdSchema,
  type GitHubRepoRef,
} from '@asvs/domain';
import type { KnowledgeIndexPort } from '@asvs/ports';
import { GitHubApiError } from '../github/redact';

const indexBodySchema = z
  .object({
    branch: z.string().trim().min(1).max(255).optional(),
    forceCold: z.boolean().optional(),
  })
  .strict()
  .optional();

const listQuerySchema = z.object({
  branch: z.string().trim().min(1).max(255).optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
});

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

function parseSnapshotId(raw: string): string {
  const parsed = knowledgeSnapshotIdSchema.safeParse(raw);
  if (!parsed.success) {
    throw new GitHubApiError({
      code: 'invalid_github_request',
      httpStatus: 400,
      message: '快照 ID 格式无效（应为 snap_ 加 32 位小写十六进制）。',
    });
  }
  return parsed.data;
}

export function registerKnowledgeRoutes(
  app: FastifyInstance,
  indexer: KnowledgeIndexPort,
): void {
  app.post<{ Params: { owner: string; repo: string } }>(
    '/v1/github/repos/:owner/:repo/index',
    async (request, reply) => {
      const repo = parseRepoParams(request.params);
      const body = indexBodySchema.safeParse(request.body ?? undefined);
      if (!body.success) {
        throw new GitHubApiError({
          code: 'invalid_github_request',
          httpStatus: 400,
          message: '索引请求体无效（仅支持 branch 与 forceCold）。',
        });
      }

      const snapshot = await indexer.indexRepository(repo, body.data);
      // 201 conveys "a new immutable snapshot was created", including on the
      // incremental path; nothing is ever updated in place.
      return reply.code(201).send({ repo: formatGitHubRepoRef(repo), snapshot });
    },
  );

  app.get<{ Params: { owner: string; repo: string } }>(
    '/v1/github/repos/:owner/:repo/snapshots',
    async (request) => {
      const repo = parseRepoParams(request.params);
      const query = listQuerySchema.safeParse(request.query);
      if (!query.success) {
        throw new GitHubApiError({
          code: 'invalid_github_request',
          httpStatus: 400,
          message: '快照查询参数无效（limit 需为 1–100）。',
        });
      }

      const snapshots = await indexer.listSnapshots(repo, query.data);
      return { repo: formatGitHubRepoRef(repo), count: snapshots.length, snapshots };
    },
  );

  app.get<{ Params: { owner: string; repo: string; snapshotId: string } }>(
    '/v1/github/repos/:owner/:repo/snapshots/:snapshotId',
    async (request, reply) => {
      const repo = parseRepoParams(request.params);
      const snapshotId = parseSnapshotId(request.params.snapshotId);

      const snapshot = await indexer.getSnapshot(repo, snapshotId);
      if (!snapshot) {
        return reply.code(404).send({
          error: { code: 'not_found', message: `快照 ${snapshotId} 不存在。` },
        });
      }
      return snapshot;
    },
  );
}
