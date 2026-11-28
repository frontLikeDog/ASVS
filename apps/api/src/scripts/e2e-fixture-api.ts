import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type {
  GitHubCommitSummary,
  GitHubConnectionStatus,
  GitHubFileContent,
  GitHubPullRequestFile,
  GitHubPullRequestSummary,
  GitHubReleaseSummary,
  GitHubRepoRef,
  GitHubRepositoryMetadata,
  GitHubWriteProbeResult,
} from '@asvs/domain';
import { formatGitHubRepoRef } from '@asvs/domain';
import type { GitHubReadOnlyPort, GitHubTreeEntry } from '@asvs/ports';
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
    kind: 'video_mp4' | 'subtitles_srt' | 'render_manifest' | 'artifact_receipt',
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

  // The export route re-hashes all four files from disk; these locals exist so
  // the seed can be inspected in a debugger without re-reading the files.
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
  const built = await buildApp({
    dbPath,
    artifactDir,
    corsOrigins: ['http://localhost:4200', 'http://127.0.0.1:4200'],
    logger: false,
    github: fixtureGitHub,
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
