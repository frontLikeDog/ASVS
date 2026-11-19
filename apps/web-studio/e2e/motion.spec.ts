import { expect, test } from '@playwright/test';

async function closeDemoDialog(page: import('@playwright/test').Page) {
  await page.getByRole('dialog').getByRole('button', { name: '关闭', exact: true }).click();
  await expect(page.getByRole('dialog')).toBeHidden();
}

test.describe('默认动效', () => {
  test('弹窗入场动画保持非零时长', async ({ page }) => {
    await page.goto('/');
    await page.getByRole('button', { name: 'Demo', exact: true }).click();
    const dialog = page.getByRole('dialog');
    await expect(dialog).toBeVisible();

    const animationSeconds = await dialog.evaluate((element) =>
      parseFloat(getComputedStyle(element).animationDuration),
    );
    expect(animationSeconds).toBeGreaterThan(0.1);
    await closeDemoDialog(page);
  });
});

test.describe('prefers-reduced-motion: reduce', () => {
  test.use({ reducedMotion: 'reduce' });

  test('媒体查询命中且动画/过渡被压缩到近零', async ({ page }) => {
    await page.goto('/');

    const reduced = await page.evaluate(() =>
      window.matchMedia('(prefers-reduced-motion: reduce)').matches,
    );
    expect(reduced).toBe(true);

    // Measure a regular control before opening the modal: Radix hides the
    // background from the accessibility tree while the dialog is open.
    const transitionSeconds = await page
      .getByRole('button', { name: '切换到浅色模式' })
      .evaluate((element) => parseFloat(getComputedStyle(element).transitionDuration));
    expect(transitionSeconds).toBeLessThan(0.02);

    await page.getByRole('button', { name: 'Demo', exact: true }).click();
    const dialog = page.getByRole('dialog');
    await expect(dialog).toBeVisible();

    const animationSeconds = await dialog.evaluate((element) =>
      parseFloat(getComputedStyle(element).animationDuration),
    );
    expect(animationSeconds).toBeLessThan(0.02);
  });

  test('减少动效时核心交互仍可用', async ({ page }) => {
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));

    await page.goto('/');
    await page.getByRole('button', { name: 'Demo', exact: true }).click();
    await expect(page.getByRole('dialog').getByText('模拟能力与真实边界')).toBeVisible();
    await closeDemoDialog(page);

    await page
      .getByRole('navigation', { name: '主导航' })
      .getByRole('link', { name: '项目', exact: true })
      .click();
    await expect(page).toHaveURL(/\/projects$/);
    await expect(page.getByRole('heading', { level: 1, name: '项目' })).toBeVisible();
    expect(errors).toEqual([]);
  });
});
