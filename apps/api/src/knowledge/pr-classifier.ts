import { createHash } from 'node:crypto';
import {
  PR_DISCOVERY_SCHEMA_VERSION,
  evaluateClaimPublishability,
  isPromotableClassification,
  prChangeCandidateV1Schema,
  type ClaimCandidateV1,
  type EvidenceRefV1,
  type GitHubPullRequestFile,
  type GitHubPullRequestSummary,
  type GitHubReleaseSummary,
  type KnowledgeSnapshotV1,
  type PRChangeCandidateV1,
  type PRChangeClassification,
  type PRFileCategory,
} from '@asvs/domain';

/**
 * 确定性 PR 变更分类器（Step 4C）。
 *
 * 设计原则与 docs/02 AC-02 一致：**宁可转人工复核，也绝不把内部重构说成
 * 用户可感知功能**。分类只使用 PR 标题的 Conventional 前缀、标签、变更文件
 * 路径分类、重命名状态、4B 快照中的符号/入口点信号，以及 Release 的显式关联；
 * 不调用任何外部模型，因此同一输入必然得到同一结论与同一批 ID。
 */

export interface ClassifyPullRequestInput {
  repo: string;
  pullRequest: GitHubPullRequestSummary;
  files: GitHubPullRequestFile[];
  /**
   * True when the file list hit the read cap and may be incomplete. An
   * incomplete list could hide a UI change or hide that everything is
   * internal, so the classifier must fail closed to human review.
   */
  filesTruncated?: boolean;
  releases: GitHubReleaseSummary[];
  snapshot: KnowledgeSnapshotV1 | null;
  analyzedAt: string;
}

const FEATURE_PREFIXES = new Set(['feat', 'feature']);
const IMPROVEMENT_PREFIXES = new Set(['fix', 'perf']);
const INTERNAL_PREFIXES = new Set([
  'refactor',
  'chore',
  'test',
  'tests',
  'ci',
  'build',
  'style',
  'revert',
  'deps',
]);
const DOCS_PREFIXES = new Set(['docs', 'doc']);

const FEATURE_LABELS = new Set(['feature', 'new feature', 'enhancement', 'feat']);
const IMPROVEMENT_LABELS = new Set(['improvement', 'fix', 'bugfix', 'bug', 'performance', 'perf', 'ux']);
const INTERNAL_LABELS = new Set([
  'refactor',
  'chore',
  'ci',
  'build',
  'dependencies',
  'deps',
  'maintenance',
  'internal',
  'no-release-notes',
  'skip-changelog',
  'test',
  'tests',
]);
const DOCS_LABELS = new Set(['documentation', 'docs']);

const TEST_PATH_PATTERNS: RegExp[] = [
  /(^|\/)(__tests__|__mocks__|tests?|e2e|spec|test-utils|fixtures?)(\/|$)/i,
  /\.(test|spec)\.[cm]?[jt]sx?$/i,
  /(^|\/)(cypress|playwright|vitest)\//i,
  /(^|\/)(playwright|vitest|cypress)\.config\.[cm]?[jt]s$/i,
];

const CI_PATH_PATTERNS: RegExp[] = [
  /^\.github\//i,
  /^\.gitlab-ci/i,
  /(^|\/)\.circleci\//i,
  /(^|\/)jenkinsfile$/i,
  /^azure-pipelines/i,
  /^\.buildkite\//i,
];

const BUILD_PATH_PATTERNS: RegExp[] = [
  /(^|\/)dockerfile/i,
  /(^|\/)docker-compose/i,
  /^makefile$/i,
  /(^|\/)(pnpm-lock\.yaml|package-lock\.json|yarn\.lock|bun\.lockb|npm-shrinkwrap\.json)$/i,
  /(^|\/)nx\.json$/i,
  /(^|\/)bundle-budget\.json$/i,
  /(^|\/)(vite|vitest|eslint|remotion|tailwind|postcss|webpack|rollup|tsup)\.config\.[cm]?[jt]s$/i,
  /^eslint\.config\.[cm]?[jt]s$/i,
  /^\.eslintrc/i,
  /(^|\/)tsconfig[^/]*\.json$/i,
  /^\.npmrc$/i,
  /^\.nvmrc$/i,
];

const CONFIG_PATH_PATTERNS: RegExp[] = [
  /^\.env/i,
  /(^|\/)\.editorconfig$/i,
  /(^|\/)\.prettierrc/i,
  /^\.prettierignore$/i,
  /^\.gitignore$/i,
  /(^|\/)\.vscode\//i,
  /\.(ya?ml|toml|ini)$/i,
  /^\.pnpmfile\.cjs$/i,
];

const DOCS_PATH_PATTERNS: RegExp[] = [
  /^docs\//i,
  /^readme/i,
  /^changelog/i,
  /^contributing/i,
  /^license/i,
  /\.mdx?$/i,
];

const UI_PATH_PATTERNS: RegExp[] = [
  /^apps\/web-studio\//i,
  /^libs\/ui\//i,
  /^libs\/features\//i,
  /^web\//i,
  /^src\/(components|pages|app|features|routes)\//i,
  /\.(tsx|jsx|vue|svelte|css|scss|sass|less|html)$/i,
];

const SOURCE_EXTENSIONS =
  /\.(ts|mts|cts|js|mjs|cjs|py|go|rs|java|kt|kts|rb|php|cs|swift|scala|clj|ex|exs|c|h|cc|cpp|hpp|lua|sh|ps1|sql)$/i;

/**
 * 文件路径 → 分类。顺序即优先级：测试 → CI → 构建 → 配置 → 文档 → 界面 → 源码。
 * 同一路径只归一类，避免一个 `libs/features/x/x.test.ts` 同时被当作 UI。
 */
export function categorizeChangedFile(filePath: string): PRFileCategory {
  const normalized = filePath.replace(/\\/g, '/').replace(/^\.?\//, '');
  if (TEST_PATH_PATTERNS.some((pattern) => pattern.test(normalized))) return 'test';
  if (CI_PATH_PATTERNS.some((pattern) => pattern.test(normalized))) return 'ci';
  if (BUILD_PATH_PATTERNS.some((pattern) => pattern.test(normalized))) return 'build';
  if (CONFIG_PATH_PATTERNS.some((pattern) => pattern.test(normalized))) return 'config';
  if (DOCS_PATH_PATTERNS.some((pattern) => pattern.test(normalized))) return 'docs';
  if (UI_PATH_PATTERNS.some((pattern) => pattern.test(normalized))) return 'ui';
  if (SOURCE_EXTENSIONS.test(normalized)) return 'source';
  return 'other';
}

/** 纯重命名 / 复制：没有增删行，不构成任何能力变化（AC-02）。 */
export function isPureRename(file: GitHubPullRequestFile): boolean {
  return (
    (file.status === 'renamed' || file.status === 'copied') &&
    file.additions === 0 &&
    file.deletions === 0
  );
}

interface ConventionalPrefix {
  type: string | null;
  breaking: boolean;
  rest: string;
}

/** 解析 `feat(scope)!: message`；无法识别时 type 为 null。 */
export function parseConventionalPrefix(title: string): ConventionalPrefix {
  const match = /^\s*([A-Za-z]+)(?:\([^)]*\))?(!)?\s*:\s*(.*)$/s.exec(title);
  if (!match) return { type: null, breaking: false, rest: title.trim() };
  return {
    type: (match[1] ?? '').toLowerCase() || null,
    breaking: Boolean(match[2]),
    rest: (match[3] ?? '').trim() || title.trim(),
  };
}

export interface ReleaseMatch {
  release: GitHubReleaseSummary;
  matchedBy: 'merge_commit' | 'body_reference';
}

/**
 * Release 与 PR 的保守关联：GitHub REST 的 Release 列表不直接给出所包含的
 * PR，因此只接受两种显式证据——`targetCommitish` 恰为合并提交，或 Release
 * 正文显式写出 `#<number>`。其余一律视为「未证实已发布」。
 */
export function matchReleaseToPullRequest(
  pullRequest: GitHubPullRequestSummary,
  releases: GitHubReleaseSummary[],
): ReleaseMatch | undefined {
  if (!pullRequest.merged || !pullRequest.mergeCommitSha) return undefined;

  const published = releases
    .filter((release) => !release.draft && !release.prerelease && release.publishedAt)
    .sort((a, b) => (a.publishedAt ?? '').localeCompare(b.publishedAt ?? ''));

  const mergeCommit = pullRequest.mergeCommitSha.toLowerCase();
  for (const release of published) {
    if (release.targetCommitish.toLowerCase() === mergeCommit) {
      return { release, matchedBy: 'merge_commit' };
    }
  }

  const bodyPattern = new RegExp(`(^|[^0-9A-Za-z_])#${pullRequest.number}(?![0-9])`);
  for (const release of published) {
    if (release.body && bodyPattern.test(release.body)) {
      return { release, matchedBy: 'body_reference' };
    }
  }
  return undefined;
}

function shortHash(seed: string): string {
  return createHash('sha256').update(seed, 'utf8').digest('hex').slice(0, 16);
}

export function candidateIdFor(repo: string, pullNumber: number): string {
  return `prc_${shortHash(`${repo}#${pullNumber}#candidate`)}`;
}

export function claimIdFor(repo: string, pullNumber: number): string {
  return `claim_${shortHash(`${repo}#${pullNumber}#claim`)}`;
}

function evidenceIdFor(repo: string, pullNumber: number, seed: string): string {
  return `evd_${shortHash(`${repo}#${pullNumber}#evidence#${seed}`)}`;
}

function cleanStatement(title: string): string {
  const prefix = parseConventionalPrefix(title);
  const text = (prefix.type ? prefix.rest : title).replace(/\s+/g, ' ').trim();
  const cleaned = text.replace(/[.。;；:：]+$/u, '').trim();
  return (cleaned || title.trim()).slice(0, 300);
}

function summarizeFiles(files: Array<{ filename: string }>): string {
  const counts: Record<PRFileCategory, number> = {
    ui: 0,
    source: 0,
    test: 0,
    ci: 0,
    build: 0,
    config: 0,
    docs: 0,
    other: 0,
  };
  for (const file of files) counts[categorizeChangedFile(file.filename)] += 1;
  return (
    `变更文件：界面 ${counts.ui}、源码 ${counts.source}、测试 ${counts.test}、` +
    `CI ${counts.ci}、构建 ${counts.build}、配置 ${counts.config}、文档 ${counts.docs}`
  );
}

function buildSourceEvidence(
  repo: string,
  pullRequest: GitHubPullRequestSummary,
  files: GitHubPullRequestFile[],
  snapshot: KnowledgeSnapshotV1 | null,
  analyzedAt: string,
): EvidenceRefV1[] {
  const commitSha = pullRequest.mergeCommitSha ?? pullRequest.headSha;
  const capturedAt = pullRequest.mergedAt ?? pullRequest.updatedAt ?? analyzedAt;
  const candidates = files
    .filter((file) => {
      if (isPureRename(file)) return false;
      const category = categorizeChangedFile(file.filename);
      return category === 'ui' || category === 'source' || category === 'docs';
    })
    .sort((a, b) => {
      const rank = (path: string) => (categorizeChangedFile(path) === 'docs' ? 1 : 0);
      return rank(a.filename) - rank(b.filename) || a.filename.localeCompare(b.filename);
    })
    .slice(0, 12);

  return candidates.map((file) => {
    const digest = snapshot?.sourceDigests[file.filename];
    const bound = digest !== undefined;
    return {
      id: evidenceIdFor(repo, pullRequest.number, file.filename),
      kind: 'source',
      status: 'valid',
      title: file.filename.slice(0, 200),
      detail: `PR #${pullRequest.number} ${file.status} 变更（${categorizeChangedFile(
        file.filename,
      )}）${bound ? '，已绑定 4B SHA256 指纹' : '，最新快照中没有该文件的指纹'}`.slice(0, 1000),
      filePath: file.filename,
      ...(digest ? { sourceDigest: digest } : {}),
      commitSha,
      ...(snapshot ? { snapshotId: snapshot.id } : {}),
      capturedAt,
    } satisfies EvidenceRefV1;
  });
}

function buildReleaseEvidence(
  repo: string,
  pullRequest: GitHubPullRequestSummary,
  match: ReleaseMatch,
): EvidenceRefV1 {
  const release = match.release;
  return {
    id: evidenceIdFor(repo, pullRequest.number, `release#${release.tagName}`),
    kind: 'release',
    status: 'valid',
    title: `Release ${release.tagName}`,
    detail:
      match.matchedBy === 'merge_commit'
        ? 'Release targetCommitish 与 PR 合并提交一致'
        : `Release 正文显式提及 #${pullRequest.number}`,
    environmentId: 'release',
    releaseTag: release.tagName,
    capturedAt: release.publishedAt ?? release.createdAt,
  };
}

function collectSnapshotSignals(
  snapshot: KnowledgeSnapshotV1 | null,
  changedPaths: Set<string>,
): string[] {
  if (!snapshot) return [];
  const signals: string[] = [];
  for (const file of snapshot.files) {
    if (!changedPaths.has(file.path)) continue;
    const routes = file.symbols
      .filter((symbol) => symbol.kind === 'route')
      .map((symbol) => symbol.name);
    if (routes.length > 0) {
      signals.push(`4B 快照显示 ${file.path} 含路由符号 ${routes.slice(0, 3).join('、')}`);
    }
    if (file.entrypoints.some((entrypoint) => entrypoint.rank <= 1)) {
      signals.push(`4B 快照将 ${file.path} 标记为项目入口点`);
    }
    if (file.language === 'markdown' && file.headings.length > 0) {
      signals.push(
        `文档章节：${file.headings
          .slice(0, 2)
          .map((heading) => heading.text)
          .join('、')}`,
      );
    }
    if (signals.length >= 5) break;
  }
  return signals.slice(0, 5);
}

interface ClassificationDecision {
  classification: PRChangeClassification;
  confidence: number;
  rationale: string[];
}

function decideClassification(
  pullRequest: GitHubPullRequestSummary,
  files: GitHubPullRequestFile[],
  labels: Set<string>,
  routeSignalCount: number,
  filesTruncated: boolean,
): ClassificationDecision {
  const prefix = parseConventionalPrefix(pullRequest.title);
  const merged = pullRequest.merged && pullRequest.mergedAt !== null;
  const rationale: string[] = [summarizeFiles(files)];

  const userFacingFiles = files.filter((file) => {
    if (isPureRename(file)) return false;
    const category = categorizeChangedFile(file.filename);
    return category === 'ui' || category === 'source';
  });
  const internalFiles = files.filter((file) => {
    if (isPureRename(file)) return false;
    const category = categorizeChangedFile(file.filename);
    return (
      category === 'test' ||
      category === 'ci' ||
      category === 'build' ||
      category === 'config' ||
      category === 'other'
    );
  });
  const docsFiles = files.filter((file) => categorizeChangedFile(file.filename) === 'docs');
  const renamedOnlyFiles = files.filter(isPureRename);
  const renamedOnly = files.length > 0 && renamedOnlyFiles.length === files.length;

  const internal = (confidence: number, extra: string): ClassificationDecision => ({
    classification: 'internal_non_promotable',
    confidence,
    rationale: [...rationale, extra],
  });
  const ambiguous = (extra: string): ClassificationDecision => ({
    classification: 'ambiguous_needs_review',
    confidence: 40,
    rationale: [...rationale, extra, '保守策略：转人工复核，不自动产出 Claim。'],
  });

  if (files.length === 0) {
    return ambiguous('GitHub 未返回任何变更文件，无法判断是否用户可感知。');
  }
  if (filesTruncated) {
    return ambiguous('变更文件数量达到读取上限，可能仍有未读取的改动，无法确认全部性质。');
  }
  if (pullRequest.draft) {
    return ambiguous('PR 仍是草稿，内容可能变化，不能进入发布核验。');
  }
  if (!merged) {
    return ambiguous('PR 尚未合并，无法绑定合并提交与发布证据。');
  }
  if (renamedOnly) {
    rationale.push(`全部 ${renamedOnlyFiles.length} 个变更文件仅重命名/移动，未新增能力`);
    return internal(85, '纯重命名/移动不构成用户可感知变化（AC-02）。');
  }
  if (userFacingFiles.length === 0) {
    if (docsFiles.length > 0) {
      return ambiguous('仅文档变更：可能是用户可感知的说明更新，也可能只是内部注释。');
    }
    rationale.push(`没有界面或产品源码变更（内部文件 ${internalFiles.length} 个）`);
    const prefixNote =
      prefix.type && FEATURE_PREFIXES.has(prefix.type)
        ? `标题声明 ${prefix.type}，但变更仅涉及测试/CI/构建/配置，不构成用户可感知变化`
        : '变更仅涉及测试/CI/构建/配置，不构成用户可感知变化';
    return internal(85, prefixNote);
  }

  rationale.push(
    `包含 ${userFacingFiles.length} 个界面/产品源码变更（界面 ${userFacingFiles.filter(
      (file) => categorizeChangedFile(file.filename) === 'ui',
    ).length}、源码 ${
      userFacingFiles.length -
      userFacingFiles.filter((file) => categorizeChangedFile(file.filename) === 'ui').length
    }）`,
  );

  if (prefix.type && INTERNAL_PREFIXES.has(prefix.type)) {
    return internal(
      80,
      `Conventional 前缀 ${prefix.type} 表明这是内部重构/维护，不能宣称新功能（AC-02）。`,
    );
  }
  if (prefix.type && DOCS_PREFIXES.has(prefix.type)) {
    return ambiguous(`Conventional 前缀 ${prefix.type} 与产品代码变更冲突，需人工确认。`);
  }

  const featureLabel = [...labels].some((label) => FEATURE_LABELS.has(label));
  const improvementLabel = [...labels].some((label) => IMPROVEMENT_LABELS.has(label));
  const internalLabel = [...labels].some((label) => INTERNAL_LABELS.has(label));
  const docsLabel = [...labels].some((label) => DOCS_LABELS.has(label));

  if (internalLabel && !featureLabel && !improvementLabel && !docsLabel) {
    return internal(75, 'PR 标签表明这是内部变更，不进入用户可感知候选。');
  }
  if (internalLabel && (featureLabel || improvementLabel)) {
    return ambiguous('PR 同时带有内部与用户可感知标签，信号冲突，需人工裁决。');
  }

  const featurePrefix = prefix.type !== null && FEATURE_PREFIXES.has(prefix.type);
  const improvementPrefix = prefix.type !== null && IMPROVEMENT_PREFIXES.has(prefix.type);

  if (featurePrefix && improvementLabel) {
    return ambiguous('feat 前缀与修复/改进标签冲突，需人工确认变更性质。');
  }
  if (improvementPrefix && featureLabel) {
    return ambiguous('修复/性能前缀与功能标签冲突，需人工确认变更性质。');
  }

  if (featurePrefix || featureLabel) {
    const signals: string[] = [];
    if (featurePrefix) signals.push(`Conventional 前缀 ${prefix.type}`);
    if (featureLabel) signals.push(`PR 标签 ${[...labels].find((label) => FEATURE_LABELS.has(label))}`);
    if (routeSignalCount > 0) signals.push(`4B 快照路由信号 ${routeSignalCount} 处`);
    if (prefix.breaking) signals.push('标记为 breaking change');
    let confidence = 70 + (featurePrefix ? 10 : 0) + (featureLabel ? 5 : 0);
    confidence += routeSignalCount > 0 ? 5 : 0;
    confidence += prefix.breaking ? 5 : 0;
    return {
      classification: 'user_facing_feature',
      confidence: Math.min(95, confidence),
      rationale: [...rationale, `${signals.join('、')} 表明这是用户可感知的新功能。`],
    };
  }

  if (improvementPrefix || improvementLabel) {
    const signals: string[] = [];
    if (improvementPrefix) signals.push(`Conventional 前缀 ${prefix.type}`);
    if (improvementLabel) {
      signals.push(`PR 标签 ${[...labels].find((label) => IMPROVEMENT_LABELS.has(label))}`);
    }
    const confidence =
      65 + (improvementPrefix ? 10 : 0) + (improvementLabel ? 5 : 0) + (userFacingFiles.length > 0 ? 5 : 0);
    return {
      classification: 'user_facing_improvement',
      confidence: Math.min(95, confidence),
      rationale: [...rationale, `${signals.join('、')} 表明这是用户可感知的改进。`],
    };
  }

  return ambiguous(
    '缺少 Conventional 前缀或功能/改进标签：无法区分新功能与内部调整，按保守策略转人工复核。',
  );
}

/**
 * 单个 PR → 候选。返回值经过 Zod 全量校验，任何违反「内部变更不得带 Claim」
 * 等不变量的状态都会直接抛错，而不是悄悄写库。
 */
export function classifyPullRequest(input: ClassifyPullRequestInput): PRChangeCandidateV1 {
  const { repo, pullRequest, files, releases, snapshot, analyzedAt } = input;
  const labels = new Set(pullRequest.labels.map((label) => label.trim().toLowerCase()));
  const changedPaths = new Set(files.map((file) => file.filename));
  const snapshotSignals = collectSnapshotSignals(snapshot, changedPaths);
  const routeSignalCount = snapshotSignals.filter((signal) => signal.includes('路由符号')).length;

  const decision = decideClassification(
    pullRequest,
    files,
    labels,
    routeSignalCount,
    input.filesTruncated === true,
  );
  const promotable = isPromotableClassification(decision.classification);
  const releaseMatch = matchReleaseToPullRequest(pullRequest, releases);
  const commitSha = pullRequest.mergeCommitSha ?? pullRequest.headSha;

  const evidence: EvidenceRefV1[] = buildSourceEvidence(
    repo,
    pullRequest,
    files,
    snapshot,
    analyzedAt,
  );
  if (releaseMatch) evidence.push(buildReleaseEvidence(repo, pullRequest, releaseMatch));

  const claims: ClaimCandidateV1[] = [];
  if (promotable && evidence.length > 0) {
    const evaluation = evaluateClaimPublishability({
      classification: decision.classification,
      evidence,
      commitSha,
      ...(snapshot ? { snapshotId: snapshot.id } : {}),
      evaluatedAt: analyzedAt,
    });
    claims.push({
      schemaVersion: PR_DISCOVERY_SCHEMA_VERSION,
      id: claimIdFor(repo, pullRequest.number),
      candidateId: candidateIdFor(repo, pullRequest.number),
      repo,
      pullNumber: pullRequest.number,
      statement: cleanStatement(pullRequest.title),
      audience:
        decision.classification === 'user_facing_feature' ? '产品用户与潜在用户' : '现有用户',
      status: evaluation.status,
      eligibility: evaluation.eligibility,
      verification: evaluation.verification,
      evidenceIds: evidence.map((item) => item.id),
      blockers: evaluation.blockers,
      guidance: evaluation.guidance,
    });
  }

  const changedFiles = files.slice(0, 200).map((file) => ({
    path: file.filename,
    status: file.status,
    additions: file.additions,
    deletions: file.deletions,
    ...(file.previousFilename ? { previousPath: file.previousFilename } : {}),
    category: categorizeChangedFile(file.filename),
  }));

  const additions = files.reduce((sum, file) => sum + file.additions, 0);
  const deletions = files.reduce((sum, file) => sum + file.deletions, 0);
  const renamedOnlyFiles = files.filter(isPureRename).length;
  const userFacingFiles = files.filter(
    (file) =>
      !isPureRename(file) && ['ui', 'source'].includes(categorizeChangedFile(file.filename)),
  ).length;
  const internalFiles = files.filter(
    (file) =>
      !isPureRename(file) &&
      ['test', 'ci', 'build', 'config', 'other'].includes(categorizeChangedFile(file.filename)),
  ).length;

  return prChangeCandidateV1Schema.parse({
    schemaVersion: PR_DISCOVERY_SCHEMA_VERSION,
    id: candidateIdFor(repo, pullRequest.number),
    repo,
    pullNumber: pullRequest.number,
    title: pullRequest.title.slice(0, 400),
    author: pullRequest.author.slice(0, 120),
    state: pullRequest.state,
    draft: pullRequest.draft,
    merged: pullRequest.merged && pullRequest.mergedAt !== null,
    mergedAt: pullRequest.mergedAt,
    baseBranch: pullRequest.baseBranch,
    headBranch: pullRequest.headBranch,
    headSha: pullRequest.headSha,
    mergeCommitSha: pullRequest.mergeCommitSha,
    htmlUrl: pullRequest.htmlUrl,
    labels: pullRequest.labels.slice(0, 50).map((label) => label.slice(0, 120)),
    classification: decision.classification,
    promotable,
    confidence: decision.confidence,
    rationale: [...decision.rationale, ...snapshotSignals]
      .slice(0, 20)
      .map((entry) => entry.slice(0, 400)),
    ...(snapshot ? { snapshotId: snapshot.id } : {}),
    changedFiles,
    diffStats: {
      filesChanged: files.length,
      additions,
      deletions,
      userFacingFiles,
      internalFiles,
      renamedOnlyFiles,
    },
    ...(releaseMatch
      ? {
          release: {
            tagName: releaseMatch.release.tagName,
            name:
              releaseMatch.release.name === null
                ? null
                : releaseMatch.release.name.slice(0, 200),
            publishedAt: releaseMatch.release.publishedAt ?? releaseMatch.release.createdAt,
            matchedBy: releaseMatch.matchedBy,
            htmlUrl: releaseMatch.release.htmlUrl,
          },
        }
      : {}),
    claims,
    evidence,
    analyzedAt,
  });
}
