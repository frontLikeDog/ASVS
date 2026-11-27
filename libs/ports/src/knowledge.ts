import type {
  GitHubRepoRef,
  KnowledgeSnapshotSummaryV1,
  KnowledgeSnapshotV1,
} from '@asvs/domain';

export interface IndexRepositoryOptions {
  /** Branch to index; defaults to the repository's default branch. */
  branch?: string;
  /**
   * Ignore any parent snapshot and re-download every file. Produces the same
   * shape as a genuine first scan so cold numbers stay comparable; the
   * resulting snapshot has no `parentSnapshotId`.
   */
  forceCold?: boolean;
}

export interface ListKnowledgeSnapshotsOptions {
  branch?: string;
  limit?: number;
}

/**
 * Boundary for the Step 4 knowledge index. `apps/api` implements this over
 * GitHub + SQLite; a future Web UI (slice 4D) consumes it through HTTP rather
 * than importing anything from this app.
 *
 * Snapshots are append-only: indexing the same commit twice yields two
 * snapshots with different ids and `indexedAt` values, never an update.
 */
export interface KnowledgeIndexPort {
  indexRepository(
    repo: GitHubRepoRef,
    options?: IndexRepositoryOptions,
  ): Promise<KnowledgeSnapshotV1>;
  getLatestSnapshot(
    repo: GitHubRepoRef,
    branch?: string,
  ): Promise<KnowledgeSnapshotV1 | null>;
  getSnapshot(
    repo: GitHubRepoRef,
    snapshotId: string,
  ): Promise<KnowledgeSnapshotV1 | null>;
  listSnapshots(
    repo: GitHubRepoRef,
    options?: ListKnowledgeSnapshotsOptions,
  ): Promise<KnowledgeSnapshotSummaryV1[]>;
}
