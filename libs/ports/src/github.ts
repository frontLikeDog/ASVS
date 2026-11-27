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

export interface ListPullRequestsOptions {
  state?: 'open' | 'closed' | 'all';
  limit?: number;
}

export interface ListPullRequestFilesOptions {
  includePatch?: boolean;
  limit?: number;
}

export interface ListReleasesOptions {
  limit?: number;
}

export interface GetRepositoryTreeOptions {
  /**
   * Recurse into subtrees (GitHub `?recursive=1`). Truncated responses throw
   * instead of returning a partial tree, because a partial tree would silently
   * delete files from an incremental snapshot.
   */
  recursive?: boolean;
}

/**
 * One entry of a git tree, normalized to what the indexer needs. Directory
 * entries are omitted; `size` is GitHub's blob size in bytes.
 */
export interface GitHubTreeEntry {
  path: string;
  type: 'blob' | 'tree' | 'commit';
  sha: string;
  size: number;
}

/**
 * Read-only GitHub boundary for Step 4 knowledge ingestion.
 * Implementations must strictly enforce read-only installation permissions and
 * never expose credentials (private keys, JWTs, installation tokens) through
 * return values or error messages.
 */
export interface GitHubReadOnlyPort {
  isConfigured(): boolean;
  getDefaultRepo(): GitHubRepoRef | undefined;
  checkConnection(repo?: GitHubRepoRef): Promise<GitHubConnectionStatus>;
  getRepository(repo: GitHubRepoRef): Promise<GitHubRepositoryMetadata>;
  listPullRequests(
    repo: GitHubRepoRef,
    options?: ListPullRequestsOptions,
  ): Promise<GitHubPullRequestSummary[]>;
  listPullRequestFiles(
    repo: GitHubRepoRef,
    pullNumber: number,
    options?: ListPullRequestFilesOptions,
  ): Promise<GitHubPullRequestFile[]>;
  listReleases(
    repo: GitHubRepoRef,
    options?: ListReleasesOptions,
  ): Promise<GitHubReleaseSummary[]>;
  getFileContent(
    repo: GitHubRepoRef,
    filePath: string,
    ref?: string,
  ): Promise<GitHubFileContent | null>;
  /**
   * Resolves a branch (or any ref) to the exact commit the indexer must pin
   * (`GET /repos/:o/:r/commits/:ref`). Branches move; commit SHAs do not.
   */
  getCommit(repo: GitHubRepoRef, ref: string): Promise<GitHubCommitSummary>;
  /**
   * Lists a commit/tree by ref (`GET /repos/:o/:r/git/trees/:ref`). Used by the
   * indexer to diff a commit against a previous snapshot without cloning.
   */
  getRepositoryTree(
    repo: GitHubRepoRef,
    ref: string,
    options?: GetRepositoryTreeOptions,
  ): Promise<GitHubTreeEntry[]>;
  probeWriteBlocked(repo: GitHubRepoRef): Promise<GitHubWriteProbeResult>;
}
