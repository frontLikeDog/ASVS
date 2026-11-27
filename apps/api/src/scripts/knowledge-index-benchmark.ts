import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { formatGitHubRepoRef, parseGitHubRepoRef } from '@asvs/domain';
import type { KnowledgeSnapshotV1 } from '@asvs/domain';
import { createGitHubPortFromConfig, loadConfig } from '../config';
import { openDatabase } from '../db/database';
import { SqliteKnowledgeSnapshotStore } from '../db/knowledge-store';
import { loadApiLocalEnv } from '../env';
import { GitHubKnowledgeIndexer } from '../knowledge/indexer';

/**
 * Step 4B acceptance benchmark against a real repository.
 *
 * Runs a cold scan (no parent), then a second scan at the same commit. The
 * second must download zero blobs and reuse every file; that is the direct
 * proof that incremental indexing does not re-fetch or re-parse unchanged
 * content. A third, forced-cold scan re-downloads everything so the two cold
 * runs can be compared for variance.
 *
 * Usage: pnpm index:benchmark [--repo owner/name] [--branch main] [--keep-db]
 */

const apiDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

interface BenchmarkRow {
  label: string;
  snapshot: KnowledgeSnapshotV1;
}

function argValue(argv: string[], flag: string): string | undefined {
  const index = argv.indexOf(flag);
  if (index >= 0 && argv[index + 1]) return argv[index + 1];
  return undefined;
}

function printRow(row: BenchmarkRow): void {
  const { snapshot } = row;
  const { stats } = snapshot;
  console.log(`\n${row.label}`);
  console.log('─'.repeat(72));
  console.log(`  快照 ID      : ${snapshot.id}`);
  console.log(`  提交         : ${snapshot.gitCommitSha.slice(0, 12)} (${snapshot.branch})`);
  console.log(`  父快照       : ${snapshot.parentSnapshotId ?? '无（冷扫描）'}`);
  console.log(`  模式         : ${stats.mode}`);
  console.log(`  耗时         : ${stats.durationMs.toFixed(0)} ms`);
  console.log(`  总文件数     : ${stats.totalFiles}`);
  console.log(`  已索引文件   : ${stats.indexedFiles}`);
  console.log(`  复用文件     : ${stats.reusedFiles}`);
  console.log(`  删除文件     : ${stats.removedFiles}`);
  console.log(`  跳过文件     : ${stats.skippedFiles}`);
  console.log(`  下载文件     : ${stats.fetchedFiles}`);
  const languages = new Map<string, number>();
  for (const file of snapshot.files) {
    languages.set(file.language, (languages.get(file.language) ?? 0) + 1);
  }
  const topLanguages = Array.from(languages.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, 6)
    .map(([language, count]) => `${language}=${count}`)
    .join('  ');
  console.log(`  语言分布     : ${topLanguages || 'n/a'}`);
  console.log(`  入口点       : ${snapshot.entrypoints.slice(0, 4).map((entry) => `${entry.path}(${entry.rank})`).join(', ') || '无'}`);
}

async function main(): Promise<void> {
  loadApiLocalEnv(apiDir);
  const config = loadConfig();
  const github = createGitHubPortFromConfig(config.github);

  const repoArg = argValue(process.argv.slice(2), '--repo');
  const targetRepo = repoArg ? parseGitHubRepoRef(repoArg) : github.getDefaultRepo();
  if (!targetRepo) {
    console.error('请通过 --repo owner/repo 或 GITHUB_DEFAULT_REPO 指定目标仓库。');
    process.exitCode = 1;
    return;
  }

  const branch = argValue(process.argv.slice(2), '--branch');
  const fullRepo = formatGitHubRepoRef(targetRepo);

  console.log(`\nASVS Step 4B · 增量知识索引基准 (${fullRepo}${branch ? ` @ ${branch}` : ''})`);
  console.log('='.repeat(72));

  const dbPath = config.dbPath;
  console.log(`SQLite: ${dbPath}`);
  const db = openDatabase(dbPath);
  const store = new SqliteKnowledgeSnapshotStore(db);
  const indexer = new GitHubKnowledgeIndexer({ github, store });

  try {
    // The benchmark must not accidentally inherit a snapshot from an earlier
    // run: the first scan is forced cold so "cold" numbers mean cold.
    const cold = await indexer.indexRepository(targetRepo, { branch, forceCold: true });
    printRow({ label: '1 · 冷扫描 (forceCold)', snapshot: cold });

    const incremental = await indexer.indexRepository(targetRepo, { branch });
    printRow({ label: '2 · 热扫描 (增量, 同一提交)', snapshot: incremental });

    const forcedCold = await indexer.indexRepository(targetRepo, { branch, forceCold: true });
    printRow({ label: '3 · 再次冷扫描 (对照)', snapshot: forcedCold });

    const history = await indexer.listSnapshots(targetRepo, { branch, limit: 10 });

    console.log('\n历史快照（最新 10 条）');
    console.log('─'.repeat(72));
    for (const summary of history) {
      console.log(
        `  ${summary.id}  ${summary.stats.mode.padEnd(11)} ${summary.gitCommitSha.slice(0, 8)}  ` +
          `total=${summary.stats.totalFiles} indexed=${summary.stats.indexedFiles} ` +
          `reused=${summary.stats.reusedFiles} fetched=${summary.stats.fetchedFiles}  ` +
          `${summary.indexedAt}`,
      );
    }

    console.log('\n验收断言');
    console.log('─'.repeat(72));
    const failures: string[] = [];
    const assert = (condition: boolean, message: string): void => {
      console.log(`  ${condition ? '✓' : '✗'} ${message}`);
      if (!condition) failures.push(message);
    };

    assert(cold.stats.mode === 'cold', '首次扫描是冷扫描');
    assert(cold.stats.reusedFiles === 0, '冷扫描没有复用任何父快照文件');
    assert(
      cold.stats.fetchedFiles >= cold.stats.indexedFiles,
      `冷扫描至少下载了每个已索引文件（fetched=${cold.stats.fetchedFiles} indexed=${cold.stats.indexedFiles}）`,
    );
    assert(
      cold.stats.indexedFiles === cold.stats.totalFiles,
      '冷扫描索引了全部可索引文件',
    );
    assert(
      incremental.stats.mode === 'incremental',
      '第二次扫描进入增量模式',
    );
    assert(
      incremental.stats.indexedFiles === 0,
      `同一提交下增量扫描重算文件数为 0（实际 ${incremental.stats.indexedFiles}）`,
    );
    assert(
      incremental.stats.reusedFiles === incremental.stats.totalFiles,
      `增量扫描复用全部文件（${incremental.stats.reusedFiles}/${incremental.stats.totalFiles}）`,
    );
    assert(
      incremental.stats.fetchedFiles === 0,
      `增量扫描零下载，未重复拉取文件内容（实际 ${incremental.stats.fetchedFiles}）`,
    );
    assert(
      incremental.stats.removedFiles === 0,
      '同一提交下增量扫描没有删除文件',
    );
    assert(
      incremental.gitCommitSha === cold.gitCommitSha,
      '两个快照固定在同一提交',
    );
    assert(
      incremental.parentSnapshotId === cold.id,
      '增量快照的父快照是上一份快照',
    );
    assert(
      cold.id !== forcedCold.id && cold.id !== incremental.id,
      '每次扫描生成新的不可变快照',
    );
    assert(
      JSON.stringify(incremental.sourceDigests) === JSON.stringify(cold.sourceDigests),
      '增量快照与冷快照的 sourceDigests 完全一致',
    );
    assert(
      Object.values(incremental.sourceDigests).every((digest) => /^[a-f0-9]{64}$/.test(digest)),
      'sourceDigests 全部是合法 SHA256',
    );

    const coldMs = cold.stats.durationMs;
    const incrementalMs = incremental.stats.durationMs;
    const speedup = incrementalMs > 0 ? coldMs / incrementalMs : Number.POSITIVE_INFINITY;
    console.log(
      `\n  冷扫描 ${coldMs.toFixed(0)} ms → 增量 ${incrementalMs.toFixed(0)} ms ` +
        `(约 ${Number.isFinite(speedup) ? speedup.toFixed(1) : '∞'}× 更快)`,
    );
    console.log(`  复用文件数(热/冷): ${incremental.stats.reusedFiles}/${cold.stats.totalFiles}`);
    console.log(`  重算文件数(热)   : ${incremental.stats.indexedFiles}`);

    if (failures.length > 0) {
      console.error(`\n✗ Step 4B 基准未通过：${failures.length} 项断言失败。\n`);
      process.exitCode = 1;
      return;
    }

    console.log('\n✓ Step 4B 冷/热扫描基准全部通过。\n');
  } finally {
    db.close();
  }
}

main().catch((error: unknown) => {
  console.error(
    '✗ 知识索引基准失败：',
    error instanceof Error ? error.message : String(error),
  );
  process.exitCode = 1;
});
