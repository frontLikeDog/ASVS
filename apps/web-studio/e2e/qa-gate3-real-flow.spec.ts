import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test, request as playwrightRequest } from '@playwright/test';
import type { APIRequestContext, BrowserContext, Page } from '@playwright/test';

/**
 * Slice 5D browser acceptance (WP-16, Gate 3 + AC-07).
 *
 * The UI is driven against the **test-only fixture API**, which installs a
 * structural QA double. What the spec proves is the *gate*: a privacy-blocked
 * report really fails the run, the review page really disables both approve
 * buttons, the deep link really lands on the reported scene, a passing report
 * really opens export, and an offline page really degrades honestly.
 *
 * What the double does NOT prove is that the scanner finds secrets — that is
 * `pnpm qa:verify`, which runs the production runner over real ffmpeg media,
 * a real trace.zip and real PNG text chunks. The double always reports
 * `ocrSynthetic: true`, so nothing here can imply a pixel was read.
 */

const here = path.dirname(fileURLToPath(import.meta.url));
const workspaceRoot = path.resolve(here, '../../..');
const tsxCli = path.resolve(workspaceRoot, 'node_modules/tsx/dist/cli.mjs');
const fixtureScript = path.resolve(workspaceRoot, 'apps/api/src/scripts/e2e-fixture-api.ts');
const VIDEO_ID = 'vid_qa_gate3';
const ISO = '2026-11-28T10:00:00.000Z';
const REVIEW = `/videos/${VIDEO_ID}/review`;
const PRODUCTION = `/videos/${VIDEO_ID}/production`;

interface FixtureApi {
  origin: string;
  request: APIRequestContext;
  dispose: () => Promise<void>;
}

async function startFixtureApi(): Promise<FixtureApi> {
  const tempRoot = await mkdtemp(path.join(tmpdir(), 'asvs-e2e-qa-'));
  const child = spawn(
    process.execPath,
    [tsxCli, '--tsconfig', 'apps/api/tsconfig.json', fixtureScript],
    {
      cwd: workspaceRoot,
      env: {
        ...process.env,
        ASVS_E2E_DB_PATH: path.join(tempRoot, 'e2e.sqlite'),
        ASVS_E2E_ARTIFACT_DIR: path.join(tempRoot, 'artifacts'),
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  const port = await new Promise<number>((resolve, reject) => {
    let stderr = '';
    const timer = setTimeout(() => reject(new Error(`Fixture API 启动超时：${stderr}`)), 25_000);
    child.stdout?.on('data', (chunk: Buffer) => {
      for (const line of chunk.toString('utf8').split(/\r?\n/)) {
        if (!line.startsWith('READY ')) continue;
        clearTimeout(timer);
        resolve((JSON.parse(line.slice('READY '.length)) as { port: number }).port);
      }
    });
    child.stderr?.on('data', (chunk: Buffer) => {
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
        setTimeout(resolve, 5_000);
      });
      await rm(tempRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }).catch(
        () => undefined,
      );
    },
  };
}

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

async function putWorkspace(fixture: FixtureApi, workspaceId: string): Promise<void> {
  const put = await fixture.request.put(`/v1/workspaces/${workspaceId}`, {
    data: { schemaVersion: 2, baseRevision: 0, workspace: buildWorkspace() },
  });
  expect(put.ok(), await put.text()).toBe(true);
}

async function setQaMode(fixture: FixtureApi, mode: 'pass' | 'privacy_block'): Promise<void> {
  const response = await fixture.request.post('/__test/qa-double', { data: { mode } });
  expect(response.ok(), await response.text()).toBe(true);
}

/** Creates a run with capture disabled: no Gate 2, straight through to QA. */
async function createRun(fixture: FixtureApi, workspaceId: string): Promise<string> {
  const created = await fixture.request.post(
    `/v1/workspaces/${workspaceId}/orchestration/runs`,
    {
      data: {
        videoId: VIDEO_ID,
        idempotencyKey: `qa-e2e-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        narration: { enabled: true, timingPolicy: 'extend_scene' },
        capture: { enabled: false },
      },
    },
  );
  expect(created.status(), await created.text()).toBe(201);
  return ((await created.json()) as { run: { id: string } }).run.id;
}

interface RunDetail {
  run: { id: string; status: string; failure?: { code: string }; scriptVersion: number };
  artifacts: Array<{ id: string; kind: string; sha256: string; metadata: Record<string, unknown> }>;
}

async function waitForTerminal(
  fixture: FixtureApi,
  workspaceId: string,
  runId: string,
): Promise<RunDetail> {
  const deadline = Date.now() + 60_000;
  for (;;) {
    const response = await fixture.request.get(
      `/v1/workspaces/${workspaceId}/orchestration/runs/${runId}`,
    );
    const detail = (await response.json()) as RunDetail;
    if (['succeeded', 'failed', 'cancelled'].includes(detail.run.status)) return detail;
    if (Date.now() > deadline) throw new Error(`等待终态超时：${detail.run.status}`);
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
}

test('Gate 3 · AC-07：隐私阻断的 QA 报告定位到镜头，批准与导出均被禁用', async ({ browser }) => {
  const fixture = await startFixtureApi();
  const workspaceId = `e2e_qa_block_${Date.now()}`;
  try {
    await putWorkspace(fixture, workspaceId);
    await setQaMode(fixture, 'privacy_block');
    const runId = await createRun(fixture, workspaceId);
    const detail = await waitForTerminal(fixture, workspaceId, runId);

    // Server truth first: the run really died on QA, not on something else.
    expect(detail.run.status).toBe('failed');
    expect(detail.run.failure?.code).toBe('qa_privacy_blocked');
    const evidence = detail.artifacts.filter((artifact) => artifact.kind === 'qa_evidence_frame');
    expect(evidence).toHaveLength(1);
    expect(evidence[0]!.metadata.redacted).toBe(true);

    const context = await browser.newContext();
    try {
      await enableSync(context, workspaceId, fixture.origin);
      const page = await context.newPage();

      // The production page names the QA failure code and links to the report,
      // so a reviewer who watched the run fail has one obvious next step.
      await page.goto(PRODUCTION);
      await expect(page.getByText('服务端真实渲染')).toBeVisible({ timeout: 20_000 });
      await expect(page.getByText('运行失败 · qa_privacy_blocked')).toBeVisible({
        timeout: 20_000,
      });
      await page.getByRole('link', { name: /到审核页查看独立 QA 报告与定位/ }).click();
      expect(new URL(page.url()).pathname).toBe(REVIEW);

      const panel = page.getByText('独立 QA 报告').first();
      await expect(panel).toBeVisible({ timeout: 20_000 });
      await expect(page.getByText('已阻断').first()).toBeVisible();
      await expect(page.getByText('独立 QA 已阻断：修复后重新运行')).toBeVisible();
      // AC-07 evidence is located, not a flat list: scene + timestamp + step.
      await expect(page.getByText('第 2 镜').first()).toBeVisible();
      await expect(page.getByText('产品演示').first()).toBeVisible();
      await expect(page.getByText('privacy.email_address').first()).toBeVisible();
      await expect(page.getByText('trace.network#1 (request.headers.authorization)')).toBeVisible();

      // Only the masked sample is rendered; the raw address is nowhere in the DOM.
      await expect(page.getByText('a***@corp.internal')).toBeVisible();
      const html = await page.content();
      expect(html).not.toContain('alice.secret@corp.internal');
      expect(html).not.toContain('a***@corp.internal'.replace('***', 'lice'));

      // The evidence preview really loads a server-registered artifact — the
      // exact one the API listed, fetched through the `?inline=1` route that
      // serves it with `nosniff` so the browser cannot re-interpret it.
      const preview = page.getByRole('img', { name: /服务端脱敏证据帧/ });
      await expect(preview).toBeVisible();
      const src = await preview.getAttribute('src');
      expect(src).toContain(`/artifacts/${evidence[0]!.id}?inline=1`);
      const inline = await fixture.request.get(
        `/v1/workspaces/${workspaceId}/orchestration/artifacts/${evidence[0]!.id}?inline=1`,
      );
      expect(inline.ok()).toBe(true);
      expect(inline.headers()['x-content-type-options']).toBe('nosniff');
      expect(inline.headers()['content-type']).toContain('image/png');

      // Both gates are closed: approving and packaging are refused by the
      // page. The approve button appears twice (header + sticky footer), and
      // both are disabled with the same QA reason.
      const blockedApproves = page.getByRole('button', { name: '等待 QA 通过' });
      await expect(blockedApproves).toHaveCount(2);
      await expect(blockedApproves.first()).toBeDisabled();
      await expect(blockedApproves.first()).toHaveAttribute(
        'title',
        /服务端独立 QA 已阻断本次运行：1 项阻断，其中 1 项为 AC-07 隐私命中/,
      );
      // The bundle section is stricter than a disabled button: the blocked run
      // produced no MP4, so there is nothing to package at all. A disabled
      // 「生成交付包」 button would be a weaker (and wrong) signal here.
      await expect(page.getByRole('button', { name: /生成交付包|需先通过 Gate 3/ })).toHaveCount(0);
      await expect(page.getByText('还没有服务端渲染的真实 MP4')).toBeVisible();
    } finally {
      await context.close();
    }
  } finally {
    await fixture.dispose();
  }
});

test('Gate 3 · 定位直达：从 QA 卡片跳到编辑器并选中对应镜头', async ({ browser }) => {
  const fixture = await startFixtureApi();
  const workspaceId = `e2e_qa_deeplink_${Date.now()}`;
  try {
    await putWorkspace(fixture, workspaceId);
    await setQaMode(fixture, 'privacy_block');
    const runId = await createRun(fixture, workspaceId);
    await waitForTerminal(fixture, workspaceId, runId);

    const context = await browser.newContext();
    try {
      await enableSync(context, workspaceId, fixture.origin);
      const page = await context.newPage();
      await page.goto(REVIEW);
      await expect(page.getByText('独立 QA 报告').first()).toBeVisible({ timeout: 20_000 });

      await page.getByRole('link', { name: /定位到第 2 镜/ }).first().click();
      await expect(page).toHaveURL(/\/editor\?scene=scene_e2e_2$/);
      // The editor selects the scene the report named, not just the video.
      await expect(page.getByText('产品演示').first()).toBeVisible();
    } finally {
      await context.close();
    }
  } finally {
    await fixture.dispose();
  }
});

test('Gate 3 · 通过与交付：QA 通过（含 1 条提醒）后可批准并生成含 qa-report.json 的交付包', async ({
  browser,
}) => {
  const fixture = await startFixtureApi();
  const workspaceId = `e2e_qa_pass_${Date.now()}`;
  try {
    await putWorkspace(fixture, workspaceId);
    await setQaMode(fixture, 'pass');
    const runId = await createRun(fixture, workspaceId);
    const detail = await waitForTerminal(fixture, workspaceId, runId);
    expect(detail.run.status).toBe('succeeded');
    const qaArtifact = detail.artifacts.find(
      (artifact) => artifact.kind === 'qa_report' && artifact.metadata.stage === 'final',
    );
    expect(qaArtifact).toBeTruthy();

    // `approved: true` seeds a succeeded production run *and* flips the video
    // to approved — the only state the export route accepts. Approving through
    // the UI's own local checks is the other specs' job (review.spec.ts).
    const seeded = await fixture.request.post('/__test/seed-export-ready', {
      data: { workspaceId, videoId: VIDEO_ID, approved: true },
    });
    expect(seeded.ok(), await seeded.text()).toBe(true);
    const seededRunId = ((await seeded.json()) as { runId: string }).runId;

    const context = await browser.newContext();
    try {
      await enableSync(context, workspaceId, fixture.origin);
      const page = await context.newPage();
      await page.goto(REVIEW);

      await expect(page.getByText('独立 QA 报告').first()).toBeVisible({ timeout: 20_000 });
      // The newest report for the video is the seeded `pass` one, which is also
      // the run this case exports — so the panel and the bundle agree.
      await expect(page.getByText('四个维度均未发现问题')).toBeVisible();
      await expect(page.getByText('已通过审核').first()).toBeVisible();
      // Coverage is shown honestly, including the synthetic-OCR label.
      await expect(page.getByText('成片帧').first()).toBeVisible();
      await expect(page.getByText('测试 OCR · 非真实识别')).toBeVisible();

      // Gate 3 is open: the QA gate did not disable anything.
      await expect(page.getByText('等待 QA 通过')).toHaveCount(0);
      await expect(page.getByRole('button', { name: /生成交付包/ })).toBeEnabled();
      // The QA report panel offers no blocking callout.
      await expect(page.getByText('独立 QA 已阻断：修复后重新运行')).toHaveCount(0);

      // The bundle really contains the QA report the panel showed, and the
      // advertised bytes really are those bytes — never a re-serialized copy.
      const bundleResponse = await fixture.request.post(
        `/v1/workspaces/${workspaceId}/orchestration/exports`,
        { data: { videoId: VIDEO_ID, runId: seededRunId } },
      );
      expect(bundleResponse.status(), await bundleResponse.text()).toBe(201);
      const bundle = (await bundleResponse.json()) as {
        files: Array<{
          artifactId: string;
          kind: string;
          fileName: string;
          sha256: string;
          downloadUrl: string;
        }>;
      };
      expect(bundle.files).toHaveLength(5);
      const qaFile = bundle.files.find((file) => file.kind === 'qa_report');
      expect(qaFile).toBeTruthy();
      // Two different runs each carry a `qa_final` report. The bundle must ship
      // the one bound to the run it exports (the seed), not the QA-double run's
      // report — compare by the hash on disk, which is what the gate checks.
      expect(qaFile!.sha256).toMatch(/^[a-f0-9]{64}$/);
      expect(qaFile!.sha256).not.toBe(qaArtifact!.sha256);

      const download = await fixture.request.get(qaFile!.downloadUrl);
      expect(download.ok()).toBe(true);
      expect(download.headers()['x-content-sha256']).toBe(qaFile!.sha256);
      expect(download.headers()['x-content-type-options']).toBe('nosniff');
      const reportText = await download.text();
      expect(JSON.parse(reportText).stage).toBe('final');
      // AC-07 red line 3 holds in the exported copy too.
      expect(reportText).not.toContain('alice.secret@corp.internal');
    } finally {
      await context.close();
    }
  } finally {
    await fixture.dispose();
  }
});

test('Gate 3 · 离线降级：未连接服务端时审核页不崩溃并诚实提示', async ({ page }) => {
  // No fixture API and no sync config: the browser runs on its local seed,
  // which is the offline case. The page must still render its normal Gate 3
  // content, and the QA panel must say "not connected" rather than showing a
  // fabricated pass — nothing here may claim the video was privacy-checked.
  await page.goto('/videos/vid_lumen_release/review');
  await expect(page.getByRole('heading', { level: 1, name: '审核与导出' })).toBeVisible({
    timeout: 20_000,
  });
  await expect(page.getByText('当前未连接服务端独立 QA')).toBeVisible();
  await expect(page.getByText(/隐私守门.*真实结论/s)).toBeVisible();
  // No report card and no verdict badge: nothing was checked, so nothing is
  // shown. Critically, the "QA blocked" banner is absent too — an offline page
  // must not invent a block any more than it may invent a pass.
  await expect(page.getByText('独立 QA 报告')).toHaveCount(0);
  await expect(page.getByText('已阻断')).toHaveCount(0);
  await expect(page.getByText(/服务端独立 QA 阻断/)).toHaveCount(0);
  await expect(page.getByText('等待 QA 通过')).toHaveCount(0);
});

function buildWorkspace() {
  return {
    projects: [
      {
        id: 'proj_qa',
        name: 'QA Gate 3',
        productName: 'QA Gate 3',
        description: 'Step 5D E2E',
        website: 'https://qa-gate3.demo.invalid',
        stage: 'active',
        brand: {
          logoText: 'QAG',
          logoMark: 'orbit',
          primary: '#38BDF8',
          secondary: '#0F172A',
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
        projectId: 'proj_qa',
        title: 'QA Gate 3 E2E',
        mode: 'release_video',
        stage: 'review',
        fps: 30,
        brief: {
          objective: 'Gate 3 QA 验收',
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
          cta: '立即体验',
          bannedPhrases: [],
        },
        scenes: [
          {
            id: 'scene_e2e_1',
            order: 0,
            revision: 1,
            title: '开场',
            intent: '',
            narration: '开场旁白。',
            caption: '开场',
            durationSec: 4,
            visualType: 'title',
            templateId: 'tpl_signal',
            claimIds: [],
            status: 'approved',
            look: 'cinematic',
            brightness: 1,
            vignette: true,
          },
          {
            id: 'scene_e2e_2',
            order: 1,
            revision: 1,
            title: '产品演示',
            intent: '',
            narration: '这是产品演示。',
            caption: '产品演示',
            durationSec: 4,
            visualType: 'title',
            templateId: 'tpl_signal',
            claimIds: [],
            status: 'approved',
            look: 'cinematic',
            brightness: 1,
            vignette: true,
          },
          {
            id: 'scene_e2e_3',
            order: 2,
            revision: 1,
            title: '结尾',
            intent: '',
            narration: '立即体验。',
            caption: '结尾',
            durationSec: 4,
            visualType: 'title',
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
