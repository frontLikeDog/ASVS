import { expect, test } from '@playwright/test';

test('视频库可按阶段与关键词筛选', async ({ page }) => {
  await page.goto('/videos');
  await expect(page.getByRole('heading', { level: 1, name: '视频库' })).toBeVisible();
  await expect(page.getByText('2 条结果')).toBeVisible();

  await page.getByRole('button', { name: '待审核', exact: true }).click();
  await expect(page.getByText('1 条结果')).toBeVisible();
  await expect(page.getByText('Lumen 2.8 · 让问题更快被看见')).toBeVisible();
  await expect(page.getByText('快速上手：实时协作看板')).toHaveCount(0);

  await page.getByRole('button', { name: '生产中', exact: true }).click();
  await expect(page.getByText('快速上手：实时协作看板')).toBeVisible();
  await expect(page.getByText('Lumen 2.8 · 让问题更快被看见')).toHaveCount(0);

  await page.getByRole('button', { name: '全部', exact: true }).click();
  await page.getByRole('textbox', { name: '搜索视频' }).fill('快速上手');
  await expect(page.getByText('1 条结果')).toBeVisible();
  await expect(page.getByText('快速上手：实时协作看板')).toBeVisible();
});
