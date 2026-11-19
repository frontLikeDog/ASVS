import { expect, test } from '@playwright/test';
import { collectRuntimeErrors } from './support';

test('仪表盘加载种子工作区且没有运行时错误', async ({ page }) => {
  const errors = collectRuntimeErrors(page);
  await page.goto('/');

  await expect(
    page.getByRole('heading', { level: 1, name: '把可信的产品事实，变成可审阅的视频。' }),
  ).toBeVisible();
  await expect(page.getByText('Lumen 2.8 · 让问题更快被看见').first()).toBeVisible();
  await expect(page.getByText('Pulse CRM').first()).toBeVisible();
  await expect(page.getByText('Demo', { exact: true }).first()).toBeVisible();

  expect(errors, errors.join('\n')).toEqual([]);
});

test('命令面板可搜索并跳转到项目列表', async ({ page }) => {
  await page.goto('/');
  await page
    .getByRole('button', { name: /搜索项目、功能、视频/ })
    .click();

  const dialog = page.getByRole('dialog');
  await expect(dialog).toBeVisible();
  await expect(dialog.getByText('快速跳转')).toBeVisible();

  await dialog.getByRole('textbox', { name: '搜索' }).fill('项目');
  await dialog.getByText('全部项目', { exact: true }).click();

  await expect(page).toHaveURL(/\/projects$/);
  await expect(page.getByRole('heading', { level: 1, name: '项目' })).toBeVisible();
});

test('未知路由展示可恢复的 404 页面', async ({ page }) => {
  await page.goto('/not-a-route');
  await expect(page.getByRole('heading', { level: 1, name: '这条路径不存在' })).toBeVisible();
  await expect(page.getByRole('link', { name: '回到概览' })).toBeVisible();
  await expect(page.getByText('404 · NOT FOUND')).toBeVisible();
});

test('主题切换会持久化，演示边界弹窗可打开关闭', async ({ page }) => {
  await page.goto('/');
  const html = page.locator('html');
  await expect(html).toHaveAttribute('data-theme', 'dark');

  await page.getByRole('button', { name: '切换到浅色模式' }).click();
  await expect(html).toHaveAttribute('data-theme', 'light');
  await page.reload();
  await expect(html).toHaveAttribute('data-theme', 'light');

  await page.getByRole('button', { name: 'Demo', exact: true }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog.getByText('模拟能力与真实边界')).toBeVisible();
  await expect(dialog.getByText('MP4 / WebM 导出：只有状态，不会伪造可播放成片。')).toBeVisible();
  await dialog.getByRole('button', { name: '关闭', exact: true }).click();
  await expect(dialog).toBeHidden();
});
