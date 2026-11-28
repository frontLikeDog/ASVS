import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test, request as playwrightRequest } from '@playwright/test';
import type { APIRequestContext, BrowserContext, Page } from '@playwright/test';

/**
 * Slice 5C browser acceptance (WP-14, Gate 2).
 *
 * The UI is driven against the **test-only fixture API**, which installs
 * deterministic doubles for the browser and render workers. Everything the
 * spec asserts is server truth: the run really stops at `awaiting_approval`,
 * the approve call really carries the digest the page displayed, the clip is
 * really backfilled into the frozen input, every artifact really re-hashes,
 * and a failed capture really leaves report + screenshot + trace with no
 * receipt. What the doubles replace is only "drive Chromium for ~20s" and
 * "run Remotion for ~3min"; the real subprocess path is proven by
 * `pnpm gate2:verify` (CI, capture job) and `pnpm capture:demo`.
 */

const here = path.dirname(fileURLToPath(import.meta.url));
const workspaceRoot = path.resolve(here, '../../..');
const tsxCli = path.resolve(workspaceRoot, 'node_modules/tsx/dist/cli.mjs');
const fixtureScript = path.resolve(workspaceRoot, 'apps/api/src/scripts/e2e-fixture-api.ts');
const VIDEO_ID = 'vid_lumen_release';
const ISO = '2026-11-27T10:00:00.000Z';
const PRODUCTION = `/videos/${VIDEO_ID}/production`;

interface FixtureApi {
  origin: string;
  request: APIRequestContext;
  dispose: () => Promise<void>;
}

/** Boots the fixture API on an ephemeral port with its own SQLite + artifacts. */
async function startFixtureApi(): Promise<FixtureApi> {
  const tempRoot = await mkdtemp(path.join(tmpdir(), 'asvs-e2e-gate2-'));
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
 * Points the browser's sync store at the fixture API. The browser boots from
 * the local seed snapshot at baseRevision 0 while the server already has r1, so
 * the 409 makes it pull the server copy — the seeded workspace wins.
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

async function putWorkspace(fixture: FixtureApi, workspaceId: string): Promise<void> {
  const put = await fixture.request.put(`/v1/workspaces/${workspaceId}`, {
    data: { schemaVersion: 2, baseRevision: 0, workspace: buildWorkspace() },
  });
  expect(put.ok(), await put.text()).toBe(true);
}

async function setDoubles(
  fixture: FixtureApi,
  mode: 'capture_success' | 'capture_failure',
): Promise<void> {
  const response = await fixture.request.post('/__test/gate2-doubles', { data: { mode } });
  expect(response.ok(), await response.text()).toBe(true);
}

/** Creates a capture run and waits for the server to park it at Gate 2. */
async function createCaptureRun(fixture: FixtureApi, workspaceId: string) {
  const created = await fixture.request.post(
    `/v1/workspaces/${workspaceId}/orchestration/runs`,
    {
      data: {
        videoId: VIDEO_ID,
        idempotencyKey: `gate2-e2e-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        narration: { enabled: true, timingPolicy: 'extend_scene' },
        capture: {
          enabled: true,
          template: 'web_studio_knowledge_claim',
          baseUrl: 'http://localhost:4200',
          resetStrategy: 'fixture',
        },
      },
    },
  );
  expect(created.status(), await created.text()).toBe(201);
  const runId = ((await created.json()) as { run: { id: string } }).run.id;

  const deadline = Date.now() + 30_000;
  for (;;) {
    const detail = await fixture.request.get(
      `/v1/workspaces/${workspaceId}/orchestration/runs/${runId}`,
    );
    const body = (await detail.json()) as {
      run: { status: string; demoPlan?: { planDigest: string; planId: string } };
    };
    if (body.run.status === 'awaiting_approval') return { runId, plan: body.run.demoPlan! };
    if (body.run.status === 'failed' || body.run.status === 'succeeded') {
      throw new Error(`运行未停在 Gate 2：${JSON.stringify(body.run)}`);
    }
    if (Date.now() > deadline) throw new Error('等待 Gate 2 超时');
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
}

/** Reads the artifacts the Gate 2 panel renders for a run. */
async function readRunDetail(fixture: FixtureApi, workspaceId: string, runId: string) {
  const response = await fixture.request.get(
    `/v1/workspaces/${workspaceId}/orchestration/runs/${runId}`,
  );
  return (await response.json()) as {
    run: {
      status: string;
      input: { capture?: { clipSha256?: string; capturedAssetId?: string } };
      captureFailure?: { code: string; screenshotArtifactIds: string[] };
    };
    artifacts: Array<{ id: string; kind: string; sha256: string; fileName: string; metadata: Record<string, unknown> }>;
  };
}

async function waitForTerminal(
  fixture: FixtureApi,
  workspaceId: string,
  runId: string,
): Promise<Awaited<ReturnType<typeof readRunDetail>>> {
  const deadline = Date.now() + 60_000;
  for (;;) {
    const detail = await readRunDetail(fixture, workspaceId, runId);
    const status = detail.run.status;
    if (status === 'succeeded' || status === 'failed' || status === 'cancelled') return detail;
    if (Date.now() > deadline) throw new Error(`等待终态超时：${status}`);
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
}

/**
 * Opens the production page with the sync store pointed at the fixture. Without
 * `enableSync` the panel honestly reports "服务端编排未连接" and never asks the
 * server, so every Gate 2 assertion below would be testing the fallback.
 */
async function openProductionPage(
  context: BrowserContext,
  workspaceId: string,
  fixture: FixtureApi,
): Promise<Page> {
  await enableSync(context, workspaceId, fixture.origin);
  const page = await context.newPage();
  await page.goto(PRODUCTION);
  await expect(page.getByRole('heading', { level: 1, name: '生产监控' })).toBeVisible();
  await expect(page.getByText('服务端真实渲染')).toBeVisible({ timeout: 20_000 });
  return page;
}

test('Gate 2：计划挂起 → 审批绑定 planDigest → 真实录屏回填并出片', async ({ browser }) => {
  const fixture = await startFixtureApi();
  const workspaceId = `e2e_gate2_ok_${Date.now()}`;
  try {
    await putWorkspace(fixture, workspaceId);
    await setDoubles(fixture, 'capture_success');
    const { runId, plan } = await createCaptureRun(fixture, workspaceId);

    const context = await browser.newContext();
    try {
      const page = await openProductionPage(context, workspaceId, fixture);

      // The Gate 2 card restored from the server — a reload is not required
      // for it to appear, and it shows the same plan the approval binds.
      await expect(page.getByText('Gate 2 · 演示计划审批与真实录屏')).toBeVisible({ timeout: 20_000 });
      await expect(page.getByText('等待审批')).toBeVisible();
      await expect(page.getByText(plan.planId)).toBeVisible();
      // The binding card names the run (twice: DAG header and binding card).
      await expect(page.getByText(runId).first()).toBeVisible();
      await expect(page.getByText('4D 知识与声明验证').first()).toBeVisible();
      await expect(page.getByText('审批 ID')).toBeVisible();
      // Declarative steps: the row shows the semantic target and assertion the
      // worker will run — and that target is the 4D-verified claim statement
      // verbatim, which is what makes the demo "prove the claim, not fake it".
      await expect(page.getByText('每个卖点都能回到已核验的证据。 · visible contains')).toBeVisible();
      await expect(page.getByText('声明式步骤')).toBeVisible();

      // Approve with the digest the card displayed. The server re-derives it
      // and refuses anything else, so a page that showed a stale plan could
      // never get here.
      await page.getByRole('button', { name: '批准 Gate 2 并启动录屏' }).click();

      // The run resumes on the server and the panel switches to the evidence.
      await expect(page.getByText('真实录屏已回填到渲染输入')).toBeVisible({ timeout: 30_000 });
      await expect(page.getByText('已出片')).toBeVisible();
      await expect(page.getByText(/全部真实录屏/)).toBeVisible();

      const detail = await waitForTerminal(fixture, workspaceId, runId);
      expect(detail.run.status).toBe('succeeded');
      const kinds = detail.artifacts.map((artifact) => artifact.kind);
      expect(kinds).toEqual(
        expect.arrayContaining(['capture_clip', 'capture_receipt', 'capture_screenshot', 'video_mp4', 'subtitles_srt']),
      );

      // The clip the panel offers really is the clip the render used: the
      // backfilled hash, the artifact row and a fresh download all agree.
      const clip = detail.artifacts.find((artifact) => artifact.kind === 'capture_clip')!;
      expect(clip.sha256).toBe(detail.run.input.capture?.clipSha256);
      expect(clip.metadata.stepKey).toBe('capture_demo');
      const downloaded = await fixture.request.get(
        `/v1/workspaces/${workspaceId}/orchestration/artifacts/${clip.id}/download`,
      );
      expect(downloaded.ok()).toBe(true);
      expect(downloaded.headers()['x-content-sha256']).toBe(clip.sha256);
      expect(downloaded.headers()['x-content-type-options']).toBe('nosniff');

      // Clicking the download button verifies the SHA256 client-side **before**
      // the browser is handed any file: `downloadVerifiedArtifact` throws on a
      // mismatch, so a `download` event can only fire for a byte-exact file.
      // The button also returns to its idle label — never stuck at "校验中…".
      const [download] = await Promise.all([
        page.waitForEvent('download'),
        page.getByRole('button', { name: '下载录屏片段' }).click(),
      ]);
      expect(download.suggestedFilename()).toMatch(/\.mp4$/);
      await expect(page.getByRole('button', { name: '下载录屏片段' })).toBeVisible();
      // No error box: the panel never reported a hash mismatch for this clip.
      await expect(page.getByText(/SHA256 不匹配/)).toHaveCount(0);

      // The capture receipt is downloadable too, and is the same file the
      // clip hash came from.
      const receipt = detail.artifacts.find((artifact) => artifact.kind === 'capture_receipt')!;
      const receiptResponse = await fixture.request.get(
        `/v1/workspaces/${workspaceId}/orchestration/artifacts/${receipt.id}/download`,
      );
      const receiptBody = (await receiptResponse.json()) as {
        planDigest: string;
        clip: { sha256: string };
      };
      expect(receiptBody.planDigest).toBe(plan.planDigest);
      expect(receiptBody.clip.sha256).toBe(clip.sha256);
    } finally {
      await context.close();
    }
  } finally {
    await fixture.dispose();
  }
});

test('Gate 2：修改计划会让旧摘要失效，新审批才能启动录屏', async ({ browser }) => {
  const fixture = await startFixtureApi();
  const workspaceId = `e2e_gate2_edit_${Date.now()}`;
  try {
    await putWorkspace(fixture, workspaceId);
    await setDoubles(fixture, 'capture_success');
    const { runId, plan: firstPlan } = await createCaptureRun(fixture, workspaceId);

    const context = await browser.newContext();
    try {
      const page = await openProductionPage(context, workspaceId, fixture);
      await expect(page.getByText('Gate 2 · 演示计划审批与真实录屏')).toBeVisible({ timeout: 20_000 });

      // Editing the waiting plan is a server round trip that supersedes the
      // approval: the digest changes, the old approval id cannot be approved.
      await page.getByRole('button', { name: '修改计划' }).click();
      await page.getByLabel('重置策略').selectOption('none');
      await page.getByRole('button', { name: '保存修改并重新审批' }).click();
      // The form closes only after the server accepted the edit and returned a
      // fresh approval, so the edit button is back and the hint is gone.
      await expect(page.getByRole('button', { name: '修改计划' })).toBeVisible({ timeout: 20_000 });
      await expect(
        page.getByText('保存后服务端会重新计算 planDigest 并作废当前审批 ID（superseded）；旧摘要不能再用于批准。'),
      ).toHaveCount(0);

      const editedRun = await fixture.request.get(
        `/v1/workspaces/${workspaceId}/orchestration/runs/${runId}`,
      );
      const editedBody = (await editedRun.json()) as {
        run: { status: string; demoPlan?: { planDigest: string }; approval?: { approvalId: string; status: string } };
      };
      expect(editedBody.run.status).toBe('awaiting_approval');
      expect(editedBody.run.demoPlan?.planDigest).not.toBe(firstPlan.planDigest);
      expect(editedBody.run.approval?.status).toBe('pending');

      // The superseded digest is refused with a 409, not silently accepted.
      const stale = await fixture.request.post(
        `/v1/workspaces/${workspaceId}/orchestration/runs/${runId}/approve`,
        { data: { approvalId: editedBody.run.approval!.approvalId, subjectDigest: firstPlan.planDigest } },
      );
      expect(stale.status()).toBe(409);
      expect(((await stale.json()) as { error: { code: string } }).error.code).toBe(
        'approval_subject_mismatch',
      );
    } finally {
      await context.close();
    }
  } finally {
    await fixture.dispose();
  }
});

test('Gate 2：录屏失败留下报告 / 截图 / trace，绝不伪造回执', async ({ browser }) => {
  const fixture = await startFixtureApi();
  const workspaceId = `e2e_gate2_fail_${Date.now()}`;
  try {
    await putWorkspace(fixture, workspaceId);
    await setDoubles(fixture, 'capture_failure');
    const { runId } = await createCaptureRun(fixture, workspaceId);

    const context = await browser.newContext();
    try {
      const page = await openProductionPage(context, workspaceId, fixture);
      await expect(page.getByText('Gate 2 · 演示计划审批与真实录屏')).toBeVisible({ timeout: 20_000 });
      await page.getByRole('button', { name: '批准 Gate 2 并启动录屏' }).click();

      // The failure panel names the code and the failed step, and shows the
      // screenshot taken at the moment the assertion refused the page.
      await expect(page.getByText(/真实录屏失败 · capture_assertion_failed/)).toBeVisible({
        timeout: 30_000,
      });
      // `失败步骤` is the Fact label; the same words also appear in the DAG
      // header and the retry row, so scope to the first occurrence.
      await expect(page.getByText('失败步骤').first()).toBeVisible();
      await expect(page.getByText('dashboard-ready').first()).toBeVisible();
      await expect(page.getByRole('img', { name: /失败现场截图/ })).toBeVisible({ timeout: 20_000 });

      const detail = await waitForTerminal(fixture, workspaceId, runId);
      expect(detail.run.status).toBe('failed');
      expect(detail.run.captureFailure?.code).toBe('capture_assertion_failed');
      const kinds = detail.artifacts.map((artifact) => artifact.kind);
      expect(kinds).toEqual(
        expect.arrayContaining(['capture_failure_report', 'capture_screenshot', 'capture_trace']),
      );
      // A failed capture never writes a receipt and never backfills the input.
      expect(kinds).not.toContain('capture_receipt');
      expect(kinds).not.toContain('capture_clip');
      expect(kinds).not.toContain('video_mp4');
      expect(detail.run.input.capture?.clipSha256).toBeUndefined();
      expect(detail.run.input.capture?.capturedAssetId).toBeUndefined();

      // The failure report downloads and is the same file the panel names.
      const report = detail.artifacts.find((artifact) => artifact.kind === 'capture_failure_report')!;
      const [reportDownload] = await Promise.all([
        page.waitForEvent('download'),
        page.getByRole('button', { name: '下载 failure-report.json' }).click(),
      ]);
      expect(reportDownload.suggestedFilename()).toBe(report.fileName);
    } finally {
      await context.close();
    }
  } finally {
    await fixture.dispose();
  }
});

test('Gate 2：未启用录屏时两个步骤在创建即跳过，DAG 仍完整', async ({ browser }) => {
  const fixture = await startFixtureApi();
  const workspaceId = `e2e_gate2_off_${Date.now()}`;
  try {
    await putWorkspace(fixture, workspaceId);
    const created = await fixture.request.post(
      `/v1/workspaces/${workspaceId}/orchestration/runs`,
      {
        data: {
          videoId: VIDEO_ID,
          idempotencyKey: `gate2-off-${Date.now()}`,
          narration: { enabled: true },
          capture: { enabled: false },
        },
      },
    );
    expect(created.status(), await created.text()).toBe(201);
    const runId = ((await created.json()) as { run: { id: string } }).run.id;
    const detail = await readRunDetail(fixture, workspaceId, runId);
    const byKey = new Map(
      (detail as unknown as { run: { steps: Array<{ stepKey: string; status: string }> } }).run.steps.map(
        (step) => [step.stepKey, step.status],
      ),
    );
    expect(byKey.get('plan_demo')).toBe('skipped');
    expect(byKey.get('capture_demo')).toBe('skipped');
    expect(byKey.size).toBe(9);

    const context = await browser.newContext();
    try {
      const page = await openProductionPage(context, workspaceId, fixture);
      // The two capture steps are shown (the DAG stays complete) but marked
      // skipped, and no Gate 2 card is mounted: there is no plan to approve.
      const captureRow = page.getByText('受控真实录屏').locator('..');
      await expect(captureRow.getByText('已跳过')).toBeVisible({ timeout: 20_000 });
      await expect(page.getByText('生成演示计划').locator('..').getByText('已跳过')).toBeVisible();
      await expect(page.getByText('Gate 2 · 演示计划审批与真实录屏')).toHaveCount(0);
      // The server's own event log says why, rather than leaving the reviewer
      // to guess why the two steps never ran.
      await expect(
        page.getByText('未请求真实录屏：plan_demo / capture_demo 已标记为 skipped。'),
      ).toBeVisible();
    } finally {
      await context.close();
    }
  } finally {
    await fixture.dispose();
  }
});

/** Workspace with one 4D-verified feature/claim and a `real_demo` scene. */
function buildWorkspace() {
  return {
    projects: [
      {
        id: 'proj_lumen',
        name: 'Lumen',
        productName: 'Lumen',
        description: 'Gate 2 E2E',
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
    features: [
      {
        id: 'feat_lumen_collab',
        projectId: 'proj_lumen',
        name: '知识中心',
        summary: '功能、声明与证据',
        category: '知识',
        status: 'verified',
        confidence: 92,
        userConfirmed: true,
        sourceRefs: [],
        claimIds: ['claim_lumen_collab'],
        prIds: [],
        demoRoute: '/videos',
        updatedAt: ISO,
        tags: [],
        demo: true,
      },
    ],
    claims: [
      {
        id: 'claim_lumen_collab',
        projectId: 'proj_lumen',
        featureId: 'feat_lumen_collab',
        statement: '每个卖点都能回到已核验的证据。',
        audience: '产品经理',
        status: 'verified',
        eligibility: 'publishable',
        evidenceIds: [],
        demo: true,
      },
    ],
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
        title: 'Gate 2 E2E',
        mode: 'release_video',
        stage: 'review',
        fps: 30,
        brief: {
          objective: 'Gate 2 录屏验收',
          audience: '工程团队',
          featureIds: ['feat_lumen_collab'],
          durationSec: 12,
          aspect: '16:9',
          language: 'zh-CN',
          tone: 'confident',
          style: 'editorial',
          templateId: 'tpl_signal',
          useRealCapture: true,
          useGeneratedVisuals: false,
          cta: '',
          bannedPhrases: [],
        },
        scenes: [
          {
            id: 'scene_demo',
            order: 0,
            revision: 1,
            title: '真实界面',
            intent: '',
            narration: '这是真实的界面。',
            caption: '真实界面',
            durationSec: 6,
            visualType: 'real_demo',
            templateId: 'tpl_signal',
            featureId: 'feat_lumen_collab',
            claimIds: ['claim_lumen_collab'],
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
            narration: '收尾旁白。',
            caption: '收尾',
            durationSec: 6,
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
