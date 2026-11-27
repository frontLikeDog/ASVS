import { describe, expect, it } from 'vitest';
import {
  KNOWLEDGE_SNAPSHOT_SCHEMA_VERSION,
  knowledgeSnapshotV1Schema,
  planKnowledgeChanges,
  sha256HexSchema,
  toKnowledgeSnapshotSummary,
  type KnowledgeSnapshotV1,
} from './knowledge';

const SHA_A = 'a'.repeat(40);
const SHA256 = 'b'.repeat(64);

function buildSnapshot(overrides: Partial<KnowledgeSnapshotV1> = {}): KnowledgeSnapshotV1 {
  return {
    schemaVersion: KNOWLEDGE_SNAPSHOT_SCHEMA_VERSION,
    id: `snap_${'1'.repeat(32)}`,
    repo: 'frontLikeDog/livenotes',
    branch: 'main',
    gitCommitSha: SHA_A,
    indexedAt: '2026-11-27T10:00:00.000Z',
    sourceDigests: { 'README.md': SHA256 },
    files: [
      {
        path: 'README.md',
        language: 'markdown',
        byteSize: 12,
        lineCount: 1,
        blobSha: SHA_A,
        headings: [{ level: 1, text: 'LiveNotes' }],
        symbols: [],
        entrypoints: [{ path: 'README.md', kind: 'readme', rank: 0 }],
      },
    ],
    skipped: [],
    entrypoints: [{ path: 'README.md', kind: 'readme', rank: 0 }],
    stats: {
      mode: 'cold',
      totalFiles: 1,
      indexedFiles: 1,
      reusedFiles: 0,
      removedFiles: 0,
      skippedFiles: 0,
      fetchedFiles: 1,
      durationMs: 12.5,
    },
    ...overrides,
  };
}

describe('knowledge domain contracts', () => {
  it('accepts a well-formed KnowledgeSnapshotV1', () => {
    expect(() => knowledgeSnapshotV1Schema.parse(buildSnapshot())).not.toThrow();
  });

  it('rejects traversal, invalid digests and malformed snapshot ids', () => {
    expect(() =>
      knowledgeSnapshotV1Schema.parse(buildSnapshot({ repo: 'owner' })),
    ).toThrow();
    expect(() =>
      knowledgeSnapshotV1Schema.parse(buildSnapshot({ repo: 'https://x/y/z' })),
    ).toThrow();
    expect(() =>
      knowledgeSnapshotV1Schema.parse(buildSnapshot({ sourceDigests: { 'a.md': 'not-a-digest' } })),
    ).toThrow();
    expect(() =>
      knowledgeSnapshotV1Schema.parse(buildSnapshot({ id: 'snap_XYZ' })),
    ).toThrow();
    expect(() =>
      knowledgeSnapshotV1Schema.parse(buildSnapshot({ gitCommitSha: 'abc123' })),
    ).toThrow();
  });

  it('accepts 64-hex SHA256 git object ids for SHA-256 repositories', () => {
    expect(() =>
      knowledgeSnapshotV1Schema.parse(buildSnapshot({ gitCommitSha: 'c'.repeat(64) })),
    ).not.toThrow();
  });

  it('requires the stats counters to be non-negative integers', () => {
    const invalid = buildSnapshot();
    invalid.stats.totalFiles = -1;
    expect(() => knowledgeSnapshotV1Schema.parse(invalid)).toThrow();
    expect(() => sha256HexSchema.parse(SHA256.toUpperCase())).toThrow();
  });

  it('drops undefined parentSnapshotId from summaries', () => {
    const summary = toKnowledgeSnapshotSummary(buildSnapshot());
    expect(summary).not.toHaveProperty('parentSnapshotId');
    expect(summary).toMatchObject({ id: buildSnapshot().id, stats: { mode: 'cold' } });
  });

  it('keeps the parent id in summaries when present', () => {
    const parentId = `snap_${'2'.repeat(32)}`;
    const summary = toKnowledgeSnapshotSummary(buildSnapshot({ parentSnapshotId: parentId }));
    expect(summary.parentSnapshotId).toBe(parentId);
  });

  it('diffs digests into added / modified / unchanged / removed, sorted', () => {
    const plan = planKnowledgeChanges(
      { 'b.md': '1', 'a.py': '2', 'gone.md': '3' },
      { 'c.ts': '4', 'a.py': '2', 'b.md': '9' },
    );
    expect(plan).toEqual({
      added: ['c.ts'],
      modified: ['b.md'],
      unchanged: ['a.py'],
      removed: ['gone.md'],
    });
  });

  it('treats an empty parent as "everything added"', () => {
    expect(planKnowledgeChanges({}, { 'a.md': 'x', 'b.md': 'y' })).toEqual({
      added: ['a.md', 'b.md'],
      modified: [],
      unchanged: [],
      removed: [],
    });
  });
});
