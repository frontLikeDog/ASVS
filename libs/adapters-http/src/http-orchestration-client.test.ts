import { describe, expect, it, vi } from 'vitest';
import type { OrchestrationRunDetailV1, OrchestrationRunV1 } from '@asvs/domain';
import { HttpOrchestrationClient, OrchestrationHttpError } from './http-orchestration-client';

const ISO = '2026-11-27T10:00:00.000Z';
const WORKSPACE_ID = 'ws_demo';

function run(overrides: Partial<OrchestrationRunV1> = {}): OrchestrationRunV1 {
  return {
    schemaVersion: '1',
    id: 'orchrun_0123456789abcdef01234567',
    workspaceId: WORKSPACE_ID,
    projectId: 'proj_lumen',
    videoId: 'vid_lumen_release',
    idempotencyKey: 'idem-0001',
    status: 'queued',
    renderProfile: { width: 1920, height: 1080, codec: 'h264', crf: 18 },
    inputDigest: null,
    currentStepKey: null,
    steps: [
      { stepKey: 'freeze_input', status: 'pending', attempt: 0, checkpointPhases: [] },
      { stepKey: 'verify_claims', status: 'pending', attempt: 0, checkpointPhases: [] },
      { stepKey: 'prepare_media', status: 'pending', attempt: 0, checkpointPhases: [] },
      { stepKey: 'synthesize_voice', status: 'pending', attempt: 0, checkpointPhases: [] },
      { stepKey: 'generate_subtitles', status: 'pending', attempt: 0, checkpointPhases: [] },
      { stepKey: 'render_video', status: 'pending', attempt: 0, checkpointPhases: [] },
      { stepKey: 'register_artifacts', status: 'pending', attempt: 0, checkpointPhases: [] },
    ],
    input: { sceneCount: 6, durationSec: 30, aspect: '16:9', claimCount: 3 },
    createdAt: ISO,
    updatedAt: ISO,
    ...overrides,
  };
}

function response(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as Response;
}

function client(fetchImpl: ReturnType<typeof vi.fn>) {
  return new HttpOrchestrationClient({
    baseUrl: '/api/',
    fetchImpl: fetchImpl as unknown as typeof fetch,
    timeoutMs: 0,
  });
}

const DETAIL: OrchestrationRunDetailV1 = {
  run: run({ status: 'running', currentStepKey: 'render_video' }),
  jobs: [],
  checkpoints: [],
  artifacts: [],
  events: [],
};

describe('HttpOrchestrationClient', () => {
  it('createRun 发送 videoId + idempotencyKey，返回 201 的 created=true', async () => {
    const fetchImpl = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) =>
      response({ run: run(), created: true }, 201),
    );
    const result = await client(fetchImpl).createRun(WORKSPACE_ID, {
      videoId: 'vid_lumen_release',
      idempotencyKey: 'idem-0001',
    });
    expect(result.created).toBe(true);
    expect(fetchImpl).toHaveBeenCalledWith(
      `/api/v1/workspaces/${WORKSPACE_ID}/orchestration/runs`,
      expect.objectContaining({ method: 'POST' }),
    );
    const init = fetchImpl.mock.calls[0]![1] as RequestInit;
    expect(JSON.parse(String(init.body))).toEqual({
      videoId: 'vid_lumen_release',
      idempotencyKey: 'idem-0001',
    });
  });

  it('404 时 getRun 返回 null，其余错误抛出 OrchestrationHttpError', async () => {
    const notFound = vi.fn(async () => response({ error: { code: 'not_found', message: '缺失' } }, 404));
    await expect(client(notFound).getRun(WORKSPACE_ID, 'missing')).resolves.toBeNull();

    const conflict = vi.fn(async () =>
      response({ error: { code: 'invalid_transition', message: '非法迁移' } }, 409),
    );
    await expect(client(conflict).cancelRun(WORKSPACE_ID, 'orchrun_x')).rejects.toMatchObject({
      status: 409,
      code: 'invalid_transition',
      message: '非法迁移',
    });
  });

  it('getRun 用共享 Zod 契约校验详情，损坏的响应会抛错', async () => {
    const ok = vi.fn(async () => response(DETAIL));
    const detail = await client(ok).getRun(WORKSPACE_ID, DETAIL.run.id);
    expect(detail?.run.currentStepKey).toBe('render_video');

    const broken = vi.fn(async () => response({ ...DETAIL, run: { ...DETAIL.run, status: 'bogus' } }));
    await expect(client(broken).getRun(WORKSPACE_ID, DETAIL.run.id)).rejects.toThrow();
  });

  it('listRuns 传递 videoId 并返回运行数组', async () => {
    const fetchImpl = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) =>
      response({ runs: [run()] }),
    );
    const runs = await client(fetchImpl).listRuns(WORKSPACE_ID, { videoId: 'vid_lumen_release' });
    expect(runs).toHaveLength(1);
    expect(fetchImpl.mock.calls[0]![0]).toBe(
      `/api/v1/workspaces/${WORKSPACE_ID}/orchestration/runs?videoId=vid_lumen_release`,
    );
  });

  it('latest-video-artifact 返回下载 URL；404 时为 null', async () => {
    const artifact = {
      schemaVersion: '1' as const,
      id: 'artifact_1_video_mp4',
      runId: DETAIL.run.id,
      workspaceId: WORKSPACE_ID,
      jobId: 'orchjob_1',
      kind: 'video_mp4' as const,
      fileName: 'video.mp4',
      mimeType: 'video/mp4',
      byteSize: 1024,
      sha256: 'a'.repeat(64),
      storageRef: 'workspaces/ws_demo/runs/x/artifacts/video.mp4',
      metadata: {},
      createdAt: ISO,
    };
    const fetchImpl = vi.fn(async () =>
      response({ run: run({ status: 'succeeded' }), artifact, downloadUrl: '/x/artifacts/id' }),
    );
    const found = await client(fetchImpl).getLatestVideoArtifact(WORKSPACE_ID, 'vid_lumen_release');
    expect(found?.artifact.sha256).toBe('a'.repeat(64));
    expect(found?.downloadUrl).toBe('/x/artifacts/id');

    const missing = vi.fn(async () => response({ error: { code: 'not_found' } }, 404));
    await expect(
      client(missing).getLatestVideoArtifact(WORKSPACE_ID, 'vid_none'),
    ).resolves.toBeNull();
  });

  it('isReachable 依据 health.orchestrationReady 判定，网络失败返回 false', async () => {
    const ready = vi.fn(async () => response({ ok: true, orchestrationReady: true }));
    await expect(client(ready).isReachable()).resolves.toBe(true);

    const notReady = vi.fn(async () => response({ ok: true }));
    await expect(client(notReady).isReachable()).resolves.toBe(false);

    const down = vi.fn(async () => {
      throw new TypeError('fetch failed');
    });
    await expect(client(down).isReachable()).resolves.toBe(false);
  });

  it('网络错误包装为 api_unreachable，而不是泄漏底层异常', async () => {
    const down = vi.fn(async () => {
      throw new TypeError('fetch failed');
    });
    await expect(
      client(down).createRun(WORKSPACE_ID, { videoId: 'v', idempotencyKey: 'k-12345678' }),
    ).rejects.toBeInstanceOf(OrchestrationHttpError);
  });

  it('artifactDownloadUrl 生成编码后的下载路径', () => {
    const url = client(vi.fn()).artifactDownloadUrl(WORKSPACE_ID, 'artifact a/b');
    // Export bundles hand out explicit `/download` URLs; this helper matches
    // them so an `<a download>` and a bundle file resolve to the same route.
    expect(url).toBe(
      `/api/v1/workspaces/${WORKSPACE_ID}/orchestration/artifacts/artifact%20a%2Fb/download`,
    );
  });

  it('getHealth 返回 TTS 状态，且响应里没有凭证字段', async () => {
    const fetchImpl = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) =>
      response({
        ok: true,
        orchestrationReady: true,
        tts: {
          configured: true,
          provider: 'deterministic_test',
          synthetic: true,
          license: 'internal-deterministic-test-only',
        },
      }),
    );
    await expect(client(fetchImpl).getHealth()).resolves.toEqual({
      configured: true,
      provider: 'deterministic_test',
      synthetic: true,
      license: 'internal-deterministic-test-only',
    });
  });

  it('createExportBundle 发送 videoId/runId 并校验返回的出口包', async () => {
    const detail = exportDetail();
    const fetchImpl = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) =>
      response(detail, 201),
    );
    const created = await client(fetchImpl).createExportBundle(WORKSPACE_ID, {
      videoId: 'vid_lumen_release',
      runId: DETAIL.run.id,
    });
    expect(created.bundle.mp4Sha256).toBe(detail.bundle.mp4Sha256);
    expect(fetchImpl.mock.calls[0]![0]).toBe(
      `/api/v1/workspaces/${WORKSPACE_ID}/orchestration/exports`,
    );
    const init = fetchImpl.mock.calls[0]![1] as RequestInit;
    expect(JSON.parse(String(init.body))).toEqual({
      videoId: 'vid_lumen_release',
      runId: DETAIL.run.id,
    });
  });

  it('createExportBundle 把 409 门禁错误透出为 OrchestrationHttpError', async () => {
    const fetchImpl = vi.fn(async () =>
      response({ error: { code: 'export_not_approved', message: '尚未批准' } }, 409),
    );
    await expect(
      client(fetchImpl).createExportBundle(WORKSPACE_ID, { videoId: 'vid_lumen_release' }),
    ).rejects.toMatchObject({ status: 409, code: 'export_not_approved' });
  });

  it('listExportBundles 传递 videoId/limit 并解析 bundles 数组', async () => {
    const fetchImpl = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) =>
      response({ bundles: [exportDetail()] }),
    );
    const list = await client(fetchImpl).listExportBundles(WORKSPACE_ID, {
      videoId: 'vid_lumen_release',
      limit: 5,
    });
    expect(list).toHaveLength(1);
    expect(fetchImpl.mock.calls[0]![0]).toBe(
      `/api/v1/workspaces/${WORKSPACE_ID}/orchestration/exports?videoId=vid_lumen_release&limit=5`,
    );
  });
});

/** A minimal Gate-3 export detail, shaped exactly like the server's response. */
function exportDetail() {
  const sha = (char: string) => char.repeat(64);
  return {
    bundle: {
      schemaVersion: '1' as const,
      id: 'exportbundle_0123456789abcdef',
      workspaceId: WORKSPACE_ID,
      projectId: 'proj_lumen',
      videoId: 'vid_lumen_release',
      runId: DETAIL.run.id,
      mp4ArtifactId: 'artifact_1_video_mp4',
      srtArtifactId: 'artifact_1_subtitles_srt',
      manifestArtifactId: 'artifact_1_render_manifest',
      receiptArtifactId: 'artifact_1_artifact_receipt',
      mp4Sha256: sha('a'),
      srtSha256: sha('b'),
      manifestSha256: sha('c'),
      scriptVersion: 2,
      createdAt: ISO,
    },
    files: [
      {
        artifactId: 'artifact_1_video_mp4',
        kind: 'video_mp4' as const,
        fileName: 'vid_lumen_release.mp4',
        mimeType: 'video/mp4',
        byteSize: 2048,
        sha256: sha('a'),
        downloadUrl: `/v1/workspaces/${WORKSPACE_ID}/orchestration/artifacts/artifact_1_video_mp4/download`,
      },
    ],
    videoDurationMs: 30_000,
    audioDurationMs: 29_800,
    narration: {
      provider: 'deterministic_test',
      voiceId: 'test-voice-zh',
      language: 'zh-CN',
      license: 'internal-deterministic-test-only',
      synthetic: true,
      timingPolicy: 'extend_scene',
    },
  };
}
