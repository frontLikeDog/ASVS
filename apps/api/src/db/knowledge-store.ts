import type { DatabaseSync } from 'node:sqlite';
import {
  knowledgeSnapshotV1Schema,
  toKnowledgeSnapshotSummary,
  type KnowledgeSnapshotSummaryV1,
  type KnowledgeSnapshotV1,
} from '@asvs/domain';

interface SnapshotRow {
  payload: string;
}

interface SummaryRow {
  payload: string;
}

function decodeSnapshot(row: SnapshotRow): KnowledgeSnapshotV1 {
  let parsed: unknown;
  try {
    parsed = JSON.parse(row.payload) as unknown;
  } catch {
    throw new Error('knowledge_snapshots.payload 不是有效 JSON');
  }
  // Validate on read as well: the payload is the source of truth, and a store
  // that silently serves a half-written snapshot would poison every later
  // incremental diff.
  return knowledgeSnapshotV1Schema.parse(parsed);
}

/**
 * Append-only persistence for `KnowledgeSnapshotV1`. There is no update or
 * delete path by design: history is the audit trail later slices (4C change
 * classification) diff against, and `docs/05` §9 requires snapshots to be
 * immutable. Every scan therefore inserts a new row; the snapshot id is the
 * primary key, so an accidental duplicate insert fails loudly instead of
 * overwriting history.
 */
export class SqliteKnowledgeSnapshotStore {
  constructor(private readonly db: DatabaseSync) {}

  insert(snapshot: KnowledgeSnapshotV1): KnowledgeSnapshotV1 {
    const validated = knowledgeSnapshotV1Schema.parse(snapshot);
    const { stats } = validated;

    this.db
      .prepare(
        `INSERT INTO knowledge_snapshots
          (id, repo, branch, git_commit_sha, parent_snapshot_id, indexed_at, index_mode,
           total_files, indexed_files, reused_files, removed_files, skipped_files,
           fetched_files, duration_ms, payload)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        validated.id,
        validated.repo,
        validated.branch,
        validated.gitCommitSha,
        validated.parentSnapshotId ?? null,
        validated.indexedAt,
        stats.mode,
        stats.totalFiles,
        stats.indexedFiles,
        stats.reusedFiles,
        stats.removedFiles,
        stats.skippedFiles,
        stats.fetchedFiles,
        stats.durationMs,
        JSON.stringify(validated),
      );

    return validated;
  }

  get(repo: string, snapshotId: string): KnowledgeSnapshotV1 | null {
    const row = this.db
      .prepare('SELECT payload FROM knowledge_snapshots WHERE repo = ? AND id = ?')
      .get(repo, snapshotId) as SnapshotRow | undefined;
    return row ? decodeSnapshot(row) : null;
  }

  /**
   * Latest snapshot for a repo, optionally pinned to one branch. Used as the
   * incremental parent, so the ordering has to be stable when two scans land
   * in the same millisecond.
   */
  getLatest(repo: string, branch?: string): KnowledgeSnapshotV1 | null {
    const row = branch
      ? (this.db
          .prepare(
            `SELECT payload FROM knowledge_snapshots
              WHERE repo = ? AND branch = ?
              ORDER BY indexed_at DESC, rowid DESC LIMIT 1`,
          )
          .get(repo, branch) as SnapshotRow | undefined)
      : (this.db
          .prepare(
            `SELECT payload FROM knowledge_snapshots
              WHERE repo = ?
              ORDER BY indexed_at DESC, rowid DESC LIMIT 1`,
          )
          .get(repo) as SnapshotRow | undefined);
    return row ? decodeSnapshot(row) : null;
  }

  list(repo: string, options: { branch?: string; limit?: number } = {}): KnowledgeSnapshotSummaryV1[] {
    const limit = Math.max(1, Math.min(options.limit ?? 20, 100));
    const rows = options.branch
      ? (this.db
          .prepare(
            `SELECT payload FROM knowledge_snapshots
              WHERE repo = ? AND branch = ?
              ORDER BY indexed_at DESC, rowid DESC LIMIT ?`,
          )
          .all(repo, options.branch, limit) as unknown as SummaryRow[])
      : (this.db
          .prepare(
            `SELECT payload FROM knowledge_snapshots
              WHERE repo = ?
              ORDER BY indexed_at DESC, rowid DESC LIMIT ?`,
          )
          .all(repo, limit) as unknown as SummaryRow[]);
    return rows.map((row) => toKnowledgeSnapshotSummary(decodeSnapshot(row)));
  }
}
