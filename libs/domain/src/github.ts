import { z } from 'zod';

const GITHUB_SEGMENT_RE = /^[A-Za-z0-9_.-]{1,100}$/;

function isSafeRepoSegment(segment: string): boolean {
  return (
    GITHUB_SEGMENT_RE.test(segment) &&
    segment !== '.' &&
    segment !== '..' &&
    !segment.includes('..')
  );
}

export const githubRepoSegmentSchema = z
  .string()
  .min(1)
  .max(100)
  .refine(isSafeRepoSegment, '仓库 owner/name 只能包含字母、数字、.、_ 或 -，且不能包含路径穿越');

export const githubRepoRefSchema = z.object({
  owner: githubRepoSegmentSchema,
  repo: githubRepoSegmentSchema,
});
export type GitHubRepoRef = z.infer<typeof githubRepoRefSchema>;

export function formatGitHubRepoRef(ref: GitHubRepoRef): string {
  return `${ref.owner}/${ref.repo}`;
}

/**
 * Parses `owner/repo` or `https://github.com/owner/repo(.git)` into a validated
 * GitHubRepoRef. Rejects non-GitHub hosts, extra path segments, query strings,
 * credentials in URLs, and traversal sequences.
 */
export function parseGitHubRepoRef(raw: string): GitHubRepoRef {
  const trimmed = raw.trim();
  if (!trimmed) {
    throw new Error('GitHub 仓库标识不能为空，请使用 owner/repo 格式。');
  }

  let owner: string;
  let repo: string;

  if (/^https?:\/\//i.test(trimmed)) {
    let url: URL;
    try {
      url = new URL(trimmed);
    } catch {
      throw new Error(`无效的 GitHub 仓库 URL：${trimmed}`);
    }
    if (url.protocol !== 'https:' || url.hostname.toLowerCase() !== 'github.com') {
      throw new Error('仅允许 https://github.com 仓库地址。');
    }
    if (url.username || url.password || url.search || url.hash) {
      throw new Error('GitHub 仓库 URL 不允许包含凭证、查询参数或锚点。');
    }
    const parts = url.pathname.replace(/^\/+|\/+$/g, '').split('/');
    if (parts.length !== 2) {
      throw new Error('GitHub 仓库 URL 必须为 https://github.com/owner/repo 格式。');
    }
    owner = parts[0] ?? '';
    repo = (parts[1] ?? '').replace(/\.git$/i, '');
  } else {
    const parts = trimmed.replace(/^\/+|\/+$/g, '').split('/');
    if (parts.length !== 2) {
      throw new Error(`无效的 GitHub 仓库标识：${trimmed}，请使用 owner/repo 格式。`);
    }
    owner = parts[0] ?? '';
    repo = (parts[1] ?? '').replace(/\.git$/i, '');
  }

  return githubRepoRefSchema.parse({ owner, repo });
}

export const githubPermissionAuditSchema = z.object({
  readOnly: z.boolean(),
  permissions: z.record(z.string(), z.string()),
  writePermissions: z.array(z.string()),
});
export type GitHubPermissionAudit = z.infer<typeof githubPermissionAuditSchema>;

/**
 * Audits a GitHub App installation token's granted permissions map.
 * Any permission level other than `read` or `none` is treated as write/elevated.
 */
export function auditGitHubPermissions(
  permissions: Record<string, string> | undefined | null,
): GitHubPermissionAudit {
  const normalized: Record<string, string> = {};
  const writePermissions: string[] = [];

  for (const [scope, level] of Object.entries(permissions ?? {})) {
    const cleanLevel = String(level).toLowerCase().trim();
    normalized[scope] = cleanLevel;
    if (cleanLevel !== 'read' && cleanLevel !== 'none') {
      writePermissions.push(`${scope}:${cleanLevel}`);
    }
  }

  writePermissions.sort();
  return {
    readOnly: writePermissions.length === 0,
    permissions: normalized,
    writePermissions,
  };
}

export const githubRepositoryMetadataSchema = z.object({
  id: z.number().int().positive(),
  owner: githubRepoSegmentSchema,
  name: githubRepoSegmentSchema,
  fullName: z.string().min(3),
  description: z.string().nullable(),
  private: z.boolean(),
  defaultBranch: z.string().min(1),
  htmlUrl: z.string().url(),
  pushedAt: z.string().nullable(),
  updatedAt: z.string().nullable(),
});
export type GitHubRepositoryMetadata = z.infer<typeof githubRepositoryMetadataSchema>;

export const GITHUB_PR_STATES = ['open', 'closed'] as const;
export const githubPullRequestSummarySchema = z.object({
  id: z.number().int().positive(),
  number: z.number().int().positive(),
  title: z.string(),
  body: z.string().nullable(),
  state: z.enum(GITHUB_PR_STATES),
  draft: z.boolean(),
  merged: z.boolean(),
  mergedAt: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
  author: z.string(),
  labels: z.array(z.string()),
  headSha: z.string().min(1),
  baseBranch: z.string().min(1),
  headBranch: z.string().min(1),
  mergeCommitSha: z.string().nullable(),
  htmlUrl: z.string().url(),
});
export type GitHubPullRequestSummary = z.infer<typeof githubPullRequestSummarySchema>;

export const GITHUB_FILE_STATUSES = [
  'added',
  'modified',
  'removed',
  'renamed',
  'copied',
  'changed',
  'unchanged',
] as const;
export const githubPullRequestFileSchema = z.object({
  filename: z.string().min(1),
  status: z.enum(GITHUB_FILE_STATUSES),
  additions: z.number().int().min(0),
  deletions: z.number().int().min(0),
  changes: z.number().int().min(0),
  previousFilename: z.string().optional(),
  patch: z.string().optional(),
});
export type GitHubPullRequestFile = z.infer<typeof githubPullRequestFileSchema>;

export const githubReleaseSummarySchema = z.object({
  id: z.number().int().positive(),
  tagName: z.string().min(1),
  name: z.string().nullable(),
  body: z.string().nullable(),
  draft: z.boolean(),
  prerelease: z.boolean(),
  createdAt: z.string(),
  publishedAt: z.string().nullable(),
  targetCommitish: z.string(),
  htmlUrl: z.string().url(),
});
export type GitHubReleaseSummary = z.infer<typeof githubReleaseSummarySchema>;

export const githubFileContentSchema = z.object({
  path: z.string().min(1),
  sha: z.string().min(1),
  size: z.number().int().min(0),
  encoding: z.literal('utf-8'),
  content: z.string(),
});
export type GitHubFileContent = z.infer<typeof githubFileContentSchema>;

/**
 * A resolved commit. The indexer pins the exact commit SHA so a snapshot can
 * never silently mix files from two different commits.
 */
export const githubCommitSummarySchema = z.object({
  sha: z.string().regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/),
  treeSha: z.string().regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/),
  commitAt: z.string().nullable(),
  message: z.string().nullable(),
});
export type GitHubCommitSummary = z.infer<typeof githubCommitSummarySchema>;

export const githubConnectionStatusSchema = z.object({
  configured: z.boolean(),
  mode: z.literal('github_app'),
  connected: z.boolean(),
  readOnly: z.boolean(),
  appId: z.string().optional(),
  installationId: z.string().optional(),
  repo: z.string().optional(),
  repositorySelection: z.enum(['all', 'selected']).optional(),
  accessibleRepositories: z.array(z.string()),
  permissions: z.record(z.string(), z.string()),
  writePermissions: z.array(z.string()),
  checkedAt: z.string(),
  error: z.string().optional(),
});
export type GitHubConnectionStatus = z.infer<typeof githubConnectionStatusSchema>;

export const githubWriteProbeResultSchema = z.object({
  repo: z.string().min(3),
  readOnlyToken: z.boolean(),
  writeBlocked: z.boolean(),
  statusCode: z.number().int().min(0),
  detail: z.string(),
  writePermissions: z.array(z.string()),
  checkedAt: z.string(),
});
export type GitHubWriteProbeResult = z.infer<typeof githubWriteProbeResultSchema>;
