import { createHash, randomBytes } from 'node:crypto';
import {
  KNOWLEDGE_SNAPSHOT_SCHEMA_VERSION,
  formatGitHubRepoRef,
  knowledgeSnapshotV1Schema,
  type GitHubRepoRef,
  type KnowledgeEntrypoint,
  type KnowledgeFile,
  type KnowledgeSkipRecord,
  type KnowledgeSnapshotSummaryV1,
  type KnowledgeSnapshotV1,
} from '@asvs/domain';
import type {
  GitHubReadOnlyPort,
  IndexRepositoryOptions,
  KnowledgeIndexPort,
  ListKnowledgeSnapshotsOptions,
} from '@asvs/ports';
import type { SqliteKnowledgeSnapshotStore } from '../db/knowledge-store';
import { GitHubApiError } from '../github/redact';
import { extractFile, mergeEntrypoints } from './extract';
import {
  DEFAULT_KNOWLEDGE_INDEX_LIMITS,
  evaluateRepositoryPath,
  looksBinary,
  type KnowledgeIndexLimits,
} from './policy';

/**
 * Incremental knowledge indexer.
 *
 * Cold scan: resolve the branch to a commit, list its tree once, download and
 * parse every eligible text file.
 *
 * Incremental scan: same tree listing, then diff for each path:
 *   1. same git blob sha as the parent  → reuse the parent `KnowledgeFile`
 *      verbatim (no download, no parse);
 *   2. same skip decision blob sha      → reuse the skip record;
 *   3. otherwise                          → download and parse.
 * `stats.fetchedFiles` counts actual blob downloads, so a no-op scan at an
 * unchanged commit reports `fetchedFiles === 0`, `indexedFiles === 0` and
 * `reusedFiles === totalFiles`. That is the property the benchmark asserts.
 *
 * `sourceDigests` is the SHA256 of the raw file bytes (the contract in
 * `docs/05`), computed when the file is downloaded and carried over unchanged
 * on reuse — never recomputed from the extraction, which would change the
 * meaning of the digest.
 */

export interface KnowledgeIndexerOptions {
  github: GitHubReadOnlyPort;
  store: SqliteKnowledgeSnapshotStore;
  limits?: KnowledgeIndexLimits;
  now?: () => Date;
  /** Injectable so tests can produce stable ids. */
  newSnapshotId?: () => string;
  /** Max blob downloads in flight; keeps cold scans from stampeding GitHub. */
  concurrency?: number;
}

interface TreeCandidate {
  path: string;
  sha: string;
  size: number;
}

export function sha256Hex(content: string | Uint8Array): string {
  return createHash('sha256').update(content).digest('hex');
}

export function defaultSnapshotId(): string {
  return `snap_${randomBytes(16).toString('hex')}`;
}

function assertValidRef(ref: string): void {
  if (
    !ref.trim() ||
    ref.includes('..') ||
    ref.startsWith('/') ||
    ref.endsWith('/') ||
    ref.includes('\\') ||
    ref.includes('\0') ||
    ref.includes('?') ||
    ref.includes('#')
  ) {
    throw new GitHubApiError({
      code: 'invalid_github_request',
      httpStatus: 400,
      message: '分支名称无效。',
    });
  }
}

function assertBlobSha(entry: TreeCandidate): void {
  if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(entry.sha)) {
    throw new GitHubApiError({
      code: 'github_upstream_error',
      httpStatus: 502,
      message: `文件树包含非法 blob sha：${entry.path}`,
    });
  }
}

async function mapWithConcurrency<T, R>(
  items: T[],
  concurrency: number,
  worker: (item: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const runners = Array.from(
    { length: Math.max(1, Math.min(concurrency, items.length)) },
    async () => {
      while (next < items.length) {
        const index = next;
        next += 1;
        results[index] = await worker(items[index] as T);
      }
    },
  );
  await Promise.all(runners);
  return results;
}

function sortFiles(files: KnowledgeFile[]): KnowledgeFile[] {
  return [...files].sort((a, b) => a.path.localeCompare(b.path));
}

function sortSkipped(skipped: KnowledgeSkipRecord[]): KnowledgeSkipRecord[] {
  return [...skipped].sort((a, b) => a.path.localeCompare(b.path));
}

function sortEntrypoints(entrypoints: KnowledgeEntrypoint[]): KnowledgeEntrypoint[] {
  return [...entrypoints].sort((a, b) => a.rank - b.rank || a.path.localeCompare(b.path));
}

export class GitHubKnowledgeIndexer implements KnowledgeIndexPort {
  readonly #github: GitHubReadOnlyPort;
  readonly #store: SqliteKnowledgeSnapshotStore;
  readonly #limits: KnowledgeIndexLimits;
  readonly #now: () => Date;
  readonly #newSnapshotId: () => string;
  readonly #concurrency: number;

  constructor(options: KnowledgeIndexerOptions) {
    this.#github = options.github;
    this.#store = options.store;
    this.#limits = options.limits ?? DEFAULT_KNOWLEDGE_INDEX_LIMITS;
    this.#now = options.now ?? (() => new Date());
    this.#newSnapshotId = options.newSnapshotId ?? defaultSnapshotId;
    this.#concurrency = options.concurrency ?? 6;
  }

  async indexRepository(
    repo: GitHubRepoRef,
    options: IndexRepositoryOptions = {},
  ): Promise<KnowledgeSnapshotV1> {
    const startedAt = performance.now();
    const fullRepo = formatGitHubRepoRef(repo);

    const repository = await this.#github.getRepository(repo);
    const branch = options.branch?.trim() || repository.defaultBranch || 'main';
    assertValidRef(branch);

    const parent =
      options.forceCold === true ? null : this.#store.getLatest(fullRepo, branch);

    return this.#scan(repo, fullRepo, branch, parent, startedAt);
  }

  async getLatestSnapshot(
    repo: GitHubRepoRef,
    branch?: string,
  ): Promise<KnowledgeSnapshotV1 | null> {
    return this.#store.getLatest(formatGitHubRepoRef(repo), branch);
  }

  async getSnapshot(
    repo: GitHubRepoRef,
    snapshotId: string,
  ): Promise<KnowledgeSnapshotV1 | null> {
    return this.#store.get(formatGitHubRepoRef(repo), snapshotId);
  }

  async listSnapshots(
    repo: GitHubRepoRef,
    options: ListKnowledgeSnapshotsOptions = {},
  ): Promise<KnowledgeSnapshotSummaryV1[]> {
    return this.#store.list(formatGitHubRepoRef(repo), options);
  }

  async #scan(
    repo: GitHubRepoRef,
    fullRepo: string,
    branch: string,
    parent: KnowledgeSnapshotV1 | null,
    startedAt: number,
  ): Promise<KnowledgeSnapshotV1> {
    const commit = await this.#github.getCommit(repo, branch);
    const tree = await this.#github.getRepositoryTree(repo, commit.sha, { recursive: true });

    const blobs: TreeCandidate[] = [];
    const skipped: KnowledgeSkipRecord[] = [];
    let fileBudget = this.#limits.maxFiles;

    for (const entry of tree) {
      if (entry.type !== 'blob') continue;
      assertBlobSha(entry);

      const decision = evaluateRepositoryPath(entry.path, entry.size, this.#limits);
      if (decision.action === 'skip') {
        skipped.push({
          path: entry.path,
          reason: decision.reason ?? 'excluded_file',
          byteSize: entry.size,
          blobSha: entry.sha,
        });
        continue;
      }
      if (fileBudget <= 0) {
        skipped.push({
          path: entry.path,
          reason: 'too_many_files',
          byteSize: entry.size,
          blobSha: entry.sha,
        });
        continue;
      }
      fileBudget -= 1;
      blobs.push({ path: entry.path, sha: entry.sha, size: entry.size });
    }
    blobs.sort((a, b) => a.path.localeCompare(b.path));

    const parentFilesByPath = new Map<string, KnowledgeFile>();
    const parentSkippedByPath = new Map<string, KnowledgeSkipRecord>();
    if (parent) {
      for (const file of parent.files) parentFilesByPath.set(file.path, file);
      for (const entry of parent.skipped) parentSkippedByPath.set(entry.path, entry);
    }

    const files: KnowledgeFile[] = [];
    const sourceDigests: Record<string, string> = {};
    const toFetch: TreeCandidate[] = [];
    const resolvedSkipped: KnowledgeSkipRecord[] = [];
    let reusedFiles = 0;

    for (const entry of blobs) {
      const parentFile = parentFilesByPath.get(entry.path);
      const parentDigest = parent?.sourceDigests[entry.path];
      if (parentFile && parentDigest && parentFile.blobSha === entry.sha) {
        files.push(parentFile);
        sourceDigests[entry.path] = parentDigest;
        reusedFiles += 1;
        continue;
      }
      // A file that was downloaded and rejected last time (binary or oversized
      // after decoding) is remembered by path + blob sha, so the rejection is
      // reused instead of re-downloading the same bytes on every scan.
      const parentSkip = parentSkippedByPath.get(entry.path);
      if (parentSkip && parentSkip.blobSha === entry.sha) {
        resolvedSkipped.push(parentSkip);
        continue;
      }
      toFetch.push(entry);
    }

    for (const entry of skipped) {
      const parentSkip = parentSkippedByPath.get(entry.path);
      resolvedSkipped.push(
        parentSkip && parentSkip.blobSha === entry.blobSha && parentSkip.reason === entry.reason
          ? parentSkip
          : entry,
      );
    }

    let fetchedFiles = 0;
    const fetched = await mapWithConcurrency(toFetch, this.#concurrency, async (entry) => {
      const read = await this.#readText(repo, commit.sha, entry);
      fetchedFiles += 1;
      if (read.action === 'skip') {
        return { file: null, skip: read.skip } as const;
      }
      const extracted = extractFile(entry.path, read.content);
      sourceDigests[entry.path] = sha256Hex(read.content);
      return {
        file: {
          path: entry.path,
          language: extracted.language,
          byteSize: extracted.byteSize,
          lineCount: extracted.lineCount,
          blobSha: entry.sha,
          headings: extracted.headings,
          symbols: extracted.symbols,
          entrypoints: extracted.entrypoints,
        } satisfies KnowledgeFile,
        skip: null,
      } as const;
    });

    for (const result of fetched) {
      if (result.file) files.push(result.file);
      else if (result.skip) resolvedSkipped.push(result.skip);
    }
    const sortedFiles = sortFiles(files);
    const sortedDigests: Record<string, string> = {};
    for (const file of sortedFiles) {
      const digest = sourceDigests[file.path];
      if (digest) sortedDigests[file.path] = digest;
    }

    const previousPaths = parent ? new Set(parent.files.map((file) => file.path)) : new Set<string>();
    const currentPaths = new Set(sortedFiles.map((file) => file.path));
    let removedFiles = 0;
    for (const previousPath of previousPaths) {
      if (!currentPaths.has(previousPath)) removedFiles += 1;
    }

    const snapshot = knowledgeSnapshotV1Schema.parse({
      schemaVersion: KNOWLEDGE_SNAPSHOT_SCHEMA_VERSION,
      id: this.#newSnapshotId(),
      repo: fullRepo,
      branch,
      gitCommitSha: commit.sha,
      ...(parent ? { parentSnapshotId: parent.id } : {}),
      indexedAt: this.#now().toISOString(),
      sourceDigests: sortedDigests,
      files: sortedFiles,
      skipped: sortSkipped(resolvedSkipped),
      entrypoints: sortEntrypoints(mergeEntrypoints(sortedFiles)),
      stats: {
        mode: parent ? 'incremental' : 'cold',
        totalFiles: sortedFiles.length,
        indexedFiles: sortedFiles.length - reusedFiles,
        reusedFiles,
        removedFiles,
        skippedFiles: resolvedSkipped.length,
        fetchedFiles,
        durationMs: Math.round((performance.now() - startedAt) * 100) / 100,
      },
    });

    return this.#store.insert(snapshot);
  }

  /**
   * Downloads one blob as text. Only content-derived rejections (decoded size
   * over the cap, binary bytes) produce a skip record: GitHub returning no
   * content is treated as transient and retried on the next scan rather than
   * being remembered as a permanent exclusion.
   */
  async #readText(
    repo: GitHubRepoRef,
    commitSha: string,
    entry: TreeCandidate,
  ): Promise<{ action: 'index'; content: string } | { action: 'skip'; skip: KnowledgeSkipRecord }> {
    const file = await this.#github.getFileContent(repo, entry.path, commitSha);
    if (!file) {
      throw new GitHubApiError({
        code: 'github_upstream_error',
        httpStatus: 502,
        message: `GitHub 未返回文件内容：${entry.path}@${commitSha.slice(0, 12)}`,
      });
    }

    const decodedBytes = Buffer.byteLength(file.content, 'utf8');
    if (decodedBytes > this.#limits.maxFileBytes) {
      return {
        action: 'skip',
        skip: { path: entry.path, reason: 'too_large', byteSize: decodedBytes, blobSha: entry.sha },
      };
    }

    const sample = Buffer.from(file.content.slice(0, this.#limits.sniffBytes), 'utf8');
    if (looksBinary(new Uint8Array(sample))) {
      return {
        action: 'skip',
        skip: { path: entry.path, reason: 'binary', byteSize: file.size, blobSha: entry.sha },
      };
    }

    return { action: 'index', content: file.content };
  }
}
