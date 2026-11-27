import { readFileSync } from 'node:fs';
import {
  auditGitHubPermissions,
  formatGitHubRepoRef,
  githubCommitSummarySchema,
  githubConnectionStatusSchema,
  githubFileContentSchema,
  githubPullRequestFileSchema,
  githubPullRequestSummarySchema,
  githubReleaseSummarySchema,
  githubRepoRefSchema,
  githubRepositoryMetadataSchema,
  githubWriteProbeResultSchema,
  type GitHubCommitSummary,
  type GitHubConnectionStatus,
  type GitHubFileContent,
  type GitHubPermissionAudit,
  type GitHubPullRequestFile,
  type GitHubPullRequestSummary,
  type GitHubReleaseSummary,
  type GitHubRepoRef,
  type GitHubRepositoryMetadata,
  type GitHubWriteProbeResult,
} from '@asvs/domain';
import type {
  GetRepositoryTreeOptions,
  GitHubReadOnlyPort,
  GitHubTreeEntry,
  ListPullRequestFilesOptions,
  ListPullRequestsOptions,
  ListReleasesOptions,
} from '@asvs/ports';
import { createGitHubAppJwt } from './jwt';
import { GitHubApiError, redactSecrets } from './redact';

const DEFAULT_GITHUB_API_BASE_URL = 'https://api.github.com';
const GITHUB_API_VERSION = '2022-11-28';
const USER_AGENT = 'asvs-github-readonly/0.1';
const TOKEN_REFRESH_SKEW_MS = 60_000;
const MAX_FILE_BYTES = 1024 * 1024;
const MAX_PATCH_CHARS = 32_768;

export interface GitHubAppClientOptions {
  appId: string;
  installationId: string;
  privateKeyPem?: string;
  privateKeyPath?: string;
  defaultRepo?: GitHubRepoRef;
  apiBaseUrl?: string;
  fetchImpl?: typeof fetch;
  now?: () => number;
}

interface CachedInstallationToken {
  token: string;
  expiresAtMs: number;
  audit: GitHubPermissionAudit;
  repositorySelection?: 'all' | 'selected';
}

function clampLimit(value: number | undefined, fallback: number, max = 100): number {
  if (value === undefined || !Number.isFinite(value)) return fallback;
  return Math.max(1, Math.min(max, Math.trunc(value)));
}

/**
 * Branch names may contain slashes (`feat/x`) but never traversal, empty
 * segments or control characters. Each segment is percent-encoded so a branch
 * name cannot escape its path slot or inject a query string.
 */
function encodeGitRef(rawRef: string): string {
  const trimmed = rawRef.trim();
  if (
    !trimmed ||
    trimmed.startsWith('/') ||
    trimmed.endsWith('/') ||
    trimmed.includes('\0') ||
    trimmed.includes('\\') ||
    trimmed.includes('?') ||
    trimmed.includes('#')
  ) {
    throw new GitHubApiError({
      code: 'invalid_github_request',
      httpStatus: 400,
      message: 'Git ref 无效。',
    });
  }
  const segments = trimmed.split('/');
  for (const seg of segments) {
    if (!seg || seg === '.' || seg === '..') {
      throw new GitHubApiError({
        code: 'invalid_github_request',
        httpStatus: 400,
        message: 'Git ref 不能包含空段或相对路径穿越。',
      });
    }
  }
  return segments.map((seg) => encodeURIComponent(seg)).join('/');
}

function validateSafeRepoFilePath(rawPath: string): string {
  const normalized = rawPath.trim().replace(/\\/g, '/');
  if (
    !normalized ||
    normalized.startsWith('/') ||
    normalized.endsWith('/') ||
    normalized.includes('\0')
  ) {
    throw new GitHubApiError({
      code: 'invalid_github_request',
      httpStatus: 400,
      message: '仓库文件路径无效。',
    });
  }
  const segments = normalized.split('/');
  for (const seg of segments) {
    if (!seg || seg === '.' || seg === '..') {
      throw new GitHubApiError({
        code: 'invalid_github_request',
        httpStatus: 400,
        message: '仓库文件路径不能包含空段或相对路径穿越。',
      });
    }
  }
  return segments.map((seg) => encodeURIComponent(seg)).join('/');
}

function parseErrorMessage(bodyText: string): string {
  if (!bodyText) return '';
  try {
    const parsed = JSON.parse(bodyText) as { message?: unknown };
    if (typeof parsed.message === 'string') return redactSecrets(parsed.message);
  } catch {
    // Plain text upstream error
  }
  return redactSecrets(bodyText.slice(0, 300));
}

function mapUpstreamHttpError(status: number, bodyText: string, context: string): GitHubApiError {
  const upstreamMsg = parseErrorMessage(bodyText);
  const suffix = upstreamMsg ? `（${upstreamMsg}）` : '';

  if (status === 401) {
    return new GitHubApiError({
      code: 'github_auth_error',
      httpStatus: 502,
      upstreamStatus: status,
      message: `GitHub 认证失败或授权已被撤销：${context}${suffix}`,
    });
  }
  if (status === 403) {
    const isRateLimit = /rate limit/i.test(upstreamMsg);
    return new GitHubApiError({
      code: isRateLimit ? 'github_rate_limited' : 'github_forbidden',
      httpStatus: isRateLimit ? 429 : 403,
      upstreamStatus: status,
      message: isRateLimit
        ? `GitHub API 触发速率限制：${context}${suffix}`
        : `GitHub 拒绝访问（权限不足或仓库未授权给该安装）：${context}${suffix}`,
    });
  }
  if (status === 404) {
    return new GitHubApiError({
      code: 'github_not_found',
      httpStatus: 404,
      upstreamStatus: status,
      message: `GitHub 资源不存在或未授权访问：${context}${suffix}`,
    });
  }
  if (status === 429) {
    return new GitHubApiError({
      code: 'github_rate_limited',
      httpStatus: 429,
      upstreamStatus: status,
      message: `GitHub API 触发速率限制：${context}${suffix}`,
    });
  }
  return new GitHubApiError({
    code: 'github_upstream_error',
    httpStatus: 502,
    upstreamStatus: status,
    message: `GitHub API 请求失败（HTTP ${status}）：${context}${suffix}`,
  });
}

export class GitHubAppReadOnlyClient implements GitHubReadOnlyPort {
  readonly #appId: string;
  readonly #installationId: string;
  readonly #privateKeyPath?: string;
  #privateKeyPem?: string;
  readonly #defaultRepo?: GitHubRepoRef;
  readonly #apiBaseUrl: string;
  readonly #fetchImpl: typeof fetch;
  readonly #now: () => number;
  #cachedToken?: CachedInstallationToken;

  constructor(options: GitHubAppClientOptions) {
    const appId = options.appId.trim();
    const installationId = options.installationId.trim();
    if (!/^\d+$/.test(appId)) {
      throw new GitHubApiError({
        code: 'invalid_github_request',
        httpStatus: 500,
        message: 'GITHUB_APP_ID 必须为纯数字。',
      });
    }
    if (!/^\d+$/.test(installationId)) {
      throw new GitHubApiError({
        code: 'invalid_github_request',
        httpStatus: 500,
        message: 'GITHUB_APP_INSTALLATION_ID 必须为纯数字。',
      });
    }
    if (!options.privateKeyPem && !options.privateKeyPath) {
      throw new GitHubApiError({
        code: 'github_not_configured',
        httpStatus: 503,
        message: '缺少 GitHub App 私钥配置（GITHUB_APP_PRIVATE_KEY_PATH 或 GITHUB_APP_PRIVATE_KEY）。',
      });
    }

    const baseUrl = (options.apiBaseUrl ?? DEFAULT_GITHUB_API_BASE_URL).replace(/\/+$/, '');
    let parsedBase: URL;
    try {
      parsedBase = new URL(baseUrl);
    } catch {
      throw new GitHubApiError({
        code: 'invalid_github_request',
        httpStatus: 500,
        message: 'GITHUB_API_BASE_URL 无效。',
      });
    }
    if (parsedBase.protocol !== 'https:' && !options.fetchImpl) {
      throw new GitHubApiError({
        code: 'invalid_github_request',
        httpStatus: 500,
        message: '生产环境下 GitHub API 必须使用 HTTPS。',
      });
    }

    this.#appId = appId;
    this.#installationId = installationId;
    this.#privateKeyPem = options.privateKeyPem;
    this.#privateKeyPath = options.privateKeyPath;
    this.#defaultRepo = options.defaultRepo ? githubRepoRefSchema.parse(options.defaultRepo) : undefined;
    this.#apiBaseUrl = baseUrl;
    this.#fetchImpl = options.fetchImpl ?? fetch;
    this.#now = options.now ?? (() => Date.now());
  }

  isConfigured(): boolean {
    return true;
  }

  getDefaultRepo(): GitHubRepoRef | undefined {
    return this.#defaultRepo;
  }

  #getPrivateKeyPem(): string {
    if (this.#privateKeyPem) return this.#privateKeyPem;
    if (!this.#privateKeyPath) {
      throw new GitHubApiError({
        code: 'github_not_configured',
        httpStatus: 503,
        message: '未配置 GitHub App 私钥路径。',
      });
    }
    try {
      this.#privateKeyPem = readFileSync(this.#privateKeyPath, 'utf8');
      return this.#privateKeyPem;
    } catch {
      throw new GitHubApiError({
        code: 'github_auth_error',
        httpStatus: 500,
        message: '无法读取 GitHub App 私钥文件，请检查文件路径和读取权限。',
      });
    }
  }

  async #getInstallationToken(forceRefresh = false): Promise<CachedInstallationToken> {
    const nowMs = this.#now();
    if (
      !forceRefresh &&
      this.#cachedToken &&
      this.#cachedToken.expiresAtMs - TOKEN_REFRESH_SKEW_MS > nowMs
    ) {
      return this.#cachedToken;
    }

    const jwt = createGitHubAppJwt({
      appId: this.#appId,
      privateKeyPem: this.#getPrivateKeyPem(),
      nowMs,
    });

    const url = `${this.#apiBaseUrl}/app/installations/${this.#installationId}/access_tokens`;
    let response: Response;
    try {
      response = await this.#fetchImpl(url, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${jwt}`,
          Accept: 'application/vnd.github+json',
          'X-GitHub-Api-Version': GITHUB_API_VERSION,
          'User-Agent': USER_AGENT,
        },
      });
    } catch (error) {
      throw new GitHubApiError({
        code: 'github_upstream_error',
        httpStatus: 502,
        message: `无法连接 GitHub API 获取安装令牌：${error instanceof Error ? error.message : '网络错误'}`,
      });
    }

    const bodyText = await response.text();
    if (!response.ok) {
      this.#cachedToken = undefined;
      throw mapUpstreamHttpError(response.status, bodyText, '获取 GitHub App 安装令牌');
    }

    let data: {
      token?: string;
      expires_at?: string;
      permissions?: Record<string, string>;
      repository_selection?: string;
    };
    try {
      data = JSON.parse(bodyText) as typeof data;
    } catch {
      throw new GitHubApiError({
        code: 'github_upstream_error',
        httpStatus: 502,
        message: 'GitHub 安装令牌响应不是有效 JSON。',
      });
    }

    if (typeof data.token !== 'string' || !data.token) {
      throw new GitHubApiError({
        code: 'github_upstream_error',
        httpStatus: 502,
        message: 'GitHub 安装令牌响应缺少 token 字段。',
      });
    }

    const parsedExpiry = data.expires_at ? Date.parse(data.expires_at) : Number.NaN;
    const expiresAtMs = Number.isFinite(parsedExpiry) ? parsedExpiry : nowMs + 50 * 60_000;
    const audit = auditGitHubPermissions(data.permissions);
    const repositorySelection =
      data.repository_selection === 'all' || data.repository_selection === 'selected'
        ? data.repository_selection
        : undefined;

    this.#cachedToken = {
      token: data.token,
      expiresAtMs,
      audit,
      repositorySelection,
    };
    return this.#cachedToken;
  }

  #assertReadOnlyToken(cached: CachedInstallationToken): void {
    if (!cached.audit.readOnly) {
      throw new GitHubApiError({
        code: 'github_write_permission_detected',
        httpStatus: 403,
        message: `GitHub App 安装包含写权限（${cached.audit.writePermissions.join(', ')}），出于安全策略已拒绝访问，请改为只读权限。`,
        details: { writePermissions: cached.audit.writePermissions },
      });
    }
  }

  async #requestReadOnlyJson<T>(
    apiPath: string,
    context: string,
    options: { allowNotFound?: boolean } = {},
  ): Promise<T | null> {
    const cached = await this.#getInstallationToken(false);
    this.#assertReadOnlyToken(cached);

    const doFetch = async (token: string): Promise<Response> => {
      const url = `${this.#apiBaseUrl}${apiPath}`;
      try {
        return await this.#fetchImpl(url, {
          method: 'GET',
          headers: {
            Authorization: `Bearer ${token}`,
            Accept: 'application/vnd.github+json',
            'X-GitHub-Api-Version': GITHUB_API_VERSION,
            'User-Agent': USER_AGENT,
          },
        });
      } catch (error) {
        throw new GitHubApiError({
          code: 'github_upstream_error',
          httpStatus: 502,
          message: `请求 GitHub API 失败（${context}）：${error instanceof Error ? error.message : '网络错误'}`,
        });
      }
    };

    let response = await doFetch(cached.token);
    if (response.status === 401) {
      // Cached installation token may have been revoked or rotated; refresh once.
      const refreshed = await this.#getInstallationToken(true);
      this.#assertReadOnlyToken(refreshed);
      response = await doFetch(refreshed.token);
    }

    if (options.allowNotFound && response.status === 404) {
      return null;
    }

    const bodyText = await response.text();
    if (!response.ok) {
      throw mapUpstreamHttpError(response.status, bodyText, context);
    }

    try {
      return JSON.parse(bodyText) as T;
    } catch {
      throw new GitHubApiError({
        code: 'github_upstream_error',
        httpStatus: 502,
        message: `GitHub API 返回了无法解析的 JSON（${context}）。`,
      });
    }
  }

  async checkConnection(repo?: GitHubRepoRef): Promise<GitHubConnectionStatus> {
    const targetRepo = repo ? githubRepoRefSchema.parse(repo) : this.#defaultRepo;
    const checkedAt = new Date(this.#now()).toISOString();

    let cached: CachedInstallationToken;
    try {
      cached = await this.#getInstallationToken(true);
    } catch (error) {
      const message =
        error instanceof Error ? redactSecrets(error.message) : '无法连接 GitHub App。';
      return githubConnectionStatusSchema.parse({
        configured: true,
        mode: 'github_app',
        connected: false,
        readOnly: false,
        appId: this.#appId,
        installationId: this.#installationId,
        repo: targetRepo ? formatGitHubRepoRef(targetRepo) : undefined,
        accessibleRepositories: [],
        permissions: {},
        writePermissions: [],
        checkedAt,
        error: message,
      });
    }

    if (!cached.audit.readOnly) {
      return githubConnectionStatusSchema.parse({
        configured: true,
        mode: 'github_app',
        connected: false,
        readOnly: false,
        appId: this.#appId,
        installationId: this.#installationId,
        repo: targetRepo ? formatGitHubRepoRef(targetRepo) : undefined,
        repositorySelection: cached.repositorySelection,
        accessibleRepositories: [],
        permissions: cached.audit.permissions,
        writePermissions: cached.audit.writePermissions,
        checkedAt,
        error: `检测到非只读权限：${cached.audit.writePermissions.join(', ')}。请在 GitHub App 权限设置中改为 Read-only 或 No access。`,
      });
    }

    let accessibleRepositories: string[] = [];
    try {
      const repoList = await this.#requestReadOnlyJson<{
        repositories?: Array<{ full_name?: string }>;
      }>('/installation/repositories?per_page=100', '查询已授权仓库列表');
      accessibleRepositories = (repoList?.repositories ?? [])
        .map((item) => item.full_name)
        .filter((name): name is string => typeof name === 'string' && name.length > 0)
        .sort();
    } catch (error) {
      return githubConnectionStatusSchema.parse({
        configured: true,
        mode: 'github_app',
        connected: false,
        readOnly: true,
        appId: this.#appId,
        installationId: this.#installationId,
        repo: targetRepo ? formatGitHubRepoRef(targetRepo) : undefined,
        repositorySelection: cached.repositorySelection,
        accessibleRepositories: [],
        permissions: cached.audit.permissions,
        writePermissions: [],
        checkedAt,
        error: error instanceof Error ? redactSecrets(error.message) : '无法列出已授权仓库。',
      });
    }

    if (targetRepo) {
      try {
        await this.getRepository(targetRepo);
      } catch (error) {
        return githubConnectionStatusSchema.parse({
          configured: true,
          mode: 'github_app',
          connected: false,
          readOnly: true,
          appId: this.#appId,
          installationId: this.#installationId,
          repo: formatGitHubRepoRef(targetRepo),
          repositorySelection: cached.repositorySelection,
          accessibleRepositories,
          permissions: cached.audit.permissions,
          writePermissions: [],
          checkedAt,
          error:
            error instanceof Error
              ? redactSecrets(error.message)
              : `无法访问目标仓库 ${formatGitHubRepoRef(targetRepo)}。`,
        });
      }
    }

    return githubConnectionStatusSchema.parse({
      configured: true,
      mode: 'github_app',
      connected: true,
      readOnly: true,
      appId: this.#appId,
      installationId: this.#installationId,
      repo: targetRepo ? formatGitHubRepoRef(targetRepo) : undefined,
      repositorySelection: cached.repositorySelection,
      accessibleRepositories,
      permissions: cached.audit.permissions,
      writePermissions: [],
      checkedAt,
    });
  }

  async getRepository(repo: GitHubRepoRef): Promise<GitHubRepositoryMetadata> {
    const safe = githubRepoRefSchema.parse(repo);
    const full = formatGitHubRepoRef(safe);
    const raw = await this.#requestReadOnlyJson<Record<string, any>>(
      `/repos/${encodeURIComponent(safe.owner)}/${encodeURIComponent(safe.repo)}`,
      `读取仓库 ${full}`,
    );

    return githubRepositoryMetadataSchema.parse({
      id: raw?.id,
      owner: raw?.owner?.login ?? safe.owner,
      name: raw?.name ?? safe.repo,
      fullName: raw?.full_name ?? full,
      description: typeof raw?.description === 'string' ? raw.description : null,
      private: Boolean(raw?.private),
      defaultBranch: raw?.default_branch ?? 'main',
      htmlUrl: raw?.html_url,
      pushedAt: typeof raw?.pushed_at === 'string' ? raw.pushed_at : null,
      updatedAt: typeof raw?.updated_at === 'string' ? raw.updated_at : null,
    });
  }

  async listPullRequests(
    repo: GitHubRepoRef,
    options: ListPullRequestsOptions = {},
  ): Promise<GitHubPullRequestSummary[]> {
    const safe = githubRepoRefSchema.parse(repo);
    const state = options.state ?? 'all';
    const perPage = clampLimit(options.limit, 30, 100);
    const full = formatGitHubRepoRef(safe);

    const rawList = await this.#requestReadOnlyJson<Array<Record<string, any>>>(
      `/repos/${encodeURIComponent(safe.owner)}/${encodeURIComponent(safe.repo)}/pulls?state=${encodeURIComponent(state)}&sort=updated&direction=desc&per_page=${perPage}`,
      `读取 ${full} 的 PR 列表`,
    );

    return (rawList ?? []).map((pr) =>
      githubPullRequestSummarySchema.parse({
        id: pr.id,
        number: pr.number,
        title: pr.title ?? '',
        body: typeof pr.body === 'string' ? pr.body : null,
        state: pr.state === 'open' ? 'open' : 'closed',
        draft: Boolean(pr.draft),
        merged: Boolean(pr.merged_at),
        mergedAt: typeof pr.merged_at === 'string' ? pr.merged_at : null,
        createdAt: pr.created_at,
        updatedAt: pr.updated_at,
        author: pr.user?.login ?? 'unknown',
        labels: Array.isArray(pr.labels)
          ? pr.labels
              .map((label: { name?: unknown }) =>
                typeof label?.name === 'string' ? label.name : null,
              )
              .filter((name: string | null): name is string => name !== null)
          : [],
        headSha: pr.head?.sha ?? '',
        baseBranch: pr.base?.ref ?? 'main',
        headBranch: pr.head?.ref ?? '',
        mergeCommitSha: typeof pr.merge_commit_sha === 'string' ? pr.merge_commit_sha : null,
        htmlUrl: pr.html_url,
      }),
    );
  }

  async listPullRequestFiles(
    repo: GitHubRepoRef,
    pullNumber: number,
    options: ListPullRequestFilesOptions = {},
  ): Promise<GitHubPullRequestFile[]> {
    const safe = githubRepoRefSchema.parse(repo);
    if (!Number.isInteger(pullNumber) || pullNumber <= 0) {
      throw new GitHubApiError({
        code: 'invalid_github_request',
        httpStatus: 400,
        message: 'PR 编号必须为正整数。',
      });
    }
    const perPage = clampLimit(options.limit, 100, 100);
    const includePatch = options.includePatch === true;
    const full = formatGitHubRepoRef(safe);

    const rawList = await this.#requestReadOnlyJson<Array<Record<string, any>>>(
      `/repos/${encodeURIComponent(safe.owner)}/${encodeURIComponent(safe.repo)}/pulls/${pullNumber}/files?per_page=${perPage}`,
      `读取 ${full}#${pullNumber} 的变更文件`,
    );

    return (rawList ?? []).map((file) => {
      const rawPatch =
        includePatch && typeof file.patch === 'string'
          ? file.patch.slice(0, MAX_PATCH_CHARS)
          : undefined;
      return githubPullRequestFileSchema.parse({
        filename: file.filename,
        status: file.status,
        additions: Number(file.additions ?? 0),
        deletions: Number(file.deletions ?? 0),
        changes: Number(file.changes ?? 0),
        previousFilename:
          typeof file.previous_filename === 'string' ? file.previous_filename : undefined,
        ...(rawPatch !== undefined ? { patch: rawPatch } : {}),
      });
    });
  }

  async listReleases(
    repo: GitHubRepoRef,
    options: ListReleasesOptions = {},
  ): Promise<GitHubReleaseSummary[]> {
    const safe = githubRepoRefSchema.parse(repo);
    const perPage = clampLimit(options.limit, 20, 100);
    const full = formatGitHubRepoRef(safe);

    const rawList = await this.#requestReadOnlyJson<Array<Record<string, any>>>(
      `/repos/${encodeURIComponent(safe.owner)}/${encodeURIComponent(safe.repo)}/releases?per_page=${perPage}`,
      `读取 ${full} 的 Release 列表`,
    );

    return (rawList ?? []).map((release) =>
      githubReleaseSummarySchema.parse({
        id: release.id,
        tagName: release.tag_name,
        name: typeof release.name === 'string' ? release.name : null,
        body: typeof release.body === 'string' ? release.body : null,
        draft: Boolean(release.draft),
        prerelease: Boolean(release.prerelease),
        createdAt: release.created_at,
        publishedAt: typeof release.published_at === 'string' ? release.published_at : null,
        targetCommitish: release.target_commitish ?? '',
        htmlUrl: release.html_url,
      }),
    );
  }

  async getFileContent(
    repo: GitHubRepoRef,
    filePath: string,
    ref?: string,
  ): Promise<GitHubFileContent | null> {
    const safe = githubRepoRefSchema.parse(repo);
    const encodedPath = validateSafeRepoFilePath(filePath);
    const full = formatGitHubRepoRef(safe);
    const refQuery = ref ? `?ref=${encodeURIComponent(ref)}` : '';

    const raw = await this.#requestReadOnlyJson<Record<string, any>>(
      `/repos/${encodeURIComponent(safe.owner)}/${encodeURIComponent(safe.repo)}/contents/${encodedPath}${refQuery}`,
      `读取 ${full}:${filePath}`,
      { allowNotFound: true },
    );
    if (!raw) return null;

    if (raw.type !== 'file') {
      throw new GitHubApiError({
        code: 'invalid_github_request',
        httpStatus: 400,
        message: `目标路径不是普通文件：${filePath}`,
      });
    }

    const size = Number(raw.size ?? 0);
    if (size > MAX_FILE_BYTES) {
      throw new GitHubApiError({
        code: 'invalid_github_request',
        httpStatus: 400,
        message: `文件内容超过 1 MiB 限制：${filePath}`,
      });
    }

    if (raw.encoding !== 'base64' || typeof raw.content !== 'string') {
      throw new GitHubApiError({
        code: 'github_upstream_error',
        httpStatus: 502,
        message: `不支持的 GitHub 文件编码：${String(raw.encoding)}`,
      });
    }

    const content = Buffer.from(raw.content.replace(/\n/g, ''), 'base64').toString('utf8');
    return githubFileContentSchema.parse({
      path: raw.path ?? filePath,
      sha: raw.sha,
      size,
      encoding: 'utf-8',
      content,
    });
  }

  async getCommit(repo: GitHubRepoRef, ref: string): Promise<GitHubCommitSummary> {
    const safe = githubRepoRefSchema.parse(repo);
    const encodedRef = encodeGitRef(ref);
    const full = formatGitHubRepoRef(safe);
    const raw = await this.#requestReadOnlyJson<Record<string, any>>(
      `/repos/${encodeURIComponent(safe.owner)}/${encodeURIComponent(safe.repo)}/commits/${encodedRef}`,
      `解析 ${full} 的 ${ref} 提交`,
    );

    return githubCommitSummarySchema.parse({
      sha: raw?.sha,
      treeSha: raw?.commit?.tree?.sha,
      commitAt:
        typeof raw?.commit?.committer?.date === 'string'
          ? raw.commit.committer.date
          : typeof raw?.commit?.author?.date === 'string'
            ? raw.commit.author.date
            : null,
      message:
        typeof raw?.commit?.message === 'string'
          ? raw.commit.message.split('\n')[0]?.slice(0, 200) ?? null
          : null,
    });
  }

  /**
   * Lists a tree recursively. GitHub truncates very large trees and flags it
   * with `truncated: true`; a truncated tree would look like mass deletion to
   * the incremental diff, so it fails closed instead.
   */
  async getRepositoryTree(
    repo: GitHubRepoRef,
    ref: string,
    options: GetRepositoryTreeOptions = {},
  ): Promise<GitHubTreeEntry[]> {
    const safe = githubRepoRefSchema.parse(repo);
    const encodedRef = encodeGitRef(ref);
    const recursive = options.recursive !== false;
    const full = formatGitHubRepoRef(safe);

    const raw = await this.#requestReadOnlyJson<{
      sha?: string;
      truncated?: boolean;
      tree?: Array<{ path?: string; type?: string; sha?: string; size?: number }>;
    }>(
      `/repos/${encodeURIComponent(safe.owner)}/${encodeURIComponent(safe.repo)}/git/trees/${encodedRef}${
        recursive ? '?recursive=1' : ''
      }`,
      `读取 ${full} 的文件树 ${ref}`,
    );

    if (raw?.truncated === true) {
      throw new GitHubApiError({
        code: 'github_upstream_error',
        httpStatus: 502,
        message: `GitHub 返回的文件树不完整（truncated），拒绝生成可能误删文件的增量快照：${full}@${ref}`,
      });
    }

    const entries: GitHubTreeEntry[] = [];
    for (const item of raw?.tree ?? []) {
      if (typeof item?.path !== 'string' || typeof item?.sha !== 'string') continue;
      const type = item.type === 'tree' || item.type === 'commit' ? item.type : 'blob';
      entries.push({
        path: item.path,
        type,
        sha: item.sha,
        size: Number.isFinite(item.size) ? Number(item.size) : 0,
      });
    }
    return entries;
  }

  /**
   * Verifies AC-01: first checks the installation token permissions map.
   * Only when strictly read-only does it issue a benign no-op PATCH `{}` to
   * prove GitHub itself rejects writes with HTTP 403.
   */
  async probeWriteBlocked(repo: GitHubRepoRef): Promise<GitHubWriteProbeResult> {
    const safe = githubRepoRefSchema.parse(repo);
    const full = formatGitHubRepoRef(safe);
    const checkedAt = new Date(this.#now()).toISOString();

    const cached = await this.#getInstallationToken(true);
    if (!cached.audit.readOnly) {
      return githubWriteProbeResultSchema.parse({
        repo: full,
        readOnlyToken: false,
        writeBlocked: false,
        statusCode: 0,
        detail: `检测到安装授予了写权限（${cached.audit.writePermissions.join(', ')}），未发送写入探针。`,
        writePermissions: cached.audit.writePermissions,
        checkedAt,
      });
    }

    const url = `${this.#apiBaseUrl}/repos/${encodeURIComponent(safe.owner)}/${encodeURIComponent(safe.repo)}`;
    let response: Response;
    try {
      response = await this.#fetchImpl(url, {
        method: 'PATCH',
        headers: {
          Authorization: `Bearer ${cached.token}`,
          Accept: 'application/vnd.github+json',
          'Content-Type': 'application/json',
          'X-GitHub-Api-Version': GITHUB_API_VERSION,
          'User-Agent': USER_AGENT,
        },
        body: '{}',
      });
    } catch (error) {
      throw new GitHubApiError({
        code: 'github_upstream_error',
        httpStatus: 502,
        message: `执行只读写入探针时网络失败：${error instanceof Error ? error.message : '网络错误'}`,
      });
    }

    const bodyText = await response.text();
    const upstreamMsg = parseErrorMessage(bodyText);
    const blocked = response.status === 403 || response.status === 401;

    return githubWriteProbeResultSchema.parse({
      repo: full,
      readOnlyToken: true,
      writeBlocked: blocked,
      statusCode: response.status,
      detail: blocked
        ? `GitHub 已按预期拒绝写操作（HTTP ${response.status}${upstreamMsg ? `：${upstreamMsg}` : ''}）。`
        : `警告：写探针未被拒绝（HTTP ${response.status}${upstreamMsg ? `：${upstreamMsg}` : ''}）。`,
      writePermissions: [],
      checkedAt,
    });
  }
}

export class UnconfiguredGitHubReadOnlyClient implements GitHubReadOnlyPort {
  readonly #defaultRepo?: GitHubRepoRef;
  readonly #reason: string;

  constructor(options: { defaultRepo?: GitHubRepoRef; reason?: string } = {}) {
    this.#defaultRepo = options.defaultRepo;
    this.#reason =
      options.reason ??
      '尚未配置 GitHub App 只读凭证（GITHUB_APP_ID / GITHUB_APP_INSTALLATION_ID / GITHUB_APP_PRIVATE_KEY_PATH）。';
  }

  isConfigured(): boolean {
    return false;
  }

  getDefaultRepo(): GitHubRepoRef | undefined {
    return this.#defaultRepo;
  }

  async checkConnection(repo?: GitHubRepoRef): Promise<GitHubConnectionStatus> {
    const targetRepo = repo ?? this.#defaultRepo;
    return githubConnectionStatusSchema.parse({
      configured: false,
      mode: 'github_app',
      connected: false,
      readOnly: false,
      repo: targetRepo ? formatGitHubRepoRef(targetRepo) : undefined,
      accessibleRepositories: [],
      permissions: {},
      writePermissions: [],
      checkedAt: new Date().toISOString(),
      error: this.#reason,
    });
  }

  #fail(): never {
    throw new GitHubApiError({
      code: 'github_not_configured',
      httpStatus: 503,
      message: this.#reason,
    });
  }

  async getRepository(): Promise<GitHubRepositoryMetadata> {
    this.#fail();
  }

  async listPullRequests(): Promise<GitHubPullRequestSummary[]> {
    this.#fail();
  }

  async listPullRequestFiles(): Promise<GitHubPullRequestFile[]> {
    this.#fail();
  }

  async listReleases(): Promise<GitHubReleaseSummary[]> {
    this.#fail();
  }

  async getFileContent(): Promise<GitHubFileContent | null> {
    this.#fail();
  }

  async getCommit(): Promise<GitHubCommitSummary> {
    this.#fail();
  }

  async getRepositoryTree(): Promise<GitHubTreeEntry[]> {
    this.#fail();
  }

  async probeWriteBlocked(): Promise<GitHubWriteProbeResult> {
    this.#fail();
  }
}
