import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

interface Migration {
  version: number;
  up(db: DatabaseSync): void;
}

/**
 * Additive schema migrations. `PRAGMA user_version` records the last applied
 * step; never edit a shipped migration, append a new one instead.
 */
const MIGRATIONS: Migration[] = [
  {
    version: 1,
    up(db) {
      db.exec(`
        CREATE TABLE IF NOT EXISTS workspaces (
          id TEXT PRIMARY KEY,
          revision INTEGER NOT NULL,
          schema_version INTEGER NOT NULL,
          payload TEXT NOT NULL,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS production_runs (
          id TEXT PRIMARY KEY,
          workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
          video_id TEXT NOT NULL,
          status TEXT NOT NULL,
          elapsed_ms INTEGER NOT NULL,
          started_at TEXT NOT NULL,
          finished_at TEXT,
          payload TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );

        CREATE INDEX IF NOT EXISTS idx_production_runs_workspace
          ON production_runs(workspace_id, started_at DESC);
      `);
    },
  },
  {
    version: 2,
    up(db) {
      // Run ids are only unique inside a workspace (seed/export data uses
      // fixed ids such as `run_lumen_success`), so the primary key must be
      // composite. SQLite cannot alter a primary key in place; rebuild.
      db.exec(`
        CREATE TABLE production_runs_v2 (
          id TEXT NOT NULL,
          workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
          video_id TEXT NOT NULL,
          status TEXT NOT NULL,
          elapsed_ms INTEGER NOT NULL,
          started_at TEXT NOT NULL,
          finished_at TEXT,
          payload TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          PRIMARY KEY (workspace_id, id)
        );

        INSERT INTO production_runs_v2
          (id, workspace_id, video_id, status, elapsed_ms, started_at, finished_at, payload, updated_at)
        SELECT id, workspace_id, video_id, status, elapsed_ms, started_at, finished_at, payload, updated_at
        FROM production_runs;

        DROP TABLE production_runs;
        ALTER TABLE production_runs_v2 RENAME TO production_runs;

        CREATE INDEX idx_production_runs_workspace
          ON production_runs(workspace_id, started_at DESC);
      `);
    },
  },
  {
    version: 3,
    up(db) {
      // Append-only knowledge snapshots (Step 4B). One row per snapshot; the
      // payload is the full validated `KnowledgeSnapshotV1`, the indexed
      // columns exist only for listing/filtering without parsing JSON.
      // No foreign key to workspaces: knowledge is keyed by repository, not by
      // a video workspace, and snapshots must outlive workspace deletion.
      db.exec(`
        CREATE TABLE IF NOT EXISTS knowledge_snapshots (
          id TEXT PRIMARY KEY,
          repo TEXT NOT NULL,
          branch TEXT NOT NULL,
          git_commit_sha TEXT NOT NULL,
          parent_snapshot_id TEXT,
          indexed_at TEXT NOT NULL,
          index_mode TEXT NOT NULL,
          total_files INTEGER NOT NULL,
          indexed_files INTEGER NOT NULL,
          reused_files INTEGER NOT NULL,
          removed_files INTEGER NOT NULL,
          skipped_files INTEGER NOT NULL,
          fetched_files INTEGER NOT NULL,
          duration_ms REAL NOT NULL,
          payload TEXT NOT NULL
        );

        CREATE INDEX IF NOT EXISTS idx_knowledge_snapshots_repo_branch
          ON knowledge_snapshots(repo, branch, indexed_at DESC);

        CREATE INDEX IF NOT EXISTS idx_knowledge_snapshots_repo_commit
          ON knowledge_snapshots(repo, git_commit_sha, indexed_at DESC);
      `);
    },
  },
  {
    version: 4,
    up(db) {
      // PR 变更候选与 Claim 核验审计（Step 4C）。候选按 (repo, pull_number)
      // 唯一：同一 PR 重新分析会更新分析快照，但人工录入的核验证据由服务层
      // 保留；审计表只追加，永不更新或删除。
      db.exec(`
        CREATE TABLE IF NOT EXISTS pr_change_candidates (
          id TEXT PRIMARY KEY,
          repo TEXT NOT NULL,
          pull_number INTEGER NOT NULL,
          classification TEXT NOT NULL,
          promotable INTEGER NOT NULL,
          merged INTEGER NOT NULL,
          merge_commit_sha TEXT,
          snapshot_id TEXT,
          analyzed_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          payload TEXT NOT NULL
        );

        CREATE UNIQUE INDEX IF NOT EXISTS idx_pr_candidates_repo_pull
          ON pr_change_candidates(repo, pull_number);

        CREATE INDEX IF NOT EXISTS idx_pr_candidates_repo_analyzed
          ON pr_change_candidates(repo, analyzed_at DESC);

        CREATE TABLE IF NOT EXISTS claim_verifications (
          id TEXT PRIMARY KEY,
          repo TEXT NOT NULL,
          candidate_id TEXT NOT NULL,
          claim_id TEXT NOT NULL,
          kind TEXT NOT NULL,
          decision TEXT,
          environment_id TEXT,
          release_tag TEXT,
          test_run_id TEXT,
          commit_sha TEXT,
          file_path TEXT,
          source_digest TEXT,
          note TEXT NOT NULL,
          recorded_at TEXT NOT NULL,
          payload TEXT NOT NULL
        );

        CREATE INDEX IF NOT EXISTS idx_claim_verifications_claim
          ON claim_verifications(repo, claim_id, recorded_at);
      `);
    },
  },
  {
    version: 5,
    up(db) {
      // Step 5A production orchestration (docs/06 §5, AC-06). These tables are
      // deliberately decoupled from the client-synced `production_runs`:
      // every workspace PUT replaces that table wholesale, which would destroy
      // server-authoritative run state.
      db.exec(`
        CREATE TABLE IF NOT EXISTS orchestration_runs (
          id TEXT PRIMARY KEY,
          workspace_id TEXT NOT NULL,
          project_id TEXT NOT NULL,
          video_id TEXT NOT NULL,
          idempotency_key TEXT NOT NULL,
          status TEXT NOT NULL,
          input_digest TEXT,
          current_step_key TEXT,
          approval_json TEXT,
          failure_json TEXT,
          payload TEXT NOT NULL,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          finished_at TEXT
        );

        CREATE UNIQUE INDEX IF NOT EXISTS idx_orch_runs_workspace_idem
          ON orchestration_runs(workspace_id, idempotency_key);

        CREATE INDEX IF NOT EXISTS idx_orch_runs_workspace_video
          ON orchestration_runs(workspace_id, video_id, created_at DESC);

        CREATE INDEX IF NOT EXISTS idx_orch_runs_status
          ON orchestration_runs(status, created_at);

        CREATE TABLE IF NOT EXISTS orchestration_jobs (
          id TEXT PRIMARY KEY,
          run_id TEXT NOT NULL REFERENCES orchestration_runs(id) ON DELETE CASCADE,
          workspace_id TEXT NOT NULL,
          step_key TEXT NOT NULL,
          job_type TEXT NOT NULL,
          status TEXT NOT NULL,
          attempt INTEGER NOT NULL DEFAULT 0,
          max_attempts INTEGER NOT NULL DEFAULT 3,
          input_digest TEXT NOT NULL,
          lease_owner TEXT,
          lease_expires_at TEXT,
          heartbeat_at TEXT,
          worker_pid INTEGER,
          deadline_at TEXT,
          last_checkpoint_phase TEXT,
          error_code TEXT,
          error_message TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );

        CREATE INDEX IF NOT EXISTS idx_orch_jobs_poll
          ON orchestration_jobs(status, lease_expires_at, created_at);

        CREATE UNIQUE INDEX IF NOT EXISTS idx_orch_jobs_run_step
          ON orchestration_jobs(run_id, step_key);

        CREATE TABLE IF NOT EXISTS orchestration_checkpoints (
          id TEXT PRIMARY KEY,
          run_id TEXT NOT NULL REFERENCES orchestration_runs(id) ON DELETE CASCADE,
          step_key TEXT NOT NULL,
          phase TEXT NOT NULL,
          input_digest TEXT NOT NULL,
          payload TEXT NOT NULL,
          created_at TEXT NOT NULL
        );

        CREATE UNIQUE INDEX IF NOT EXISTS idx_orch_checkpoints_key
          ON orchestration_checkpoints(run_id, step_key, phase);

        CREATE TABLE IF NOT EXISTS orchestration_artifacts (
          id TEXT PRIMARY KEY,
          run_id TEXT NOT NULL REFERENCES orchestration_runs(id) ON DELETE CASCADE,
          workspace_id TEXT NOT NULL,
          job_id TEXT NOT NULL,
          kind TEXT NOT NULL,
          file_name TEXT NOT NULL,
          mime_type TEXT NOT NULL,
          byte_size INTEGER NOT NULL,
          sha256 TEXT NOT NULL,
          storage_ref TEXT NOT NULL,
          metadata_json TEXT NOT NULL,
          created_at TEXT NOT NULL
        );

        CREATE INDEX IF NOT EXISTS idx_orch_artifacts_run
          ON orchestration_artifacts(run_id, kind);

        CREATE TABLE IF NOT EXISTS orchestration_events (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          run_id TEXT NOT NULL REFERENCES orchestration_runs(id) ON DELETE CASCADE,
          step_key TEXT,
          level TEXT NOT NULL,
          event_type TEXT NOT NULL,
          message TEXT NOT NULL,
          details_json TEXT,
          created_at TEXT NOT NULL
        );

        CREATE INDEX IF NOT EXISTS idx_orch_events_run
          ON orchestration_events(run_id, id);
      `);
    },
  },
  {
    version: 6,
    up(db) {
      // Step 5B narration + Gate-3 bound export bundles (docs/06 §5, AC-10).
      //
      // `speech_cache` is content-addressed: the key hashes provider, model,
      // voice, language, speed and the exact text, so an identical re-run must
      // never re-bill the provider. The WAV bytes live on disk under
      // `data/artifacts/tts/<cache_key>.wav`; this row records their hash so a
      // truncated or swapped file is detected on the next hit.
      db.exec(`
        CREATE TABLE IF NOT EXISTS speech_cache (
          cache_key TEXT PRIMARY KEY,
          provider TEXT NOT NULL,
          model TEXT NOT NULL,
          voice_id TEXT NOT NULL,
          language TEXT NOT NULL,
          speed REAL NOT NULL,
          text_sha256 TEXT NOT NULL,
          text_length INTEGER NOT NULL,
          file_path TEXT NOT NULL,
          sha256 TEXT NOT NULL,
          byte_size INTEGER NOT NULL,
          duration_ms INTEGER NOT NULL,
          sample_rate INTEGER NOT NULL,
          channels INTEGER NOT NULL,
          license TEXT NOT NULL,
          synthetic INTEGER NOT NULL,
          created_at TEXT NOT NULL,
          last_used_at TEXT NOT NULL,
          hit_count INTEGER NOT NULL DEFAULT 0
        );

        CREATE INDEX IF NOT EXISTS idx_speech_cache_created
          ON speech_cache(created_at DESC);

        CREATE TABLE IF NOT EXISTS export_bundles (
          id TEXT PRIMARY KEY,
          workspace_id TEXT NOT NULL,
          project_id TEXT NOT NULL,
          video_id TEXT NOT NULL,
          run_id TEXT NOT NULL,
          mp4_artifact_id TEXT NOT NULL,
          srt_artifact_id TEXT NOT NULL,
          manifest_artifact_id TEXT NOT NULL,
          receipt_artifact_id TEXT NOT NULL,
          mp4_sha256 TEXT NOT NULL,
          srt_sha256 TEXT NOT NULL,
          manifest_sha256 TEXT NOT NULL,
          script_version INTEGER NOT NULL,
          approval_note TEXT,
          payload TEXT NOT NULL,
          created_at TEXT NOT NULL
        );

        CREATE INDEX IF NOT EXISTS idx_export_bundles_workspace_video
          ON export_bundles(workspace_id, video_id, created_at DESC);

        CREATE INDEX IF NOT EXISTS idx_export_bundles_run
          ON export_bundles(run_id, created_at DESC);
      `);
    },
  },
];

function readUserVersion(db: DatabaseSync): number {
  const row = db.prepare('PRAGMA user_version').get() as { user_version?: number } | undefined;
  return Number(row?.user_version ?? 0);
}

export function migrateDatabase(db: DatabaseSync): number {
  let version = readUserVersion(db);
  for (const migration of MIGRATIONS) {
    if (migration.version <= version) continue;
    db.exec('BEGIN');
    try {
      migration.up(db);
      db.exec(`PRAGMA user_version = ${migration.version}`);
      db.exec('COMMIT');
      version = migration.version;
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
  }
  return version;
}

export function openDatabase(dbPath: string): DatabaseSync {
  if (dbPath !== ':memory:') {
    mkdirSync(path.dirname(dbPath), { recursive: true });
  }
  const db = new DatabaseSync(dbPath);
  if (dbPath !== ':memory:') {
    db.exec('PRAGMA journal_mode = WAL');
  }
  db.exec('PRAGMA foreign_keys = ON');
  db.exec('PRAGMA busy_timeout = 5000');
  migrateDatabase(db);
  return db;
}

export { MIGRATIONS };
