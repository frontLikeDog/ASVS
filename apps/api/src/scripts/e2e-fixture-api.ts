import { createHash } from 'node:crypto';
import type {
  GitHubCommitSummary,
  GitHubConnectionStatus,
  GitHubFileContent,
  GitHubPullRequestFile,
  GitHubPullRequestSummary,
  GitHubReleaseSummary,
  GitHubRepoRef,
  GitHubRepositoryMetadata,
  GitHubWriteProbeResult,
} from '@asvs/domain';
import { formatGitHubRepoRef } from '@asvs/domain';
import type { GitHubReadOnlyPort, GitHubTreeEntry } from '@asvs/ports';
import { buildApp } from '../app';

/**
 * Standalone local test-only fixture API for Playwright Step 4D E2E tests.
 * Never imported by `apps/api/src/main.ts`; binds `127.0.0.1` on an ephemeral
 * port and uses real Fastify + SQLite v4 + 4B incremental indexer + 4C PR
 * discovery over a deterministic in-memory GitHub repository fixture.
 */

const REPO_OWNER = 'acme';
const REPO_NAME = 'livenotes';
const FULL_REPO = `${REPO_OWNER}/${REPO_NAME}`;
const COMMIT_1 = '1111111111111111111111111111111111111111';
const COMMIT_2 = '2222222222222222222222222222222222222222';
const TREE_1 = 'aaaa111111111111111111111111111111111111';
const TREE_2 = 'bbbb222222222222222222222222222222222222';

function gitSha1(content: string): string {
  return createHash('sha1').update(content, 'utf8').digest('hex');
}

interface FixtureFile {
  path: string;
  content: string;
  sha: string;
}

function buildFiles(commitVersion: 1 | 2): Map<string, FixtureFile> {
  const exportPanelContent =
    commitVersion === 1
      ? `export function ExportPanel() {\n  return <button type="button">Export CSV</button>;\n}\n`
      : `export function ExportPanel() {\n  return <button type="button">Export CSV v2</button>;\n}\n`;
  const entries: Array<[string, string]> = [
    ['README.md', '# LiveNotes\n\nCollaborative workspace notes.\n'],
    ['src/ui/export-panel.tsx', exportPanelContent],
    ['src/core/format.ts', 'export function normalizeTitle(v: string) { return v.trim(); }\n'],
  ];
  const map = new Map<string, FixtureFile>();
  for (const [filePath, content] of entries) {
    map.set(filePath, { path: filePath, content, sha: gitSha1(`${filePath}:${content}`) });
  }
  return map;
}

class FixtureGitHubReadOnlyPort implements GitHubReadOnlyPort {
  #commitVersion: 1 | 2 = 1;
  #files = buildFiles(1);

  advanceCommit(): { commitSha: string; changedFile: string } {
    this.#commitVersion = 2;
    this.#files = buildFiles(2);
    return { commitSha: COMMIT_2, changedFile: 'src/ui/export-panel.tsx' };
  }

  isConfigured(): boolean {
    return true;
  }

  getDefaultRepo(): GitHubRepoRef {
    return { owner: REPO_OWNER, repo: REPO_NAME };
  }

  #assertSupportedRepo(repo: GitHubRepoRef): void {
    if (formatGitHubRepoRef(repo) !== FULL_REPO) {
      throw new Error(`测试夹具仅包含仓库 ${FULL_REPO}，收到 ${formatGitHubRepoRef(repo)}`);
    }
  }

  async checkConnection(repo?: GitHubRepoRef): Promise<GitHubConnectionStatus> {
    if (repo) this.#assertSupportedRepo(repo);
    return {
      configured: true,
      mode: 'github_app',
      connected: true,
      readOnly: true,
      appId: '900001',
      installationId: '800001',
      repo: FULL_REPO,
      repositorySelection: 'selected',
      accessibleRepositories: [FULL_REPO],
      permissions: { contents: 'read', metadata: 'read', pull_requests: 'read' },
      writePermissions: [],
      checkedAt: new Date().toISOString(),
    };
  }

  async getRepository(repo: GitHubRepoRef): Promise<GitHubRepositoryMetadata> {
    this.#assertSupportedRepo(repo);
    return {
      id: 9001,
      owner: REPO_OWNER,
      name: REPO_NAME,
      fullName: FULL_REPO,
      description: 'LiveNotes E2E Fixture Repository',
      private: false,
      defaultBranch: 'main',
      htmlUrl: `https://github.com/${FULL_REPO}`,
      pushedAt: '2026-11-27T10:00:00.000Z',
      updatedAt: '2026-11-27T10:00:00.000Z',
    };
  }

  async listPullRequests(repo: GitHubRepoRef): Promise<GitHubPullRequestSummary[]> {
    this.#assertSupportedRepo(repo);
    return [
      {
        id: 1001,
        number: 101,
        title: 'feat: add CSV export button',
        body: 'Expose one-click CSV export in the workspace panel.',
        state: 'closed',
        draft: false,
        merged: true,
        mergedAt: '2026-11-26T12:00:00.000Z',
        createdAt: '2026-11-26T10:00:00.000Z',
        updatedAt: '2026-11-26T12:00:00.000Z',
        author: 'alice',
        labels: ['feature'],
        headSha: COMMIT_1,
        baseBranch: 'main',
        headBranch: 'feat/csv-export',
        mergeCommitSha: COMMIT_1,
        htmlUrl: `https://github.com/${FULL_REPO}/pull/101`,
      },
      {
        id: 1002,
        number: 102,
        title: 'refactor: cleanup internal helper',
        body: 'Internal formatting helper cleanup.',
        state: 'closed',
        draft: false,
        merged: true,
        mergedAt: '2026-11-25T12:00:00.000Z',
        createdAt: '2026-11-25T10:00:00.000Z',
        updatedAt: '2026-11-25T12:00:00.000Z',
        author: 'bob',
        labels: ['refactor'],
        headSha: COMMIT_1,
        baseBranch: 'main',
        headBranch: 'refactor/format',
        mergeCommitSha: COMMIT_1,
        htmlUrl: `https://github.com/${FULL_REPO}/pull/102`,
      },
    ];
  }

  async listPullRequestFiles(
    repo: GitHubRepoRef,
    pullNumber: number,
  ): Promise<GitHubPullRequestFile[]> {
    this.#assertSupportedRepo(repo);
    if (pullNumber === 101) {
      return [
        {
          filename: 'src/ui/export-panel.tsx',
          status: 'modified',
          additions: 24,
          deletions: 4,
          changes: 28,
        },
      ];
    }
    return [
      {
        filename: 'src/core/format.ts',
        status: 'modified',
        additions: 5,
        deletions: 7,
        changes: 12,
      },
    ];
  }

  async listReleases(repo: GitHubRepoRef): Promise<GitHubReleaseSummary[]> {
    this.#assertSupportedRepo(repo);
    return [];
  }

  async getCommit(repo: GitHubRepoRef): Promise<GitHubCommitSummary> {
    this.#assertSupportedRepo(repo);
    return this.#commitVersion === 1
      ? {
          sha: COMMIT_1,
          treeSha: TREE_1,
          commitAt: '2026-11-26T12:00:00.000Z',
          message: 'feat: add CSV export button',
        }
      : {
          sha: COMMIT_2,
          treeSha: TREE_2,
          commitAt: '2026-11-27T12:00:00.000Z',
          message: 'chore: update export panel component',
        };
  }

  async getRepositoryTree(repo: GitHubRepoRef): Promise<GitHubTreeEntry[]> {
    this.#assertSupportedRepo(repo);
    return Array.from(this.#files.values()).map((file) => ({
      path: file.path,
      type: 'blob' as const,
      sha: file.sha,
      size: Buffer.byteLength(file.content, 'utf8'),
    }));
  }

  async getFileContent(
    repo: GitHubRepoRef,
    filePath: string,
  ): Promise<GitHubFileContent | null> {
    this.#assertSupportedRepo(repo);
    const file = this.#files.get(filePath);
    if (!file) return null;
    return {
      path: file.path,
      sha: file.sha,
      size: Buffer.byteLength(file.content, 'utf8'),
      encoding: 'utf-8',
      content: file.content,
      contentBase64: Buffer.from(file.content, 'utf8').toString('base64'),
    };
  }

  async probeWriteBlocked(repo: GitHubRepoRef): Promise<GitHubWriteProbeResult> {
    this.#assertSupportedRepo(repo);
    return {
      repo: FULL_REPO,
      readOnlyToken: true,
      writeBlocked: true,
      statusCode: 403,
      detail: 'GitHub App 只读令牌已拦截写入请求（AC-01）',
      writePermissions: [],
      checkedAt: new Date().toISOString(),
    };
  }
}

async function main(): Promise<void> {
  const dbPath = process.env.ASVS_E2E_DB_PATH?.trim() || ':memory:';
  const fixtureGitHub = new FixtureGitHubReadOnlyPort();
  const { app } = await buildApp({
    dbPath,
    corsOrigins: ['http://localhost:4200', 'http://127.0.0.1:4200'],
    logger: false,
    github: fixtureGitHub,
  });

  app.post('/__test/advance-commit', async (request, reply) => {
    const ip = request.ip;
    if (ip !== '127.0.0.1' && ip !== '::1' && ip !== '::ffff:127.0.0.1') {
      return reply.code(403).send({ error: { code: 'forbidden', message: 'localhost only' } });
    }
    return fixtureGitHub.advanceCommit();
  });

  const address = await app.listen({ host: '127.0.0.1', port: 0 });
  const port = Number(new URL(address).port);
  process.stdout.write(`READY ${JSON.stringify({ port })}\n`);

  const shutdown = async () => {
    await app.close();
    process.exit(0);
  };
  process.once('SIGINT', () => void shutdown());
  process.once('SIGTERM', () => void shutdown());
}

void main().catch((error) => {
  console.error(error);
  process.exit(1);
});
