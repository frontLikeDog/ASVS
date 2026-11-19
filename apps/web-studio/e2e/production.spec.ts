import { expect, test } from '@playwright/test';

test('标准生产场景在加速后运行到完成', async ({ page }) => {
  await page.goto('/videos/vid_lumen_release/production');
  await expect(page.getByRole('heading', { level: 1, name: '生产监控' })).toBeVisible();

  await page.getByRole('button', { name: /标准成功路径/ }).click();
  await page.getByRole('button', { name: /启动「一路通过」/ }).click();

  await expect(page.getByRole('button', { name: '暂停' })).toBeVisible();
  await page
    .getByRole('radiogroup', { name: '模拟运行速度' })
    .getByRole('radio', { name: '4×' })
    .click();

  await expect(page.getByText('所有步骤已结束')).toBeVisible({ timeout: 30_000 });
  await expect(page.getByText('8/8 步完成')).toBeVisible();
  await expect(page.getByText('模拟生产完成，可以进入审核')).toBeVisible();
  await expect(page.getByText('2 次本地模拟')).toBeVisible();
});
