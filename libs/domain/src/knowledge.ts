import { z } from 'zod';

/**
 * Step 4B · Incremental repository index contracts.
 *
 * `KnowledgeSnapshotV1` is an immutable, digest-addressed view of a repository
 * at one commit. A new snapshot is created for every sync; nothing here
 * mutates a snapshot, performs I/O or touches Node APIs, so this module stays
 * browser-safe and dependency-free (zod only, like the rest of `libs/domain`).
 */

export const KNOWLEDGE_SNAPSHOT_SCHEMA_VERSION = '1' as const;
export const KNOWLEDGE_SNAPSHOT_ID_PREFIX = 'snap_' as const;

export const knowledgeSnapshotIdSchema = z
  .string()
  .regex(
    new RegExp(`^${KNOWLEDGE_SNAPSHOT_ID_PREFIX}[0-9a-f]{32}$`),
    '快照 ID 必须是 snap_ 加 32 位小写十六进制',
  );

export const KNOWLEDGE_INDEX_MODES = ['cold', 'incremental'] as const;
export const knowledgeIndexModeSchema = z.enum(KNOWLEDGE_INDEX_MODES);
export type KnowledgeIndexMode = z.infer<typeof knowledgeIndexModeSchema>;

/**
 * Languages the lightweight extractor understands. Everything else is still
 * indexed as `unknown` (digest, size, line count) so change detection and
 * deletion bookkeeping stay exact for every text file.
 */
export const KNOWLEDGE_LANGUAGES = [
  'markdown',
  'python',
  'typescript',
  'javascript',
  'json',
  'yaml',
  'toml',
  'css',
  'html',
  'shell',
  'unknown',
] as const;
export const knowledgeLanguageSchema = z.enum(KNOWLEDGE_LANGUAGES);
export type KnowledgeLanguage = z.infer<typeof knowledgeLanguageSchema>;

/** Why a tree entry was not indexed. Skipped entries are counted and named. */
export const KNOWLEDGE_SKIP_REASONS = [
  'binary',
  'too_large',
  'excluded_directory',
  'excluded_file',
  'secret_file',
  'too_many_files',
  'not_a_file',
  'invalid_path',
  'unreadable',
] as const;
export const knowledgeSkipReasonSchema = z.enum(KNOWLEDGE_SKIP_REASONS);
export type KnowledgeSkipReason = z.infer<typeof knowledgeSkipReasonSchema>;

export const knowledgeSkipRecordSchema = z.object({
  path: z.string().min(1),
  reason: knowledgeSkipReasonSchema,
  byteSize: z.number().int().min(0).optional(),
  /** Lets an incremental scan reuse a skip decision without refetching. */
  blobSha: z.string().regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/).optional(),
});
export type KnowledgeSkipRecord = z.infer<typeof knowledgeSkipRecordSchema>;

export const knowledgeHeadingSchema = z.object({
  level: z.number().int().min(1).max(6),
  text: z.string().min(1).max(200),
});
export type KnowledgeHeading = z.infer<typeof knowledgeHeadingSchema>;

/**
 * Deliberately shallow symbols: what a file declares, not a full AST. The
 * extractor only reads text and never executes repository code.
 */
export const KNOWLEDGE_SYMBOL_KINDS = [
  'class',
  'function',
  'method',
  'route',
  'export',
  'constant',
  'type',
  'interface',
  'component',
] as const;
export const knowledgeSymbolKindSchema = z.enum(KNOWLEDGE_SYMBOL_KINDS);
export type KnowledgeSymbolKind = z.infer<typeof knowledgeSymbolKindSchema>;

export const knowledgeSymbolSchema = z.object({
  name: z.string().min(1).max(200),
  kind: knowledgeSymbolKindSchema,
  line: z.number().int().min(1),
});
export type KnowledgeSymbol = z.infer<typeof knowledgeSymbolSchema>;

/**
 * Entrypoints are ranked so downstream slices can pick a canonical "where do I
 * start reading" file without re-deriving heuristics:
 * 0 project/README docs, 1 runtime entry or manifest, 2 supporting docs.
 */
export const knowledgeEntrypointSchema = z.object({
  path: z.string().min(1),
  kind: z.string().min(1).max(40),
  rank: z.number().int().min(0).max(2),
});
export type KnowledgeEntrypoint = z.infer<typeof knowledgeEntrypointSchema>;

export const sha256HexSchema = z
  .string()
  .regex(/^[a-f0-9]{64}$/, 'sourceDigests 的值必须是 64 位小写十六进制 SHA256');
/** Git object ids are SHA-1 (40 hex) today; SHA-256 repositories use 64 hex. */
export const gitObjectShaSchema = z.string().regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/);

export const knowledgeFileSchema = z.object({
  path: z.string().min(1).max(1024),
  language: knowledgeLanguageSchema,
  byteSize: z.number().int().min(0),
  lineCount: z.number().int().min(0),
  /** Git blob id used for cheap change detection before downloading content. */
  blobSha: gitObjectShaSchema.optional(),
  headings: z.array(knowledgeHeadingSchema),
  symbols: z.array(knowledgeSymbolSchema),
  entrypoints: z.array(knowledgeEntrypointSchema),
});
export type KnowledgeFile = z.infer<typeof knowledgeFileSchema>;

export const knowledgeIndexStatsSchema = z.object({
  mode: knowledgeIndexModeSchema,
  /** Files that passed path/size filters and are represented in `files`. */
  totalFiles: z.number().int().min(0),
  /** Added or modified files that were fetched and parsed in this scan. */
  indexedFiles: z.number().int().min(0),
  /** Unchanged files whose previous extraction was carried over. */
  reusedFiles: z.number().int().min(0),
  /** Files present in the parent snapshot but gone (or now excluded) here. */
  removedFiles: z.number().int().min(0),
  /** Tree entries deliberately not indexed (binary, too large, secrets…). */
  skippedFiles: z.number().int().min(0),
  /** Blob downloads performed by this scan. A hot no-op scan must report 0. */
  fetchedFiles: z.number().int().min(0),
  durationMs: z.number().min(0),
});
export type KnowledgeIndexStats = z.infer<typeof knowledgeIndexStatsSchema>;

export const knowledgeSnapshotV1Schema = z.object({
  schemaVersion: z.literal(KNOWLEDGE_SNAPSHOT_SCHEMA_VERSION),
  id: knowledgeSnapshotIdSchema,
  /** `owner/repo`, the same shape the GitHub routes already accept. */
  repo: z
    .string()
    .min(3)
    .max(201)
    .regex(
      /^[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}$/,
      'repo 必须是 owner/repo 格式',
    ),
  branch: z.string().min(1).max(255),
  gitCommitSha: gitObjectShaSchema,
  parentSnapshotId: knowledgeSnapshotIdSchema.optional(),
  indexedAt: z.string().min(1),
  sourceDigests: z.record(z.string(), sha256HexSchema),
  files: z.array(knowledgeFileSchema),
  /** Files that matched the scan but were intentionally not indexed. */
  skipped: z.array(knowledgeSkipRecordSchema),
  entrypoints: z.array(knowledgeEntrypointSchema),
  stats: knowledgeIndexStatsSchema,
});
export type KnowledgeSnapshotV1 = z.infer<typeof knowledgeSnapshotV1Schema>;

/** Compact row returned by `GET /…/snapshots`. */
export const knowledgeSnapshotSummaryV1Schema = z.object({
  id: knowledgeSnapshotIdSchema,
  repo: z.string().min(3),
  branch: z.string().min(1),
  gitCommitSha: z.string().min(1),
  parentSnapshotId: knowledgeSnapshotIdSchema.optional(),
  indexedAt: z.string().min(1),
  stats: knowledgeIndexStatsSchema,
});
export type KnowledgeSnapshotSummaryV1 = z.infer<typeof knowledgeSnapshotSummaryV1Schema>;

export function toKnowledgeSnapshotSummary(
  snapshot: KnowledgeSnapshotV1,
): KnowledgeSnapshotSummaryV1 {
  return {
    id: snapshot.id,
    repo: snapshot.repo,
    branch: snapshot.branch,
    gitCommitSha: snapshot.gitCommitSha,
    ...(snapshot.parentSnapshotId ? { parentSnapshotId: snapshot.parentSnapshotId } : {}),
    indexedAt: snapshot.indexedAt,
    stats: snapshot.stats,
  };
}

export interface KnowledgeChangePlan {
  added: string[];
  modified: string[];
  unchanged: string[];
  removed: string[];
}

/**
 * Pure diff between the previous snapshot's digests and the current tree.
 * Both sides are keyed by path; output is sorted so snapshots stay
 * deterministic for tests and diffing.
 */
export function planKnowledgeChanges(
  previousDigests: Record<string, string>,
  currentDigests: Record<string, string>,
): KnowledgeChangePlan {
  const added: string[] = [];
  const modified: string[] = [];
  const unchanged: string[] = [];
  const removed: string[] = [];

  for (const path of Object.keys(currentDigests).sort()) {
    const before = previousDigests[path];
    const after = currentDigests[path];
    if (before === undefined) added.push(path);
    else if (before === after) unchanged.push(path);
    else modified.push(path);
  }
  for (const path of Object.keys(previousDigests).sort()) {
    if (currentDigests[path] === undefined) removed.push(path);
  }

  return { added, modified, unchanged, removed };
}
