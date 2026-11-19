import { expect, test } from '@playwright/test';

test('项目信息改名、来源同步与数据重置形成闭环', async ({ page }) => {
  await page.goto('/projects/proj_lumen/settings');
  await expect(page.getByRole('heading', { level: 1, name: '设置与品牌' })).toBeVisible();

  await page.getByRole('tab', { name: '项目信息' }).click();
  const projectName = page.locator('main input').first();
  await expect(projectName).toHaveValue('Lumen Analytics');
  await projectName.fill('Lumen Analytics E2E');
  await page.getByRole('button', { name: '保存项目信息' }).click();

  await expect(page.getByText('项目信息已更新')).toBeVisible();
  await expect(page.getByText('Lumen Analytics E2E').first()).toBeVisible();

  await page.reload();
  await expect(page.getByText('Lumen Analytics E2E').first()).toBeVisible();

  await page.getByRole('tab', { name: '来源与同步' }).click();
  await page.getByRole('button', { name: '同步全部' }).click();
  await expect(page.getByText('模拟同步完成')).toBeVisible({ timeout: 10_000 });

  await page.getByRole('tab', { name: '演示数据' }).click();
  await page.getByRole('button', { name: '重置演示数据' }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog).toBeVisible();
  await expect(dialog.getByText('确认重置所有演示数据？')).toBeVisible();
  await dialog.getByRole('button', { name: '确认重置' }).click();

  await expect(page).toHaveURL(/\/$/);
  await expect(page.getByText('演示数据已重置')).toBeVisible();
  await expect(page.getByText('Lumen Analytics E2E')).toHaveCount(0);
});
