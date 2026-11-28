// @vitest-environment node
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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
import { DeterministicQaRunner, type DeterministicQaScript } from '../qa/testing/deterministic-qa-runner';

/**
 * Step 5D · HTTP surface for the QA read routes and health block.
 *
 * These tests drive a real orchestrator run through the deterministic
 * `QaRunnerPort` double, so the report file, `qa_reports` row and artifact row
 * are all real — only the media scanning is stubbed (proven by `pnpm qa:verify`).
 */

const ISO = '2026-11-28T10:00:00.000Z';
const WORKSPACE_ID = 'ws_route_qa';
const VIDEO_ID = 'vid_route_qa';

const SNAPSHOT: StudioSnapshot = {
  projects: [
    {
      id: 'proj_route_qa',
      name: 'Route QA',
      productName: 'Route QA',
      description: '',
      website: '',
      stage: 'active',
      brand: {
        logoText: 'RQA',
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
      projectId: 'proj_route_qa',
      title: 'Route QA test',
      mode: 'release_video',
      stage: 'review',
      fps: 30,
      brief: {
        objective: '验证 QA 路由',
        audience: '工程师',
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

function sha(text: string | Buffer): string {
  return createHash('sha256').update(text).digest('hex');
}

/** A worker double that writes the MP4/receipt/manifest the QA step reads. */
class WriteThroughExecutor implements RenderJobExecutorPort {
  isRunning(): boolean {
    return false;
  }
  abort(): void {
    /* no-op */
  }
  async execute(
    job: unknown,
    _inputFile: string,
    outDir: string,
    _checkpointFile: string,
    callbacks: RenderJobExecutorCallbacks,
  ): Promise<RenderJobExecutionResult> {
    const typed = job as { jobId: string; runId: string };
    callbacks.onHeartbeat?.(4242);
    const file = path.join(outDir, `${typed.runId}.mp4`);
    const body = 'route-qa-mp4-bytes';
    writeFileSync(file, body);
    const digest = sha(body);
    const bytes = Buffer.byteLength(body);
    writeFileSync(
      path.join(outDir, 'receipt.json'),
      JSON.stringify({
        schemaVersion: '1',
        jobId: typed.jobId,
        artifactId: typed.jobId.replace(/^orchjob/, 'artifact'),
        sha256: digest,
        mimeType: 'video/mp4',
        byteSize: bytes,
        storageRef: `workspaces/${WORKSPACE_ID}/runs/${typed.runId}/artifacts/${typed.runId}.mp4`,
        durationMs: 12_000,
        width: 1920,
        height: 1080,
        fps: 30,
        rendererVersion: '4.0.545',
        compositionId: 'AsvsVideo',
        createdAt: ISO,
      }),
    );
    writeFileSync(
      path.join(outDir, 'manifest.json'),
      JSON.stringify({
        schemaVersion: '1',
        jobId: typed.jobId,
        artifactId: typed.jobId.replace(/^orchjob/, 'artifact'),
        compositionId: 'AsvsVideo',
        rendererVersion: '4.0.545',
        renderInputDigest: 'b'.repeat(64),
        storyboardDigest: 'c'.repeat(64),
        sceneDigests: [],
        assetHashes: [],
        renderProfile: { width: 1920, height: 1080, codec: 'h264', crf: 18 },
        output: { fileName: `${typed.runId}.mp4`, mimeType: 'video/mp4', byteSize: bytes, sha256: digest },
        ffprobe: {
          codecName: 'h264',
          durationMs: 12_000,
          width: 1920,
          height: 1080,
          fps: 30,
          frameCount: 360,
        },
        createdAt: ISO,
      }),
    );
    return {
      ok: true,
      workerPid: 4242,
      exitCode: 0,
      checkpoints: [],
      completed: {
        type: 'completed',
        receiptPath: 'receipt.json',
        manifestPath: 'manifest.json',
        outputPath: `${typed.runId}.mp4`,
        outputSha256: digest,
        byteSize: bytes,
      },
    };
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

async function start(script: DeterministicQaScript = {}): Promise<FastifyInstance> {
  artifactDir = mkdtempSync(path.join(os.tmpdir(), 'asvs-orch-qa-route-'));
  const built = await buildApp({
    dbPath: ':memory:',
    artifactDir,
    renderExecutor: new WriteThroughExecutor(),
    orchestrationInstanceId: 'api_route_qa_test',
    speechService: null,
    captureExecutor: null,
    qaRunner: new DeterministicQaRunner(script),
  });
  app = built.app;
  const put = await built.app.inject({
    method: 'PUT',
    url: `/v1/workspaces/${WORKSPACE_ID}`,
    payload: { schemaVersion: 2, baseRevision: 0, workspace: SNAPSHOT },
  });
  if (put.statusCode !== 200) throw new Error(`workspace PUT failed: ${put.statusCode} ${put.body}`);
  return built.app;
}

const BASE = `/v1/workspaces/${WORKSPACE_ID}/orchestration`;

async function finishRun(instance: FastifyInstance, runId: string): Promise<string> {
  const deadline = Date.now() + 10_000;
  for (;;) {
    const detail = await instance.inject({ method: 'GET', url: `${BASE}/runs/${runId}` });
    const status = (detail.json() as { run: { status: string } }).run.status;
    if (status === 'succeeded' || status === 'failed') return status;
    if (Date.now() > deadline) throw new Error(`运行未结束：${status}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

async function createAndFinish(
  instance: FastifyInstance,
  idempotencyKey: string,
): Promise<{ runId: string; status: string }> {
  const created = await instance.inject({
    method: 'POST',
    url: `${BASE}/runs`,
    payload: { videoId: VIDEO_ID, idempotencyKey, narration: { enabled: false } },
  });
  expect(created.statusCode).toBe(201);
  const runId = (created.json() as { run: { id: string } }).run.id;
  const status = await finishRun(instance, runId);
  return { runId, status };
}

describe('独立 QA 路由（Step 5D）', () => {
  it('health 的 qa 块报告 OCR 是否已配置（fail-closed 信号，不含路径）', async () => {
    const instance = await start();
    const response = await instance.inject({ method: 'GET', url: '/v1/health' });
    expect(response.statusCode).toBe(200);
    const qa = (response.json() as { qa: Record<string, unknown> }).qa;
    expect(qa).toMatchObject({
      enabled: true,
      ocrProvider: 'unconfigured',
      ocrConfigured: false,
    });
    expect(JSON.stringify(qa)).not.toMatch(/[A-Za-z]:\\|\/opt\//);
  });

  it('GET /runs/:runId/qa-report 返回完整报告与产物哈希', async () => {
    const instance = await start();
    const { runId, status } = await createAndFinish(instance, 'route-qa-pass-0001');
    expect(status).toBe('succeeded');

    const response = await instance.inject({
      method: 'GET',
      url: `${BASE}/runs/${runId}/qa-report`,
    });
    expect(response.statusCode).toBe(200);
    const body = response.json() as {
      report: { stage: string; verdict: string; runId: string };
      reportArtifact: { kind: string; sha256: string; storageRef: string };
      evidenceArtifacts: unknown[];
    };
    expect(body.report.runId).toBe(runId);
    expect(body.report.stage).toBe('final');
    expect(body.report.verdict).toBe('pass');
    expect(body.reportArtifact.kind).toBe('qa_report');
    expect(body.reportArtifact.sha256).toMatch(/^[a-f0-9]{64}$/);
    // The served digest is the digest of the bytes actually on disk.
    expect(sha(readFileSync(path.join(artifactDir!, body.reportArtifact.storageRef)))).toBe(
      body.reportArtifact.sha256,
    );
    expect(Array.isArray(body.evidenceArtifacts)).toBe(true);
  });

  it('?stage 过滤：未跑的 capture 阶段 404，非法 stage 400', async () => {
    const instance = await start();
    const { runId } = await createAndFinish(instance, 'route-qa-stage-0001');
    const captureOnly = await instance.inject({
      method: 'GET',
      url: `${BASE}/runs/${runId}/qa-report?stage=capture`,
    });
    expect(captureOnly.statusCode).toBe(404);
    const finalOnly = await instance.inject({
      method: 'GET',
      url: `${BASE}/runs/${runId}/qa-report?stage=final`,
    });
    expect(finalOnly.statusCode).toBe(200);
    const invalid = await instance.inject({
      method: 'GET',
      url: `${BASE}/runs/${runId}/qa-report?stage=nope`,
    });
    expect(invalid.statusCode).toBe(400);
    const unknownRun = await instance.inject({
      method: 'GET',
      url: `${BASE}/runs/orchrun_nope/qa-report`,
    });
    expect(unknownRun.statusCode).toBe(404);
  });

  it('GET /videos/:videoId/latest-qa-report 在 QA 阻断的失败运行上仍返回 200 且不泄露原文', async () => {
    const instance = await start({
      findings: {
        final: [
          {
            category: 'privacy',
            severity: 'blocker',
            ruleId: 'privacy.email',
            title: '成片帧命中邮箱',
            sourceKind: 'render_frame',
            matchRedacted: 'c***@corp.internal',
          },
        ],
      },
      evidenceFor: [{ category: 'privacy', severity: 'blocker', ruleId: 'privacy.email' }],
    });
    const { runId, status } = await createAndFinish(instance, 'route-qa-blocked-0001');
    expect(status).toBe('failed');

    const response = await instance.inject({
      method: 'GET',
      url: `${BASE}/videos/${VIDEO_ID}/latest-qa-report`,
    });
    expect(response.statusCode).toBe(200);
    const body = response.json() as {
      run: { id: string; status: string };
      report: { verdict: string; summary: { privacyBlockerCount: number } };
      evidenceArtifacts: Array<{ kind: string }>;
    };
    expect(body.run.id).toBe(runId);
    expect(body.run.status).toBe('failed');
    expect(body.report.verdict).toBe('fail');
    expect(body.report.summary.privacyBlockerCount).toBe(1);
    expect(body.evidenceArtifacts.length).toBeGreaterThan(0);
    // No full email address may appear in the HTTP response.
    expect(response.body).not.toMatch(/[A-Za-z0-9._%+-]{2,}@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/);
    expect(response.body).toContain('c***@corp.internal');
  });

  it('报告文件被篡改时 409 qa_report_tampered', async () => {
    const instance = await start();
    const { runId } = await createAndFinish(instance, 'route-qa-tamper-0001');
    const first = await instance.inject({
      method: 'GET',
      url: `${BASE}/runs/${runId}/qa-report`,
    });
    const artifact = (first.json() as { reportArtifact: { storageRef: string } }).reportArtifact;
    const file = path.join(artifactDir!, artifact.storageRef);
    writeFileSync(file, `${readFileSync(file, 'utf8')} `);
    const tampered = await instance.inject({
      method: 'GET',
      url: `${BASE}/runs/${runId}/qa-report`,
    });
    expect(tampered.statusCode).toBe(409);
    expect((tampered.json() as { error: { code: string } }).error.code).toBe('qa_report_tampered');
    // The Gate 3 core query must refuse the same tampered file.
    const latest = await instance.inject({
      method: 'GET',
      url: `${BASE}/videos/${VIDEO_ID}/latest-qa-report`,
    });
    expect(latest.statusCode).toBe(409);
  });

  it('qa_evidence_frame 经 ?inline=1 内联返回 image/png + nosniff', async () => {
    const instance = await start({
      findings: {
        final: [
          {
            category: 'privacy',
            severity: 'blocker',
            ruleId: 'privacy.email',
            title: '成片帧命中邮箱',
            sourceKind: 'render_frame',
          },
        ],
      },
      evidenceFor: [{ category: 'privacy', severity: 'blocker', ruleId: 'privacy.email' }],
    });
    const { runId } = await createAndFinish(instance, 'route-qa-inline-0001');
    const report = await instance.inject({
      method: 'GET',
      url: `${BASE}/runs/${runId}/qa-report`,
    });
    const evidence = (
      report.json() as { evidenceArtifacts: Array<{ id: string; kind: string; mimeType: string }> }
    ).evidenceArtifacts;
    const png = evidence.find((item) => item.kind === 'qa_evidence_frame')!;
    expect(png).toBeDefined();
    const inline = await instance.inject({
      method: 'GET',
      url: `${BASE}/artifacts/${png.id}?inline=1`,
    });
    expect(inline.statusCode).toBe(200);
    expect(inline.headers['content-type']).toBe('image/png');
    expect(inline.headers['x-content-type-options']).toBe('nosniff');
    expect(inline.headers['content-disposition']).toContain('inline');
    // Without `?inline=1` it is a download, not an inline render.
    const download = await instance.inject({
      method: 'GET',
      url: `${BASE}/artifacts/${png.id}`,
    });
    expect(download.headers['content-disposition']).toContain('attachment');
  });
});
