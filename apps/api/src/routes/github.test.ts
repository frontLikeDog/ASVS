// @vitest-environment node
import { afterEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { GitHubReadOnlyPort } from '@asvs/ports';
import { buildApp } from '../app';
import { GitHubApiError } from '../github/redact';

let app: FastifyInstance | undefined;

afterEach(async () => {
  await app?.close();
  app = undefined;
});

function createStubGitHubPort(overrides: Partial<GitHubReadOnlyPort> = {}): GitHubReadOnlyPort {
  return {
    isConfigured: () => true,
    getDefaultRepo: () => ({ owner: 'frontLikeDog', repo: 'livenotes' }),
    checkConnection: async (repo) => ({
      configured: true,
      mode: 'github_app',
      connected: true,
      readOnly: true,
      appId: '5947613',
      installationId: '186376455',
      repo: repo ? `${repo.owner}/${repo.repo}` : 'frontLikeDog/livenotes',
      repositorySelection: 'selected',
      accessibleRepositories: ['frontLikeDog/livenotes'],
      permissions: { contents: 'read', pull_requests: 'read', metadata: 'read' },
      writePermissions: [],
      checkedAt: '2026-11-27T12:00:00.000Z',
    }),
    getRepository: async (repo) => ({
      id: 1,
      owner: repo.owner,
      name: repo.repo,
      fullName: `${repo.owner}/${repo.repo}`,
      description: 'Notes',
      private: true,
      defaultBranch: 'main',
      htmlUrl: `https://github.com/${repo.owner}/${repo.repo}`,
      pushedAt: '2026-11-26T12:00:00Z',
      updatedAt: '2026-11-26T12:00:00Z',
    }),
    listPullRequests: async () => [
      {
        id: 10,
        number: 1,
        title: 'feat: markdown preview',
        body: null,
        state: 'closed',
        draft: false,
        merged: true,
        mergedAt: '2026-11-26T10:00:00Z',
        createdAt: '2026-11-25T10:00:00Z',
        updatedAt: '2026-11-26T10:00:00Z',
        author: 'frontLikeDog',
        labels: [],
        headSha: 'abc1234',
        baseBranch: 'main',
        headBranch: 'feat/preview',
        mergeCommitSha: 'def5678',
        htmlUrl: 'https://github.com/frontLikeDog/livenotes/pull/1',
      },
    ],
    listPullRequestFiles: async () => [
      {
        filename: 'src/preview.tsx',
        status: 'added',
        additions: 42,
        deletions: 0,
        changes: 42,
      },
    ],
    listReleases: async () => [],
    getFileContent: async () => null,
    getCommit: async () => ({
      sha: '0123456789abcdef0123456789abcdef01234567',
      treeSha: '89abcdef0123456789abcdef0123456789abcdef',
      commitAt: '2026-11-26T12:00:00Z',
      message: 'feat: markdown preview',
    }),
    getRepositoryTree: async () => [],
    probeWriteBlocked: async (repo) => ({
      repo: `${repo.owner}/${repo.repo}`,
      readOnlyToken: true,
      writeBlocked: true,
      statusCode: 403,
      detail: 'GitHub 已按预期拒绝写操作（HTTP 403）。',
      writePermissions: [],
      checkedAt: '2026-11-27T12:00:00.000Z',
    }),
    ...overrides,
  };
}

describe('ASVS API · GitHub 只读路由', () => {
  it('未配置 GitHub App 时 /v1/health 正常且 /v1/github/status 返回 configured=false', async () => {
    const built = await buildApp({ dbPath: ':memory:' });
    app = built.app;

    const health = await app.inject({ method: 'GET', url: '/v1/health' });
    expect(health.statusCode).toBe(200);
    expect(health.json().githubConfigured).toBe(false);

    const status = await app.inject({ method: 'GET', url: '/v1/github/status' });
    expect(status.statusCode).toBe(200);
    expect(status.json()).toMatchObject({
      configured: false,
      connected: false,
      readOnly: false,
    });

    const pulls = await app.inject({
      method: 'GET',
      url: '/v1/github/repos/frontLikeDog/livenotes/pulls',
    });
    expect(pulls.statusCode).toBe(503);
    expect(pulls.json().error.code).toBe('github_not_configured');
  });

  it('已配置只读端口时提供状态、仓库、PR、文件、Release 与只读探针', async () => {
    const built = await buildApp({
      dbPath: ':memory:',
      github: createStubGitHubPort(),
    });
    app = built.app;

    const health = await app.inject({ method: 'GET', url: '/v1/health' });
    expect(health.json().githubConfigured).toBe(true);

    const status = await app.inject({
      method: 'GET',
      url: '/v1/github/status?repo=frontLikeDog/livenotes',
    });
    expect(status.statusCode).toBe(200);
    expect(status.json()).toMatchObject({
      connected: true,
      readOnly: true,
      repo: 'frontLikeDog/livenotes',
    });

    const pulls = await app.inject({
      method: 'GET',
      url: '/v1/github/repos/frontLikeDog/livenotes/pulls?state=all&limit=10',
    });
    expect(pulls.statusCode).toBe(200);
    expect(pulls.json().count).toBe(1);

    const files = await app.inject({
      method: 'GET',
      url: '/v1/github/repos/frontLikeDog/livenotes/pulls/1/files',
    });
    expect(files.statusCode).toBe(200);
    expect(files.json().files[0].filename).toBe('src/preview.tsx');

    const probe = await app.inject({
      method: 'POST',
      url: '/v1/github/repos/frontLikeDog/livenotes/verify-readonly',
    });
    expect(probe.statusCode).toBe(200);
    expect(probe.json()).toMatchObject({
      readOnlyToken: true,
      writeBlocked: true,
      statusCode: 403,
    });
  });

  it('拒绝非法参数并映射写权限错误为 403', async () => {
    const built = await buildApp({
      dbPath: ':memory:',
      github: createStubGitHubPort({
        listPullRequests: async () => {
          throw new GitHubApiError({
            code: 'github_write_permission_detected',
            httpStatus: 403,
            message: '检测到写权限',
            details: { writePermissions: ['contents:write'] },
          });
        },
      }),
    });
    app = built.app;

    const badPr = await app.inject({
      method: 'GET',
      url: '/v1/github/repos/frontLikeDog/livenotes/pulls/abc/files',
    });
    expect(badPr.statusCode).toBe(400);
    expect(badPr.json().error.code).toBe('invalid_github_request');

    const badRepo = await app.inject({
      method: 'GET',
      url: '/v1/github/status?repo=https://evil.example/a/b',
    });
    expect(badRepo.statusCode).toBe(400);

    const writeErr = await app.inject({
      method: 'GET',
      url: '/v1/github/repos/frontLikeDog/livenotes/pulls',
    });
    expect(writeErr.statusCode).toBe(403);
    expect(writeErr.json().error.code).toBe('github_write_permission_detected');
  });
});
