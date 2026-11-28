import type { DatabaseSync } from 'node:sqlite';
import {
  exportBundleV1Schema,
  type ExportBundleDetailV1,
  type ExportBundleV1,
} from '@asvs/domain';

/**
 * Gate-3 bound export bundles (migration v6, AC-10).
 *
 * A bundle records the exact MP4 / SRT / manifest hashes that were verified at
 * export time, so a later re-hash mismatch is detectable — and the download
 * route can pin its ETag to the hash the reviewer actually approved.
 */

interface ExportBundleRow {
  payload: string;
}

interface ExportBundleListRow {
  payload: string;
}

export class ExportBundleStore {
  constructor(private readonly db: DatabaseSync) {}

  insert(detail: ExportBundleDetailV1): void {
    const { bundle, ...rest } = detail;
    this.db
      .prepare(
        `INSERT INTO export_bundles (
          id, workspace_id, project_id, video_id, run_id,
          mp4_artifact_id, srt_artifact_id, manifest_artifact_id, receipt_artifact_id,
          mp4_sha256, srt_sha256, manifest_sha256, script_version, approval_note,
          payload, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        bundle.id,
        bundle.workspaceId,
        bundle.projectId,
        bundle.videoId,
        bundle.runId,
        bundle.mp4ArtifactId,
        bundle.srtArtifactId,
        bundle.manifestArtifactId,
        bundle.receiptArtifactId,
        bundle.mp4Sha256,
        bundle.srtSha256,
        bundle.manifestSha256,
        bundle.scriptVersion,
        bundle.approvalNote ?? null,
        // `payload` holds the bundle plus its files/narration provenance so a
        // bundle survives a restart without re-probing the artifacts (they are
        // still re-hashed on every download).
        JSON.stringify({ bundle, details: rest }),
        bundle.createdAt,
      );
  }

  get(id: string): ExportBundleDetailV1 | null {
    const row = this.db
      .prepare('SELECT payload FROM export_bundles WHERE id = ?')
      .get(id) as ExportBundleRow | undefined;
    return row ? this.decode(row.payload) : null;
  }

  list(workspaceId: string, options: { videoId?: string; limit?: number } = {}): ExportBundleDetailV1[] {
    const limit = Math.max(1, Math.min(options.limit ?? 20, 100));
    const rows = options.videoId
      ? (this.db
          .prepare(
            `SELECT payload FROM export_bundles
             WHERE workspace_id = ? AND video_id = ?
             ORDER BY created_at DESC LIMIT ?`,
          )
          .all(workspaceId, options.videoId, limit) as unknown as ExportBundleListRow[])
      : (this.db
          .prepare(
            `SELECT payload FROM export_bundles
             WHERE workspace_id = ?
             ORDER BY created_at DESC LIMIT ?`,
          )
          .all(workspaceId, limit) as unknown as ExportBundleListRow[]);
    return rows
      .map((row) => this.decode(row.payload))
      .filter((detail): detail is ExportBundleDetailV1 => detail !== null);
  }

  /** Newest bundle for a video; used to pin download hashes to the approval. */
  latestForVideo(workspaceId: string, videoId: string): ExportBundleDetailV1 | null {
    return this.list(workspaceId, { videoId, limit: 1 })[0] ?? null;
  }

  private decode(raw: string): ExportBundleDetailV1 | null {
    try {
      const parsed = JSON.parse(raw) as { bundle?: unknown; details?: unknown };
      const bundle = exportBundleV1Schema.parse(parsed.bundle);
      const details = (parsed.details ?? {}) as Partial<ExportBundleDetailV1>;
      return {
        bundle: bundle as ExportBundleV1,
        files: details.files ?? [],
        ...(details.videoDurationMs !== undefined
          ? { videoDurationMs: details.videoDurationMs }
          : {}),
        ...(details.audioDurationMs !== undefined
          ? { audioDurationMs: details.audioDurationMs }
          : {}),
        ...(details.narration ? { narration: details.narration } : {}),
      };
    } catch {
      return null;
    }
  }
}
