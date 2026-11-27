import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { formatGitHubRepoRef, parseGitHubRepoRef } from '@asvs/domain';
import { createGitHubPortFromConfig, loadConfig } from '../config';
import { loadApiLocalEnv } from '../env';

function parseRepoArg(argv: string[]): string | undefined {
  const index = argv.indexOf('--repo');
  if (index >= 0 && argv[index + 1]) return argv[index + 1];
  return undefined;
}

async function main(): Promise<void> {
  const apiDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
  loadApiLocalEnv(apiDir);

  const config = loadConfig();
  const github = createGitHubPortFromConfig(config.github);

  const repoArg = parseRepoArg(process.argv.slice(2));
  const targetRepo = repoArg ? parseGitHubRepoRef(repoArg) : github.getDefaultRepo();
  if (!targetRepo) {
    console.error('请通过 --repo owner/repo 或 GITHUB_DEFAULT_REPO 指定目标仓库。');
    process.exitCode = 1;
    return;
  }

  const fullRepo = formatGitHubRepoRef(targetRepo);
  console.log(`\nASVS Step 4A · GitHub App 只读验收 (${fullRepo})`);
  console.log('─'.repeat(64));

  const status = await github.checkConnection(targetRepo);
  console.log(
    `1. 连接状态: configured=${status.configured} connected=${status.connected} readOnly=${status.readOnly}`,
  );
  console.log(`   授权范围: ${status.repositorySelection ?? 'unknown'} (${status.accessibleRepositories.join(', ') || 'none'})`);
  console.log(`   授予权限: ${JSON.stringify(status.permissions)}`);

  if (!status.configured || !status.connected || !status.readOnly) {
    console.error(`✗ 连接或只读校验未通过：${status.error ?? '未知错误'}`);
    process.exitCode = 1;
    return;
  }

  const repoMeta = await github.getRepository(targetRepo);
  console.log(
    `2. 仓库信息: ${repoMeta.fullName} | ${repoMeta.private ? 'private' : 'public'} | defaultBranch=${repoMeta.defaultBranch} | pushedAt=${repoMeta.pushedAt ?? 'n/a'}`,
  );

  const pulls = await github.listPullRequests(targetRepo, { state: 'all', limit: 10 });
  console.log(`3. PR 列表: 最近 ${pulls.length} 条`);
  for (const pr of pulls.slice(0, 5)) {
    const tag = pr.merged ? 'merged' : pr.state;
    console.log(`   - #${pr.number} [${tag}] ${pr.title} (by ${pr.author}, sha=${pr.headSha.slice(0, 7)})`);
  }

  if (pulls.length > 0) {
    const latestPr = pulls[0]!;
    const files = await github.listPullRequestFiles(targetRepo, latestPr.number, {
      includePatch: false,
      limit: 20,
    });
    console.log(`4. 最新 PR #${latestPr.number} 变更文件: ${files.length} 个`);
    for (const file of files.slice(0, 5)) {
      console.log(`   - ${file.status} ${file.filename} (+${file.additions}/-${file.deletions})`);
    }
  } else {
    console.log('4. 最新 PR 变更文件: 仓库暂无 PR');
  }

  const releases = await github.listReleases(targetRepo, { limit: 5 });
  console.log(`5. Release 列表: ${releases.length} 条`);
  for (const rel of releases.slice(0, 3)) {
    console.log(`   - ${rel.tagName} (${rel.name ?? 'untitled'}) publishedAt=${rel.publishedAt ?? 'draft'}`);
  }

  const readme = await github.getFileContent(targetRepo, 'README.md');
  console.log(
    `6. README.md 读取: ${readme ? `成功 (${readme.size} bytes, sha=${readme.sha.slice(0, 7)})` : '仓库中无 README.md'}`,
  );

  const probe = await github.probeWriteBlocked(targetRepo);
  console.log(
    `7. AC-01 写操作阻断探针: readOnlyToken=${probe.readOnlyToken} writeBlocked=${probe.writeBlocked} httpStatus=${probe.statusCode}`,
  );
  console.log(`   详情: ${probe.detail}`);

  console.log('─'.repeat(64));
  if (!probe.readOnlyToken || !probe.writeBlocked) {
    console.error('✗ AC-01 未通过：安装必须严格只读且写操作被 GitHub 拒绝。');
    process.exitCode = 1;
    return;
  }

  console.log('✓ Step 4A 全部只读验收项通过。\n');
}

main().catch((error: unknown) => {
  console.error('✗ GitHub 只读验收失败：', error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
