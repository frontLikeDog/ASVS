// @vitest-environment node
import { createHash } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import type { DatabaseSync } from 'node:sqlite';
import type { GitHubConnectionStatus, GitHubRepoRef, KnowledgeSnapshotV1 } from '@asvs/domain';
import type { GitHubReadOnlyPort, GitHubTreeEntry } from '@asvs/ports';
import { openDatabase } from '../db/database';
import { SqliteKnowledgeSnapshotStore } from '../db/knowledge-store';
import { GitHubKnowledgeIndexer } from './indexer';
import { DEFAULT_KNOWLEDGE_INDEX_LIMITS } from './policy';

const REPO: GitHubRepoRef = { owner: 'frontLikeDog', repo: 'livenotes' };
const COMMIT_1 = '1'.repeat(40);
const COMMIT_2 = '2'.repeat(40);

interface FakeFile {
  path: string;
  content: string;
  /** Overrides the auto blob sha, so a test can force a "changed" decision. */
  blobSha?: string;
}

interface FakeRepoState {
  files: FakeFile[];
  commitSha: string;
}

function blobSha(content: string): string {
  return createHash('sha1').update(`blob ${Buffer.byteLength(content)}\0${content}`).digest('hex');
}

function treeFrom(state: FakeRepoState): GitHubTreeEntry[] {
  return state.files.map((file) => ({
    path: file.path,
    type: 'blob' as const,
    sha: file.blobSha ?? blobSha(file.content),
    size: Buffer.byteLength(file.content, 'utf8'),
  }));
}

interface FakeGitHub extends GitHubReadOnlyPort {
  state: FakeRepoState;
  counters: {
    treeReads: number;
    fileReads: number;
    readPaths: string[];
    commits: number;
    repos: number;
  };
}

function createFakeGitHub(initial: FakeRepoState): FakeGitHub {
  const fake: FakeGitHub = {
    state: initial,
    counters: { treeReads: 0, fileReads: 0, readPaths: [], commits: 0, repos: 0 },
    isConfigured: () => true,
    getDefaultRepo: () => REPO,
    checkConnection: async (): Promise<GitHubConnectionStatus> => ({
      configured: true,
      mode: 'github_app',
      connected: true,
      readOnly: true,
      accessibleRepositories: ['frontLikeDog/livenotes'],
      permissions: { contents: 'read', metadata: 'read' },
      writePermissions: [],
      checkedAt: '2026-11-27T12:00:00.000Z',
    }),
    getRepository: async (repo) => {
      fake.counters.repos += 1;
      return {
        id: 1,
        owner: repo.owner,
        name: repo.repo,
        fullName: `${repo.owner}/${repo.repo}`,
        description: 'Notes',
        private: true,
        defaultBranch: 'main',
        htmlUrl: `https://github.com/${repo.owner}/${repo.repo}`,
        pushedAt: null,
        updatedAt: null,
      };
    },
    listPullRequests: async () => [],
    listPullRequestFiles: async () => [],
    listReleases: async () => [],
    getFileContent: async (_repo, filePath) => {
      fake.counters.fileReads += 1;
      fake.counters.readPaths.push(filePath);
      const file = fake.state.files.find((candidate) => candidate.path === filePath);
      if (!file) return null;
      const content = file.content;
      return {
        path: filePath,
        sha: file.blobSha ?? blobSha(content),
        size: Buffer.byteLength(content, 'utf8'),
        encoding: 'utf-8',
        content,
      };
    },
    getCommit: async () => {
      fake.counters.commits += 1;
      return { sha: fake.state.commitSha, treeSha: fake.state.commitSha, commitAt: null, message: null };
    },
    getRepositoryTree: async () => {
      fake.counters.treeReads += 1;
      return treeFrom(fake.state);
    },
    probeWriteBlocked: async (repo) => ({
      repo: `${repo.owner}/${repo.repo}`,
      readOnlyToken: true,
      writeBlocked: true,
      statusCode: 403,
      detail: 'blocked',
      writePermissions: [],
      checkedAt: '2026-11-27T12:00:00.000Z',
    }),
  };
  return fake;
}

let db: DatabaseSync | undefined;

function createIndexer(github: GitHubReadOnlyPort) {
  db = openDatabase(':memory:');
  const store = new SqliteKnowledgeSnapshotStore(db);
  let counter = 0;
  const indexer = new GitHubKnowledgeIndexer({
    github,
    store,
    now: () => new Date('2026-11-27T10:00:00.000Z'),
    newSnapshotId: () => `snap_${String(++counter).padStart(32, '0')}`,
    concurrency: 2,
  });
  return { indexer, store };
}

afterEach(() => {
  db?.close();
  db = undefined;
});

const BASE_FILES: FakeFile[] = [
  { path: 'README.md', content: '# LiveNotes\n\nA notes app.\n\n## Features\n\n- Sync\n' },
  {
    path: 'app/main.py',
    content: 'from flask import Flask\n\napp = Flask(__name__)\n\n\n@app.route("/notes")\ndef list_notes():\n    return []\n',
  },
  {
    path: 'app/models.py',
    content: 'class Note:\n\t"""A note."""\n\n\tdef __init__(self, body):\n\t\tself.body = body\n',
  },
  { path: 'web/src/App.tsx', content: 'export function App() {\n  return null;\n}\n' },
  { path: 'pyproject.toml', content: '[project]\nname = "livenotes"\n' },
];

describe('增量索引 · 冷扫描', () => {
  it('生成 sourceDigests、结构化信号与统计，并对每个文件只下载一次', async () => {
    const github = createFakeGitHub({ files: BASE_FILES, commitSha: COMMIT_1 });
    const { indexer } = createIndexer(github);

    const snapshot = await indexer.indexRepository(REPO);

    expect(snapshot.stats).toMatchObject({
      mode: 'cold',
      totalFiles: BASE_FILES.length,
      indexedFiles: BASE_FILES.length,
      reusedFiles: 0,
      removedFiles: 0,
      fetchedFiles: BASE_FILES.length,
    });
    expect(snapshot.parentSnapshotId).toBeUndefined();
    expect(snapshot.gitCommitSha).toBe(COMMIT_1);
    expect(snapshot.repo).toBe('frontLikeDog/livenotes');
    expect(Object.keys(snapshot.sourceDigests).sort()).toEqual(
      BASE_FILES.map((file) => file.path).sort(),
    );
    for (const file of BASE_FILES) {
      expect(snapshot.sourceDigests[file.path]).toBe(
        createHash('sha256').update(file.content).digest('hex'),
      );
    }
    expect(github.counters.fileReads).toBe(BASE_FILES.length);
    expect(github.counters.treeReads).toBe(1);

    const readme = snapshot.files.find((file) => file.path === 'README.md');
    expect(readme).toMatchObject({ language: 'markdown' });
    expect(readme?.headings.map((heading) => heading.text)).toEqual(['LiveNotes', 'Features']);

    const main = snapshot.files.find((file) => file.path === 'app/main.py');
    expect(main?.symbols).toEqual([{ name: 'list_notes', kind: 'route', line: 7 }]);
    // Module-level constants require the conventional uppercase name; a
    // lowercase `app = Flask(...)` is a variable and deliberately not a symbol.
    expect(main?.symbols.some((symbol) => symbol.name === 'app')).toBe(false);
    expect(snapshot.files.find((file) => file.path === 'web/src/App.tsx')?.symbols).toEqual([
      { name: 'App', kind: 'component', line: 1 },
    ]);

    expect(snapshot.entrypoints.map((entry) => entry.path)).toEqual(
      expect.arrayContaining(['README.md', 'app/main.py', 'pyproject.toml']),
    );
    // Tab-indented Python still yields methods.
    expect(snapshot.files.find((file) => file.path === 'app/models.py')?.symbols).toEqual(
      expect.arrayContaining([{ name: '__init__', kind: 'method', line: 4 }]),
    );
  });

  it('拒绝非法路径与敏感文件，并跳过二进制与超大文件', async () => {
    const files: FakeFile[] = [
      { path: '../etc/passwd', content: 'root:x:0:0' },
      { path: '/absolute/path.md', content: '# nope' },
      { path: 'a/../b.md', content: '# nope' },
      { path: '.env', content: 'SECRET=1' },
      { path: 'config/.env.local', content: 'TOKEN=1' },
      { path: 'certs/server.pem', content: '-----BEGIN PRIVATE KEY-----' },
      { path: 'logo.png', content: 'not really png' },
      { path: 'node_modules/pkg/index.js', content: 'module.exports = 1;' },
      { path: '.venv/lib/site.py', content: 'x = 1' },
      { path: 'big.md', content: 'a'.repeat(600) },
      { path: 'notes.md', content: '# Notes\n' },
    ];
    const github = createFakeGitHub({ files, commitSha: COMMIT_1 });
    const { indexer } = createIndexer(github);
    // A tiny size cap makes the "too large" branch reachable without 256 KiB fixtures.
    const limited = new GitHubKnowledgeIndexer({
      github,
      store: new SqliteKnowledgeSnapshotStore(db!),
      limits: { ...DEFAULT_KNOWLEDGE_INDEX_LIMITS, maxFileBytes: 100 },
      now: () => new Date('2026-11-27T10:00:00.000Z'),
      newSnapshotId: () => `snap_${'9'.repeat(32)}`,
    });

    const snapshot = await limited.indexRepository(REPO);

    expect(snapshot.files.map((file) => file.path)).toEqual(['notes.md']);
    const reasons = Object.fromEntries(snapshot.skipped.map((entry) => [entry.path, entry.reason]));
    expect(reasons).toMatchObject({
      '../etc/passwd': 'invalid_path',
      '/absolute/path.md': 'invalid_path',
      'a/../b.md': 'invalid_path',
      '.env': 'secret_file',
      'config/.env.local': 'secret_file',
      'certs/server.pem': 'secret_file',
      'logo.png': 'excluded_file',
      'node_modules/pkg/index.js': 'excluded_directory',
      '.venv/lib/site.py': 'excluded_directory',
      'big.md': 'too_large',
    });
    expect(github.counters.readPaths).toEqual(['notes.md']);
    expect(indexer).toBeDefined();
  });

  it('对二进制内容在下载后才判定：记录 skip，且热扫描不再重复下载', async () => {
    const files: FakeFile[] = [
      { path: 'data/corrupt.md', content: '# \u0000\u0000\u0000 binary' },
      { path: 'notes.md', content: '# Notes\n' },
    ];
    const github = createFakeGitHub({ files, commitSha: COMMIT_1 });
    const { indexer } = createIndexer(github);

    const cold = await indexer.indexRepository(REPO);
    expect(cold.files.map((file) => file.path)).toEqual(['notes.md']);
    expect(Object.keys(cold.sourceDigests)).toEqual(['notes.md']);
    expect(cold.skipped).toEqual([
      expect.objectContaining({ path: 'data/corrupt.md', reason: 'binary' }),
    ]);
    expect(cold.skipped[0]?.blobSha).toMatch(/^[a-f0-9]{40}$/);

    const readsAfterCold = github.counters.fileReads;
    const hot = await indexer.indexRepository(REPO);
    // The binary rejection is content-addressed, so it is reused too.
    expect(hot.stats.fetchedFiles).toBe(0);
    expect(hot.stats.skippedFiles).toBe(1);
    expect(github.counters.fileReads).toBe(readsAfterCold);
  });

  it('下载后才发现的超大文件也会进入 skipped，而不是悄悄消失', async () => {
    // The tree reports a small size, but the decoded file is over the cap.
    const files: FakeFile[] = [
      { path: 'liar.md', content: '# Notes\n\n' + 'x'.repeat(300) },
      { path: 'small.md', content: '# Small\n' },
    ];
    const github = createFakeGitHub({ files, commitSha: COMMIT_1 });
    db = openDatabase(':memory:');
    const limited = new GitHubKnowledgeIndexer({
      github,
      store: new SqliteKnowledgeSnapshotStore(db),
      limits: { ...DEFAULT_KNOWLEDGE_INDEX_LIMITS, maxFileBytes: 100 },
    });

    const snapshot = await limited.indexRepository(REPO);
    expect(snapshot.files.map((file) => file.path)).toEqual(['small.md']);
    expect(snapshot.skipped).toEqual(
      expect.arrayContaining([expect.objectContaining({ path: 'liar.md', reason: 'too_large' })]),
    );
  });
});

describe('增量索引 · 热扫描', () => {
  it('同一提交的热扫描不下载、不解析任何文件', async () => {
    const github = createFakeGitHub({ files: BASE_FILES, commitSha: COMMIT_1 });
    const { indexer } = createIndexer(github);

    const cold = await indexer.indexRepository(REPO);
    const readsAfterCold = github.counters.fileReads;

    const hot = await indexer.indexRepository(REPO);

    expect(hot.stats).toMatchObject({
      mode: 'incremental',
      totalFiles: BASE_FILES.length,
      indexedFiles: 0,
      reusedFiles: BASE_FILES.length,
      removedFiles: 0,
      fetchedFiles: 0,
    });
    expect(github.counters.fileReads).toBe(readsAfterCold);
    expect(hot.parentSnapshotId).toBe(cold.id);
    expect(hot.id).not.toBe(cold.id);
    expect(hot.sourceDigests).toEqual(cold.sourceDigests);
    // Carry-over is structural: file records are byte-identical.
    expect(hot.files).toEqual(cold.files);
    expect(hot.entrypoints).toEqual(cold.entrypoints);
  });

  it('单文件变更时只重新拉取并解析该文件，其余全部复用', async () => {
    const github = createFakeGitHub({ files: BASE_FILES, commitSha: COMMIT_1 });
    const { indexer } = createIndexer(github);
    const cold = await indexer.indexRepository(REPO);
    const readsAfterCold = github.counters.fileReads;

    const changed = BASE_FILES.map((file) =>
      file.path === 'app/models.py'
        ? {
            ...file,
            content: 'class Note:\n\t"""A note."""\n\n\tdef __init__(self, body):\n\t\tself.body = body\n\n\tdef render(self):\n\t\treturn self.body\n',
          }
        : file,
    );
    github.state = { files: changed, commitSha: COMMIT_2 };

    const hot = await indexer.indexRepository(REPO);

    expect(hot.stats).toMatchObject({
      mode: 'incremental',
      totalFiles: BASE_FILES.length,
      indexedFiles: 1,
      reusedFiles: BASE_FILES.length - 1,
      removedFiles: 0,
      fetchedFiles: 1,
    });
    expect(github.counters.readPaths.slice(readsAfterCold)).toEqual(['app/models.py']);
    expect(hot.gitCommitSha).toBe(COMMIT_2);
    expect(hot.sourceDigests['README.md']).toBe(cold.sourceDigests['README.md']);
    expect(hot.sourceDigests['app/models.py']).not.toBe(cold.sourceDigests['app/models.py']);
    expect(hot.files.find((file) => file.path === 'app/models.py')?.symbols).toEqual(
      expect.arrayContaining([{ name: 'render', kind: 'method', line: 7 }]),
    );
  });

  it('删除文件会被清理，并计入 removedFiles', async () => {
    const github = createFakeGitHub({ files: BASE_FILES, commitSha: COMMIT_1 });
    const { indexer } = createIndexer(github);
    await indexer.indexRepository(REPO);

    github.state = {
      files: BASE_FILES.filter((file) => file.path !== 'web/src/App.tsx'),
      commitSha: COMMIT_2,
    };
    const hot = await indexer.indexRepository(REPO);

    expect(hot.stats).toMatchObject({
      totalFiles: BASE_FILES.length - 1,
      indexedFiles: 0,
      reusedFiles: BASE_FILES.length - 1,
      removedFiles: 1,
      fetchedFiles: 0,
    });
    expect(hot.files.some((file) => file.path === 'web/src/App.tsx')).toBe(false);
    expect(hot.sourceDigests['web/src/App.tsx']).toBeUndefined();
  });

  it('新增文件会被单独拉取，并保留父快照对不变文件的复用', async () => {
    const github = createFakeGitHub({ files: BASE_FILES, commitSha: COMMIT_1 });
    const { indexer } = createIndexer(github);
    await indexer.indexRepository(REPO);
    const readsAfterCold = github.counters.fileReads;

    github.state = {
      files: [...BASE_FILES, { path: 'docs/guide.md', content: '# Guide\n\n## Setup\n' }],
      commitSha: COMMIT_2,
    };
    const hot = await indexer.indexRepository(REPO);

    expect(hot.stats).toMatchObject({
      totalFiles: BASE_FILES.length + 1,
      indexedFiles: 1,
      reusedFiles: BASE_FILES.length,
      removedFiles: 0,
      fetchedFiles: 1,
    });
    expect(github.counters.readPaths.slice(readsAfterCold)).toEqual(['docs/guide.md']);
  });

  it('forceCold 忽略父快照并重新下载全部文件，结果不带父快照', async () => {
    const github = createFakeGitHub({ files: BASE_FILES, commitSha: COMMIT_1 });
    const { indexer } = createIndexer(github);
    const cold = await indexer.indexRepository(REPO);
    const readsAfterCold = github.counters.fileReads;

    const forced = await indexer.indexRepository(REPO, { forceCold: true });
    expect(forced.stats).toMatchObject({
      mode: 'cold',
      indexedFiles: BASE_FILES.length,
      reusedFiles: 0,
      fetchedFiles: BASE_FILES.length,
    });
    expect(forced.parentSnapshotId).toBeUndefined();
    expect(forced.sourceDigests).toEqual(cold.sourceDigests);
    expect(github.counters.fileReads).toBe(readsAfterCold + BASE_FILES.length);
  });

  it('父快照在不同分支时不交叉复用', async () => {
    const github = createFakeGitHub({ files: BASE_FILES, commitSha: COMMIT_1 });
    const { indexer, store } = createIndexer(github);
    const mainSnapshot = await indexer.indexRepository(REPO);

    const feature = await indexer.indexRepository(REPO, { branch: 'feature/x' });
    expect(feature.branch).toBe('feature/x');
    expect(feature.parentSnapshotId).toBeUndefined();
    expect(feature.stats.mode).toBe('cold');
    expect(feature.id).not.toBe(mainSnapshot.id);
    expect(store.getLatest('frontLikeDog/livenotes', 'main')?.id).toBe(mainSnapshot.id);
  });
});

describe('快照持久化与查询', () => {
  it('快照不可变：多次扫描追加历史，读取仍返回原快照', async () => {
    const github = createFakeGitHub({ files: BASE_FILES, commitSha: COMMIT_1 });
    const { indexer } = createIndexer(github);
    const first = await indexer.indexRepository(REPO);
    await indexer.indexRepository(REPO, { forceCold: true });

    const stored = await indexer.getSnapshot(REPO, first.id);
    expect(stored).toEqual(first);
    expect(stored?.stats.mode).toBe('cold');

    const listed = await indexer.listSnapshots(REPO);
    expect(listed).toHaveLength(2);
    expect(listed.map((summary) => summary.id)).toEqual(
      expect.arrayContaining([first.id]),
    );
    // Newest first.
    expect(listed[0]?.id).not.toBe(first.id);
    expect(listed[0]?.stats.mode).toBe('cold');

    const latest = await indexer.getLatestSnapshot(REPO);
    expect(latest?.id).toBe(listed[0]?.id);
  });

  it('未知仓库或快照 ID 返回 null，而不是抛错', async () => {
    const github = createFakeGitHub({ files: BASE_FILES, commitSha: COMMIT_1 });
    const { indexer } = createIndexer(github);
    expect(await indexer.getSnapshot({ owner: 'other', repo: 'repo' }, `snap_${'a'.repeat(32)}`)).toBeNull();
    expect(await indexer.getLatestSnapshot(REPO)).toBeNull();
    expect(await indexer.listSnapshots(REPO)).toEqual([]);
  });

  it('存储层拒绝不合法的快照，避免污染后续增量 diff', async () => {
    const github = createFakeGitHub({ files: BASE_FILES, commitSha: COMMIT_1 });
    const { indexer, store } = createIndexer(github);
    const snapshot = await indexer.indexRepository(REPO);

    const corrupt = { ...snapshot, sourceDigests: { 'README.md': 'not-hex' } } as unknown as KnowledgeSnapshotV1;
    expect(() => store.insert(corrupt)).toThrow();
  });
});
