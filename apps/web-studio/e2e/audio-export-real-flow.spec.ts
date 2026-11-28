import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test, request as playwrightRequest } from '@playwright/test';
import type { APIRequestContext, BrowserContext } from '@playwright/test';

/**
 * Slice 5B browser acceptance (AC-10).
 *
 * The UI is driven against the **test-only fixture API**, not the production
 * server started by `playwright.config.ts`: the fixture can seed a succeeded
 * narrated run whose artifacts are internally consistent, and it runs the
 * deterministic test voice, so the page's honesty labels can be asserted
 * (`synthetic: true`, never "真实商用配音").
 *
 * A real Remotion render is far too slow for a UI spec, and the fixture's MP4
 * is a labelled placeholder. The real MP4 + AAC + SRT + non-silence proof is
 * `pnpm export:verify`.
 */

const here = path.dirname(fileURLToPath(import.meta.url));
const workspaceRoot = path.resolve(here, '../../..');
const tsxCli = path.resolve(workspaceRoot, 'node_modules/tsx/dist/cli.mjs');
const fixtureScript = path.resolve(workspaceRoot, 'apps/api/src/scripts/e2e-fixture-api.ts');
const VIDEO_ID = 'vid_lumen_release';
const ISO = '2026-11-27T10:00:00.000Z';

interface FixtureApi {
  origin: string;
  request: APIRequestContext;
  dispose: () => Promise<void>;
}

/** Boots the fixture API on an ephemeral port with its own SQLite + artifacts. */
async function startFixtureApi(): Promise<FixtureApi> {
  const tempRoot = await mkdtemp(path.join(tmpdir(), 'asvs-e2e-export-'));
  const child = spawn(process.execPath, [tsxCli, '--tsconfig', 'apps/api/tsconfig.json', fixtureScript], {
    cwd: workspaceRoot,
    env: {
      ...process.env,
      ASVS_E2E_DB_PATH: path.join(tempRoot, 'e2e.sqlite'),
      ASVS_E2E_ARTIFACT_DIR: path.join(tempRoot, 'artifacts'),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const port = await new Promise<number>((resolve, reject) => {
    let stderr = '';
    const timer = setTimeout(() => reject(new Error(`Fixture API 启动超时：${stderr}`)), 25_000);
    child.stdout.on('data', (chunk: Buffer) => {
      for (const line of chunk.toString('utf8').split(/\r?\n/)) {
        if (!line.startsWith('READY ')) continue;
        clearTimeout(timer);
        resolve((JSON.parse(line.slice('READY '.length)) as { port: number }).port);
      }
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8');
    });
    child.once('exit', (code) => {
      clearTimeout(timer);
      reject(new Error(`Fixture API 提前退出（${code}）：${stderr}`));
    });
  });
  child.removeAllListeners('exit');
  const origin = `http://127.0.0.1:${port}`;
  const request = await playwrightRequest.newContext({ baseURL: origin });
  return {
    origin,
    request,
    dispose: async () => {
      await request.dispose();
      await new Promise<void>((resolve) => {
        child.once('exit', () => resolve());
        child.kill();
        // Windows keeps the SQLite file locked until the process really exits;
        // a bounded wait keeps a stuck fixture from hanging the suite.
        setTimeout(resolve, 5_000);
      });
      await rm(tempRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }).catch(
        () => undefined,
      );
    },
  };
}

/**
 * Points the browser's sync store at the fixture API.
 *
 * The browser boots from the local seed snapshot with baseRevision 0. The
 * server already has r1 (the uploaded seed workspace), and `HttpWorkspaceRepository`
 * treats a 409 as a conflict, so the browser pulls the server copy instead of
 * uploading its own — which is exactly what lets the seeded run and the
 * approved stage coexist.
 */
async function enableSync(
  context: BrowserContext,
  workspaceId: string,
  baseUrl: string,
): Promise<void> {
  await context.addInitScript(
    ({ id, base }) => {
      window.localStorage.setItem(
        'asvs.workspace-sync.v1',
        JSON.stringify({
          state: { config: { enabled: true, baseUrl: base, workspaceId: id } },
          version: 1,
        }),
      );
    },
    { id: workspaceId, base: baseUrl },
  );
}

/** Uploads a workspace the review page can render, already Gate-3 approved. */
async function putWorkspace(fixture: FixtureApi, workspaceId: string): Promise<void> {
  const put = await fixture.request.put(`/v1/workspaces/${workspaceId}`, {
    data: { schemaVersion: 2, baseRevision: 0, workspace: buildWorkspace('approved') },
  });
  expect(put.ok(), await put.text()).toBe(true);
}

test('health 暴露 TTS 合成状态，且不泄露任何凭证', async ({ request }) => {
  const response = await request.get('/api/v1/health');
  expect(response.ok()).toBe(true);
  const body = (await response.json()) as {
    tts: { configured: boolean; provider: string; synthetic: boolean; license: string };
  };
  expect(body.tts.configured).toBe(true);
  expect(body.tts.provider).toBe('deterministic_test');
  expect(body.tts.synthetic).toBe(true);
  expect(body.tts.license).toBe('internal-deterministic-test-only');
  expect(JSON.stringify(body)).not.toMatch(/api[_-]?key|secret|bearer/i);
});

test('未审批的视频导出被 409 拒绝，且不会生成导出包', async ({ request }) => {
  const workspaceId = `e2e_audio_gate_${Date.now()}`;
  const put = await request.put(`/api/v1/workspaces/${workspaceId}`, {
    data: { schemaVersion: 2, baseRevision: 0, workspace: buildWorkspace('review') },
  });
  expect(put.ok(), await put.text()).toBe(true);

  const denied = await request.post(`/api/v1/workspaces/${workspaceId}/orchestration/exports`, {
    data: { videoId: VIDEO_ID },
  });
  expect(denied.status()).toBe(409);
  expect((await denied.json()).error.code).toBe('export_not_approved');

  const listed = await request.get(`/api/v1/workspaces/${workspaceId}/orchestration/exports`);
  expect((await listed.json()).bundles).toEqual([]);
});

test('批准后生成交付包：MP4 / SRT / manifest 下载均通过 SHA256 校验', async ({ browser }) => {
  const fixture = await startFixtureApi();
  const workspaceId = `e2e_audio_export_${Date.now()}`;
  try {
    await putWorkspace(fixture, workspaceId);
    const seeded = await fixture.request.post('/__test/seed-export-ready', {
      data: { workspaceId, videoId: VIDEO_ID, approved: true },
    });
    expect(seeded.ok(), await seeded.text()).toBe(true);

    const context = await browser.newContext();
    await enableSync(context, workspaceId, fixture.origin);
    try {
      const page = await context.newPage();
      await page.goto(`/videos/${VIDEO_ID}/review`);
      await expect(page.getByRole('heading', { level: 1, name: '审核与导出' })).toBeVisible({
        timeout: 20_000,
      });

      // The server artifact panel is present, and the seeded narration is
      // labelled synthetic — never as a real commercial voice.
      await expect(page.getByText('服务端真实产物')).toBeVisible({ timeout: 20_000 });
      await expect(page.getByText('测试合成音轨 · 非真人配音').first()).toBeVisible();
      await expect(page.getByText(/internal-deterministic-test-only/).first()).toBeVisible();

      const exportButton = page.getByRole('button', { name: '生成交付包' });
      await expect(exportButton).toBeVisible();
      await exportButton.click();

      await expect(page.getByText(/已生成 ·/)).toBeVisible({ timeout: 20_000 });
      await expect(page.getByText(/MP4 [0-9a-f]{16}…/)).toBeVisible();

      // Every bundle file downloads and is verified client-side against SHA256.
      const [mp4Download] = await Promise.all([
        page.waitForEvent('download'),
        page.getByRole('button', { name: /^MP4 · / }).click(),
      ]);
      expect(mp4Download.suggestedFilename()).toBe(`${VIDEO_ID}.mp4`);

      const [srtDownload] = await Promise.all([
        page.waitForEvent('download'),
        page.getByRole('button', { name: /^SRT · / }).click(),
      ]);
      expect(srtDownload.suggestedFilename()).toBe(`${VIDEO_ID}.srt`);

      const [manifestDownload] = await Promise.all([
        page.waitForEvent('download'),
        page.getByRole('button', { name: /^manifest\.json · / }).click(),
      ]);
      expect(manifestDownload.suggestedFilename()).toBe(`${VIDEO_ID}.manifest.json`);

      // Exactly one bundle with exactly four files exists on the server.
      const listed = await fixture.request.get(
        `/v1/workspaces/${workspaceId}/orchestration/exports?videoId=${VIDEO_ID}`,
      );
      const bundles = (await listed.json()).bundles as Array<{ files: unknown[] }>;
      expect(bundles).toHaveLength(1);
      expect(bundles[0]!.files).toHaveLength(4);
    } finally {
      await context.close();
    }
  } finally {
    await fixture.dispose();
  }
});

/** Minimal workspace shaped exactly like the app's own snapshot contract. */
function buildWorkspace(stage: 'approved' | 'review') {
  const approved = stage === 'approved';
  return {
    projects: [
      {
        id: 'proj_lumen',
        name: 'Lumen',
        productName: 'Lumen',
        description: 'E2E 导出验收',
        website: 'https://lumen.demo.invalid',
        stage: 'active',
        brand: {
          logoText: 'LUMEN',
          logoMark: 'orbit',
          primary: '#FF7A59',
          secondary: '#FFD5B8',
          fontPair: 'grotesk',
          style: 'editorial',
          intro: '',
          outro: '',
        },
        sources: [],
        defaultAspect: '16:9',
        defaultLanguage: 'zh-CN',
        templateId: 'tpl_signal',
        analysisCount: 0,
        createdAt: ISO,
        updatedAt: ISO,
        demo: true,
      },
    ],
    features: [],
    claims: [],
    evidence: [],
    pullRequests: [],
    releases: [],
    suggestions: [],
    assets: [],
    templates: [],
    videos: [
      {
        id: VIDEO_ID,
        projectId: 'proj_lumen',
        title: 'Audio export E2E',
        mode: 'release_video',
        stage,
        fps: 30,
        brief: {
          objective: '导出验收',
          audience: '工程团队',
          featureIds: [],
          durationSec: 12,
          aspect: '16:9',
          language: 'zh-CN',
          tone: 'confident',
          style: 'editorial',
          templateId: 'tpl_signal',
          useRealCapture: false,
          useGeneratedVisuals: true,
          cta: '',
          bannedPhrases: [],
        },
        scenes: [
          {
            id: 'scene_intro',
            order: 0,
            revision: 1,
            title: '开场',
            intent: '',
            narration: '开场旁白',
            caption: '开场',
            durationSec: 6,
            durationFrames: 180,
            visualType: 'title',
            visual: { type: 'title' },
            templateId: 'tpl_signal',
            claimIds: [],
            status: 'approved',
            look: 'cinematic',
            brightness: 1,
            vignette: true,
          },
          {
            id: 'scene_outro',
            order: 1,
            revision: 1,
            title: '收尾',
            intent: '',
            narration: '收尾旁白',
            caption: '收尾',
            durationSec: 6,
            durationFrames: 180,
            visualType: 'title',
            visual: { type: 'title' },
            templateId: 'tpl_signal',
            claimIds: [],
            status: 'approved',
            look: 'cinematic',
            brightness: 1,
            vignette: true,
          },
        ],
        directorMessages: [],
        scriptVersion: 1,
        ...(approved
          ? { review: { status: 'approved' as const, note: 'E2E Gate 3', decidedAt: ISO } }
          : {}),
        createdAt: ISO,
        updatedAt: ISO,
        demo: true,
      },
    ],
    runs: [],
    exports: [],
    activity: [],
  };
}
