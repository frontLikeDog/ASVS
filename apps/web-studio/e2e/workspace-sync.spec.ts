import { expect, test } from '@playwright/test';
import type { BrowserContext, Page } from '@playwright/test';

const PROJECT_SETTINGS = '/projects/proj_lumen/settings';

async function enableSync(context: BrowserContext, workspaceId: string): Promise<void> {
  await context.addInitScript(
    ({ id }) => {
      window.localStorage.setItem(
        'asvs.workspace-sync.v1',
        JSON.stringify({
          state: { config: { enabled: true, baseUrl: '/api', workspaceId: id } },
          version: 1,
        }),
      );
    },
    { id: workspaceId },
  );
}

async function openDataTab(page: Page): Promise<void> {
  await page.goto(PROJECT_SETTINGS);
  await page.getByRole('tab', { name: '演示数据' }).click();
  await expect(page.getByText('工作区同步（SQLite API）')).toBeVisible();
}

test('两个独立浏览器上下文通过 SQLite API 看到同一工作区', async ({ browser }) => {
  const workspaceId = `e2e_sync_${Date.now()}`;
  const contextA = await browser.newContext();
  const contextB = await browser.newContext();
  await enableSync(contextA, workspaceId);
  await enableSync(contextB, workspaceId);

  try {
    const pageA = await contextA.newPage();
    await openDataTab(pageA);
    await expect(pageA.getByText('已同步', { exact: true })).toBeVisible({ timeout: 15_000 });

    await pageA.getByRole('tab', { name: '项目信息' }).click();
    const nameInput = pageA.locator('main input').first();
    await nameInput.fill('Lumen Sync E2E');
    await pageA.getByRole('button', { name: '保存项目信息' }).click();
    await expect(pageA.getByText('项目信息已更新')).toBeVisible();

    // The whole workspace is PUT after the 1.2 s debounce; poll the API until
    // the rename is actually stored, then let a second context load it.
    await expect
      .poll(
        async () => {
          const response = await pageA.request.get(`/api/v1/workspaces/${workspaceId}`);
          if (!response.ok()) return null;
          const record = await response.json();
          return record.workspace.projects.find((project: { id: string }) => project.id === 'proj_lumen')
            ?.name;
        },
        { timeout: 15_000 },
      )
      .toBe('Lumen Sync E2E');

    const pageB = await contextB.newPage();
    await pageB.goto(PROJECT_SETTINGS);
    await expect(pageB.getByRole('tab', { name: '项目信息' })).toBeVisible();
    await pageB.getByRole('tab', { name: '项目信息' }).click();
    // B boots with its own seed and replaces it with the server record on
    // connect; the assertion waits for that replacement.
    await expect(pageB.locator('main input').first()).toHaveValue('Lumen Sync E2E', {
      timeout: 15_000,
    });
  } finally {
    await contextA.close();
    await contextB.close();
  }
});

test('工作区导出 JSON 可在全新浏览器导入恢复', async ({ page, browser }) => {
  await page.goto(PROJECT_SETTINGS);
  await page.getByRole('tab', { name: '项目信息' }).click();
  await page.locator('main input').first().fill('Workspace Backup E2E');
  await page.getByRole('button', { name: '保存项目信息' }).click();
  await expect(page.getByText('项目信息已更新')).toBeVisible();

  await page.getByRole('tab', { name: '演示数据' }).click();
  const downloadPromise = page.waitForEvent('download');
  await page.getByRole('button', { name: '导出工作区 JSON' }).click();
  const download = await downloadPromise;
  const filePath = test.info().outputPath('workspace-export.json');
  await download.saveAs(filePath);

  const fresh = await browser.newContext();
  try {
    const freshPage = await fresh.newPage();
    await freshPage.goto(PROJECT_SETTINGS);
    await freshPage.getByRole('tab', { name: '演示数据' }).click();
    await freshPage.locator('input[type="file"]').setInputFiles(filePath);

    const dialog = freshPage.getByRole('dialog');
    await expect(dialog.getByText('导入并替换当前工作区？')).toBeVisible();
    await dialog.getByRole('button', { name: '确认导入' }).click();
    await expect(freshPage.getByText('工作区已导入')).toBeVisible();

    await freshPage.reload();
    await freshPage.getByRole('tab', { name: '项目信息' }).click();
    await expect(freshPage.locator('main input').first()).toHaveValue('Workspace Backup E2E');
  } finally {
    await fresh.close();
  }
});
