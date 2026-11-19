import { expect, test } from '@playwright/test';

test('重命名功能后刷新页面仍然保留', async ({ page }) => {
  await page.goto('/projects/proj_lumen/knowledge');
  await expect(page.getByRole('heading', { level: 1, name: '知识中心' })).toBeVisible();

  await page.getByRole('button', { name: '编辑', exact: true }).click();
  const nameInput = page.locator('main input').nth(1);
  await expect(nameInput).toHaveValue('实时协作看板');

  await nameInput.fill('实时协作看板 E2E');
  await page.getByRole('button', { name: '保存', exact: true }).click();
  await expect(page.getByText('实时协作看板 E2E').first()).toBeVisible();

  await page.reload();
  await expect(page.getByRole('heading', { level: 1, name: '知识中心' })).toBeVisible();
  await expect(page.getByText('实时协作看板 E2E').first()).toBeVisible();
});
