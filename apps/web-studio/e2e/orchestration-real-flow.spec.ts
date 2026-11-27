import { expect, test } from '@playwright/test';
import type { BrowserContext } from '@playwright/test';

/**
 * Slice 5A browser acceptance against the real local API (started by
 * `playwright.config.ts` on :4300 with a throwaway SQLite file).
 *
 * These tests never click "启动服务端渲染": the render worker is a real
 * Remotion subprocess and a full render is far too slow for a UI spec. Instead
 * they drive the read-only server-mode surface the user actually sees — the
 * idle panel, the honest "no server artifacts yet" review panel, and the
 * graceful degradation when no workspace is connected — and assert the
 * simulated DAG keeps working untouched. The real MP4/ffprobe/SIGKILL proof
 * lives in `pnpm orchestration:verify` (AC-06).
 */

const PRODUCTION = '/videos/vid_lumen_release/production';
const REVIEW = '/videos/vid_lumen_release/review';

async function enableSync(context: BrowserContext, workspaceId: string): Promise<void> {
  await context.addInitScript(
    ({ id }) => {
      window.localStorage.setItem(
        'asvs.workspace-sync.v1',
        JSON.stringify({
          state: { config: { enabled: true, baseUrl: '/api', workspaceId: id } },
          version: 1,
        }),
      );
    },
    { id: workspaceId },
  );
}

test('未连接工作区时服务端面板诚实降级，模拟 DAG 仍然可用', async ({ page }) => {
  await page.goto(PRODUCTION);
  await expect(page.getByRole('heading', { level: 1, name: '生产监控' })).toBeVisible();
  await expect(page.getByText('服务端编排未连接')).toBeVisible();
  await expect(page.getByRole('button', { name: '启动服务端渲染' })).toHaveCount(0);

  // The browser-owned simulated run is untouched by server mode.
  await page.getByRole('button', { name: /标准成功路径/ }).click();
  await page.getByRole('button', { name: /启动「一路通过」/ }).click();
  await page
    .getByRole('radiogroup', { name: '模拟运行速度' })
    .getByRole('radio', { name: '4×' })
    .click();
  await expect(page.getByText('所有步骤已结束')).toBeVisible({ timeout: 30_000 });
});

test('连接工作区后生产页展示服务端真实渲染入口与恢复策略', async ({ browser }) => {
  const workspaceId = `e2e_orch_${Date.now()}`;
  const context = await browser.newContext();
  await enableSync(context, workspaceId);
  try {
    const page = await context.newPage();
    await page.goto(PRODUCTION);
    await expect(page.getByText('服务端真实渲染')).toBeVisible({ timeout: 15_000 });
    await expect(page.getByText('服务端').first()).toBeVisible();
    await expect(page.getByRole('button', { name: '启动服务端渲染' })).toBeVisible();
    await expect(page.getByText('Remotion · 独立子进程')).toBeVisible();
    await expect(page.getByText('SIGKILL / API 重启后按 checkpoint 续跑')).toBeVisible();
    await expect(
      page.getByText('16:9 · H.264 · 无音轨（5B 接入配音与 SRT）').first(),
    ).toBeVisible();
    // The simulated DAG still renders below it.
    await expect(page.getByRole('button', { name: /标准成功路径/ })).toBeVisible();
  } finally {
    await context.close();
  }
});

test('还没有服务端产物时审核页如实说明，不伪造可下载 MP4', async ({ browser }) => {
  const workspaceId = `e2e_orch_${Date.now()}`;
  const context = await browser.newContext();
  await enableSync(context, workspaceId);
  try {
    const page = await context.newPage();
    await page.goto(REVIEW);
    await expect(page.getByRole('heading', { level: 1, name: '审核与导出' })).toBeVisible();
    await expect(
      page.getByText('还没有服务端渲染的真实 MP4'),
    ).toBeVisible({ timeout: 15_000 });
    // The pre-existing simulated export path is still offered.
    await expect(page.getByRole('button', { name: /^工程 JSON/ })).toBeVisible();
  } finally {
    await context.close();
  }
});

test('服务端 health 暴露 orchestrationReady，编排接口按工作区隔离', async ({ request }) => {
  const health = await request.get('/api/v1/health');
  expect(health.ok()).toBe(true);
  expect(await health.json()).toMatchObject({ ok: true, orchestrationReady: true });

  const workspaceId = `e2e_orch_api_${Date.now()}`;
  const list = await request.get(`/api/v1/workspaces/${workspaceId}/orchestration/runs`);
  expect(list.ok()).toBe(true);
  expect((await list.json()).runs).toEqual([]);

  // Unknown workspace => 404 from the service, not a fabricated run.
  const created = await request.post(`/api/v1/workspaces/${workspaceId}/orchestration/runs`, {
    data: { videoId: 'vid_lumen_release', idempotencyKey: `e2e-orch-${Date.now()}` },
  });
  expect(created.status()).toBe(404);
  expect((await created.json()).error.code).toBe('workspace_not_found');
});
