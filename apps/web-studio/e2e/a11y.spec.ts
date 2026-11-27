import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';

const AXE_TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'];

function formatViolations(
  violations: Awaited<ReturnType<AxeBuilder['analyze']>>['violations'],
): string {
  if (violations.length === 0) return '';
  return violations
    .map((violation) => {
      const nodes = violation.nodes
        .slice(0, 4)
        .map((node) => `    ${node.target.join(' ')}`)
        .join('\n');
      return `  ${violation.id} [${violation.impact ?? 'unknown'}] ×${violation.nodes.length}: ${violation.help}\n${nodes}`;
    })
    .join('\n\n');
}

async function scan(page: Page, path: string, heading: string) {
  await page.goto(path);
  await expect(page.getByRole('heading', { level: 1, name: heading }).first()).toBeVisible();

  const results = await new AxeBuilder({ page }).withTags(AXE_TAGS).analyze();
  expect(
    results.violations,
    `${path} 存在 ${results.violations.length} 个无障碍违规：\n\n${formatViolations(results.violations)}`,
  ).toEqual([]);
}

test.describe('axe 无障碍扫描（WCAG 2.1 A/AA）', () => {
  test('工作台概览', async ({ page }) => {
    await scan(page, '/', '把可信的产品事实，变成可审阅的视频。');
  });

  test('项目列表', async ({ page }) => {
    await scan(page, '/projects', '项目');
  });

  test('知识中心', async ({ page }) => {
    await scan(page, '/projects/proj_lumen/knowledge', '知识中心');
  });

  test('知识中心 · PR 变更发现', async ({ page }) => {
    await scan(page, '/projects/proj_lumen/knowledge?tab=discovery', '知识中心');
  });

  test('视频库', async ({ page }) => {
    await scan(page, '/videos', '视频库');
  });

  test('AI 导演', async ({ page }) => {
    await scan(page, '/videos/vid_lumen_release/director', 'Lumen 2.8 · 让问题更快被看见');
  });

  test('分镜工作室', async ({ page }) => {
    await scan(page, '/videos/vid_lumen_release/storyboard', 'Lumen 2.8 · 让问题更快被看见');
  });

  test('视频编辑器', async ({ page }) => {
    await scan(page, '/videos/vid_lumen_release/editor', 'Lumen 2.8 · 让问题更快被看见');
  });

  test('生产监控', async ({ page }) => {
    await scan(page, '/videos/vid_lumen_release/production', '生产监控');
  });

  test('审核与导出', async ({ page }) => {
    await scan(page, '/videos/vid_lumen_release/review', '审核与导出');
  });

  test('设置与品牌', async ({ page }) => {
    await scan(page, '/projects/proj_lumen/settings', '设置与品牌');
  });

  test('命令面板', async ({ page }) => {
    await page.goto('/');
    await page.getByRole('button', { name: /搜索项目、功能、视频/ }).click();
    const dialog = page.getByRole('dialog');
    await expect(dialog).toBeVisible();

    const results = await new AxeBuilder({ page }).withTags(AXE_TAGS).analyze();
    expect(
      results.violations,
      `命令面板存在 ${results.violations.length} 个无障碍违规：\n\n${formatViolations(results.violations)}`,
    ).toEqual([]);
  });

  test('浅色主题关键页面', async ({ page }) => {
    await page.goto('/');
    await page.getByRole('button', { name: '切换到浅色模式' }).click();
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');

    for (const route of [
      { path: '/', heading: '把可信的产品事实，变成可审阅的视频。' },
      { path: '/projects/proj_lumen/knowledge', heading: '知识中心' },
      { path: '/projects/proj_lumen/settings', heading: '设置与品牌' },
    ]) {
      await scan(page, route.path, route.heading);
    }
  });
});
