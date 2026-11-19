import { readFile } from 'node:fs/promises';
import { expect, test } from '@playwright/test';

test('批准后可真实下载工程 JSON 与 SRT，MP4 仍为模拟', async ({ page }) => {
  await page.goto('/videos/vid_lumen_release/review');
  await expect(page.getByRole('heading', { level: 1, name: '审核与导出' })).toBeVisible();

  await page.getByRole('button', { name: '批准视频', exact: true }).click();
  const approveDialog = page.getByRole('dialog');
  await expect(approveDialog).toBeVisible();
  await approveDialog.getByRole('button', { name: '确认批准' }).click();
  await expect(page.getByRole('button', { name: '已通过审核' })).toBeVisible();

  await page.getByRole('button', { name: /^工程 JSON/ }).click();
  const [jsonDownload] = await Promise.all([
    page.waitForEvent('download'),
    page.getByRole('button', { name: '开始导出' }).click(),
  ]);
  expect(jsonDownload.suggestedFilename()).toMatch(/\.json$/);

  const jsonPath = await jsonDownload.path();
  expect(jsonPath).toBeTruthy();
  const project = JSON.parse(await readFile(jsonPath!, 'utf8')) as {
    kind: string;
    video: { scenes: unknown[]; totalDurationSec: number };
  };
  expect(project.kind).toBe('asvs.video-project');
  expect(project.video.scenes).toHaveLength(6);
  expect(project.video.totalDurationSec).toBe(32);

  await page.getByRole('button', { name: /^字幕 SRT/ }).click();
  const [srtDownload] = await Promise.all([
    page.waitForEvent('download'),
    page.getByRole('button', { name: '开始导出' }).click(),
  ]);
  expect(srtDownload.suggestedFilename()).toMatch(/\.srt$/);
  const srtPath = await srtDownload.path();
  const srt = await readFile(srtPath!, 'utf8');
  expect(srt).toContain('00:00:00,000 -->');
  expect(srt).toContain('00:00:32,000');

  await page.getByRole('button', { name: /^MP4/ }).click();
  const mediaDownload = page
    .waitForEvent('download', { timeout: 1_500 })
    .catch(() => null);
  await page.getByRole('button', { name: '开始导出' }).click();
  expect(await mediaDownload).toBeNull();
  await expect(page.getByText(/模拟导出|已开始模拟/).first()).toBeVisible();
});
