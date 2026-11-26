import type { DatabaseSync } from 'node:sqlite';
import {
  STUDIO_SNAPSHOT_VERSION,
  normalizeWorkspacePayload,
  productionRunSchema,
} from '@asvs/domain';
import type { ProductionRun, StudioSnapshot, WorkspaceRecord } from '@asvs/domain';
import type { WorkspaceSaveInput, WorkspaceSaveResult } from '@asvs/ports';

interface WorkspaceRow {
  id: string;
  revision: number;
  schema_version: number;
  payload: string;
  created_at: string;
  updated_at: string;
}

interface RunRow {
  payload: string;
}

function decodeWorkspace(row: WorkspaceRow): StudioSnapshot {
  let parsed: unknown;
  try {
    parsed = JSON.parse(row.payload) as unknown;
  } catch {
    throw new Error(`工作区 ${row.id} 的 payload 不是有效 JSON`);
  }
  return normalizeWorkspacePayload({
    schemaVersion: row.schema_version,
    workspace: parsed,
  }).workspace;
}

/**
 * One JSON document per workspace plus a materialized run index. SQLite gives
 * us transactions and crash safety without committing to a normalized schema
 * the domain cannot yet support (no tombstones, no per-entity revisions).
 */
export class SqliteWorkspaceStore {
  constructor(private readonly db: DatabaseSync) {}

  get(id: string): WorkspaceRecord | null {
    const row = this.db
      .prepare('SELECT id, revision, schema_version, payload, created_at, updated_at FROM workspaces WHERE id = ?')
      .get(id) as WorkspaceRow | undefined;
    if (!row) return null;

    const workspace = decodeWorkspace(row);
    if (row.schema_version !== STUDIO_SNAPSHOT_VERSION) {
      // Persist the migrated payload so the migration runs once, not on every
      // read. The row keeps its revision; this is a shape upgrade, not an edit.
      this.db
        .prepare('UPDATE workspaces SET schema_version = ?, payload = ? WHERE id = ?')
        .run(STUDIO_SNAPSHOT_VERSION, JSON.stringify(workspace), id);
    }

    return {
      kind: 'asvs.workspace',
      id: row.id,
      revision: row.revision,
      schemaVersion: STUDIO_SNAPSHOT_VERSION,
      updatedAt: row.updated_at,
      workspace,
    };
  }

  put(id: string, input: WorkspaceSaveInput): WorkspaceSaveResult {
    if (!id.trim()) throw new Error('workspace id 不能为空');
    if (!Number.isInteger(input.baseRevision) || input.baseRevision < 0) {
      throw new Error('baseRevision 必须是非负整数');
    }

    // Normalize here as well so every caller (route, import, tests) gets the
    // same invariant even if it hands us a raw payload.
    const workspace = normalizeWorkspacePayload({
      schemaVersion: STUDIO_SNAPSHOT_VERSION,
      workspace: input.workspace,
    }).workspace;
    const payload = JSON.stringify(workspace);
    const now = new Date().toISOString();

    this.db.exec('BEGIN IMMEDIATE');
    try {
      const current = this.get(id);
      const expected = current ? current.revision : 0;
      if (input.baseRevision !== expected) {
        this.db.exec('ROLLBACK');
        return { ok: false, conflict: current };
      }

      const revision = expected + 1;
      if (current) {
        this.db
          .prepare(
            'UPDATE workspaces SET revision = ?, schema_version = ?, payload = ?, updated_at = ? WHERE id = ?',
          )
          .run(revision, STUDIO_SNAPSHOT_VERSION, payload, now, id);
      } else {
        this.db
          .prepare(
            'INSERT INTO workspaces (id, revision, schema_version, payload, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)',
          )
          .run(id, revision, STUDIO_SNAPSHOT_VERSION, payload, now, now);
      }
      this.replaceRuns(id, workspace.runs, now);
      this.db.exec('COMMIT');

      return {
        ok: true,
        record: {
          kind: 'asvs.workspace',
          id,
          revision,
          schemaVersion: STUDIO_SNAPSHOT_VERSION,
          updatedAt: now,
          workspace,
        },
      };
    } catch (error) {
      try {
        this.db.exec('ROLLBACK');
      } catch {
        // The transaction may already be rolled back on a conflict path.
      }
      throw error;
    }
  }

  listRuns(workspaceId: string): ProductionRun[] {
    const rows = this.db
      .prepare('SELECT payload FROM production_runs WHERE workspace_id = ? ORDER BY started_at DESC')
      .all(workspaceId) as unknown as RunRow[];
    return rows.map((row) => productionRunSchema.parse(JSON.parse(row.payload) as unknown));
  }

  getRun(workspaceId: string, runId: string): ProductionRun | null {
    const row = this.db
      .prepare('SELECT payload FROM production_runs WHERE workspace_id = ? AND id = ?')
      .get(workspaceId, runId) as unknown as RunRow | undefined;
    if (!row) return null;
    return productionRunSchema.parse(JSON.parse(row.payload) as unknown);
  }

  private replaceRuns(workspaceId: string, runs: ProductionRun[], updatedAt: string): void {
    this.db.prepare('DELETE FROM production_runs WHERE workspace_id = ?').run(workspaceId);
    const insert = this.db.prepare(`
      INSERT INTO production_runs
        (id, workspace_id, video_id, status, elapsed_ms, started_at, finished_at, payload, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    for (const run of runs) {
      insert.run(
        run.id,
        workspaceId,
        run.videoId,
        run.status,
        Math.round(run.elapsedMs),
        run.startedAt,
        run.finishedAt ?? null,
        JSON.stringify(run),
        updatedAt,
      );
    }
  }
}
