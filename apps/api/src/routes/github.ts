import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  formatGitHubRepoRef,
  githubRepoRefSchema,
  parseGitHubRepoRef,
  type GitHubRepoRef,
} from '@asvs/domain';
import type { GitHubReadOnlyPort } from '@asvs/ports';
import { GitHubApiError } from '../github/redact';

const pullsQuerySchema = z.object({
  state: z.enum(['open', 'closed', 'all']).optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
});

const pullFilesQuerySchema = z.object({
  includePatch: z
    .enum(['true', 'false', '1', '0'])
    .transform((value) => value === 'true' || value === '1')
    .optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
});

const releasesQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).optional(),
});

const statusQuerySchema = z.object({
  repo: z.string().trim().min(1).optional(),
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

function parsePullNumber(raw: string): number {
  if (!/^\d+$/.test(raw)) {
    throw new GitHubApiError({
      code: 'invalid_github_request',
      httpStatus: 400,
      message: 'PR 编号必须为正整数。',
    });
  }
  const num = Number.parseInt(raw, 10);
  if (!Number.isSafeInteger(num) || num <= 0) {
    throw new GitHubApiError({
      code: 'invalid_github_request',
      httpStatus: 400,
      message: 'PR 编号必须为正整数。',
    });
  }
  return num;
}

export function registerGitHubRoutes(
  app: FastifyInstance,
  github: GitHubReadOnlyPort,
): void {
  app.get('/v1/github/status', async (request) => {
    const query = statusQuerySchema.safeParse(request.query);
    if (!query.success) {
      throw new GitHubApiError({
        code: 'invalid_github_request',
        httpStatus: 400,
        message: 'repo 查询参数无效。',
      });
    }

    let repo: GitHubRepoRef | undefined;
    if (query.data.repo) {
      try {
        repo = parseGitHubRepoRef(query.data.repo);
      } catch (error) {
        throw new GitHubApiError({
          code: 'invalid_github_request',
          httpStatus: 400,
          message: error instanceof Error ? error.message : 'repo 查询参数无效。',
        });
      }
    }

    return github.checkConnection(repo);
  });

  app.get<{ Params: { owner: string; repo: string } }>(
    '/v1/github/repos/:owner/:repo',
    async (request) => {
      const repo = parseRepoParams(request.params);
      return github.getRepository(repo);
    },
  );

  app.get<{ Params: { owner: string; repo: string } }>(
    '/v1/github/repos/:owner/:repo/pulls',
    async (request) => {
      const repo = parseRepoParams(request.params);
      const query = pullsQuerySchema.safeParse(request.query);
      if (!query.success) {
        throw new GitHubApiError({
          code: 'invalid_github_request',
          httpStatus: 400,
          message: 'PR 查询参数无效（state 需为 open/closed/all，limit 需为 1–100）。',
        });
      }

      const pulls = await github.listPullRequests(repo, query.data);
      return {
        repo: formatGitHubRepoRef(repo),
        count: pulls.length,
        pulls,
      };
    },
  );

  app.get<{ Params: { owner: string; repo: string; number: string } }>(
    '/v1/github/repos/:owner/:repo/pulls/:number/files',
    async (request) => {
      const repo = parseRepoParams(request.params);
      const pullNumber = parsePullNumber(request.params.number);
      const query = pullFilesQuerySchema.safeParse(request.query);
      if (!query.success) {
        throw new GitHubApiError({
          code: 'invalid_github_request',
          httpStatus: 400,
          message: 'PR 文件查询参数无效。',
        });
      }

      const files = await github.listPullRequestFiles(repo, pullNumber, query.data);
      return {
        repo: formatGitHubRepoRef(repo),
        pullNumber,
        count: files.length,
        files,
      };
    },
  );

  app.get<{ Params: { owner: string; repo: string } }>(
    '/v1/github/repos/:owner/:repo/releases',
    async (request) => {
      const repo = parseRepoParams(request.params);
      const query = releasesQuerySchema.safeParse(request.query);
      if (!query.success) {
        throw new GitHubApiError({
          code: 'invalid_github_request',
          httpStatus: 400,
          message: 'Release 查询参数无效（limit 需为 1–100）。',
        });
      }

      const releases = await github.listReleases(repo, query.data);
      return {
        repo: formatGitHubRepoRef(repo),
        count: releases.length,
        releases,
      };
    },
  );

  app.post<{ Params: { owner: string; repo: string } }>(
    '/v1/github/repos/:owner/:repo/verify-readonly',
    async (request) => {
      const repo = parseRepoParams(request.params);
      return github.probeWriteBlocked(repo);
    },
  );
}
