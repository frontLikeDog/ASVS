// @vitest-environment node
import { describe, expect, it } from 'vitest';
import type {
  GitHubPullRequestFile,
  GitHubPullRequestSummary,
  GitHubReleaseSummary,
  KnowledgeSnapshotV1,
} from '@asvs/domain';
import {
  categorizeChangedFile,
  classifyPullRequest,
  isPureRename,
  matchReleaseToPullRequest,
} from './pr-classifier';

const REPO = 'frontLikeDog/livenotes';
const HEAD_SHA = '1'.repeat(40);
const MERGE_SHA = '2'.repeat(40);
const ANALYZED_AT = '2026-11-27T10:00:00.000Z';
const SNAPSHOT_ID = `snap_${'a'.repeat(32)}`;

function buildPr(overrides: Partial<GitHubPullRequestSummary> = {}): GitHubPullRequestSummary {
  return {
    id: 1200,
    number: 12,
    title: 'feat: 支持笔记增量同步',
    body: null,
    state: 'closed',
    draft: false,
    merged: true,
    mergedAt: '2026-11-26T08:00:00.000Z',
    createdAt: '2026-11-24T08:00:00.000Z',
    updatedAt: '2026-11-26T08:00:00.000Z',
    author: 'frontLikeDog',
    labels: [],
    headSha: HEAD_SHA,
    baseBranch: 'main',
    headBranch: 'feat/sync',
    mergeCommitSha: MERGE_SHA,
    htmlUrl: 'https://github.com/frontLikeDog/livenotes/pull/12',
    ...overrides,
  };
}

function file(
  filename: string,
  overrides: Partial<GitHubPullRequestFile> = {},
): GitHubPullRequestFile {
  return {
    filename,
    status: 'modified',
    additions: 10,
    deletions: 2,
    changes: 12,
    ...overrides,
  };
}

function buildSnapshot(
  entries: Array<{
    path: string;
    symbols?: KnowledgeSnapshotV1['files'][number]['symbols'];
    headings?: KnowledgeSnapshotV1['files'][number]['headings'];
    entrypoints?: KnowledgeSnapshotV1['files'][number]['entrypoints'];
  }> = [],
): KnowledgeSnapshotV1 {
  return {
    schemaVersion: '1',
    id: SNAPSHOT_ID,
    repo: REPO,
    branch: 'main',
    gitCommitSha: MERGE_SHA,
    indexedAt: ANALYZED_AT,
    sourceDigests: Object.fromEntries(
      entries.map((entry, index) => [entry.path, `${index + 1}`.repeat(64)]),
    ),
    files: entries.map((entry) => ({
      path: entry.path,
      language: entry.path.endsWith('.md') ? 'markdown' : 'typescript',
      byteSize: 100,
      lineCount: 10,
      blobSha: '3'.repeat(40),
      headings: entry.headings ?? [],
      symbols: entry.symbols ?? [],
      entrypoints: entry.entrypoints ?? [],
    })),
    skipped: [],
    entrypoints: [],
    stats: {
      mode: 'cold',
      totalFiles: entries.length,
      indexedFiles: entries.length,
      reusedFiles: 0,
      removedFiles: 0,
      skippedFiles: 0,
      fetchedFiles: entries.length,
      durationMs: 5,
    },
  };
}

function release(overrides: Partial<GitHubReleaseSummary> = {}): GitHubReleaseSummary {
  return {
    id: 900,
    tagName: 'v1.4.0',
    name: 'v1.4.0',
    body: null,
    draft: false,
    prerelease: false,
    createdAt: '2026-11-27T08:00:00.000Z',
    publishedAt: '2026-11-27T08:30:00.000Z',
    targetCommitish: 'main',
    htmlUrl: 'https://github.com/frontLikeDog/livenotes/releases/tag/v1.4.0',
    ...overrides,
  };
}

describe('变更文件分类', () => {
  it('按优先级区分测试 / CI / 构建 / 配置 / 文档 / 界面 / 源码', () => {
    expect(categorizeChangedFile('libs/features/notes/src/App.test.tsx')).toBe('test');
    expect(categorizeChangedFile('apps/api/src/knowledge/indexer.test.ts')).toBe('test');
    expect(categorizeChangedFile('workers/browser-worker/plans/demo.yaml')).toBe('config');
    expect(categorizeChangedFile('.github/workflows/ci.yml')).toBe('ci');
    expect(categorizeChangedFile('pnpm-lock.yaml')).toBe('build');
    expect(categorizeChangedFile('vite.config.ts')).toBe('build');
    expect(categorizeChangedFile('.env.local')).toBe('config');
    expect(categorizeChangedFile('README.md')).toBe('docs');
    expect(categorizeChangedFile('docs/02-PRODUCT-REQUIREMENTS-PRD.md')).toBe('docs');
    expect(categorizeChangedFile('libs/ui/src/button.tsx')).toBe('ui');
    expect(categorizeChangedFile('apps/web-studio/src/routes/home.tsx')).toBe('ui');
    expect(categorizeChangedFile('apps/api/src/routes/github.ts')).toBe('source');
    expect(categorizeChangedFile('assets/logo.svg')).toBe('other');
  });

  it('纯重命名需要同时满足状态与零增删', () => {
    expect(isPureRename(file('libs/ui/src/a.tsx', { status: 'renamed', additions: 0, deletions: 0 }))).toBe(true);
    expect(isPureRename(file('libs/ui/src/a.tsx', { status: 'renamed', additions: 4, deletions: 1 }))).toBe(false);
    expect(isPureRename(file('libs/ui/src/a.tsx', { status: 'modified', additions: 0, deletions: 0 }))).toBe(false);
  });
});

describe('AC-02：内部变更绝不产出新功能候选', () => {
  it('refactor 前缀即使改动 UI 文件也判为内部变更', () => {
    const candidate = classifyPullRequest({
      repo: REPO,
      pullRequest: buildPr({ title: 'refactor(notes): extract editor component' }),
      files: [
        file('libs/features/notes/src/editor.tsx'),
        file('libs/features/notes/src/editor-old.tsx', { status: 'removed', additions: 0, deletions: 80 }),
        file('libs/features/notes/src/editor.test.tsx'),
      ],
      releases: [],
      snapshot: null,
      analyzedAt: ANALYZED_AT,
    });

    expect(candidate.classification).toBe('internal_non_promotable');
    expect(candidate.promotable).toBe(false);
    expect(candidate.claims).toEqual([]);
    expect(candidate.rationale.join(' ')).toContain('refactor');
  });

  it('纯重命名 PR 判为内部变更，不误判为 UI 改版', () => {
    const candidate = classifyPullRequest({
      repo: REPO,
      pullRequest: buildPr({ title: 'move note editor files' }),
      files: [
        file('libs/features/notes/src/editor/index.tsx', {
          status: 'renamed',
          previousFilename: 'libs/features/notes/src/editor.tsx',
          additions: 0,
          deletions: 0,
        }),
        file('libs/ui/src/buttons/primary.tsx', {
          status: 'renamed',
          previousFilename: 'libs/ui/src/primary-button.tsx',
          additions: 0,
          deletions: 0,
        }),
      ],
      releases: [],
      snapshot: null,
      analyzedAt: ANALYZED_AT,
    });

    expect(candidate.classification).toBe('internal_non_promotable');
    expect(candidate.promotable).toBe(false);
    expect(candidate.claims).toEqual([]);
    expect(candidate.diffStats.renamedOnlyFiles).toBe(2);
    expect(candidate.rationale.join(' ')).toContain('重命名');
  });

  it('feat 标题但只改测试：不构成用户可感知变化', () => {
    const candidate = classifyPullRequest({
      repo: REPO,
      pullRequest: buildPr({ title: 'feat: add tests for note sync' }),
      files: [file('apps/api/src/knowledge/indexer.test.ts'), file('.github/workflows/ci.yml')],
      releases: [],
      snapshot: null,
      analyzedAt: ANALYZED_AT,
    });

    expect(candidate.classification).toBe('internal_non_promotable');
    expect(candidate.claims).toEqual([]);
    expect(candidate.rationale.join(' ')).toContain('测试/CI/构建/配置');
  });

  it('内部标签压过自由标题', () => {
    const candidate = classifyPullRequest({
      repo: REPO,
      pullRequest: buildPr({ title: 'improve note syncing', labels: ['chore'] }),
      files: [file('libs/features/notes/src/sync.ts')],
      releases: [],
      snapshot: null,
      analyzedAt: ANALYZED_AT,
    });

    expect(candidate.classification).toBe('internal_non_promotable');
    expect(candidate.claims).toEqual([]);
  });

  it('仅修改其他资源文件（other）时 rationale 与 diffStats.internalFiles 口径一致', () => {
    const candidate = classifyPullRequest({
      repo: REPO,
      pullRequest: buildPr({ title: 'chore: update package manifest' }),
      files: [file('package.json')],
      releases: [],
      snapshot: null,
      analyzedAt: ANALYZED_AT,
    });

    expect(candidate.classification).toBe('internal_non_promotable');
    expect(candidate.diffStats.internalFiles).toBe(1);
    expect(candidate.rationale.join(' ')).toContain('内部文件 1 个');
  });
});

describe('用户可感知候选', () => {
  it('feat + 界面文件 + 快照路由信号：生成 1 条待验证 Claim', () => {
    const snapshot = buildSnapshot([
      {
        path: 'libs/features/notes/src/sync-panel.tsx',
        symbols: [{ name: 'SyncPanel', kind: 'component', line: 1 }],
        entrypoints: [{ path: 'libs/features/notes/src/sync-panel.tsx', kind: 'component', rank: 1 }],
      },
      {
        path: 'apps/api/src/routes/notes.ts',
        symbols: [{ name: 'listNotes', kind: 'route', line: 5 }],
      },
    ]);

    const candidate = classifyPullRequest({
      repo: REPO,
      pullRequest: buildPr({ title: 'feat(notes)!: 支持增量同步' }),
      files: [
        file('libs/features/notes/src/sync-panel.tsx'),
        file('apps/api/src/routes/notes.ts'),
        file('apps/api/src/routes/notes.test.ts'),
      ],
      releases: [],
      snapshot,
      analyzedAt: ANALYZED_AT,
    });

    expect(candidate.classification).toBe('user_facing_feature');
    expect(candidate.promotable).toBe(true);
    expect(candidate.claims).toHaveLength(1);
    const claim = candidate.claims[0]!;
    expect(claim.statement).toBe('支持增量同步');
    expect(claim.eligibility).toBe('blocked_unverified');
    expect(claim.verification.deployed).toBe(false);
    expect(claim.verification.snapshotId).toBe(SNAPSHOT_ID);
    expect(claim.verification.validityScope).toBe('unverified');
    expect(claim.blockers.join(' ')).toContain('禁止声称「已上线」');

    const boundEvidence = candidate.evidence.filter((item) => item.kind === 'source');
    expect(boundEvidence.length).toBeGreaterThan(0);
    expect(boundEvidence[0]?.sourceDigest).toMatch(/^[0-9a-f]{64}$/);
    expect(boundEvidence[0]?.snapshotId).toBe(SNAPSHOT_ID);
    expect(candidate.rationale.join(' ')).toContain('路由符号');
  });

  it('fix 前缀 + 产品源码：判为改进而不是新功能', () => {
    const candidate = classifyPullRequest({
      repo: REPO,
      pullRequest: buildPr({ title: 'fix: 修复同步丢失问题' }),
      files: [file('apps/api/src/knowledge/indexer.ts')],
      releases: [],
      snapshot: null,
      analyzedAt: ANALYZED_AT,
    });

    expect(candidate.classification).toBe('user_facing_improvement');
    expect(candidate.claims).toHaveLength(1);
    expect(candidate.claims[0]?.audience).toBe('现有用户');
  });

  it('缺少前缀与标签的自由标题：转人工复核，不产出 Claim', () => {
    const candidate = classifyPullRequest({
      repo: REPO,
      pullRequest: buildPr({ title: 'Note sync improvements' }),
      files: [file('libs/features/notes/src/sync.tsx')],
      releases: [],
      snapshot: null,
      analyzedAt: ANALYZED_AT,
    });

    expect(candidate.classification).toBe('ambiguous_needs_review');
    expect(candidate.promotable).toBe(false);
    expect(candidate.claims).toEqual([]);
  });

  it('仅文档变更：转人工复核', () => {
    const candidate = classifyPullRequest({
      repo: REPO,
      pullRequest: buildPr({ title: 'docs: rewrite README' }),
      files: [file('README.md'), file('docs/03-ARCHITECTURE.md')],
      releases: [],
      snapshot: null,
      analyzedAt: ANALYZED_AT,
    });

    expect(candidate.classification).toBe('ambiguous_needs_review');
    expect(candidate.claims).toEqual([]);
  });

  it('变更文件达到读取上限时 fail closed，转人工复核', () => {
    const files = Array.from({ length: 100 }, (_, index) =>
      file(`libs/features/notes/src/feature-${index}.tsx`),
    );
    const candidate = classifyPullRequest({
      repo: REPO,
      pullRequest: buildPr(),
      files,
      filesTruncated: true,
      releases: [],
      snapshot: null,
      analyzedAt: ANALYZED_AT,
    });

    expect(candidate.classification).toBe('ambiguous_needs_review');
    expect(candidate.promotable).toBe(false);
    expect(candidate.claims).toEqual([]);
    expect(candidate.rationale.join(' ')).toContain('读取上限');
  });

  it('未合并或草稿 PR 不进入发布核验', () => {
    const draft = classifyPullRequest({
      repo: REPO,
      pullRequest: buildPr({ draft: true }),
      files: [file('libs/features/notes/src/sync-panel.tsx')],
      releases: [],
      snapshot: null,
      analyzedAt: ANALYZED_AT,
    });
    expect(draft.classification).toBe('ambiguous_needs_review');
    expect(draft.claims).toEqual([]);

    const open = classifyPullRequest({
      repo: REPO,
      pullRequest: buildPr({ state: 'open', merged: false, mergedAt: null, mergeCommitSha: null }),
      files: [file('libs/features/notes/src/sync-panel.tsx')],
      releases: [],
      snapshot: null,
      analyzedAt: ANALYZED_AT,
    });
    expect(open.classification).toBe('ambiguous_needs_review');
    expect(open.claims).toEqual([]);
  });

  it('同一输入重复分类得到完全一致的 ID 与内容', () => {
    const input = {
      repo: REPO,
      pullRequest: buildPr({ labels: ['feature'] }),
      files: [file('libs/features/notes/src/sync-panel.tsx')],
      releases: [],
      snapshot: buildSnapshot([{ path: 'libs/features/notes/src/sync-panel.tsx' }]),
      analyzedAt: ANALYZED_AT,
    };
    expect(classifyPullRequest(input)).toEqual(classifyPullRequest(input));
  });
});

describe('Release 保守关联', () => {
  it('正文显式提及 #PR：绑定 Release 证据，deployed=true 但仍需运行态', () => {
    const candidate = classifyPullRequest({
      repo: REPO,
      pullRequest: buildPr(),
      files: [file('libs/features/notes/src/sync-panel.tsx')],
      releases: [release({ body: 'Highlights:\n- 支持增量同步 (#12)' })],
      snapshot: null,
      analyzedAt: ANALYZED_AT,
    });

    expect(candidate.release).toMatchObject({ tagName: 'v1.4.0', matchedBy: 'body_reference' });
    const releaseEvidence = candidate.evidence.find((item) => item.kind === 'release');
    expect(releaseEvidence).toMatchObject({ status: 'valid', releaseTag: 'v1.4.0' });
    const claim = candidate.claims[0]!;
    expect(claim.verification.deployed).toBe(true);
    expect(claim.verification.releaseTag).toBe('v1.4.0');
    expect(claim.eligibility).toBe('needs_qualification');
    expect(claim.blockers.join(' ')).toContain('没有真实环境运行态证据');
  });

  it('targetCommitish 恰为合并提交时绑定 Release', () => {
    const match = matchReleaseToPullRequest(buildPr(), [release({ targetCommitish: MERGE_SHA })]);
    expect(match?.matchedBy).toBe('merge_commit');
  });

  it('草稿 / 预发布 Release 与无关 Release 一律不匹配', () => {
    expect(
      matchReleaseToPullRequest(buildPr(), [release({ targetCommitish: MERGE_SHA, draft: true })]),
    ).toBeUndefined();
    expect(
      matchReleaseToPullRequest(buildPr(), [
        release({ targetCommitish: MERGE_SHA, prerelease: true }),
      ]),
    ).toBeUndefined();
    expect(matchReleaseToPullRequest(buildPr(), [release({ body: 'unrelated #120' })])).toBeUndefined();
    expect(matchReleaseToPullRequest(buildPr(), [release({ targetCommitish: 'main' })])).toBeUndefined();
  });
});
