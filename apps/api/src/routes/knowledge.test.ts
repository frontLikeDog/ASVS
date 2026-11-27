// @vitest-environment node
import { afterEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { GitHubRepoRef, KnowledgeSnapshotV1 } from '@asvs/domain';
import type { KnowledgeIndexPort } from '@asvs/ports';
import { buildApp } from '../app';

const REPO: GitHubRepoRef = { owner: 'frontLikeDog', repo: 'livenotes' };
const SNAPSHOT_ID = `snap_${'a'.repeat(32)}`;

let app: FastifyInstance | undefined;

afterEach(async () => {
  await app?.close();
  app = undefined;
});

function buildSnapshot(overrides: Partial<KnowledgeSnapshotV1> = {}): KnowledgeSnapshotV1 {
  return {
    schemaVersion: '1',
    id: SNAPSHOT_ID,
    repo: 'frontLikeDog/livenotes',
    branch: 'main',
    gitCommitSha: '1'.repeat(40),
    indexedAt: '2026-11-27T10:00:00.000Z',
    sourceDigests: { 'README.md': 'b'.repeat(64) },
    files: [
      {
        path: 'README.md',
        language: 'markdown',
        byteSize: 12,
        lineCount: 1,
        blobSha: '1'.repeat(40),
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
      durationMs: 5,
    },
    ...overrides,
  };
}

function createStubIndexer(overrides: Partial<KnowledgeIndexPort> = {}): KnowledgeIndexPort {
  return {
    indexRepository: async () => buildSnapshot(),
    getLatestSnapshot: async () => buildSnapshot(),
    getSnapshot: async (_repo, snapshotId) =>
      snapshotId === SNAPSHOT_ID ? buildSnapshot() : null,
    listSnapshots: async () => [
      {
        id: SNAPSHOT_ID,
        repo: 'frontLikeDog/livenotes',
        branch: 'main',
        gitCommitSha: '1'.repeat(40),
        indexedAt: '2026-11-27T10:00:00.000Z',
        stats: buildSnapshot().stats,
      },
    ],
    ...overrides,
  };
}

describe('知识索引路由', () => {
  it('未配置 GitHub 时索引请求返回 503，快照读取仍可用', async () => {
    const built = await buildApp({ dbPath: ':memory:' });
    app = built.app;

    const index = await app.inject({
      method: 'POST',
      url: '/v1/github/repos/frontLikeDog/livenotes/index',
      payload: {},
    });
    expect(index.statusCode).toBe(503);
    expect(index.json().error.code).toBe('github_not_configured');

    // Listing/reading do not touch GitHub, so they stay available.
    const list = await app.inject({
      method: 'GET',
      url: '/v1/github/repos/frontLikeDog/livenotes/snapshots',
    });
    expect(list.statusCode).toBe(200);
    expect(list.json()).toMatchObject({ repo: 'frontLikeDog/livenotes', count: 0, snapshots: [] });

    const get = await app.inject({
      method: 'GET',
      url: `/v1/github/repos/frontLikeDog/livenotes/snapshots/${SNAPSHOT_ID}`,
    });
    expect(get.statusCode).toBe(404);
  });

  it('已配置时触发索引并返回 201 + 完整快照', async () => {
    const calls: Array<{ repo: GitHubRepoRef; options: unknown }> = [];
    const built = await buildApp({
      dbPath: ':memory:',
      knowledgeIndexer: createStubIndexer({
        indexRepository: async (repo, options) => {
          calls.push({ repo, options });
          return buildSnapshot();
        },
      }),
    });
    app = built.app;

    const response = await app.inject({
      method: 'POST',
      url: '/v1/github/repos/frontLikeDog/livenotes/index',
      payload: { branch: 'main', forceCold: true },
    });

    expect(response.statusCode).toBe(201);
    expect(response.json()).toMatchObject({
      repo: 'frontLikeDog/livenotes',
      snapshot: { id: SNAPSHOT_ID, branch: 'main', stats: { mode: 'cold' } },
    });
    expect(calls).toEqual([{ repo: REPO, options: { branch: 'main', forceCold: true } }]);
  });

  it('接受空请求体，并把参数校验失败映射为 400', async () => {
    const built = await buildApp({
      dbPath: ':memory:',
      knowledgeIndexer: createStubIndexer(),
    });
    app = built.app;

    const noBody = await app.inject({
      method: 'POST',
      url: '/v1/github/repos/frontLikeDog/livenotes/index',
    });
    expect(noBody.statusCode).toBe(201);

    const extraField = await app.inject({
      method: 'POST',
      url: '/v1/github/repos/frontLikeDog/livenotes/index',
      payload: { forceCold: true, unknown: 'x' },
    });
    expect(extraField.statusCode).toBe(400);
    expect(extraField.json().error.code).toBe('invalid_github_request');

    const badForceCold = await app.inject({
      method: 'POST',
      url: '/v1/github/repos/frontLikeDog/livenotes/index',
      payload: { forceCold: 'yes' },
    });
    expect(badForceCold.statusCode).toBe(400);

    // `%2e%2e` decodes to `..` in the route param, so the repo schema must
    // reject it even though the URL itself routes cleanly.
    const badRepo = await app.inject({
      method: 'POST',
      url: '/v1/github/repos/frontLikeDog/a..b/index',
      payload: {},
    });
    expect(badRepo.statusCode).toBe(400);
    expect(badRepo.json().error.code).toBe('invalid_github_request');
  });

  it('列出历史快照并按 limit / branch 过滤', async () => {
    const seen: Array<{ branch?: string; limit?: number }> = [];
    const built = await buildApp({
      dbPath: ':memory:',
      knowledgeIndexer: createStubIndexer({
        listSnapshots: async (_repo, options) => {
          seen.push(options ?? {});
          return [];
        },
      }),
    });
    app = built.app;

    const response = await app.inject({
      method: 'GET',
      url: '/v1/github/repos/frontLikeDog/livenotes/snapshots?branch=main&limit=5',
    });
    expect(response.statusCode).toBe(200);
    expect(seen).toEqual([{ branch: 'main', limit: 5 }]);

    const badLimit = await app.inject({
      method: 'GET',
      url: '/v1/github/repos/frontLikeDog/livenotes/snapshots?limit=1000',
    });
    expect(badLimit.statusCode).toBe(400);
    expect(badLimit.json().error.code).toBe('invalid_github_request');
  });

  it('读取完整快照，并拒绝非法 ID 与未知 ID', async () => {
    const built = await buildApp({
      dbPath: ':memory:',
      knowledgeIndexer: createStubIndexer(),
    });
    app = built.app;

    const found = await app.inject({
      method: 'GET',
      url: `/v1/github/repos/frontLikeDog/livenotes/snapshots/${SNAPSHOT_ID}`,
    });
    expect(found.statusCode).toBe(200);
    expect(found.json()).toMatchObject({
      id: SNAPSHOT_ID,
      schemaVersion: '1',
      sourceDigests: { 'README.md': 'b'.repeat(64) },
    });

    const invalid = await app.inject({
      method: 'GET',
      url: '/v1/github/repos/frontLikeDog/livenotes/snapshots/not-a-snapshot',
    });
    expect(invalid.statusCode).toBe(400);

    const unknown = await app.inject({
      method: 'GET',
      url: `/v1/github/repos/frontLikeDog/livenotes/snapshots/snap_${'f'.repeat(32)}`,
    });
    expect(unknown.statusCode).toBe(404);
    expect(unknown.json().error.code).toBe('not_found');
  });

  it('存储层经真实 SQLite 往返：索引后立即可读', async () => {
    const built = await buildApp({ dbPath: ':memory:' });
    app = built.app;

    // Insert through the store the app built, matching what the indexer does.
    built.knowledgeStore.insert(buildSnapshot());

    const list = await app.inject({
      method: 'GET',
      url: '/v1/github/repos/frontLikeDog/livenotes/snapshots',
    });
    expect(list.statusCode).toBe(200);
    expect(list.json()).toMatchObject({
      count: 1,
      snapshots: [{ id: SNAPSHOT_ID, stats: { totalFiles: 1, fetchedFiles: 1 } }],
    });

    const get = await app.inject({
      method: 'GET',
      url: `/v1/github/repos/frontLikeDog/livenotes/snapshots/${SNAPSHOT_ID}`,
    });
    expect(get.statusCode).toBe(200);
    expect(get.json().files[0].path).toBe('README.md');

    // A snapshot of another repository is not visible under this repo.
    const otherRepo = await app.inject({
      method: 'GET',
      url: `/v1/github/repos/other/repo/snapshots/${SNAPSHOT_ID}`,
    });
    expect(otherRepo.statusCode).toBe(404);
  });
});
