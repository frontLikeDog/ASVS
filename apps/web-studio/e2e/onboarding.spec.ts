import { expect, test } from '@playwright/test';

test('六步入门使用示例数据完成初始化并落地项目', async ({ page }) => {
  await page.goto('/onboarding');
  await expect(page.getByRole('heading', { level: 1, name: '新建视频项目' })).toBeVisible();

  await page.getByRole('button', { name: '使用 Lumen 示例' }).click();
  await expect(page.locator('main input').first()).toHaveValue('Atlas');

  // 示例中的三个连接是模拟异步建立的，确认全部完成后再继续。
  await page.getByRole('button', { name: '继续', exact: true }).click();
  await expect(page.getByText('2 / 6')).toBeVisible();
  await expect(page.getByText('已连接 · 模拟')).toHaveCount(3, { timeout: 5_000 });

  for (const step of [3, 4, 5, 6]) {
    await page.getByRole('button', { name: '继续', exact: true }).click();
    await expect(page.getByText(`${step} / 6`)).toBeVisible();
  }

  await expect(page.getByRole('button', { name: '开始初始化' })).toBeVisible();
  await page.getByRole('button', { name: '开始初始化' }).click();

  await expect(page).toHaveURL(/\/projects\/proj_[^/]+\/knowledge(\?.*)?$/, {
    timeout: 15_000,
  });
  await expect(page.getByRole('heading', { level: 1, name: '知识中心' })).toBeVisible();
  await expect(page.getByText('初始化完成').first()).toBeVisible();
  await expect(page.getByText('5 个功能').first()).toBeVisible();
});
