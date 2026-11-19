import { expect, test } from '@playwright/test';
import { collectRuntimeErrors } from './support';

/**
 * Runs only in the `mobile-chromium` project (390 × 844, touch, mobile UA).
 * Desktop-only specs are excluded from that project by testMatch.
 */
test.describe('移动端布局', () => {
  test('抽屉导航可打开、跳转后自动关闭', async ({ page }) => {
    const errors = collectRuntimeErrors(page);
    await page.goto('/');
    await expect(
      page.getByRole('heading', { level: 1, name: '把可信的产品事实，变成可审阅的视频。' }),
    ).toBeVisible();

    const sidebar = page.locator('aside').first();
    const closedBox = await sidebar.boundingBox();
    expect(closedBox).not.toBeNull();
    expect((closedBox?.x ?? 0) + (closedBox?.width ?? 0)).toBeLessThanOrEqual(0);

    await page.getByRole('button', { name: '打开导航' }).click();
    await expect(page.getByRole('button', { name: '关闭导航' })).toBeVisible();
    await expect
      .poll(async () => (await sidebar.boundingBox())?.x ?? -1)
      .toBeGreaterThanOrEqual(0);

    await page
      .getByRole('navigation', { name: '主导航' })
      .getByRole('link', { name: '视频工程' })
      .click();

    await expect(page).toHaveURL(/\/projects\/[^/]+\/videos$/);
    await expect(page.getByRole('heading', { level: 1 }).first()).toBeVisible();
    await expect(page.getByRole('button', { name: '关闭导航' })).toBeHidden();
    await expect
      .poll(async () => {
        const box = await sidebar.boundingBox();
        return box ? box.x + box.width : 0;
      })
      .toBeLessThanOrEqual(0);

    expect(errors, errors.join('\n')).toEqual([]);
  });

  test('移动端搜索打开命令面板并可跳转', async ({ page }) => {
    await page.goto('/');
    await page.getByRole('button', { name: '搜索', exact: true }).click();

    const dialog = page.getByRole('dialog');
    await expect(dialog).toBeVisible();
    await dialog.getByRole('textbox', { name: '搜索' }).fill('全部项目');
    await dialog.getByText('全部项目', { exact: true }).click();

    await expect(page).toHaveURL(/\/projects$/);
    await expect(page.getByRole('heading', { level: 1, name: '项目' })).toBeVisible();
  });

  test('关键页面在 390px 宽下没有横向溢出', async ({ page }) => {
    const errors = collectRuntimeErrors(page);
    const routes = [
      { path: '/', heading: '把可信的产品事实，变成可审阅的视频。' },
      { path: '/projects', heading: '项目' },
      { path: '/videos', heading: '视频库' },
      { path: '/projects/proj_lumen/knowledge', heading: '知识中心' },
      { path: '/projects/proj_lumen/settings', heading: '设置与品牌' },
      { path: '/videos/vid_lumen_release/director', heading: 'Lumen 2.8 · 让问题更快被看见' },
      { path: '/videos/vid_lumen_release/editor', heading: 'Lumen 2.8 · 让问题更快被看见' },
      { path: '/videos/vid_lumen_release/production', heading: '生产监控' },
      { path: '/videos/vid_lumen_release/review', heading: '审核与导出' },
    ];

    for (const route of routes) {
      await page.goto(route.path);
      await expect(
        page.getByRole('heading', { level: 1, name: route.heading }).first(),
      ).toBeVisible();

      const layout = await page.evaluate(() => {
        const root = document.documentElement;
        return {
          viewport: window.innerWidth,
          documentWidth: root.scrollWidth,
          bodyWidth: document.body.scrollWidth,
        };
      });
      expect(
        layout.documentWidth,
        `${route.path} 的文档宽度 ${layout.documentWidth} 超过视口 ${layout.viewport}`,
      ).toBeLessThanOrEqual(layout.viewport + 1);
      expect(
        layout.bodyWidth,
        `${route.path} 的 body 宽度 ${layout.bodyWidth} 超过视口 ${layout.viewport}`,
      ).toBeLessThanOrEqual(layout.viewport + 1);
    }

    expect(errors, errors.join('\n')).toEqual([]);
  });
});
