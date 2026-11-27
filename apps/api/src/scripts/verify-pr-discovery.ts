import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { formatGitHubRepoRef, parseGitHubRepoRef } from '@asvs/domain';
import type { PRChangeCandidateV1 } from '@asvs/domain';
import { createGitHubPortFromConfig, loadConfig } from '../config';
import { openDatabase } from '../db/database';
import { SqliteKnowledgeSnapshotStore } from '../db/knowledge-store';
import { SqlitePRDiscoveryStore } from '../db/pr-discovery-store';
import { loadApiLocalEnv } from '../env';
import { GitHubKnowledgeIndexer } from '../knowledge/indexer';
import { PRDiscoveryService } from '../knowledge/pr-discovery-service';

/**
 * Step 4C acceptance against a real, authorized repository.
 *
 * 1. Incrementally indexes the branch (unless `--no-index`) so every claim can
 *    bind SHA256 source digests from a 4B snapshot.
 * 2. Discovers PRs, classifies them and prints the real result — including the
 *    forms the sample does NOT contain.
 * 3. Runs AC-09 staleness propagation and verifies AC-02 / AC-03 invariants.
 *
 * Usage: pnpm discovery:verify [--repo owner/name] [--branch main] [--limit 15]
 *                              [--no-index]
 */

const apiDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

function argValue(argv: string[], flag: string): string | undefined {
  const index = argv.indexOf(flag);
  if (index >= 0 && argv[index + 1]) return argv[index + 1];
  return undefined;
}

function hasFlag(argv: string[], flag: string): boolean {
  return argv.includes(flag);
}

function printCandidate(candidate: PRChangeCandidateV1): void {
  const status = candidate.merged ? 'merged' : candidate.state;
  console.log(
    `  #${String(candidate.pullNumber).padEnd(4)} [${status}] ${candidate.classification.padEnd(
      24,
    )} confidence=${String(candidate.confidence).padStart(3)}  ${candidate.title.slice(0, 60)}`,
  );
  console.log(`        理由: ${candidate.rationale.slice(0, 3).join('；')}`);
  if (candidate.release) {
    console.log(
      `        Release: ${candidate.release.tagName}（${candidate.release.matchedBy}，${candidate.release.publishedAt}）`,
    );
  }
  for (const claim of candidate.claims) {
    console.log(
      `        Claim ${claim.id}: 「${claim.statement}」 → ${claim.eligibility} / ${claim.status}`,
    );
    console.log(`          核验: deployed=${claim.verification.deployed} env=${claim.verification.environmentId} scope=${claim.verification.validityScope}`);
    if (claim.blockers.length > 0) {
      console.log(`          阻断: ${claim.blockers.join('；')}`);
    }
  }
  if (!candidate.promotable) {
    console.log('        可推广: 否（不产出新功能/改进候选）');
  }
}

async function main(): Promise<void> {
  loadApiLocalEnv(apiDir);
  const config = loadConfig();
  const github = createGitHubPortFromConfig(config.github);
  const argv = process.argv.slice(2);

  const repoArg = argValue(argv, '--repo');
  const targetRepo = repoArg ? parseGitHubRepoRef(repoArg) : github.getDefaultRepo();
  if (!targetRepo) {
    console.error('请通过 --repo owner/repo 或 GITHUB_DEFAULT_REPO 指定目标仓库。');
    process.exitCode = 1;
    return;
  }
  if (!github.isConfigured()) {
    console.error(
      '✗ 未配置 GitHub App 只读凭证（GITHUB_APP_ID / GITHUB_APP_INSTALLATION_ID / GITHUB_APP_PRIVATE_KEY_PATH）。本脚本不会伪造结果。',
    );
    process.exitCode = 1;
    return;
  }

  const fullRepo = formatGitHubRepoRef(targetRepo);
  const branch = argValue(argv, '--branch');
  const limitArg = argValue(argv, '--limit');
  const limit = limitArg ? Number.parseInt(limitArg, 10) : 15;
  const skipIndex = hasFlag(argv, '--no-index');

  console.log(`\nASVS Step 4C · PR 变更发现与发布守门验收 (${fullRepo}${branch ? ` @ ${branch}` : ''})`);
  console.log('='.repeat(76));

  const db = openDatabase(config.dbPath);
  console.log(`SQLite: ${config.dbPath}`);
  const knowledgeStore = new SqliteKnowledgeSnapshotStore(db);
  const discoveryStore = new SqlitePRDiscoveryStore(db);
  const indexer = new GitHubKnowledgeIndexer({ github, store: knowledgeStore });
  const discovery = new PRDiscoveryService({ github, knowledgeStore, store: discoveryStore });

  try {
    if (!skipIndex) {
      console.log('\n1 · 增量知识索引（为 Claim 绑定 sourceDigests）');
      console.log('─'.repeat(76));
      const snapshot = await indexer.indexRepository(targetRepo, { branch });
      console.log(
        `  快照 ${snapshot.id} @ ${snapshot.gitCommitSha.slice(0, 12)} (${snapshot.branch}) · ` +
          `mode=${snapshot.stats.mode} total=${snapshot.stats.totalFiles} fetched=${snapshot.stats.fetchedFiles} reused=${snapshot.stats.reusedFiles}`,
      );
    } else {
      console.log('\n1 · 跳过索引（--no-index），使用数据库中的最新快照');
    }

    console.log('\n2 · PR 发现与确定性分类');
    console.log('─'.repeat(76));
    const report = await discovery.analyzePullRequests(targetRepo, { branch, limit });
    console.log(
      `  分析 ${report.summary.analyzed} 个 PR · 新功能 ${report.summary.userFacingFeature} · 改进 ${report.summary.userFacingImprovement} · 内部 ${report.summary.internal} · 待复核 ${report.summary.ambiguous}`,
    );
    console.log(
      `  Claim ${report.summary.claims} 条 · 待验证 ${report.summary.claimsBlockedUnverified} · 过期 ${report.summary.claimsBlockedStale} · 可发布 ${report.summary.claimsPublishable}`,
    );
    if (report.snapshotId) console.log(`  绑定快照: ${report.snapshotId}`);
    if (report.errors.length > 0) {
      console.log(`  部分 PR 分析失败（${report.errors.length}）:`);
      for (const error of report.errors) {
        console.log(`    #${error.pullNumber}: ${error.message}`);
      }
    }
    for (const candidate of report.candidates) {
      printCandidate(candidate);
    }

    console.log('\n3 · AC-09 过期传播（对比最新快照指纹）');
    console.log('─'.repeat(76));
    const staleness = await discovery.refreshStaleness(targetRepo, { branch });
    console.log(
      `  快照 ${staleness.snapshotId} @ ${staleness.gitCommitSha.slice(0, 12)} · ` +
        `扫描候选 ${staleness.candidatesScanned} · 变更 ${staleness.candidatesChanged} · ` +
        `证据过期 ${staleness.evidenceMarkedStale} · Claim 过期 ${staleness.claimsMarkedStale.length}`,
    );
    if (staleness.staleFiles.length > 0) {
      console.log(`  过期文件: ${staleness.staleFiles.join(', ')}`);
    }

    console.log('\n验收断言');
    console.log('─'.repeat(76));
    const failures: string[] = [];
    const assert = (condition: boolean, message: string): void => {
      console.log(`  ${condition ? '✓' : '✗'} ${message}`);
      if (!condition) failures.push(message);
    };

    const nonPromotable = report.candidates.filter((candidate) => !candidate.promotable);
    assert(
      nonPromotable.every((candidate) => candidate.claims.length === 0),
      `AC-02：${nonPromotable.length} 个内部/待复核候选均无 Claim`,
    );
    assert(
      report.candidates.every(
        (candidate) =>
          candidate.promotable ===
          (candidate.classification === 'user_facing_feature' ||
            candidate.classification === 'user_facing_improvement'),
      ),
      'AC-02：promotable 与分类完全一致',
    );

    const claims = report.candidates.flatMap((candidate) => candidate.claims);
    const undeployedClaims = claims.filter((claim) => claim.verification.deployed === false);
    assert(
      undeployedClaims.every(
        (claim) =>
          claim.eligibility === 'blocked_unverified' ||
            claim.eligibility === 'blocked_stale' ||
            claim.eligibility === 'blocked_rejected',
      ),
      `AC-03：${undeployedClaims.length} 条未部署 Claim 全部被阻断（无「已上线」）`,
    );
    assert(
      claims
        .filter(
          (claim) =>
            claim.eligibility === 'needs_qualification' || claim.eligibility === 'publishable',
        )
        .every((claim) => claim.verification.deployed),
      'AC-03：任何可发布/需限定 Claim 都有真实发布或运行态证据',
    );
    assert(
      claims
        .filter((claim) => claim.verification.deployed === false)
        .every(
          (claim) =>
            claim.verification.validityScope === 'unverified' ||
            claim.verification.validityScope === 'rejected' ||
            claim.status === 'stale',
        ),
      'AC-03：未部署 Claim 的 validityScope 为 unverified（或已过期）',
    );
    assert(
      report.candidates.every((candidate) =>
        candidate.evidence.every((evidence) =>
          evidence.sourceDigest === undefined
            ? true
            : /^[a-f0-9]{64}$/.test(evidence.sourceDigest),
        ),
      ),
      '所有绑定的源码证据指纹都是合法 SHA256',
    );
    assert(staleness.candidatesScanned >= report.summary.analyzed, '过期扫描覆盖本轮候选');
    assert(
      staleness.evidenceMarkedStale === 0 || staleness.staleFiles.length > 0,
      'AC-09：证据过期时给出具体文件清单',
    );

    console.log('\n样本形态覆盖（真实仓库 vs 单元测试夹具）');
    console.log('─'.repeat(76));
    const forms: Array<[string, number, string]> = [
      ['用户可感知新功能', report.summary.userFacingFeature, 'pr-classifier.test.ts › feat + UI'],
      ['用户可感知改进', report.summary.userFacingImprovement, 'pr-classifier.test.ts › fix + source'],
      ['纯重构/内部变更', report.summary.internal, 'pr-classifier.test.ts › refactor / rename-only'],
      ['待人工复核', report.summary.ambiguous, 'pr-classifier.test.ts › free-form title'],
    ];
    for (const [label, count, fixture] of forms) {
      console.log(
        `  ${label.padEnd(12)} 真实样本 ${String(count).padStart(2)} 个` +
          (count === 0 ? `  → 未出现该形态；由夹具覆盖：${fixture}` : ''),
      );
    }
    if (report.candidates.length === 0) {
      console.log('  ⚠ 该仓库在这批 PR 中没有可分析样本；上述夹具是当前唯一证据来源。');
    }

    if (failures.length > 0) {
      console.error(`\n✗ Step 4C 验收未通过：${failures.length} 项断言失败。\n`);
      process.exitCode = 1;
      return;
    }

    console.log('\n✓ Step 4C 发现 / 守门 / 过期传播验收全部通过。\n');
  } finally {
    db.close();
  }
}

main().catch((error: unknown) => {
  console.error(
    '✗ PR 变更发现验收失败：',
    error instanceof Error ? error.message : String(error),
  );
  process.exitCode = 1;
});
