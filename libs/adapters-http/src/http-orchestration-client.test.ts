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

  it('approveRun 发送 approvalId + subjectDigest + note（Gate 2 绑定摘要）', async () => {
    const approval = {
      approvalId: 'appr_0123456789abcdef',
      stepKey: 'capture_demo' as const,
      status: 'approved' as const,
      gateType: 'gate2_demo_capture' as const,
      subjectDigest: 'd'.repeat(64),
      policyVersion: 'gate2-v1',
      requestedAt: ISO,
      approvedAt: ISO,
      decidedBy: 'local',
      decisionNote: '只读计划',
    };
    const fetchImpl = vi.fn(async () => response({ approval }));
    const result = await client(fetchImpl).approveRun(WORKSPACE_ID, DETAIL.run.id, {
      approvalId: approval.approvalId,
      subjectDigest: approval.subjectDigest,
      note: '只读计划',
    });
    expect(result.status).toBe('approved');
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(
      `/api/v1/workspaces/${WORKSPACE_ID}/orchestration/runs/${DETAIL.run.id}/approve`,
    );
    expect(JSON.parse(String(init.body))).toEqual({
      approvalId: approval.approvalId,
      subjectDigest: approval.subjectDigest,
      note: '只读计划',
    });
  });

  it('409 approval_subject_mismatch 原样透出（不重试、不静默改摘要）', async () => {
    const fetchImpl = vi.fn(async () =>
      response({ error: { code: 'approval_subject_mismatch', message: '摘要不一致' } }, 409),
    );
    await expect(
      client(fetchImpl).approveRun(WORKSPACE_ID, DETAIL.run.id, {
        approvalId: 'appr_x',
        subjectDigest: 'e'.repeat(64),
      }),
    ).rejects.toMatchObject({ status: 409, code: 'approval_subject_mismatch' });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('rejectRun 发送 approvalId + reason，并解析被驳回的审批', async () => {
    const approval = {
      approvalId: 'appr_x',
      stepKey: 'capture_demo' as const,
      status: 'rejected' as const,
      gateType: 'gate2_demo_capture' as const,
      requestedAt: ISO,
      rejectedAt: ISO,
      decidedBy: 'local',
      decisionNote: '包含未审计写操作',
    };
    const fetchImpl = vi.fn(async () => response({ approval }));
    const result = await client(fetchImpl).rejectRun(WORKSPACE_ID, DETAIL.run.id, {
      approvalId: 'appr_x',
      reason: '包含未审计写操作',
    });
    expect(result.status).toBe('rejected');
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(
      `/api/v1/workspaces/${WORKSPACE_ID}/orchestration/runs/${DETAIL.run.id}/reject`,
    );
    expect(JSON.parse(String(init.body))).toEqual({
      approvalId: 'appr_x',
      reason: '包含未审计写操作',
    });
  });

  it('updateDemoPlan 走 PUT，并把新审批（新摘要）返回给调用方', async () => {
    const approval = {
      approvalId: 'appr_new',
      stepKey: 'capture_demo' as const,
      status: 'pending' as const,
      gateType: 'gate2_demo_capture' as const,
      subjectDigest: 'f'.repeat(64),
      requestedAt: ISO,
    };
    const fetchImpl = vi.fn(async () => response({ approval, run: null }));
    const result = await client(fetchImpl).updateDemoPlan(WORKSPACE_ID, DETAIL.run.id, {
      expectedPlanDigest: 'a'.repeat(64),
      patch: { template: 'web_studio_tour' },
    });
    expect(result.approvalId).toBe('appr_new');
    expect(result.subjectDigest).toBe('f'.repeat(64));
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(init.method).toBe('PUT');
    expect(url).toBe(
      `/api/v1/workspaces/${WORKSPACE_ID}/orchestration/runs/${DETAIL.run.id}/demo-plan`,
    );
    expect(JSON.parse(String(init.body))).toEqual({
      expectedPlanDigest: 'a'.repeat(64),
      patch: { template: 'web_studio_tour' },
    });
  });

  it('updateDemoPlan 对过期摘要的 409 plan_digest_stale 抛出而不是覆盖', async () => {
    const fetchImpl = vi.fn(async () =>
      response({ error: { code: 'plan_digest_stale', message: '摘要已过期' } }, 409),
    );
    await expect(
      client(fetchImpl).updateDemoPlan(WORKSPACE_ID, DETAIL.run.id, {
        expectedPlanDigest: 'a'.repeat(64),
        patch: { resetStrategy: 'none' },
      }),
    ).rejects.toMatchObject({ status: 409, code: 'plan_digest_stale' });
  });

  it('artifactInlineUrl 生成 ?inline=1，download 与 inline 命中同一路由', () => {
    const instance = client(vi.fn());
    expect(instance.artifactInlineUrl(WORKSPACE_ID, 'artifact shot')).toBe(
      `/api/v1/workspaces/${WORKSPACE_ID}/orchestration/artifacts/artifact%20shot?inline=1`,
    );
    expect(instance.artifactDownloadUrl(WORKSPACE_ID, 'artifact shot')).toBe(
      `/api/v1/workspaces/${WORKSPACE_ID}/orchestration/artifacts/artifact%20shot/download`,
    );
  });

  it('getHealth 解析可选 capture 块；旧服务端缺失时不伪造能力', async () => {
    const withCapture = vi.fn(async () =>
      response({
        ok: true,
        orchestrationReady: true,
        tts: { configured: true, provider: 'p', synthetic: true, license: 'l' },
        capture: {
          enabled: true,
          allowedOrigins: ['http://localhost:4200'],
          defaultBaseUrl: 'http://localhost:4200',
          allowAutoServe: false,
          policyVersion: 'gate2-v1',
        },
      }),
    );
    const health = await client(withCapture).getHealth();
    expect(health.capture).toEqual({
      enabled: true,
      allowedOrigins: ['http://localhost:4200'],
      defaultBaseUrl: 'http://localhost:4200',
      allowAutoServe: false,
      policyVersion: 'gate2-v1',
    });

    const legacy = vi.fn(async () =>
      response({
        ok: true,
        orchestrationReady: true,
        tts: { configured: true, provider: 'p', synthetic: true, license: 'l' },
      }),
    );
    await expect(client(legacy).getHealth()).resolves.toEqual({
      configured: true,
      provider: 'p',
      synthetic: true,
      license: 'l',
    });
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

describe('HttpOrchestrationClient · 独立 QA（Step 5D）', () => {
  const sha = (char: string) => char.repeat(64);

  function qaArtifact(kind: 'qa_report' | 'qa_evidence_frame') {
    return {
      schemaVersion: '1' as const,
      id: `artifact_qa_${kind}`,
      runId: 'orchrun_0123456789abcdef01234567',
      workspaceId: WORKSPACE_ID,
      jobId: 'orchjob_qa',
      kind,
      fileName: kind === 'qa_report' ? 'qa-final-report.json' : 'evidence-1.png',
      mimeType: kind === 'qa_report' ? 'application/json' : 'image/png',
      byteSize: 128,
      sha256: sha('b'),
      storageRef: `workspaces/${WORKSPACE_ID}/runs/r/qa/${kind}`,
      metadata: {},
      createdAt: ISO,
    };
  }

  function qaReport(overrides: Record<string, unknown> = {}) {
    const checks = (['privacy', 'technical', 'fact', 'content'] as const).map((category) => ({
      category,
      status: 'pass' as const,
      blockerCount: 0,
      warningCount: 0,
      infoCount: 0,
      summary: '无问题',
    }));
    return {
      schemaVersion: '1',
      kind: 'asvs.qa-report',
      reportId: 'qarep_final_demo',
      runId: 'orchrun_0123456789abcdef01234567',
      workspaceId: WORKSPACE_ID,
      projectId: 'proj_lumen',
      videoId: 'vid_lumen_release',
      stage: 'final',
      policyVersion: 'qa-v1',
      verdict: 'pass',
      summary: {
        totalFindings: 0,
        blockerCount: 0,
        warningCount: 0,
        infoCount: 0,
        privacyBlockerCount: 0,
        technicalBlockerCount: 0,
        factBlockerCount: 0,
        contentBlockerCount: 0,
      },
      checks,
      findings: [],
      coverage: {
        scannedCaptureFrames: 0,
        scannedRenderFrames: 10,
        scannedScreenshots: 0,
        scannedTraceEntries: 0,
        skippedTraceStaticEntries: 0,
        scannedScenes: 3,
        scannedSrtCues: 4,
        ocrProvider: 'tesseract_cli',
        ocrExecuted: true,
        ocrSynthetic: false,
        allowlistedDomains: [],
      },
      subject: { inputDigest: sha('c'), scriptVersion: 1, mp4Sha256: sha('a') },
      durationMs: 2500,
      createdAt: ISO,
      ...overrides,
    };
  }

  it('getRunQaReport 按 stage 拼查询并校验报告；404 返回 null', async () => {
    const fetchImpl = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) =>
      response({
        run: run({ status: 'succeeded' }),
        report: qaReport(),
        reportArtifact: qaArtifact('qa_report'),
        evidenceArtifacts: [qaArtifact('qa_evidence_frame')],
      }),
    );
    const found = await client(fetchImpl).getRunQaReport(WORKSPACE_ID, 'orchrun_0123456789abcdef01234567', 'final');
    expect(found?.report.verdict).toBe('pass');
    expect(found?.evidenceArtifacts).toHaveLength(1);

    const missing = vi.fn(async () => response({ error: { code: 'not_found' } }, 404));
    await expect(
      client(missing).getRunQaReport(WORKSPACE_ID, 'orchrun_nope'),
    ).resolves.toBeNull();
  });

  it('getLatestQaReport 打 video 路由，阻断报告也解析成功', async () => {
    const fetchImpl = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) =>
      response({
        run: run({ status: 'failed' }),
        report: qaReport({
          verdict: 'fail',
          summary: {
            totalFindings: 1,
            blockerCount: 1,
            warningCount: 0,
            infoCount: 0,
            privacyBlockerCount: 1,
            technicalBlockerCount: 0,
            factBlockerCount: 0,
            contentBlockerCount: 0,
          },
          checks: [
            { category: 'privacy', status: 'fail', blockerCount: 1, warningCount: 0, infoCount: 0, summary: '阻断 1 项' },
            { category: 'technical', status: 'pass', blockerCount: 0, warningCount: 0, infoCount: 0, summary: '无问题' },
            { category: 'fact', status: 'pass', blockerCount: 0, warningCount: 0, infoCount: 0, summary: '无问题' },
            { category: 'content', status: 'pass', blockerCount: 0, warningCount: 0, infoCount: 0, summary: '无问题' },
          ],
          findings: [
            {
              id: 'qaf_01',
              ruleId: 'privacy.email',
              category: 'privacy',
              severity: 'blocker',
              sourceKind: 'render_frame',
              title: '成片帧命中邮箱',
              message: '帧中出现疑似邮箱。',
              remediation: '替换为脱敏账号后重录。',
              remediationAction: 'production',
              location: { scope: 'global' },
              matchRedacted: 'c***@corp.internal',
            },
          ],
        }),
        reportArtifact: qaArtifact('qa_report'),
        evidenceArtifacts: [],
      }),
    );
    const found = await client(fetchImpl).getLatestQaReport(WORKSPACE_ID, 'vid_lumen_release');
    expect(found?.run.status).toBe('failed');
    expect(found?.report.summary.privacyBlockerCount).toBe(1);
    expect(fetchImpl.mock.calls[0]![0]).toBe(
      `/api/v1/workspaces/${WORKSPACE_ID}/orchestration/videos/vid_lumen_release/latest-qa-report`,
    );
  });

  it('getHealth 透传 qa 块；旧服务器缺省时为 undefined', async () => {
    const withQa = vi.fn(async () =>
      response({
        ok: true,
        tts: { configured: true, provider: 'deterministic_test', synthetic: true, license: 'x' },
        qa: { enabled: true, ocrProvider: 'tesseract_cli', ocrConfigured: true, policyVersion: 'qa-v1' },
      }),
    );
    const health = await client(withQa).getHealth();
    expect(health.qa).toEqual({
      enabled: true,
      ocrProvider: 'tesseract_cli',
      ocrConfigured: true,
      policyVersion: 'qa-v1',
    });
    const withoutQa = vi.fn(async () =>
      response({
        ok: true,
        tts: { configured: false, provider: 'unconfigured', synthetic: false, license: 'none' },
      }),
    );
    expect((await client(withoutQa).getHealth()).qa).toBeUndefined();
  });
});
