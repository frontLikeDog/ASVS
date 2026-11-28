import type { DatabaseSync } from 'node:sqlite';

/**
 * Content-addressed TTS cache rows (migration v6).
 *
 * One row per `cache_key`; the payload WAV stays on disk. Nothing here is
 * workflow state, so writes are idempotent and a lost row only costs one
 * re-synthesis (never a wrong file — the disk hash is re-verified on hit).
 */

export interface SpeechCacheEntry {
  cacheKey: string;
  provider: string;
  model: string;
  voiceId: string;
  language: string;
  speed: number;
  textSha256: string;
  textLength: number;
  filePath: string;
  sha256: string;
  byteSize: number;
  durationMs: number;
  sampleRate: number;
  channels: number;
  license: string;
  synthetic: boolean;
  createdAt: string;
  lastUsedAt: string;
  hitCount: number;
}

interface SpeechCacheRow {
  cache_key: string;
  provider: string;
  model: string;
  voice_id: string;
  language: string;
  speed: number;
  text_sha256: string;
  text_length: number;
  file_path: string;
  sha256: string;
  byte_size: number;
  duration_ms: number;
  sample_rate: number;
  channels: number;
  license: string;
  synthetic: number;
  created_at: string;
  last_used_at: string;
  hit_count: number;
}

function rowToEntry(row: SpeechCacheRow): SpeechCacheEntry {
  return {
    cacheKey: row.cache_key,
    provider: row.provider,
    model: row.model,
    voiceId: row.voice_id,
    language: row.language,
    speed: row.speed,
    textSha256: row.text_sha256,
    textLength: row.text_length,
    filePath: row.file_path,
    sha256: row.sha256,
    byteSize: row.byte_size,
    durationMs: row.duration_ms,
    sampleRate: row.sample_rate,
    channels: row.channels,
    license: row.license,
    synthetic: row.synthetic === 1,
    createdAt: row.created_at,
    lastUsedAt: row.last_used_at,
    hitCount: row.hit_count,
  };
}

export class SpeechCacheStore {
  constructor(private readonly db: DatabaseSync) {}

  get(cacheKey: string): SpeechCacheEntry | null {
    const row = this.db
      .prepare('SELECT * FROM speech_cache WHERE cache_key = ?')
      .get(cacheKey) as SpeechCacheRow | undefined;
    return row ? rowToEntry(row) : null;
  }

  put(entry: SpeechCacheEntry): void {
    this.db
      .prepare(
        `INSERT INTO speech_cache (
          cache_key, provider, model, voice_id, language, speed, text_sha256,
          text_length, file_path, sha256, byte_size, duration_ms, sample_rate,
          channels, license, synthetic, created_at, last_used_at, hit_count
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(cache_key) DO UPDATE SET
          file_path = excluded.file_path,
          sha256 = excluded.sha256,
          byte_size = excluded.byte_size,
          duration_ms = excluded.duration_ms,
          sample_rate = excluded.sample_rate,
          channels = excluded.channels,
          license = excluded.license,
          synthetic = excluded.synthetic`,
      )
      .run(
        entry.cacheKey,
        entry.provider,
        entry.model,
        entry.voiceId,
        entry.language,
        entry.speed,
        entry.textSha256,
        entry.textLength,
        entry.filePath,
        entry.sha256,
        entry.byteSize,
        entry.durationMs,
        entry.sampleRate,
        entry.channels,
        entry.license,
        entry.synthetic ? 1 : 0,
        entry.createdAt,
        entry.lastUsedAt,
        entry.hitCount,
      );
  }

  /** Records a cache hit; the key is user-independent so this is safe to bump. */
  recordHit(cacheKey: string, at: string): void {
    this.db
      .prepare(
        'UPDATE speech_cache SET last_used_at = ?, hit_count = hit_count + 1 WHERE cache_key = ?',
      )
      .run(at, cacheKey);
  }

  delete(cacheKey: string): void {
    this.db.prepare('DELETE FROM speech_cache WHERE cache_key = ?').run(cacheKey);
  }

  count(): number {
    const row = this.db.prepare('SELECT COUNT(*) AS n FROM speech_cache').get() as
      | { n: number }
      | undefined;
    return Number(row?.n ?? 0);
  }
}
