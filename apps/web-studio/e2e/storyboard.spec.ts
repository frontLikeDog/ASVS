import { expect, test } from '@playwright/test';

test('分镜可下移并持久化顺序', async ({ page }) => {
  await page.goto('/videos/vid_lumen_release/storyboard');
  await expect(
    page.getByRole('heading', { level: 1, name: 'Lumen 2.8 · 让问题更快被看见' }),
  ).toBeVisible();

  const cards = page.locator('[draggable="true"]');
  const titles = page.locator('[draggable="true"] span.truncate.text-\\[10\\.5px\\]');
  await expect(cards).toHaveCount(6);

  const before = await titles.allTextContents();
  expect(before).toHaveLength(6);
  expect(before[0]).not.toBe(before[1]);

  await cards.nth(0).click();
  await page.getByRole('button', { name: '下移镜头' }).click();

  const expected = [before[1], before[0], ...before.slice(2)];
  await expect.poll(async () => titles.allTextContents()).toEqual(expected);

  await page.reload();
  await expect(cards).toHaveCount(6);
  await expect.poll(async () => titles.allTextContents()).toEqual(expected);
});
