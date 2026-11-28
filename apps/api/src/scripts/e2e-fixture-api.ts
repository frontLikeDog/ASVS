import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { deflateRawSync } from 'node:zlib';
import type {
  CaptureJobInputV1,
  GitHubCommitSummary,
  GitHubConnectionStatus,
  GitHubFileContent,
  GitHubPullRequestFile,
  GitHubPullRequestSummary,
  GitHubReleaseSummary,
  GitHubRepoRef,
  GitHubRepositoryMetadata,
  GitHubWriteProbeResult,
  QaCategory,
  QaCheckSummaryV1,
  QaFindingV1,
  QaReportV1,
  QaStage,
  QaVerdict,
} from '@asvs/domain';
import {
  QA_POLICY_VERSION,
  QA_SCHEMA_VERSION,
  captureReceiptV1Schema,
  formatGitHubRepoRef,
  qaReportV1Schema,
} from '@asvs/domain';
import type {
  CaptureJobExecutionResult,
  CaptureJobExecutorCallbacks,
  CaptureJobExecutorPort,
  GitHubReadOnlyPort,
  GitHubTreeEntry,
  QaCaptureInput,
  QaEvidenceFrameResult,
  QaFinalInput,
  QaHealth,
  QaRunOutcome,
  QaRunnerPort,
  RenderJobExecutionResult,
  RenderJobExecutorCallbacks,
  RenderJobExecutorPort,
} from '@asvs/ports';
import { buildApp } from '../app';

/** apps/api/src/scripts → repository root */
const workspaceRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');

/**
 * Standalone local test-only fixture API for Playwright Step 4D E2E tests.
 * Never imported by `apps/api/src/main.ts`; binds `127.0.0.1` on an ephemeral
 * port and uses real Fastify + SQLite v4 + 4B incremental indexer + 4C PR
 * discovery over a deterministic in-memory GitHub repository fixture.
 */

const REPO_OWNER = 'acme';
const REPO_NAME = 'livenotes';
const FULL_REPO = `${REPO_OWNER}/${REPO_NAME}`;
const COMMIT_1 = '1111111111111111111111111111111111111111';
const COMMIT_2 = '2222222222222222222222222222222222222222';
const TREE_1 = 'aaaa111111111111111111111111111111111111';
const TREE_2 = 'bbbb222222222222222222222222222222222222';

function gitSha1(content: string): string {
  return createHash('sha1').update(content, 'utf8').digest('hex');
}

interface FixtureFile {
  path: string;
  content: string;
  sha: string;
}

function buildFiles(commitVersion: 1 | 2): Map<string, FixtureFile> {
  const exportPanelContent =
    commitVersion === 1
      ? `export function ExportPanel() {\n  return <button type="button">Export CSV</button>;\n}\n`
      : `export function ExportPanel() {\n  return <button type="button">Export CSV v2</button>;\n}\n`;
  const entries: Array<[string, string]> = [
    ['README.md', '# LiveNotes\n\nCollaborative workspace notes.\n'],
    ['src/ui/export-panel.tsx', exportPanelContent],
    ['src/core/format.ts', 'export function normalizeTitle(v: string) { return v.trim(); }\n'],
  ];
  const map = new Map<string, FixtureFile>();
  for (const [filePath, content] of entries) {
    map.set(filePath, { path: filePath, content, sha: gitSha1(`${filePath}:${content}`) });
  }
  return map;
}

class FixtureGitHubReadOnlyPort implements GitHubReadOnlyPort {
  #commitVersion: 1 | 2 = 1;
  #files = buildFiles(1);

  advanceCommit(): { commitSha: string; changedFile: string } {
    this.#commitVersion = 2;
    this.#files = buildFiles(2);
    return { commitSha: COMMIT_2, changedFile: 'src/ui/export-panel.tsx' };
  }

  isConfigured(): boolean {
    return true;
  }

  getDefaultRepo(): GitHubRepoRef {
    return { owner: REPO_OWNER, repo: REPO_NAME };
  }

  #assertSupportedRepo(repo: GitHubRepoRef): void {
    if (formatGitHubRepoRef(repo) !== FULL_REPO) {
      throw new Error(`测试夹具仅包含仓库 ${FULL_REPO}，收到 ${formatGitHubRepoRef(repo)}`);
    }
  }

  async checkConnection(repo?: GitHubRepoRef): Promise<GitHubConnectionStatus> {
    if (repo) this.#assertSupportedRepo(repo);
    return {
      configured: true,
      mode: 'github_app',
      connected: true,
      readOnly: true,
      appId: '900001',
      installationId: '800001',
      repo: FULL_REPO,
      repositorySelection: 'selected',
      accessibleRepositories: [FULL_REPO],
      permissions: { contents: 'read', metadata: 'read', pull_requests: 'read' },
      writePermissions: [],
      checkedAt: new Date().toISOString(),
    };
  }

  async getRepository(repo: GitHubRepoRef): Promise<GitHubRepositoryMetadata> {
    this.#assertSupportedRepo(repo);
    return {
      id: 9001,
      owner: REPO_OWNER,
      name: REPO_NAME,
      fullName: FULL_REPO,
      description: 'LiveNotes E2E Fixture Repository',
      private: false,
      defaultBranch: 'main',
      htmlUrl: `https://github.com/${FULL_REPO}`,
      pushedAt: '2026-11-27T10:00:00.000Z',
      updatedAt: '2026-11-27T10:00:00.000Z',
    };
  }

  async listPullRequests(repo: GitHubRepoRef): Promise<GitHubPullRequestSummary[]> {
    this.#assertSupportedRepo(repo);
    return [
      {
        id: 1001,
        number: 101,
        title: 'feat: add CSV export button',
        body: 'Expose one-click CSV export in the workspace panel.',
        state: 'closed',
        draft: false,
        merged: true,
        mergedAt: '2026-11-26T12:00:00.000Z',
        createdAt: '2026-11-26T10:00:00.000Z',
        updatedAt: '2026-11-26T12:00:00.000Z',
        author: 'alice',
        labels: ['feature'],
        headSha: COMMIT_1,
        baseBranch: 'main',
        headBranch: 'feat/csv-export',
        mergeCommitSha: COMMIT_1,
        htmlUrl: `https://github.com/${FULL_REPO}/pull/101`,
      },
      {
        id: 1002,
        number: 102,
        title: 'refactor: cleanup internal helper',
        body: 'Internal formatting helper cleanup.',
        state: 'closed',
        draft: false,
        merged: true,
        mergedAt: '2026-11-25T12:00:00.000Z',
        createdAt: '2026-11-25T10:00:00.000Z',
        updatedAt: '2026-11-25T12:00:00.000Z',
        author: 'bob',
        labels: ['refactor'],
        headSha: COMMIT_1,
        baseBranch: 'main',
        headBranch: 'refactor/format',
        mergeCommitSha: COMMIT_1,
        htmlUrl: `https://github.com/${FULL_REPO}/pull/102`,
      },
    ];
  }

  async listPullRequestFiles(
    repo: GitHubRepoRef,
    pullNumber: number,
  ): Promise<GitHubPullRequestFile[]> {
    this.#assertSupportedRepo(repo);
    if (pullNumber === 101) {
      return [
        {
          filename: 'src/ui/export-panel.tsx',
          status: 'modified',
          additions: 24,
          deletions: 4,
          changes: 28,
        },
      ];
    }
    return [
      {
        filename: 'src/core/format.ts',
        status: 'modified',
        additions: 5,
        deletions: 7,
        changes: 12,
      },
    ];
  }

  async listReleases(repo: GitHubRepoRef): Promise<GitHubReleaseSummary[]> {
    this.#assertSupportedRepo(repo);
    return [];
  }

  async getCommit(repo: GitHubRepoRef): Promise<GitHubCommitSummary> {
    this.#assertSupportedRepo(repo);
    return this.#commitVersion === 1
      ? {
          sha: COMMIT_1,
          treeSha: TREE_1,
          commitAt: '2026-11-26T12:00:00.000Z',
          message: 'feat: add CSV export button',
        }
      : {
          sha: COMMIT_2,
          treeSha: TREE_2,
          commitAt: '2026-11-27T12:00:00.000Z',
          message: 'chore: update export panel component',
        };
  }

  async getRepositoryTree(repo: GitHubRepoRef): Promise<GitHubTreeEntry[]> {
    this.#assertSupportedRepo(repo);
    return Array.from(this.#files.values()).map((file) => ({
      path: file.path,
      type: 'blob' as const,
      sha: file.sha,
      size: Buffer.byteLength(file.content, 'utf8'),
    }));
  }

  async getFileContent(
    repo: GitHubRepoRef,
    filePath: string,
  ): Promise<GitHubFileContent | null> {
    this.#assertSupportedRepo(repo);
    const file = this.#files.get(filePath);
    if (!file) return null;
    return {
      path: file.path,
      sha: file.sha,
      size: Buffer.byteLength(file.content, 'utf8'),
      encoding: 'utf-8',
      content: file.content,
      contentBase64: Buffer.from(file.content, 'utf8').toString('base64'),
    };
  }

  async probeWriteBlocked(repo: GitHubRepoRef): Promise<GitHubWriteProbeResult> {
    this.#assertSupportedRepo(repo);
    return {
      repo: FULL_REPO,
      readOnlyToken: true,
      writeBlocked: true,
      statusCode: 403,
      detail: 'GitHub App 只读令牌已拦截写入请求（AC-01）',
      writePermissions: [],
      checkedAt: new Date().toISOString(),
    };
  }
}

// ── Gate 2 capture double (browser E2E only; this API is test-only) ────────

/**
 * Fast stand-ins for the two worker subprocesses, installed only when asked.
 *
 * The E2E suite drives the production page through Gate 2 in a few seconds, so
 * it cannot pay for a real Chromium recording plus a Remotion render. These
 * doubles keep every *server-side* guarantee intact — the orchestrator still
 * validates the approval ledger, recomputes the plan digest, re-hashes every
 * file and refuses stray artifacts — and only replace "run the browser" and
 * "run Remotion" with files that are internally consistent. What they do NOT
 * prove is that a real capture/render works; that is `pnpm gate2:verify` and
 * `pnpm capture:demo` / `pnpm render:captured`.
 */

/** Deterministic fake clip bytes; the receipt and backfill hash these exactly. */
const FAKE_CLIP_BODY = 'e2e-gate2-double-clip';

function writeGate2Clip(outDir: string, fileName: string): { file: string; sha256: string } {
  const file = path.join(outDir, fileName);
  writeFileSync(file, FAKE_CLIP_BODY);
  return { file, sha256: createHash('sha256').update(FAKE_CLIP_BODY).digest('hex') };
}

class Gate2CaptureDouble implements CaptureJobExecutorPort {
  private running = false;
  constructor(private readonly options: { fail: boolean; message: string }) {}
  isRunning(): boolean {
    return this.running;
  }
  abort(): void {
    /* instantaneous double: nothing to kill */
  }
  async execute(
    job: CaptureJobInputV1,
    _inputFile: string,
    outDir: string,
    _checkpointFile: string,
    callbacks: CaptureJobExecutorCallbacks,
  ): Promise<CaptureJobExecutionResult> {
    this.running = true;
    try {
      callbacks.onSpawn?.(4_242);
      callbacks.onHeartbeat?.(4_242);
      // The same phases the real worker emits, in the same order.
      callbacks.onCheckpoint?.('plan_verified', { planId: job.plan.id });
      const checkpoints: Array<{ phase: string; payload: Record<string, unknown> }> = [
        { phase: 'plan_verified', payload: { planId: job.plan.id } },
      ];
      if (this.options.fail) {
        mkdirSync(path.join(outDir, 'screenshots'), { recursive: true });
        writeFileSync(path.join(outDir, 'screenshots', '01-failure.png'), FAILURE_PNG_BYTES);
        writeFileSync(
          path.join(outDir, 'failure-report.json'),
          JSON.stringify(
            {
              schemaVersion: '1',
              kind: 'asvs.capture-failure',
              jobId: job.jobId,
              planId: job.plan.id,
              planDigest: job.planDigest,
              error: this.options.message,
              blockedRequests: [],
              screenshots: ['screenshots/01-failure.png'],
            },
            null,
            2,
          ),
        );
        writeFileSync(path.join(outDir, 'trace.zip'), 'e2e-trace');
        const failedAt = new Date().toISOString();
        const result = {
          schemaVersion: '1' as const,
          kind: 'asvs.capture-job-result' as const,
          jobId: job.jobId,
          planId: job.plan.id,
          planDigest: job.planDigest,
          policyVersion: job.policyVersion,
          passed: false,
          failed: {
            kind: 'asvs.capture-job-failed' as const,
            jobId: job.jobId,
            code: 'capture_assertion_failed' as const,
            message: this.options.message,
            failedStepId: job.plan.steps.find((step) => step.action === 'assert')?.id ?? 'assert',
            failureReportRef: 'failure-report.json',
            // `traceRef` is deliberately omitted: this failure path leaves no
            // trace, and naming a file that is not on disk would be a lie the
            // UI would repeat back to the reviewer.
            screenshotRefs: ['screenshots/01-failure.png'],
            assertionFailures: 1,
            retryable: false,
            failedAt,
          },
          durationMs: 15,
          writtenAt: failedAt,
        };
        writeFileSync(path.join(outDir, 'job-result.json'), JSON.stringify(result, null, 2));
        return {
          ok: false,
          workerPid: 4_242,
          exitCode: 1,
          signal: null,
          crashed: false,
          code: 'capture_assertion_failed',
          message: this.options.message,
          checkpoints,
          result,
        };
      }

      callbacks.onCheckpoint?.('capture_started', { baseUrl: job.plan.baseUrl });
      callbacks.onCheckpoint?.('capture_recorded', {});
      callbacks.onCheckpoint?.('clip_transcoded', {});
      checkpoints.push(
        { phase: 'capture_started', payload: { baseUrl: job.plan.baseUrl } },
        { phase: 'capture_recorded', payload: {} },
        { phase: 'clip_transcoded', payload: {} },
      );
      const plannedAsset = job.plan.asset;
      if (!plannedAsset) {
        // A receipt must carry the asset it produced; without one there is
        // nothing honest to record, so fail instead of inventing it.
        throw new Error('Gate 2 double: 计划缺少 asset，无法生成回执');
      }
      const slug = plannedAsset.id;
      const clip = writeGate2Clip(outDir, `${slug}.mp4`);
      mkdirSync(path.join(outDir, 'screenshots'), { recursive: true });
      writeFileSync(path.join(outDir, 'screenshots', '01-dashboard.png'), FAILURE_PNG_BYTES);
      writeFileSync(path.join(outDir, 'trace.zip'), 'e2e-trace');
      const durationMs = job.plan.capture.clipDurationMs;
      const rel = (file: string) => path.relative(job.storageRefBase, file).split(path.sep).join('/');
      const receipt = captureReceiptV1Schema.parse({
        schemaVersion: '1',
        kind: 'asvs.capture-receipt',
        jobId: job.jobId,
        planId: job.plan.id,
        planFile: 'capture-job-input.json',
        planDigest: job.planDigest,
        approvalId: job.plan.approval?.approvalId ?? 'appr_e2e',
        createdAt: new Date().toISOString(),
        environment: {
          baseUrl: job.plan.baseUrl,
          browser: 'Chromium · E2E double',
          viewport: job.plan.viewport,
          locale: job.plan.locale,
          timezoneId: job.plan.timezoneId,
          colorScheme: job.plan.colorScheme,
          reducedMotion: job.plan.reducedMotion,
        },
        assertions: { total: 1, passed: 1, failed: 0 },
        steps: [
          {
            id: job.plan.steps.find((step) => step.action === 'assert')?.id ?? 'assert',
            action: 'assert',
            status: 'passed',
            startedAtMs: 0,
            durationMs: 10,
            assertion: { kind: 'visible', passed: true },
          },
        ],
        rawVideo: {
          file: rel(clip.file),
          sha256: clip.sha256,
          byteSize: Buffer.byteLength(FAKE_CLIP_BODY),
          mimeType: 'video/webm',
          width: job.plan.capture.width,
          height: job.plan.capture.height,
          fps: job.plan.capture.fps,
          durationMs,
          codecName: 'vp8',
        },
        clip: {
          file: rel(clip.file),
          sha256: clip.sha256,
          byteSize: Buffer.byteLength(FAKE_CLIP_BODY),
          mimeType: 'video/mp4',
          width: job.plan.capture.width,
          height: job.plan.capture.height,
          fps: job.plan.capture.fps,
          durationMs,
          codecName: 'h264',
        },
        trace: {
          file: 'trace.zip',
          sha256: createHash('sha256').update('e2e-trace').digest('hex'),
          byteSize: 9,
          mimeType: 'application/zip',
        },
        screenshots: [
          {
            file: 'screenshots/01-dashboard.png',
            sha256: createHash('sha256').update(FAILURE_PNG_BYTES).digest('hex'),
            byteSize: FAILURE_PNG_BYTES.length,
            mimeType: 'image/png',
          },
        ],
        // The asset the planner proposed, flipped to a real capture: mock:false,
        // media pointing at the clip we just wrote, hashes matching exactly.
        asset: {
          id: plannedAsset.id,
          projectId: job.plan.projectId,
          name: plannedAsset.name,
          kind: 'capture',
          durationSec: Math.max(1, Math.round(durationMs / 1000)),
          description: plannedAsset.description,
          palette: plannedAsset.palette,
          mock: false,
          media: {
            src: rel(clip.file),
            mimeType: 'video/mp4',
            width: job.plan.capture.width,
            height: job.plan.capture.height,
            durationMs,
            sha256: clip.sha256,
            capturePlanId: job.plan.id,
            // Resolved by the orchestrator against the artifact root, which is
            // where this double wrote it; `rel` keeps it in the same
            // storageRefBase-relative form as `media.sourceFile`.
            captureReceiptRef: rel(path.join(outDir, 'capture-receipt.json')),
          },
        },
        media: {
          assetId: plannedAsset.id,
          sourceFile: rel(clip.file),
          sha256: clip.sha256,
          mimeType: 'video/mp4',
          width: job.plan.capture.width,
          height: job.plan.capture.height,
          durationMs,
        },
        renderFixture: { file: 'captured-30s.json', sha256: 'f'.repeat(64) },
      });
      writeFileSync(path.join(outDir, 'capture-receipt.json'), JSON.stringify(receipt, null, 2));
      const completedAt = new Date().toISOString();
      const result = {
        schemaVersion: '1' as const,
        kind: 'asvs.capture-job-result' as const,
        jobId: job.jobId,
        planId: job.plan.id,
        planDigest: job.planDigest,
        policyVersion: job.policyVersion,
        passed: true,
        completed: {
          kind: 'asvs.capture-job-completed' as const,
          jobId: job.jobId,
          planId: job.plan.id,
          planDigest: job.planDigest,
          receiptFile: 'capture-receipt.json',
          receiptSha256: createHash('sha256')
            .update(readFileSync(path.join(outDir, 'capture-receipt.json')))
            .digest('hex'),
          clipFile: rel(clip.file),
          clipSha256: clip.sha256,
          clipDurationMs: durationMs,
          clipWidth: job.plan.capture.width,
          clipHeight: job.plan.capture.height,
          assertions: { total: 1, passed: 1, failed: 0 as const },
          screenshotCount: 1,
          completedAt,
        },
        durationMs: 20,
        writtenAt: completedAt,
      };
      writeFileSync(path.join(outDir, 'job-result.json'), JSON.stringify(result, null, 2));
      return { ok: true, workerPid: 4_242, exitCode: 0, checkpoints, result };
    } finally {
      this.running = false;
    }
  }
}

/** 1×1 PNG; a real image so the inline `nosniff` preview path is exercised. */
const FAILURE_PNG_BYTES = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);

/**
 * A byte-valid 1280×720 PNG (solid colour, no encoder) used as the
 * `qa_evidence_frame`. Real bytes matter: the review page loads it through
 * `?inline=1` with `X-Content-Type-Options: nosniff`, and a truncated file
 * would fail there while the test still "passed" on the DOM alone.
 */
const QA_EVIDENCE_PNG_BYTES = (() => {
  const width = 64;
  const height = 36;
  const raw = Buffer.alloc((width * 3 + 1) * height);
  for (let row = 0; row < height; row += 1) {
    const offset = row * (width * 3 + 1);
    raw[offset] = 0; // filter: none
    for (let column = 0; column < width; column += 1) {
      const pixel = offset + 1 + column * 3;
      raw[pixel] = 0x2b;
      raw[pixel + 1] = 0x6c;
      raw[pixel + 2] = 0xb0;
    }
  }
  const crc32 = (bytes: Buffer): number => {
    let crc = 0xffffffff;
    for (const byte of bytes) {
      crc ^= byte;
      for (let bit = 0; bit < 8; bit += 1) {
        crc = crc & 1 ? 0xedb88320 ^ (crc >>> 1) : crc >>> 1;
      }
    }
    return (crc ^ 0xffffffff) >>> 0;
  };
  const chunk = (type: string, data: Buffer): Buffer => {
    const header = Buffer.alloc(8);
    header.writeUInt32BE(data.length, 0);
    header.write(type, 4, 'ascii');
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(Buffer.concat([header.subarray(4), data])), 0);
    return Buffer.concat([header, data, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // truecolour
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateRawSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
})();

function qaCheckSummaries(findings: QaFindingV1[]): QaCheckSummaryV1[] {
  const labels: Record<QaCategory, string> = {
    privacy: 'AC-07 隐私守门',
    technical: '技术 QA',
    fact: '事实与声明',
    content: '内容与品牌',
  };
  return (['privacy', 'technical', 'fact', 'content'] as const).map((category) => {
    const scoped = findings.filter((finding) => finding.category === category);
    const blockers = scoped.filter((finding) => finding.severity === 'blocker').length;
    const warnings = scoped.filter((finding) => finding.severity === 'warning').length;
    const infos = scoped.filter((finding) => finding.severity === 'info').length;
    return {
      category,
      status: blockers > 0 ? ('fail' as const) : warnings > 0 ? ('warn' as const) : ('pass' as const),
      blockerCount: blockers,
      warningCount: warnings,
      infoCount: infos,
      summary:
        scoped.length === 0
          ? `${labels[category]}：未发现问题`
          : `${labels[category]}：${blockers} 项阻断 / ${warnings} 项提醒 / ${infos} 项提示`,
    };
  });
}

/**
 * QA double for the Gate 3 specs (docs/16 §9.2, red line 4).
 *
 * Like the Gate 2 doubles it produces structurally valid evidence — a real PNG
 * evidence frame, a real report file, matching SHA256s — but it does **not**
 * scan anything and always reports `ocrSynthetic: true` when available. That
 * is why every spec that uses it asserts the *UI gate*, never "the video is
 * privacy-clean": `pnpm qa:verify` is what proves the real scanner.
 *
 * Mode is a single mutable object so a spec can flip it per scenario; the
 * server registers this double only when the spec asks for it.
 */
interface QaDoubleState {
  mode: 'pass' | 'privacy_block';
}

class QaRunnerDouble implements QaRunnerPort {
  private running = false;
  constructor(private readonly state: QaDoubleState) {}
  isRunning(): boolean {
    return this.running;
  }
  abort(): void {
    /* instantaneous double */
  }
  health(): QaHealth {
    return {
      enabled: true,
      ocrProvider: 'deterministic_test',
      ocrConfigured: true,
      policyVersion: QA_POLICY_VERSION,
    };
  }
  async runCaptureQa(input: QaCaptureInput): Promise<QaRunOutcome> {
    return this.writeReport(input, 'capture');
  }
  async runFinalQa(input: QaFinalInput): Promise<QaRunOutcome> {
    return this.writeReport(input, 'final');
  }

  private writeReport(input: QaCaptureInput | QaFinalInput, stage: QaStage): QaRunOutcome {
    // A privacy block can happen at either stage (the real scanner checks both),
    // and the Gate 3 page must handle the one a reviewer actually sees. The
    // double blocks at whichever stage runs, so the spec can use a
    // capture-disabled run and still get a blocked verdict at `qa_final`.
    const blocked = this.state.mode === 'privacy_block';
    const findings: QaFindingV1[] = [];
    const evidenceFrames: QaEvidenceFrameResult[] = [];

    if (blocked) {
      findings.push({
        id: 'qaf_01',
        ruleId: 'privacy.email_address',
        category: 'privacy',
        severity: 'blocker',
        sourceKind: 'capture_trace',
        title: 'trace 中出现完整邮箱地址',
        message:
          'Playwright trace 的请求头中出现了包含完整邮箱的凭据值。原始命中值不会写入报告，仅保留脱敏样本与 SHA256。',
        remediation: '在录屏用的测试账号中移除该凭据，重新计划并录屏；确认 trace 不再包含该值。',
        remediationAction: 'production',
        location: {
          scope: 'scene',
          sceneId: 'scene_e2e_2',
          sceneOrder: 1,
          sceneTitle: '产品演示',
          timestampMs: 3200,
          traceEntryPath: 'trace.network#1 (request.headers.authorization)',
        },
        // Only the masked sample ever leaves the scanner (AC-07 red line 3).
        matchRedacted: 'a***@corp.internal',
        matchSha256: '9f2c'.padEnd(64, '0'),
      });
      const evidenceFile = path.join(input.runDir, 'qa', 'evidence', 'qaf_01.png');
      mkdirSync(path.dirname(evidenceFile), { recursive: true });
      writeFileSync(evidenceFile, QA_EVIDENCE_PNG_BYTES);
      evidenceFrames.push({
        findingId: 'qaf_01',
        file: evidenceFile,
        sha256: createHash('sha256').update(QA_EVIDENCE_PNG_BYTES).digest('hex'),
        byteSize: QA_EVIDENCE_PNG_BYTES.length,
        redacted: true,
      });
    } else if (stage === 'final') {
      // Only the passing path gets the non-blocking warning.
      // One non-blocking warning on the passing path, so the spec proves the
      // page distinguishes 「通过 · 有提醒」 from a clean pass (#3 of §9.2).
      findings.push({
        id: 'qaf_01',
        ruleId: 'content.brand_kit',
        category: 'content',
        severity: 'warning',
        sourceKind: 'scene_text',
        title: '缺少明确的行动号召',
        message: '成片结尾未检测到行动号召文案，建议在最后一镜补上「立即体验」等 CTA。',
        remediation: '在编辑器中为最后一镜补充 CTA 文案，然后重新渲染。',
        remediationAction: 'editor',
        location: { scope: 'scene', sceneId: 'scene_e2e_3', sceneOrder: 2, sceneTitle: '结尾' },
      });
    }

    const sha256Of = (file: string): string | undefined =>
      existsSync(file) ? createHash('sha256').update(readFileSync(file)).digest('hex') : undefined;
    // Derive the verdict the same way the schema enforces it, so the double can
    // never emit an inconsistent report (`superRefine` would reject it anyway).
    const verdict: QaVerdict = findings.some((finding) => finding.severity === 'blocker')
      ? 'fail'
      : findings.some((finding) => finding.severity === 'warning')
        ? 'pass_with_warnings'
        : 'pass';
    const report: QaReportV1 = qaReportV1Schema.parse({
      schemaVersion: QA_SCHEMA_VERSION,
      kind: 'asvs.qa-report',
      reportId: `qarep_e2e_${stage}`,
      runId: input.runId,
      workspaceId: input.workspaceId,
      projectId: input.projectId,
      videoId: input.videoId,
      stage,
      verdict,
      policyVersion: QA_POLICY_VERSION,
      summary: {
        totalFindings: findings.length,
        blockerCount: findings.filter((finding) => finding.severity === 'blocker').length,
        warningCount: findings.filter((finding) => finding.severity === 'warning').length,
        infoCount: findings.filter((finding) => finding.severity === 'info').length,
        privacyBlockerCount: findings.filter(
          (finding) => finding.category === 'privacy' && finding.severity === 'blocker',
        ).length,
        technicalBlockerCount: findings.filter(
          (finding) => finding.category === 'technical' && finding.severity === 'blocker',
        ).length,
        factBlockerCount: findings.filter(
          (finding) => finding.category === 'fact' && finding.severity === 'blocker',
        ).length,
        contentBlockerCount: findings.filter(
          (finding) => finding.category === 'content' && finding.severity === 'blocker',
        ).length,
      },
      checks: qaCheckSummaries(findings),
      findings,
      coverage: {
        scannedCaptureFrames: stage === 'capture' ? 4 : 0,
        scannedRenderFrames: stage === 'final' ? 6 : 0,
        scannedScreenshots: stage === 'capture' ? 1 : 0,
        scannedTraceEntries: stage === 'capture' ? 3 : 0,
        skippedTraceStaticEntries: 0,
        scannedScenes: 3,
        scannedSrtCues: stage === 'final' ? 3 : 0,
        ocrProvider: 'deterministic_test',
        ocrExecuted: true,
        // Honest label: nothing here read a pixel.
        ocrSynthetic: true,
        allowlistedDomains: [],
      },
      subject: {
        inputDigest: input.inputDigest,
        scriptVersion: input.scriptVersion,
        ...(stage === 'capture'
          ? { capturePlanDigest: 'd'.repeat(64) }
          : {
              ...(sha256Of((input as QaFinalInput).videoFile)
                ? { mp4Sha256: sha256Of((input as QaFinalInput).videoFile)! }
                : {}),
              ...((input as QaFinalInput).subtitlesFile && sha256Of((input as QaFinalInput).subtitlesFile!)
                ? { srtSha256: sha256Of((input as QaFinalInput).subtitlesFile!)! }
                : {}),
              ...(sha256Of((input as QaFinalInput).manifestFile)
                ? { manifestSha256: sha256Of((input as QaFinalInput).manifestFile)! }
                : {}),
            }),
      },
      durationMs: 12,
      createdAt: new Date().toISOString(),
    });

    const reportFile = path.join(input.runDir, 'qa', `qa-${stage}-report.json`);
    mkdirSync(path.dirname(reportFile), { recursive: true });
    const bytes = `${JSON.stringify(report, null, 2)}\n`;
    writeFileSync(reportFile, bytes);
    return {
      report,
      reportFile,
      reportSha256: createHash('sha256').update(bytes, 'utf8').digest('hex'),
      evidenceFrames,
    };
  }
}

class Gate2RenderDouble implements RenderJobExecutorPort {
  private running = false;
  abort(): void {
    /* instantaneous double */
  }
  isRunning(): boolean {
    return this.running;
  }
  async execute(
    job: unknown,
    _inputFile: string,
    outDir: string,
    _checkpointFile: string,
    callbacks: RenderJobExecutorCallbacks,
  ): Promise<RenderJobExecutionResult> {
    this.running = true;
    try {
      const typed = job as {
        jobId: string;
        runId: string;
        audio: unknown[];
        subtitlesPath?: string;
      };
      callbacks.onSpawn?.(4_243);
      callbacks.onHeartbeat?.(4_243);
      callbacks.onCheckpoint?.('verified_receipt', {});
      mkdirSync(outDir, { recursive: true });
      const mp4 = path.join(outDir, `${typed.runId}.mp4`);
      writeFileSync(mp4, 'e2e-gate2-double-film');
      const digest = createHash('sha256').update('e2e-gate2-double-film').digest('hex');
      const bytes = Buffer.byteLength('e2e-gate2-double-film');
      const srtFile = path.join(path.dirname(outDir), 'subtitles.srt');
      const srtContent =
        typed.subtitlesPath && existsSync(srtFile) ? readFileSync(srtFile, 'utf8') : '';
      const narrationEnabled = typed.audio.length > 0;
      writeFileSync(
        path.join(outDir, 'receipt.json'),
        JSON.stringify({
          schemaVersion: '1',
          jobId: typed.jobId,
          artifactId: typed.jobId.replace(/^orchjob/, 'artifact'),
          sha256: digest,
          mimeType: 'video/mp4',
          byteSize: bytes,
          storageRef: path.basename(mp4),
          durationMs: 6000,
          width: 1920,
          height: 1080,
          fps: 30,
          rendererVersion: 'e2e-gate2-double',
          compositionId: 'AsvsVideo',
          createdAt: new Date().toISOString(),
        }),
      );
      writeFileSync(
        path.join(outDir, 'manifest.json'),
        JSON.stringify({
          schemaVersion: '1',
          jobId: typed.jobId,
          artifactId: typed.jobId.replace(/^orchjob/, 'artifact'),
          compositionId: 'AsvsVideo',
          rendererVersion: 'e2e-gate2-double',
          renderInputDigest: 'b'.repeat(64),
          storyboardDigest: 'c'.repeat(64),
          sceneDigests: [],
          assetHashes: [],
          renderProfile: { width: 1920, height: 1080, codec: 'h264', crf: 18 },
          output: { fileName: path.basename(mp4), mimeType: 'video/mp4', byteSize: bytes, sha256: digest },
          ffprobe: {
            codecName: 'h264',
            durationMs: 6000,
            width: 1920,
            height: 1080,
            fps: 30,
            frameCount: 180,
            ...(narrationEnabled
              ? {
                  audio: {
                    codecName: 'aac',
                    sampleRate: 48_000,
                    channels: 1,
                    durationMs: 6000,
                    meanVolumeDb: -20,
                  },
                }
              : {}),
          },
          ...(narrationEnabled
            ? {
                narration: {
                  provider: 'deterministic_test',
                  model: 'tone-v1',
                  voiceId: 'test-voice-zh',
                  language: 'zh-CN',
                  license: 'internal-deterministic-test-only',
                  synthetic: true,
                  timingPolicy: 'extend_scene',
                  adjustments: [],
                  clips: [],
                },
                subtitles: {
                  fileName: 'subtitles.srt',
                  mimeType: 'application/x-subrip',
                  byteSize: Buffer.byteLength(srtContent),
                  sha256: createHash('sha256').update(srtContent).digest('hex'),
                  cueCount: Math.max(1, srtContent.split('\n\n').filter((b) => b.trim()).length),
                  durationMs: 6000,
                },
              }
            : {}),
          createdAt: new Date().toISOString(),
        }),
      );
      return {
        ok: true,
        workerPid: 4_243,
        exitCode: 0,
        checkpoints: [{ phase: 'verified_receipt', payload: {} }],
        completed: {
          type: 'completed',
          receiptPath: path.join('artifacts', 'receipt.json'),
          manifestPath: path.join('artifacts', 'manifest.json'),
          outputPath: mp4,
          outputSha256: digest,
          byteSize: bytes,
        },
      };
    } finally {
      this.running = false;
    }
  }
}

// ── Export-ready seeding (browser E2E only; this API is test-only) ──────────

/** 400ms 440 Hz WAV; deterministic and trivially reproducible in a test. */
function buildToneWav(): Buffer {
  const sampleRate = 48_000;
  const samples = Math.round(sampleRate * 0.4);
  const data = Buffer.alloc(samples * 2);
  for (let index = 0; index < samples; index += 1) {
    const value = Math.round(Math.sin((2 * Math.PI * 440 * index) / sampleRate) * 0.2 * 32767);
    data.writeInt16LE(value, index * 2);
  }
  const header = Buffer.alloc(44);
  header.write('RIFF', 0, 'ascii');
  header.writeUInt32LE(36 + data.byteLength, 4);
  header.write('WAVE', 8, 'ascii');
  header.write('fmt ', 12, 'ascii');
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36, 'ascii');
  header.writeUInt32LE(data.byteLength, 40);
  return Buffer.concat([header, data]);
}

interface SeedOptions {
  videoId: string;
  approved: boolean;
}

/**
 * Writes a minimal but internally consistent artifact set and registers it as
 * a succeeded run. The export route re-hashes every file, so the bytes, the
 * manifest and the artifact rows must agree exactly — that is what makes the
 * seeded bundle a real test of the gate rather than a mock.
 *
 * Nothing here is a real MP4: the file is a labelled placeholder, and the
 * seeded run is only used to prove the export gate and download plumbing. The
 * real audio/video proof is `pnpm export:verify`.
 */
function seedExportReadyRun(
  built: Awaited<ReturnType<typeof buildApp>>,
  artifactDir: string,
  workspaceId: string,
  options: SeedOptions,
): { runId: string; videoArtifactId: string; srtArtifactId: string; workspaceRevision: number } {
  const store = built.orchestrationStore;
  const workspaceRecord = built.store.get(workspaceId);
  if (!workspaceRecord) throw new Error(`工作区 ${workspaceId} 尚未同步`);

  const video = workspaceRecord.workspace.videos.find((item) => item.id === options.videoId);
  if (!video) throw new Error(`视频 ${options.videoId} 不在工作区中`);

  const runId = `orchrun_e2e_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  const jobId = `orchjob_e2e_${runId.slice(-8)}`;
  const videoArtifactId = `${jobId}_video_mp4`;
  const now = new Date();
  const createdAt = now.toISOString();
  const scriptVersion = video.scriptVersion;
  const storyboardBriefRevisionId = `${options.videoId}_brief_v${scriptVersion}`;

  // The gate reads `stage` + `review.status`; the route re-checks both, so the
  // seed must change the workspace exactly the way an approval would.
  if (options.approved) {
    // The review page's own checks require a succeeded production run, so the
    // seed ships one. `finishedAt` is after `video.updatedAt` or the freshness
    // check would (correctly) fail the approval.
    const succeededRun = {
      id: `seedrun_${runId.slice(-10)}`,
      projectId: video.projectId,
      videoId: video.id,
      scenario: 'happy_path' as const,
      status: 'succeeded' as const,
      steps: [],
      logs: [],
      elapsedMs: 1000,
      startedAt: createdAt,
      finishedAt: createdAt,
      speed: 1,
      input: {
        sceneCount: video.scenes.length,
        durationSec: video.scenes.reduce((sum, scene) => sum + scene.durationSec, 0),
        aspect: '16:9' as const,
        claimCount: 0,
      },
      demo: false,
    };
    const updated = {
      ...workspaceRecord.workspace,
      runs: [succeededRun, ...workspaceRecord.workspace.runs],
      videos: workspaceRecord.workspace.videos.map((item) =>
        item.id === options.videoId
          ? {
              ...item,
              // `updatedAt` is nudged *before* `decidedAt` so approval freshness
              // holds (the check allows a 1s grace and fails after it).
              updatedAt: new Date(now.getTime() + 500).toISOString(),
              stage: 'approved' as const,
              review: {
                status: 'approved' as const,
                note: 'E2E Gate 3',
                decidedAt: new Date(now.getTime() + 1_000).toISOString(),
              },
            }
          : item,
      ),
    };
    const saved = built.store.put(workspaceId, { workspace: updated, baseRevision: workspaceRecord.revision });
    if (!saved.ok) throw new Error(`批准种子视频失败：${saved.conflict ? '版本冲突' : '写入失败'}`);
  }

  const steps = (
    [
      'freeze_input',
      'verify_claims',
      'prepare_media',
      'synthesize_voice',
      'generate_subtitles',
      'render_video',
      'register_artifacts',
    ] as const
  ).map((stepKey) => ({
    stepKey,
    status: 'succeeded' as const,
    attempt: 1,
    checkpointPhases: ['step_done'],
    startedAt: createdAt,
    finishedAt: createdAt,
  }));

  const narrationSummary = {
    enabled: true,
    clipCount: 1,
    cacheHits: 1,
    synthetic: true,
    timingPolicy: 'extend_scene',
    adjustments: 0,
  };

  const inputDigest = 'e'.repeat(64);
  const storyboardDigest = 'f'.repeat(64);
  // The export route reads `storyboard.briefRevisionId` from the frozen input to
  // prove the run matches the approved script version. Writing it is not a
  // formality: without it the route treats the run as unversioned and lets the
  // export through, which would make this seed a weaker test than it looks.
  mkdirSync(path.join(artifactDir, 'workspaces', workspaceId, 'runs', runId), { recursive: true });
  writeFileSync(
    path.join(artifactDir, 'workspaces', workspaceId, 'runs', runId, 'input.json'),
    JSON.stringify(
      {
        schemaVersion: '1',
        input: {
          storyboard: { briefRevisionId: storyboardBriefRevisionId, scenes: [] },
          narration: { enabled: true },
        },
      },
      null,
      2,
    ),
    'utf8',
  );

  const run = {
    schemaVersion: '1' as const,
    id: runId,
    workspaceId,
    projectId: video.projectId,
    videoId: video.id,
    idempotencyKey: `seed-${runId}`,
    status: 'succeeded' as const,
    renderProfile: { width: 1920, height: 1080, codec: 'h264' as const, crf: 18 },
    inputDigest,
    currentStepKey: null,
    steps,
    input: {
      sceneCount: video.scenes.length,
      durationSec: video.scenes.reduce((sum, scene) => sum + scene.durationSec, 0),
      aspect: '16:9' as const,
      claimCount: 0,
      usingPlaceholder: true,
      narration: narrationSummary,
    },
    createdAt,
    updatedAt: createdAt,
    startedAt: createdAt,
    finishedAt: createdAt,
  };
  store.insertRun({
    run,
    jobs: [
      {
        id: jobId,
        stepKey: 'render_video',
        type: 'inline',
        inputDigest,
        maxAttempts: 3,
        createdAt,
      },
    ],
  });
  store.updateRun(run);

  // A WAV so the seeded file is a real, playable audio container, not random
  // bytes. It is not an MP4 — the placeholder flag says so.
  const runDir = path.join(artifactDir, 'workspaces', workspaceId, 'runs', runId);
  const outDir = path.join(runDir, 'artifacts');
  mkdirSync(outDir, { recursive: true });
  const mp4File = path.join(outDir, `${runId}.mp4`);
  writeFileSync(mp4File, buildToneWav());
  const mp4Sha = createHash('sha256').update(readFileSync(mp4File)).digest('hex');
  const mp4Bytes = statSync(mp4File).size;

  const srtContent = [
    '1',
    '00:00:00,150 --> 00:00:02,000',
    '这是一条 E2E 种子字幕。',
    '',
    '2',
    '00:00:02,100 --> 00:00:04,000',
    '它绑定到同一个冻结时间轴。',
    '',
  ].join('\n');
  const srtFile = path.join(runDir, 'subtitles.srt');
  writeFileSync(srtFile, srtContent, 'utf8');
  const srtSha = createHash('sha256').update(readFileSync(srtFile)).digest('hex');

  const manifestFile = path.join(outDir, 'manifest.json');
  writeFileSync(
    manifestFile,
    JSON.stringify(
      {
        schemaVersion: '1',
        jobId,
        renderInputDigest: inputDigest,
        storyboardDigest,
        rendererVersion: 'e2e-seed',
        compositionId: 'Storyboard',
        assetHashes: [],
        renderProfile: { width: 1920, height: 1080, codec: 'h264', crf: 18 },
        output: {
          fileName: path.basename(mp4File),
          mimeType: 'video/mp4',
          byteSize: mp4Bytes,
          sha256: mp4Sha,
        },
        ffprobe: {
          codecName: 'h264',
          durationMs: 12_000,
          width: 1920,
          height: 1080,
          fps: 30,
          audio: {
            codecName: 'aac',
            sampleRate: 48_000,
            channels: 2,
            durationMs: 12_000,
            meanVolumeDb: -18,
          },
        },
        narration: {
          provider: 'deterministic_test',
          model: 'tone-v1',
          voiceId: 'test-voice-zh',
          language: 'zh-CN',
          license: 'internal-deterministic-test-only',
          synthetic: true,
          timingPolicy: 'extend_scene',
          adjustments: [],
          clips: [
            { sceneId: video.scenes[0]?.id ?? 'scene', sha256: mp4Sha, durationMs: 2000, startMs: 0, endMs: 2000 },
          ],
        },
        subtitles: {
          fileName: 'subtitles.srt',
          mimeType: 'application/x-subrip',
          byteSize: Buffer.byteLength(srtContent, 'utf8'),
          sha256: srtSha,
          cueCount: 2,
          durationMs: 12_000,
        },
        createdAt,
      },
      null,
      2,
    ),
    'utf8',
  );
  const manifestSha = createHash('sha256').update(readFileSync(manifestFile)).digest('hex');
  const manifestBytes = statSync(manifestFile).size;

  const receiptFile = path.join(outDir, 'receipt.json');
  writeFileSync(
    receiptFile,
    JSON.stringify(
      {
        schemaVersion: '1',
        jobId,
        artifactId: videoArtifactId,
        sha256: mp4Sha,
        mimeType: 'video/mp4',
        byteSize: mp4Bytes,
        storageRef: path.basename(mp4File),
        durationMs: 12_000,
        width: 1920,
        height: 1080,
        fps: 30,
        rendererVersion: 'e2e-seed',
        compositionId: 'Storyboard',
        createdAt,
      },
      null,
      2,
    ),
    'utf8',
  );
  const receiptSha = createHash('sha256').update(readFileSync(receiptFile)).digest('hex');
  const receiptBytes = statSync(receiptFile).size;

  const register = (
    kind: 'video_mp4' | 'subtitles_srt' | 'render_manifest' | 'artifact_receipt' | 'qa_report',
    file: string,
    relative: string,
    mimeType: string,
    metadata: Record<string, unknown>,
  ) =>
    store.insertArtifact({
      schemaVersion: '1',
      id: `${jobId}_${kind}`,
      runId,
      workspaceId,
      jobId,
      kind,
      fileName: path.basename(file),
      mimeType,
      byteSize: statSync(file).size,
      sha256: createHash('sha256').update(readFileSync(file)).digest('hex'),
      storageRef: path.posix.join('workspaces', workspaceId, 'runs', runId, relative),
      metadata,
      createdAt,
    });

  register('video_mp4', mp4File, path.posix.join('artifacts', path.basename(mp4File)), 'video/mp4', {
    width: 1920,
    height: 1080,
    fps: 30,
    durationMs: 12_000,
    codecName: 'h264',
    // Mirrors the manifest the seeded render wrote, so the UI shows the same
    // audio facts the export bundle does. The file itself is a labelled
    // placeholder; `seeded` + `usingPlaceholder` say so.
    hasAudio: true,
    audioCodecName: 'aac',
    audioSampleRate: 48_000,
    audioChannels: 2,
    audioDurationMs: 12_000,
    audioMeanVolumeDb: -18,
    aspect: '16:9',
    rendererVersion: 'e2e-seed',
    usingPlaceholder: true,
    narration: {
      provider: 'deterministic_test',
      voiceId: 'test-voice-zh',
      language: 'zh-CN',
      license: 'internal-deterministic-test-only',
      synthetic: true,
      timingPolicy: 'extend_scene',
    },
    seeded: true,
  });
  register('subtitles_srt', srtFile, 'subtitles.srt', 'application/x-subrip; charset=utf-8', {
    cueCount: 2,
    durationMs: 12_000,
    language: 'zh-CN',
    seeded: true,
  });
  register(
    'render_manifest',
    manifestFile,
    path.posix.join('artifacts', 'manifest.json'),
    'application/json',
    { renderInputDigest: inputDigest, storyboardDigest, seeded: true },
  );
  register(
    'artifact_receipt',
    receiptFile,
    path.posix.join('artifacts', 'receipt.json'),
    'application/json',
    { durationMs: 12_000, seeded: true },
  );

  // 5D · `qa_final` is a hard export precondition now (Gate 5), so a seeded
  // "ready to export" run must carry the report it would have been released
  // under. Binding it to the real MP4/SRT/manifest hashes is what makes the
  // export route's `export_qa_stale` check meaningful for this seed.
  const qaReport: QaReportV1 = qaReportV1Schema.parse({
    schemaVersion: QA_SCHEMA_VERSION,
    kind: 'asvs.qa-report',
    reportId: `qarep_seed_${runId.slice(-8)}`,
    runId,
    workspaceId,
    projectId: video.projectId,
    videoId: video.id,
    stage: 'final',
    verdict: 'pass',
    policyVersion: QA_POLICY_VERSION,
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
    checks: qaCheckSummaries([]),
    findings: [],
    coverage: {
      scannedCaptureFrames: 0,
      scannedRenderFrames: 0,
      scannedScreenshots: 0,
      scannedTraceEntries: 0,
      skippedTraceStaticEntries: 0,
      scannedScenes: video.scenes.length,
      scannedSrtCues: 2,
      ocrProvider: 'deterministic_test',
      ocrExecuted: false,
      ocrSynthetic: true,
      allowlistedDomains: [],
    },
    subject: {
      inputDigest,
      scriptVersion,
      mp4Sha256: mp4Sha,
      srtSha256: srtSha,
      manifestSha256: manifestSha,
    },
    durationMs: 5,
    createdAt,
  });
  const qaDir = path.join(runDir, 'qa');
  mkdirSync(qaDir, { recursive: true });
  const qaFile = path.join(qaDir, 'qa-final-report.json');
  const qaBytes = `${JSON.stringify(qaReport, null, 2)}\n`;
  writeFileSync(qaFile, qaBytes, 'utf8');
  const qaSha = createHash('sha256').update(qaBytes, 'utf8').digest('hex');
  built.qaReportStore.upsert({ report: qaReport, reportSha256: qaSha });
  register('qa_report', qaFile, path.posix.join('qa', 'qa-final-report.json'), 'application/json', {
    stage: 'final',
    verdict: 'pass',
    blockerCount: 0,
    privacyBlockerCount: 0,
    policyVersion: QA_POLICY_VERSION,
    seeded: true,
  });

  // The export route re-hashes every file from disk; these locals exist so the
  // seed can be inspected in a debugger without re-reading the files.
  void manifestSha;
  void manifestBytes;
  void receiptSha;
  void receiptBytes;

  return {
    runId,
    videoArtifactId,
    srtArtifactId: `${jobId}_subtitles_srt`,
    workspaceRevision: built.store.get(workspaceId)?.revision ?? 0,
  };
}

async function main(): Promise<void> {
  const dbPath = process.env.ASVS_E2E_DB_PATH?.trim() || ':memory:';
  const artifactDir =
    process.env.ASVS_E2E_ARTIFACT_DIR?.trim() || path.resolve(workspaceRoot, 'dist/e2e/artifacts');
  const fixtureGitHub = new FixtureGitHubReadOnlyPort();
  // Gate 2 browser specs opt in per call (`/__test/gate2-doubles`), because a
  // double must never be the default for a spec that proves real behaviour.
  const gate2 = { captureFail: false, captureMessage: '' };
  // QA is opt-in as well: a spec that proves the *real* router path must not
  // silently get a double. `pass` is the default once enabled, which is what a
  // Gate 3 export spec needs.
  const qa: QaDoubleState = { mode: 'pass' };
  const qaRunner = new QaRunnerDouble(qa);
  const built = await buildApp({
    dbPath,
    artifactDir,
    // The orchestrator hands the worker `storageRefBase = mediaRoot`, and the
    // worker writes receipt refs relative to it. The fixture's artifacts live
    // in a temp dir (not under the repo), so the media root must be that temp
    // dir's parent or the refs it writes back would resolve nowhere.
    mediaRoot: path.dirname(artifactDir),
    corsOrigins: ['http://localhost:4200', 'http://127.0.0.1:4200'],
    logger: false,
    github: fixtureGitHub,
    // One attempt per step: a capture failure must reach the terminal state the
    // spec asserts on, not spend three retries proving the same thing.
    maxAttempts: 1,
    // The real browser-worker downloads Chromium and records for ~20s; the UI
    // spec only needs the server-side Gate 2 guarantees, which these doubles
    // preserve exactly. `pnpm gate2:verify` proves the real worker.
    captureExecutor: {
      isRunning: () => false,
      abort: () => undefined,
      execute: (...args) => new Gate2CaptureDouble({
        fail: gate2.captureFail,
        message: gate2.captureMessage,
      }).execute(...args),
    },
    renderExecutor: {
      isRunning: () => false,
      abort: () => undefined,
      execute: (...args) => new Gate2RenderDouble().execute(...args),
    },
    // Structural QA double: real report/PNG bytes and real hashes, but no
    // scanning. `pnpm qa:verify` proves the real scanner with real media.
    qaRunner,
    // The E2E suite runs offline: the deterministic test voice is labelled
    // `synthetic: true` everywhere, so the UI assertions stay honest.
    speechConfig: {
      provider: 'deterministic_test',
      model: 'tone-v1',
      voiceZh: 'test-voice-zh',
      voiceEn: 'test-voice-en',
      license: 'internal-deterministic-test-only',
      timeoutMs: 10_000,
      maxRetries: 1,
    },
  });
  const { app } = built;

  const localOnly = (request: { ip: string }, reply: { code: (status: number) => { send: (body: unknown) => unknown } }) => {
    const ip = request.ip;
    if (ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1') return null;
    return reply.code(403).send({ error: { code: 'forbidden', message: 'localhost only' } });
  };

  app.post('/__test/advance-commit', async (request, reply) => localOnly(request, reply) ?? fixtureGitHub.advanceCommit());

  /**
   * Chooses the QA double's verdict. `privacy_block` makes `qa_capture` fail
   * with `qa_privacy_blocked` and one redacted finding + blurred evidence frame;
   * `pass` lets the run reach `qa_final` with a single non-blocking warning.
   */
  app.post<{ Body: { mode?: string } }>('/__test/qa-double', async (request, reply) => {
    const denied = localOnly(request, reply);
    if (denied) return denied;
    const mode = request.body?.mode ?? 'pass';
    if (mode !== 'pass' && mode !== 'privacy_block') {
      return reply
        .code(400)
        .send({ error: { code: 'bad_request', message: `未知的 QA 模式：${mode}` } });
    }
    qa.mode = mode;
    return reply.code(200).send({ mode });
  });

  /**
   * Chooses what the Gate 2 double does. `mode: 'capture_failure'` makes the
   * recording reject an assertion, so a spec can assert the failure evidence
   * (report + PNG + trace, `captureFailure`, no backfill) without a real
   * Chromium run. Anything other than this endpoint's default is opt-in.
   */
  app.post<{ Body: { mode?: string; message?: string } }>(
    '/__test/gate2-doubles',
    async (request, reply) => {
      const denied = localOnly(request, reply);
      if (denied) return denied;
      const mode = request.body?.mode ?? 'capture_success';
      if (mode !== 'capture_success' && mode !== 'capture_failure') {
        return reply
          .code(400)
          .send({ error: { code: 'bad_request', message: `未知的 gate2 模式：${mode}` } });
      }
      gate2.captureFail = mode === 'capture_failure';
      gate2.captureMessage =
        request.body?.message?.trim() ||
        '断言失败 [visible] heading=声明与证据：超时仍不可见（4000ms）';
      return reply.code(200).send({ mode });
    },
  );

  /**
   * Seeds a succeeded narrated run (MP4 + SRT + manifest + receipt) for an
   * arbitrary workspace, so the review page's Gate-3 export can be exercised
   * without a slow real render. `approved: true` also flips the workspace
   * snapshot's video to `stage: approved` + `review.status: approved`, which is
   * exactly the Gate 3 the export route checks.
   */
  app.post<{ Body: { workspaceId?: string; videoId?: string; approved?: boolean } }>(
    '/__test/seed-export-ready',
    async (request, reply) => {
      const denied = localOnly(request, reply);
      if (denied) return denied;
      const workspaceId = request.body?.workspaceId?.trim();
      if (!workspaceId) {
        return reply.code(400).send({ error: { code: 'bad_request', message: 'workspaceId required' } });
      }
      try {
        const seeded = seedExportReadyRun(built, artifactDir, workspaceId, {
          videoId: request.body?.videoId?.trim() || 'vid_lumen_release',
          approved: request.body?.approved !== false,
        });
        return reply.code(201).send(seeded);
      } catch (error) {
        return reply.code(500).send({
          error: { code: 'seed_failed', message: error instanceof Error ? error.message : String(error) },
        });
      }
    },
  );

  const address = await app.listen({ host: '127.0.0.1', port: 0 });
  const port = Number(new URL(address).port);
  process.stdout.write(`READY ${JSON.stringify({ port })}\n`);

  const shutdown = async () => {
    await app.close();
    process.exit(0);
  };
  process.once('SIGINT', () => void shutdown());
  process.once('SIGTERM', () => void shutdown());
}

void main().catch((error) => {
  console.error(error);
  process.exit(1);
});
