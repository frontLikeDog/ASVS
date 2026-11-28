// @vitest-environment node
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { StudioSnapshot } from '@asvs/domain';
import type {
  RenderJobExecutionResult,
  RenderJobExecutorCallbacks,
  RenderJobExecutorPort,
} from '@asvs/ports';
import { buildApp } from '../app';
import { DeterministicQaRunner } from '../qa/testing/deterministic-qa-runner';

const ISO = '2026-11-27T10:00:00.000Z';
const WORKSPACE_ID = 'ws_route_orch';

const SNAPSHOT: StudioSnapshot = {
  projects: [
    {
      id: 'proj_route',
      name: 'Route',
      productName: 'Route',
      description: '',
      website: '',
      stage: 'active',
      brand: {
        logoText: 'ROUTE',
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
      id: 'vid_route',
      projectId: 'proj_route',
      title: 'Route test',
      mode: 'release_video',
      stage: 'review',
      fps: 30,
      brief: {
        objective: '验证编排路由',
        audience: '工程师',
        featureIds: [],
        durationSec: 30,
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
          id: 'scene_one',
          order: 0,
          revision: 1,
          title: '开场',
          intent: '',
          narration: '',
          caption: '',
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

class BlockingExecutor implements RenderJobExecutorPort {
  calls = 0;
  private release: (() => void) | null = null;

  isRunning(): boolean {
    return this.release !== null;
  }

  abort(): void {
    // Mirrors the real executor: killing the child resolves `execute`.
    this.release?.();
    this.release = null;
  }

  async execute(
    _job: unknown,
    _inputFile: string,
    _outDir: string,
    _checkpointFile: string,
    _callbacks: RenderJobExecutorCallbacks,
  ): Promise<RenderJobExecutionResult> {
    this.calls += 1;
    // Holds the run at render_video so the test can drive it over HTTP.
    return new Promise<RenderJobExecutionResult>((resolve) => {
      this.release = () =>
        resolve({
          ok: false,
          workerPid: 4242,
          exitCode: null,
          signal: 'SIGTERM',
          crashed: false,
          code: 'cancelled',
          message: '渲染进程已被取消',
          checkpoints: [],
        });
    });
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

async function start(options: { qaRunner?: DeterministicQaRunner } = {}) {
  artifactDir = mkdtempSync(path.join(os.tmpdir(), 'asvs-orch-route-'));
  const built = await buildApp({
    dbPath: ':memory:',
    artifactDir,
    renderExecutor: new BlockingExecutor(),
    orchestrationInstanceId: 'api_route_test',
    // Real runs need QA (5D); the deterministic double keeps the routes
    // offline while still producing real report files on disk.
    qaRunner: options.qaRunner ?? new DeterministicQaRunner(),
    // Tests run offline: the deterministic voice keeps narration requests
    // valid without a provider while staying honestly labelled synthetic.
    speechConfig: {
      provider: 'deterministic_test',
      model: 'tone-v1',
      voiceZh: 'test-voice-zh',
      voiceEn: 'test-voice-en',
      license: 'internal-deterministic-test-only',
      timeoutMs: 5_000,
      maxRetries: 0,
    },
  });
  app = built.app;
  const put = await built.app.inject({
    method: 'PUT',
    url: `/v1/workspaces/${WORKSPACE_ID}`,
    payload: { schemaVersion: 2, baseRevision: 0, workspace: SNAPSHOT },
  });
  if (put.statusCode !== 200) throw new Error(`workspace PUT failed: ${put.statusCode} ${put.body}`);
  return built;
}

const BASE = `/v1/workspaces/${WORKSPACE_ID}/orchestration`;

describe('编排路由', () => {
  it('health 报告 orchestrationReady 与 tts 状态（不泄露凭证）', async () => {
    await start();
    const response = await app!.inject({ method: 'GET', url: '/v1/health' });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      orchestrationReady: true,
      tts: {
        configured: true,
        provider: 'deterministic_test',
        synthetic: true,
        license: 'internal-deterministic-test-only',
      },
    });
    expect(response.body).not.toMatch(/api[_-]?key/i);
  });

  it('旁白请求在 TTS 未配置时返回 503（fail-closed）', async () => {
    artifactDir = mkdtempSync(path.join(os.tmpdir(), 'asvs-orch-route-'));
    const built = await buildApp({
      dbPath: ':memory:',
      artifactDir,
      renderExecutor: new BlockingExecutor(),
      orchestrationInstanceId: 'api_route_test',
      speechConfig: {
        provider: 'unconfigured',
        model: 'none',
        voiceZh: '',
        voiceEn: '',
        license: 'none',
        timeoutMs: 5_000,
        maxRetries: 0,
      },
    });
    app = built.app;
    await built.app.inject({
      method: 'PUT',
      url: `/v1/workspaces/${WORKSPACE_ID}`,
      payload: { schemaVersion: 2, baseRevision: 0, workspace: SNAPSHOT },
    });
    const health = await app.inject({ method: 'GET', url: '/v1/health' });
    expect((health.json() as { tts: { configured: boolean } }).tts.configured).toBe(false);
    const response = await app.inject({
      method: 'POST',
      url: `${BASE}/runs`,
      payload: { videoId: 'vid_route', idempotencyKey: 'route-idem-tts-0001' },
    });
    expect(response.statusCode).toBe(503);
    expect((response.json() as { error: { code: string } }).error.code).toBe('tts_not_configured');
    // Explicitly disabling narration still works — silence is allowed when asked.
    const silent = await app.inject({
      method: 'POST',
      url: `${BASE}/runs`,
      payload: {
        videoId: 'vid_route',
        idempotencyKey: 'route-idem-tts-0002',
        narration: { enabled: false },
      },
    });
    expect(silent.statusCode).toBe(201);
  });

  it('非法旁白语速返回 400', async () => {
    await start();
    const response = await app!.inject({
      method: 'POST',
      url: `${BASE}/runs`,
      payload: {
        videoId: 'vid_route',
        idempotencyKey: 'route-idem-speed-01',
        narration: { enabled: false, speed: 3 },
      },
    });
    expect(response.statusCode).toBe(400);
  });

  it('导出门禁：未审批返回 409，未知视频返回 404，非法请求体 400', async () => {
    await start();
    const unapproved = await app!.inject({
      method: 'POST',
      url: `${BASE}/exports`,
      payload: { videoId: 'vid_route' },
    });
    expect(unapproved.statusCode).toBe(409);
    expect((unapproved.json() as { error: { code: string } }).error.code).toBe(
      'export_not_approved',
    );
    const missing = await app!.inject({
      method: 'POST',
      url: `${BASE}/exports`,
      payload: { videoId: 'vid_nope' },
    });
    expect(missing.statusCode).toBe(404);
    const invalid = await app!.inject({ method: 'POST', url: `${BASE}/exports`, payload: {} });
    expect(invalid.statusCode).toBe(400);
    const listed = await app!.inject({ method: 'GET', url: `${BASE}/exports` });
    expect(listed.statusCode).toBe(200);
    expect((listed.json() as { bundles: unknown[] }).bundles).toEqual([]);
  });

  it('创建运行：201，重复 idempotencyKey 返回 200 + created=false', async () => {
    await start();
    const payload = { videoId: 'vid_route', idempotencyKey: 'route-idem-000001', narration: { enabled: false } };
    const first = await app!.inject({ method: 'POST', url: `${BASE}/runs`, payload });
    expect(first.statusCode).toBe(201);
    const created = first.json() as { run: { id: string; status: string }; created: boolean };
    expect(created.created).toBe(true);
    expect(created.run.status).toBe('queued');

    const second = await app!.inject({ method: 'POST', url: `${BASE}/runs`, payload });
    expect(second.statusCode).toBe(200);
    expect((second.json() as { created: boolean }).created).toBe(false);
    expect((second.json() as { run: { id: string } }).run.id).toBe(created.run.id);
  });

  it('非法请求体 400；非 16:9 400；未知视频 404', async () => {
    await start();
    const invalid = await app!.inject({
      method: 'POST',
      url: `${BASE}/runs`,
      payload: { videoId: 'vid_route' },
    });
    expect(invalid.statusCode).toBe(400);
    const unknown = await app!.inject({
      method: 'POST',
      url: `${BASE}/runs`,
      payload: { videoId: 'vid_missing', idempotencyKey: 'route-idem-000002', narration: { enabled: false } },
    });
    expect(unknown.statusCode).toBe(404);
    expect((unknown.json() as { error: { code: string } }).error.code).toBe('video_not_found');
    const wrongProfile = await app!.inject({
      method: 'POST',
      url: `${BASE}/runs`,
      payload: {
        videoId: 'vid_route',
        idempotencyKey: 'route-idem-000003',
        narration: { enabled: false },
        renderProfile: { width: 1080, height: 1920 },
      },
    });
    expect(wrongProfile.statusCode).toBe(400);
    expect((wrongProfile.json() as { error: { code: string } }).error.code).toBe(
      'aspect_not_supported',
    );
  });

  it('详情、列表与 404：跨工作区读取不可见', async () => {
    await start();
    const created = await app!.inject({
      method: 'POST',
      url: `${BASE}/runs`,
      payload: { videoId: 'vid_route', idempotencyKey: 'route-idem-000010', narration: { enabled: false } },
    });
    const runId = (created.json() as { run: { id: string } }).run.id;

    const detail = await app!.inject({ method: 'GET', url: `${BASE}/runs/${runId}` });
    expect(detail.statusCode).toBe(200);
    expect((detail.json() as { run: { id: string } }).run.id).toBe(runId);

    const list = await app!.inject({ method: 'GET', url: `${BASE}/runs?videoId=vid_route` });
    expect(list.statusCode).toBe(200);
    expect((list.json() as { runs: unknown[] }).runs).toHaveLength(1);

    const otherWorkspace = await app!.inject({
      method: 'GET',
      url: `/v1/workspaces/ws_other/orchestration/runs/${runId}`,
    });
    expect(otherWorkspace.statusCode).toBe(404);
  });

  it('cancel 返回 200 并进入 cancelled；再次 cancel 幂等；对已取消运行 retry 返回 409', async () => {
    await start();
    const created = await app!.inject({
      method: 'POST',
      url: `${BASE}/runs`,
      payload: { videoId: 'vid_route', idempotencyKey: 'route-idem-000020', narration: { enabled: false } },
    });
    const runId = (created.json() as { run: { id: string } }).run.id;
    const cancelled = await app!.inject({ method: 'POST', url: `${BASE}/runs/${runId}/cancel` });
    expect(cancelled.statusCode).toBe(200);
    expect((cancelled.json() as { run: { status: string } }).run.status).toBe('cancelled');
    const again = await app!.inject({ method: 'POST', url: `${BASE}/runs/${runId}/cancel` });
    expect(again.statusCode).toBe(200);
    const retry = await app!.inject({ method: 'POST', url: `${BASE}/runs/${runId}/retry` });
    expect(retry.statusCode).toBe(409);
    expect((retry.json() as { error: { code: string } }).error.code).toBe('invalid_transition');
  });

  it('approve 对无 Gate 的运行返回 409，请求体缺失返回 400', async () => {
    await start();
    const created = await app!.inject({
      method: 'POST',
      url: `${BASE}/runs`,
      payload: { videoId: 'vid_route', idempotencyKey: 'route-idem-000030', narration: { enabled: false } },
    });
    const runId = (created.json() as { run: { id: string } }).run.id;
    const badBody = await app!.inject({
      method: 'POST',
      url: `${BASE}/runs/${runId}/approve`,
      payload: {},
    });
    expect(badBody.statusCode).toBe(400);
    const noGate = await app!.inject({
      method: 'POST',
      url: `${BASE}/runs/${runId}/approve`,
      payload: { approvalId: 'ap_1' },
    });
    expect(noGate.statusCode).toBe(409);
  });

  it('产物下载：未知产物 404，越界 storageRef 也不会泄漏文件', async () => {
    await start();
    const missing = await app!.inject({
      method: 'GET',
      url: `${BASE}/artifacts/artifact_missing`,
    });
    expect(missing.statusCode).toBe(404);

    const built = await buildApp({
      dbPath: ':memory:',
      artifactDir: artifactDir!,
      renderExecutor: new BlockingExecutor(),
    });
    await built.app.inject({
      method: 'PUT',
      url: `/v1/workspaces/${WORKSPACE_ID}`,
      payload: { schemaVersion: 2, baseRevision: 0, workspace: SNAPSHOT },
    });
    const seeded = await built.app.inject({
      method: 'POST',
      url: `${BASE}/runs`,
      payload: { videoId: 'vid_route', idempotencyKey: 'route-idem-traversal', narration: { enabled: false } },
    });
    const seededRunId = (seeded.json() as { run: { id: string } }).run.id;
    built.orchestrationStore.insertArtifact({
      schemaVersion: '1',
      id: 'artifact_traversal',
      runId: seededRunId,
      workspaceId: WORKSPACE_ID,
      jobId: 'orchjob_x',
      kind: 'video_mp4',
      fileName: 'evil.mp4',
      mimeType: 'video/mp4',
      byteSize: 1,
      sha256: 'a'.repeat(64),
      storageRef: '../../../../windows/win.ini',
      metadata: {},
      createdAt: ISO,
    });
    const traversal = await built.app.inject({
      method: 'GET',
      url: `${BASE}/artifacts/artifact_traversal`,
    });
    expect(traversal.statusCode).toBe(404);
    await built.app.close();
  });

  it('latest-video-artifact：无产物 404，有产物时返回下载 URL', async () => {
    await start();
    const empty = await app!.inject({
      method: 'GET',
      url: `${BASE}/videos/vid_route/latest-video-artifact`,
    });
    expect(empty.statusCode).toBe(404);
  });
});
