import { expect, test } from '@playwright/test';
import { collectRuntimeErrors } from './support';

/**
 * Runs in the `tablet-chromium` project (768 × 1024, touch, tablet UA).
 *
 * 768 is the boundary where the shell stops using the mobile drawer and starts
 * using the persistent (but collapsed) sidebar. It is the width most likely to
 * regress because the desktop specs never visit it and the mobile specs start
 * below it.
 */
test.describe('平板布局（768 × 1024）', () => {
  test('使用常驻侧栏而不是移动抽屉', async ({ page }) => {
    const errors = collectRuntimeErrors(page);
    await page.goto('/');
    await expect(
      page.getByRole('heading', { level: 1, name: '把可信的产品事实，变成可审阅的视频。' }),
    ).toBeVisible();

    // At 768 the sidebar is part of the layout (md:static), so it must sit
    // inside the viewport and the mobile open/close trigger must be hidden.
    const sidebar = page.locator('aside').first();
    await expect(page.getByRole('button', { name: '打开导航' })).toBeHidden();
    await expect
      .poll(async () => {
        const box = await sidebar.boundingBox();
        return box ? box.x >= 0 && box.width > 0 : false;
      })
      .toBe(true);

    expect(errors, errors.join('\n')).toEqual([]);
  });

  test('关键页面在 768px 宽下没有横向溢出', async ({ page }) => {
    const errors = collectRuntimeErrors(page);
    const routes = [
      { path: '/', heading: '把可信的产品事实，变成可审阅的视频。' },
      { path: '/projects', heading: '项目' },
      { path: '/videos', heading: '视频库' },
      { path: '/projects/proj_lumen/knowledge', heading: '知识中心' },
      { path: '/projects/proj_lumen/settings', heading: '设置与品牌' },
      { path: '/videos/vid_lumen_release/director', heading: 'Lumen 2.8 · 让问题更快被看见' },
      { path: '/videos/vid_lumen_release/storyboard', heading: 'Lumen 2.8 · 让问题更快被看见' },
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

  test('折叠侧栏在 768 下可手动展开', async ({ page }) => {
    await page.goto('/');

    // Tablet forces the collapsed sidebar; the toggle must still let the user
    // expand it without the layout breaking.
    const toggle = page.getByRole('button', { name: '展开侧栏' });
    await expect(toggle).toBeVisible();
    await toggle.click();
    await expect
      .poll(async () => {
        const box = await page.locator('aside').first().boundingBox();
        return box?.width ?? 0;
      })
      .toBeGreaterThan(120);
  });
});
