import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test, type Page } from '@playwright/test';

const here = path.dirname(fileURLToPath(import.meta.url));
const workspaceRoot = path.resolve(here, '../../..');
const tsxCli = path.resolve(workspaceRoot, 'node_modules/tsx/dist/cli.mjs');
const fixtureScript = path.resolve(workspaceRoot, 'apps/api/src/scripts/e2e-fixture-api.ts');

async function startFixtureApi(dbPath: string): Promise<{ port: number; child: ChildProcess }> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [tsxCli, '--tsconfig', 'apps/api/tsconfig.json', fixtureScript],
      {
        cwd: workspaceRoot,
        env: { ...process.env, ASVS_E2E_DB_PATH: dbPath },
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );

    let stderr = '';
    let settled = false;
    const timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        child.kill();
        reject(new Error(`Fixture API startup timeout. stderr=${stderr}`));
      }
    }, 20_000);

    child.stdout.on('data', (chunk: Buffer) => {
      const text = chunk.toString('utf8');
      for (const line of text.split(/\r?\n/)) {
        if (line.startsWith('READY ')) {
          const payload = JSON.parse(line.slice('READY '.length)) as { port: number };
          if (!settled) {
            settled = true;
            clearTimeout(timer);
            resolve({ port: payload.port, child });
          }
        }
      }
    });

    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8');
    });

    child.once('exit', (code) => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        reject(new Error(`Fixture API exited early (${code}). stderr=${stderr}`));
      }
    });
  });
}

async function routeGitHubApiToPort(page: Page, port: number): Promise<void> {
  await page.route('**/api/v1/github/**', async (route) => {
    const reqUrl = new URL(route.request().url());
    const targetUrl = `http://127.0.0.1:${port}${reqUrl.pathname.replace(/^\/api/, '')}${reqUrl.search}`;
    const response = await route.fetch({ url: targetUrl });
    await route.fulfill({ response });
  });
}

test('未配置 GitHub 凭证时诚实提示 503，绝不伪造已连接状态', async ({ page }) => {
  await page.route('**/api/v1/github/**', async (route) => {
    const url = route.request().url();
    if (url.includes('/v1/github/status')) {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          configured: false,
          mode: 'github_app',
          connected: false,
          readOnly: true,
          accessibleRepositories: [],
          permissions: {},
          writePermissions: [],
          checkedAt: '2026-11-27T12:00:00.000Z',
        }),
      });
      return;
    }
    await route.fulfill({
      status: 503,
      contentType: 'application/json',
      body: JSON.stringify({
        error: {
          code: 'github_not_configured',
          message: '尚未配置 GitHub App 只读凭证。',
        },
      }),
    });
  });

  await page.goto('/projects/proj_lumen/settings?tab=sources');
  await expect(page.getByText('GitHub App 只读凭证尚未配置')).toBeVisible();

  await page.getByLabel('GitHub 仓库（owner/repo）').fill('acme/livenotes');
  await page.getByRole('button', { name: '绑定为真实只读来源' }).click();
  await expect(page.getByText(/尚未配置 GitHub App 只读凭证/)).toBeVisible();
  await expect(page.getByText('已连接（真实只读）')).toHaveCount(0);
});

test('AC-08: 不提供源码仅文档也可完成六步入门并落地知识中心', async ({ page }) => {
  await page.goto('/onboarding');
  await page.getByLabel('产品名称').fill('DocFlow');
  await page.getByLabel('项目名称').fill('DocFlow 文档项目');
  await page.getByRole('button', { name: '继续', exact: true }).click();

  await page.getByRole('radio', { name: /产品文档/ }).click();
  await page.getByLabel('文档地址').fill('https://docs.docflow.example/guide');
  await page.getByRole('button', { name: '模拟连接' }).click();
  await expect(page.getByText('已连接 · 模拟')).toBeVisible();

  for (const step of [3, 4, 5, 6]) {
    await page.getByRole('button', { name: '继续', exact: true }).click();
    if (step === 4) {
      await page.getByLabel('品牌字标').fill('DOCFLOW');
    }
    await expect(page.getByText(`${step} / 6`)).toBeVisible();
  }

  await page.getByRole('button', { name: '开始初始化' }).click();
  await expect(page).toHaveURL(/\/projects\/proj_[^/]+\/knowledge(\?.*)?$/, {
    timeout: 15_000,
  });
  await expect(page.getByRole('heading', { level: 1, name: '知识中心' })).toBeVisible();
  await expect(page.getByText('Demo 快照')).toBeVisible();
});

test.describe('Step 4D 端到端闭环（AC-01 / AC-02 / AC-03 / AC-09）', () => {
  let tempDir = '';
  let fixturePort = 0;
  let fixtureChild: ChildProcess | undefined;

  test.beforeAll(async () => {
    tempDir = await mkdtemp(path.join(tmpdir(), 'asvs-4d-e2e-'));
    const started = await startFixtureApi(path.join(tempDir, 'fixture.sqlite'));
    fixturePort = started.port;
    fixtureChild = started.child;
  });

  test.afterAll(async () => {
    fixtureChild?.kill();
    if (tempDir) {
      await rm(tempDir, { recursive: true, force: true }).catch(() => undefined);
    }
  });

  test('真实只读接入 → 增量索引 → PR 发现(AC-02) → 核验审计(AC-03) → 审核通过 → 上游变更过期失效(AC-09)', async ({
    page,
  }) => {
    test.setTimeout(90_000);
    await routeGitHubApiToPort(page, fixturePort);

    // 1. Onboarding 真实 GitHub 模式接入 (AC-01)
    await page.goto('/onboarding');
    await page.getByLabel('产品名称').fill('LiveNotes');
    await page.getByLabel('项目名称').fill('LiveNotes 真实项目');
    await page.getByRole('button', { name: '继续', exact: true }).click();

    await page.getByRole('button', { name: '真实只读 GitHub App' }).click();
    await expect(page.getByText('API 已配置')).toBeVisible();
    await page.getByLabel('GitHub 仓库').fill('acme/livenotes');
    await page.getByRole('button', { name: '验证只读连接' }).click();
    await expect(page.getByText('已连接 · 真实只读')).toBeVisible();

    await page.getByRole('button', { name: '验证只读边界（AC-01）' }).click();
    await expect(page.getByText(/HTTP 403/)).toBeVisible();

    await page.getByRole('button', { name: '继续', exact: true }).click();
    await page.getByRole('button', { name: '继续', exact: true }).click();
    await page.getByLabel('品牌字标').fill('LIVENOTES');
    await page.getByRole('button', { name: '继续', exact: true }).click();
    await page.getByRole('button', { name: '继续', exact: true }).click();

    await page.getByRole('button', { name: '开始初始化' }).click();
    await expect(page).toHaveURL(/\/projects\/proj_[^/]+\/knowledge\?tab=discovery/, {
      timeout: 20_000,
    });

    const projectMatch = page.url().match(/\/projects\/(proj_[^/]+)\/knowledge/);
    expect(projectMatch).toBeTruthy();
    const projectId = projectMatch![1]!;

    // 2. 验证 PR 发现：#101 用户新功能（blocked_unverified）与 #102 内部变更（AC-02 过滤，0 Claim）
    await expect(page.getByText('feat: add CSV export button')).toBeVisible();
    await expect(page.getByText('refactor: cleanup internal helper')).toBeVisible();
    await expect(page.getByText(/AC-02 过滤/)).toBeVisible();
    await expect(page.getByText('未核验阻断').first()).toBeVisible();

    // 再运行一次同提交增量索引，验证热扫描复用（新下载 0）
    await page.getByRole('button', { name: '运行增量索引' }).click();
    await expect(page.getByText(/新下载 0/).first()).toBeVisible({ timeout: 10_000 });

    // 3. 将 #101 写入功能目录并创建视频 → 验证 AC-03 未核验阻断审核
    await page.getByRole('button', { name: '写入功能目录' }).click();
    await expect(page.getByText('已在目录 · 查看')).toBeVisible();

    await page.getByRole('link', { name: '创建视频' }).last().click();
    await expect(page).toHaveURL(new RegExp(`/projects/${projectId}/videos/new\\?feature=`));

    await page.getByRole('button', { name: '继续', exact: true }).click();
    await expect(page.getByText('未核验阻断').first()).toBeVisible();
    await page.getByRole('button', { name: '继续', exact: true }).click();
    await page.getByRole('button', { name: '生成脚本与分镜' }).click();
    await expect(page).toHaveURL(/\/videos\/vid_[^/]+\/director/);

    const videoId = page.url().match(/\/videos\/(vid_[^/]+)\//)![1]!;

    // 跑完模拟生产
    await page.goto(`/videos/${videoId}/production`);
    await page.getByRole('button', { name: /标准成功路径/ }).first().click();
    await page.getByRole('button', { name: /启动「一路通过」/ }).click();
    await page
      .getByRole('radiogroup', { name: '模拟运行速度' })
      .getByRole('radio', { name: '4×' })
      .click();
    await expect(page.getByText('模拟生产完成，可以进入审核')).toBeVisible({ timeout: 30_000 });

    // 进入审核页：未核验阻断必须禁用批准按钮（AC-03）
    await page.goto(`/videos/${videoId}/review`);
    await expect(page.getByRole('heading', { level: 1, name: '审核与导出' })).toBeVisible();
    await expect(page.getByRole('button', { name: '批准视频', exact: true })).toBeDisabled();
    await expect(page.getByText(/AC-03/).first()).toBeVisible();

    // 4. 回到知识中心逐级补齐核验：staging → production → human approve
    await page.goto(`/projects/${projectId}/knowledge?tab=discovery`);
    const submitVerifyBtn = page.getByRole('button', { name: '提交核验记录' }).first();

    // 4a. staging runtime → needs_qualification
    await submitVerifyBtn.click();
    let dialog = page.getByRole('dialog');
    await dialog.getByLabel(/运行环境标识/).fill('staging');
    await dialog.getByLabel(/核验说明/).fill('staging 验证 CSV 导出按钮可用');
    await dialog.getByRole('button', { name: '写入核验记录' }).click();
    await expect(page.getByText('需限定表述').first()).toBeVisible();

    // 4b. production runtime（缺人工批准）→ 仍保持 blocked_unverified！
    await submitVerifyBtn.click();
    dialog = page.getByRole('dialog');
    await dialog.getByLabel(/运行环境标识/).fill('production');
    await dialog.getByLabel(/核验说明/).fill('production 环境冒烟通过');
    await dialog.getByRole('button', { name: '写入核验记录' }).click();
    await expect(page.getByText('未核验阻断').first()).toBeVisible();

    // 4c. human approve → publishable！
    await submitVerifyBtn.click();
    dialog = page.getByRole('dialog');
    await dialog.getByLabel(/证据类型/).selectOption('human');
    await dialog.getByLabel(/核验人/).fill('qa-lead');
    await dialog.getByLabel(/核验说明/).fill('确认生产可用，批准对外展示');
    await dialog.getByRole('button', { name: '写入核验记录' }).click();
    await expect(page.getByText('可发布').first()).toBeVisible();

    // 查看追加只读审计记录
    await page.getByRole('button', { name: '核验审计' }).first().click();
    const auditDialog = page.getByRole('dialog');
    await expect(auditDialog.getByText('staging 验证 CSV 导出按钮可用')).toBeVisible();
    await expect(auditDialog.getByText('production 环境冒烟通过')).toBeVisible();
    await expect(auditDialog.getByText('确认生产可用，批准对外展示')).toBeVisible();
    await auditDialog.getByRole('button', { name: '关闭', exact: true }).click();

    // 5. 审核页现已解锁批准
    await page.goto(`/videos/${videoId}/review`);
    const approveBtn = page.getByRole('button', { name: '批准视频', exact: true });
    await expect(approveBtn).toBeEnabled();
    await approveBtn.click();
    await page.getByRole('dialog').getByRole('button', { name: '确认批准' }).click();
    await expect(page.getByRole('button', { name: '已通过审核' })).toBeVisible();

    // 6. AC-09: 上游文件变更 → 重跑增量索引 + 自动传播过期 → 已批准视频自动失效且审核重新阻断
    const advanceRes = await page.request.post(
      `http://127.0.0.1:${fixturePort}/__test/advance-commit`,
    );
    expect(advanceRes.ok()).toBe(true);

    await page.goto(`/projects/${projectId}/knowledge?tab=discovery`);
    await page.getByRole('button', { name: '运行增量索引' }).click();
    await expect(page.getByText('证据过期阻断').first()).toBeVisible({ timeout: 10_000 });

    await page.goto(`/videos/${videoId}/review`);
    await expect(page.getByRole('button', { name: '已通过审核' })).toHaveCount(0);
    await expect(page.getByRole('button', { name: '批准视频', exact: true })).toBeDisabled();
    await expect(page.getByText(/AC-09/).first()).toBeVisible();
  });
});
