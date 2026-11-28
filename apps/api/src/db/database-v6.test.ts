import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import { MIGRATIONS, migrateDatabase } from './database';

function tableNames(db: DatabaseSync): string[] {
  const rows = db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
    .all() as Array<{ name: string }>;
  return rows.map((row) => row.name);
}

function columns(db: DatabaseSync, table: string): string[] {
  const rows = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
  return rows.map((row) => row.name);
}

describe('migration v6 · 语音缓存与导出包', () => {
  it('迁移版本递增到最新且保持幂等（v6 之后的迁移不改变本测试的表契约）', () => {
    const db = new DatabaseSync(':memory:');
    const latest = MIGRATIONS.at(-1)!.version;
    expect(latest).toBeGreaterThanOrEqual(6);
    expect(migrateDatabase(db)).toBe(latest);
    expect(migrateDatabase(db)).toBe(latest);
    const version = db.prepare('PRAGMA user_version').get() as { user_version: number };
    expect(version.user_version).toBe(latest);
    db.close();
  });

  it('从 v5 升级只新增表，已存在的 5A 数据原样保留', () => {
    const db = new DatabaseSync(':memory:');
    db.exec('PRAGMA foreign_keys = ON');
    for (const migration of MIGRATIONS.filter((item) => item.version <= 5)) {
      db.exec('BEGIN');
      migration.up(db);
      db.exec(`PRAGMA user_version = ${migration.version}`);
      db.exec('COMMIT');
    }
    db.prepare(
      `INSERT INTO orchestration_runs
        (id, workspace_id, project_id, video_id, idempotency_key, status, payload, created_at, updated_at)
       VALUES ('run_old', 'ws', 'proj', 'video', 'idem', 'succeeded', '{}', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')`,
    ).run();

    expect(migrateDatabase(db)).toBe(MIGRATIONS.at(-1)!.version);
    const row = db
      .prepare("SELECT status FROM orchestration_runs WHERE id = 'run_old'")
      .get() as { status: string };
    expect(row.status).toBe('succeeded');
    db.close();
  });

  it('speech_cache 具备内容寻址所需的全部列', () => {
    const db = new DatabaseSync(':memory:');
    migrateDatabase(db);
    expect(tableNames(db)).toContain('speech_cache');
    expect(columns(db, 'speech_cache')).toEqual(
      expect.arrayContaining([
        'cache_key',
        'provider',
        'model',
        'voice_id',
        'language',
        'speed',
        'text_sha256',
        'text_length',
        'file_path',
        'sha256',
        'byte_size',
        'duration_ms',
        'sample_rate',
        'channels',
        'license',
        'synthetic',
        'created_at',
        'last_used_at',
        'hit_count',
      ]),
    );
    db.close();
  });

  it('export_bundles 绑定三个产物的哈希与 script_version', () => {
    const db = new DatabaseSync(':memory:');
    migrateDatabase(db);
    expect(columns(db, 'export_bundles')).toEqual(
      expect.arrayContaining([
        'id',
        'workspace_id',
        'project_id',
        'video_id',
        'run_id',
        'mp4_artifact_id',
        'srt_artifact_id',
        'manifest_artifact_id',
        'receipt_artifact_id',
        'mp4_sha256',
        'srt_sha256',
        'manifest_sha256',
        'script_version',
        'approval_note',
        'payload',
        'created_at',
      ]),
    );
    db.close();
  });

  it('speech_cache.cache_key 是主键（重复写入走 UPSERT 而非报错）', () => {
    const db = new DatabaseSync(':memory:');
    migrateDatabase(db);
    const insert = db.prepare(
      `INSERT INTO speech_cache
        (cache_key, provider, model, voice_id, language, speed, text_sha256, text_length,
         file_path, sha256, byte_size, duration_ms, sample_rate, channels, license,
         synthetic, created_at, last_used_at, hit_count)
       VALUES (?, 'p', 'm', 'v', 'zh-CN', 1, ?, 2, '/tmp/a.wav', ?, 100, 1000, 48000, 1, 'l', 1,
               '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z', 0)
       ON CONFLICT(cache_key) DO UPDATE SET hit_count = speech_cache.hit_count + 1`,
    );
    const key = 'a'.repeat(64);
    insert.run(key, 'b'.repeat(64), 'c'.repeat(64));
    insert.run(key, 'b'.repeat(64), 'c'.repeat(64));
    const row = db.prepare('SELECT hit_count FROM speech_cache WHERE cache_key = ?').get(key) as {
      hit_count: number;
    };
    expect(row.hit_count).toBe(1);
    db.close();
  });
});
