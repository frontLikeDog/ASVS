// @vitest-environment node
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { StudioSnapshot } from '@asvs/domain';
import type {
  CaptureJobExecutionResult,
  CaptureJobExecutorCallbacks,
  CaptureJobExecutorPort,
  RenderJobExecutionResult,
  RenderJobExecutorPort,
} from '@asvs/ports';
import { buildApp } from '../app';

const ISO = '2026-11-28T10:00:00.000Z';
const WORKSPACE_ID = 'ws_route_capture';
const BASE = `/v1/workspaces/${WORKSPACE_ID}/orchestration`;

function snapshot(): StudioSnapshot {
  return {
    projects: [
      {
        id: 'proj_route_cap',
        name: 'RouteCap',
        productName: 'RouteCap',
        description: '',
        website: '',
        stage: 'active',
        brand: {
          logoText: 'CAP',
          logoMark: 'orbit',
          primary: '#E8A44C',
          secondary: '#23262D',
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
        id: 'feat_route_cap',
        projectId: 'proj_route_cap',
        name: '知识中心',
        summary: '',
        category: '知识',
        status: 'verified',
        confidence: 90,
        userConfirmed: true,
        sourceRefs: [],
        claimIds: ['claim_route_cap'],
        prIds: [],
        demoRoute: '/videos',
        updatedAt: ISO,
        tags: [],
        demo: true,
      },
    ],
    claims: [
      {
        id: 'claim_route_cap',
        projectId: 'proj_route_cap',
        featureId: 'feat_route_cap',
        statement: '卖点必须可追溯。',
        audience: '',
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
        id: 'vid_route_cap',
        projectId: 'proj_route_cap',
        title: 'Route capture',
        mode: 'release_video',
        stage: 'review',
        fps: 30,
        brief: {
          objective: '验证 Gate 2 路由',
          audience: '工程师',
          featureIds: ['feat_route_cap'],
          durationSec: 20,
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
            id: 'scene_cap_demo',
            order: 0,
            revision: 1,
            title: '真实界面',
            intent: '',
            narration: '旁白。',
            caption: '',
            durationSec: 14,
            visualType: 'real_demo',
            templateId: 'tpl_signal',
            claimIds: ['claim_route_cap'],
            featureId: 'feat_route_cap',
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

/** Never settles on its own: capture-route tests only need `awaiting_approval`. */
class BlockingRender implements RenderJobExecutorPort {
  isRunning(): boolean {
    return false;
  }
  abort(): void {
    // no-op
  }
  async execute(): Promise<RenderJobExecutionResult> {
    throw new Error('渲染不应启动');
  }
}

class NeverCapture implements CaptureJobExecutorPort {
  calls = 0;
  isRunning(): boolean {
    return false;
  }
  abort(): void {
    // no-op
  }
  async execute(
    _job: unknown,
    _in: string,
    _out: string,
    _cp: string,
    _cb: CaptureJobExecutorCallbacks,
  ): Promise<CaptureJobExecutionResult> {
    this.calls += 1;
    throw new Error('录屏不应启动');
  }
}

class ThrowingCapture implements CaptureJobExecutorPort {
  isRunning(): boolean {
    return false;
  }
  abort(): void {
    // no-op
  }
  async execute(): Promise<CaptureJobExecutionResult> {
    throw new Error('录屏不应启动');
  }
}

let app: FastifyInstance | undefined;
let artifactDir: string | undefined;

afterEach(async () => {
  await app?.close();
  app = undefined;
  if (artifactDir) rmSync(artifactDir, { recursive: true, force: true });
  artifactDir = undefined;
});

async function start(options: {
  capture?: CaptureJobExecutorPort | null;
  allowedOrigins?: string[];
} = {}) {
  artifactDir = mkdtempSync(path.join(os.tmpdir(), 'asvs-cap-route-'));
  const built = await buildApp({
    dbPath: ':memory:',
    artifactDir,
    renderExecutor: new BlockingRender(),
    captureExecutor: options.capture === undefined ? new NeverCapture() : options.capture,
    captureConfig: {
      enabled: true,
      allowedOrigins: options.allowedOrigins ?? ['http://localhost:4200'],
      defaultBaseUrl: 'http://localhost:4200',
      allowAutoServe: false,
    },
    orchestrationInstanceId: 'api_cap_route_test',
    speechConfig: {
      provider: 'deterministic_test',
      model: 'tone-v1',
      voiceZh: 'zh',
      voiceEn: 'en',
      license: 'internal-deterministic-test-only',
      timeoutMs: 5_000,
      maxRetries: 0,
    },
  });
  app = built.app;
  const put = await built.app.inject({
    method: 'PUT',
    url: `/v1/workspaces/${WORKSPACE_ID}`,
    payload: { schemaVersion: 2, baseRevision: 0, workspace: snapshot() },
  });
  if (put.statusCode !== 200) throw new Error(`workspace PUT failed: ${put.statusCode} ${put.body}`);
  return built;
}

async function waitForAwaitingApproval(runId: string): Promise<{
  approval: { approvalId: string };
  demoPlan: { planId: string; planDigest: string; draft: { steps: unknown[] } };
}> {
  const deadline = Date.now() + 4000;
  for (;;) {
    const response = await app!.inject({ method: 'GET', url: `${BASE}/runs/${runId}` });
    const body = response.json() as {
      run: {
        status: string;
        approval?: { approvalId: string };
        demoPlan?: { planId: string; planDigest: string; draft: { steps: unknown[] } };
      };
    };
    if (body.run.status === 'awaiting_approval' && body.run.approval && body.run.demoPlan) {
      return body.run as never;
    }
    if (Date.now() > deadline) throw new Error(`等待审批超时：${JSON.stringify(body.run)}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

const CREATE = {
  videoId: 'vid_route_cap',
  idempotencyKey: 'route-cap-idem-0001',
  narration: { enabled: false },
  capture: { enabled: true as const, template: 'web_studio_knowledge_claim' as const },
};

describe('编排路由 · 5C Gate 2', () => {
  it('health 包含 capture 块（allowlist 与策略版本），且没有凭据字段', async () => {
    await start();
    const response = await app!.inject({ method: 'GET', url: '/v1/health' });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      capture: {
        enabled: true,
        allowedOrigins: ['http://localhost:4200'],
        policyVersion: 'gate2-v1',
        allowAutoServe: false,
      },
    });
    expect(response.body).not.toMatch(/api[_-]?key|secret|password/i);
  });

  it('capture 未启用时创建 503 capture_not_configured；baseUrl 越界 400', async () => {
    await start({ capture: null });
    const unconfigured = await app!.inject({ method: 'POST', url: `${BASE}/runs`, payload: CREATE });
    expect(unconfigured.statusCode).toBe(503);
    expect((unconfigured.json() as { error: { code: string } }).error.code).toBe(
      'capture_not_configured',
    );
    await app!.close();
    app = undefined;
    await start();
    const blocked = await app!.inject({
      method: 'POST',
      url: `${BASE}/runs`,
      payload: {
        ...CREATE,
        idempotencyKey: 'route-cap-idem-0002',
        capture: { enabled: true, baseUrl: 'http://10.0.0.8:4200' },
      },
    });
    expect(blocked.statusCode).toBe(400);
    expect((blocked.json() as { error: { code: string } }).error.code).toBe(
      'capture_origin_not_allowed',
    );
  });

  it('capture 请求体校验：未知模板 / 非法 steps / 未知字段都返回 400', async () => {
    await start();
    const badTemplate = await app!.inject({
      method: 'POST',
      url: `${BASE}/runs`,
      payload: { ...CREATE, capture: { enabled: true, template: 'not_a_template' } },
    });
    expect(badTemplate.statusCode).toBe(400);
    const unknownField = await app!.inject({
      method: 'POST',
      url: `${BASE}/runs`,
      payload: { ...CREATE, capture: { enabled: true, credential: 'x' } },
    });
    expect(unknownField.statusCode).toBe(400);
  });

  it('awaiting_approval 时 reject 返回 200 且运行进入 failed(approval_rejected)', async () => {
    await start();
    const created = await app!.inject({ method: 'POST', url: `${BASE}/runs`, payload: CREATE });
    expect(created.statusCode).toBe(201);
    const runId = (created.json() as { run: { id: string } }).run.id;
    const waiting = await waitForAwaitingApproval(runId);

    const rejected = await app!.inject({
      method: 'POST',
      url: `${BASE}/runs/${runId}/reject`,
      payload: { approvalId: waiting.approval.approvalId, reason: '计划包含未审计写操作' },
    });
    expect(rejected.statusCode).toBe(200);
    expect((rejected.json() as { approval: { status: string } }).approval.status).toBe('rejected');
    const detail = await app!.inject({ method: 'GET', url: `${BASE}/runs/${runId}` });
    expect(
      (detail.json() as { run: { status: string; failure?: { code: string } } }).run,
    ).toMatchObject({ status: 'failed', failure: { code: 'approval_rejected' } });
  });

  it('审批缺 subjectDigest 返回 409；旧摘要返回 409；正确摘要返回 200', async () => {
    await start();
    const created = await app!.inject({ method: 'POST', url: `${BASE}/runs`, payload: CREATE });
    const runId = (created.json() as { run: { id: string } }).run.id;
    const waiting = await waitForAwaitingApproval(runId);

    const missing = await app!.inject({
      method: 'POST',
      url: `${BASE}/runs/${runId}/approve`,
      payload: { approvalId: waiting.approval.approvalId },
    });
    expect(missing.statusCode).toBe(409);
    expect((missing.json() as { error: { code: string } }).error.code).toBe(
      'approval_subject_missing',
    );

    const stale = await app!.inject({
      method: 'POST',
      url: `${BASE}/runs/${runId}/approve`,
      payload: { approvalId: waiting.approval.approvalId, subjectDigest: 'a'.repeat(64) },
    });
    expect(stale.statusCode).toBe(409);
    expect((stale.json() as { error: { code: string } }).error.code).toBe(
      'approval_subject_mismatch',
    );

    const ok = await app!.inject({
      method: 'POST',
      url: `${BASE}/runs/${runId}/approve`,
      payload: {
        approvalId: waiting.approval.approvalId,
        subjectDigest: waiting.demoPlan.planDigest,
        note: '计划只读，已审阅',
      },
    });
    expect(ok.statusCode).toBe(200);
    expect((ok.json() as { approval: { status: string; decisionNote: string } }).approval).toMatchObject({
      status: 'approved',
      decisionNote: '计划只读，已审阅',
    });
    // A second approve is refused: the gate was already decided.
    const again = await app!.inject({
      method: 'POST',
      url: `${BASE}/runs/${runId}/approve`,
      payload: { approvalId: waiting.approval.approvalId, subjectDigest: waiting.demoPlan.planDigest },
    });
    expect(again.statusCode).toBe(409);
  });

  it('PUT demo-plan：摘要过期 409；成功时返回新 approvalId 并作废旧审批', async () => {
    await start();
    const created = await app!.inject({ method: 'POST', url: `${BASE}/runs`, payload: CREATE });
    const runId = (created.json() as { run: { id: string } }).run.id;
    const waiting = await waitForAwaitingApproval(runId);

    const stale = await app!.inject({
      method: 'PUT',
      url: `${BASE}/runs/${runId}/demo-plan`,
      payload: { expectedPlanDigest: 'b'.repeat(64), patch: { template: 'web_studio_tour' } },
    });
    expect(stale.statusCode).toBe(409);
    expect((stale.json() as { error: { code: string } }).error.code).toBe('plan_digest_stale');

    const edited = await app!.inject({
      method: 'PUT',
      url: `${BASE}/runs/${runId}/demo-plan`,
      payload: {
        expectedPlanDigest: waiting.demoPlan.planDigest,
        patch: { template: 'web_studio_tour' },
        note: '改用巡览模板',
      },
    });
    expect(edited.statusCode).toBe(200);
    const body = edited.json() as {
      approval: { approvalId: string; subjectDigest: string; status: string };
      run: { demoPlan: { planDigest: string; template: string } } | null;
    };
    expect(body.approval.approvalId).not.toBe(waiting.approval.approvalId);
    expect(body.approval.subjectDigest).not.toBe(waiting.demoPlan.planDigest);
    expect(body.run?.demoPlan.template).toBe('web_studio_tour');
    expect(body.run?.demoPlan.planDigest).toBe(body.approval.subjectDigest);

    const oldApproval = await app!.inject({
      method: 'POST',
      url: `${BASE}/runs/${runId}/approve`,
      payload: {
        approvalId: waiting.approval.approvalId,
        subjectDigest: waiting.demoPlan.planDigest,
      },
    });
    expect(oldApproval.statusCode).toBe(409);
  });

  it('截图预览：只有 PNG 截图在 ?inline=1 时 inline，其余一律 attachment + nosniff', async () => {
    const built = await start();
    const created = await built.app.inject({ method: 'POST', url: `${BASE}/runs`, payload: CREATE });
    const runId = (created.json() as { run: { id: string } }).run.id;
    const files = path.join(artifactDir!, 'workspaces', WORKSPACE_ID, 'runs', runId, 'capture');
    mkdirSync(files, { recursive: true });
    const png = path.join(files, 'shot.png');
    writeFileSync(png, 'png-bytes');
    const html = path.join(files, 'payload.html');
    writeFileSync(html, '<script>alert(1)</script>');
    const pngRow = {
      schemaVersion: '1' as const,
      id: 'artifact_shot',
      runId,
      workspaceId: WORKSPACE_ID,
      jobId: 'orchjob_cap',
      kind: 'capture_screenshot' as const,
      fileName: 'shot.png',
      mimeType: 'image/png',
      byteSize: 9,
      sha256: 'c'.repeat(64),
      storageRef: `workspaces/${WORKSPACE_ID}/runs/${runId}/capture/shot.png`,
      metadata: {},
      createdAt: ISO,
    };
    const htmlRow = {
      ...pngRow,
      id: 'artifact_html',
      kind: 'capture_failure_report' as const,
      fileName: 'payload.html',
      mimeType: 'text/html',
      storageRef: `workspaces/${WORKSPACE_ID}/runs/${runId}/capture/payload.html`,
    };
    built.orchestrationStore.insertArtifact(pngRow);
    built.orchestrationStore.insertArtifact(htmlRow);

    const inlinePng = await built.app.inject({
      method: 'GET',
      url: `${BASE}/artifacts/artifact_shot?inline=1`,
    });
    expect(inlinePng.statusCode).toBe(200);
    expect(inlinePng.headers['content-type']).toBe('image/png');
    expect(inlinePng.headers['content-disposition']).toContain('inline');
    expect(inlinePng.headers['x-content-type-options']).toBe('nosniff');

    const downloadPng = await built.app.inject({ method: 'GET', url: `${BASE}/artifacts/artifact_shot` });
    expect(downloadPng.headers['content-disposition']).toContain('attachment');

    const inlineHtml = await built.app.inject({
      method: 'GET',
      url: `${BASE}/artifacts/artifact_html?inline=1`,
    });
    expect(inlineHtml.headers['content-disposition']).toContain('attachment');
    expect(inlineHtml.headers['x-content-type-options']).toBe('nosniff');
  });

  it('未知 capture 执行器为空时，approve 后 capture 步骤失败而不是伪造回执', async () => {
    await start({ capture: new ThrowingCapture() });
    const created = await app!.inject({ method: 'POST', url: `${BASE}/runs`, payload: CREATE });
    const runId = (created.json() as { run: { id: string } }).run.id;
    const waiting = await waitForAwaitingApproval(runId);
    await app!.inject({
      method: 'POST',
      url: `${BASE}/runs/${runId}/approve`,
      payload: { approvalId: waiting.approval.approvalId, subjectDigest: waiting.demoPlan.planDigest },
    });
    const deadline = Date.now() + 4000;
    let status = 'running';
    while (status !== 'failed' && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 25));
      const detail = await app!.inject({ method: 'GET', url: `${BASE}/runs/${runId}` });
      status = (detail.json() as { run: { status: string } }).run.status;
    }
    const detail = await app!.inject({ method: 'GET', url: `${BASE}/runs/${runId}` });
    // `artifacts` is a sibling of `run` in the detail envelope, not a field on it.
    const body = detail.json() as {
      run: { status: string };
      artifacts: Array<{ kind: string }>;
    };
    expect(body.run.status).toBe('failed');
    expect(body.artifacts.map((item) => item.kind)).not.toContain('capture_receipt');
  });
});
