import path from 'node:path';
import {
  renderJobDigest,
  type RenderJobInputV1,
} from '@asvs/domain';
import { defaultFixture, defaultOutDir, workspaceRoot } from './paths';
import { rendererVersion } from './renderer-version';
import { loadRenderFixture } from './load-fixture';
import { runRenderJob } from './run-render-job';
import { artifactReceiptV1Schema, renderManifestV1Schema } from '@asvs/domain';

interface CliOptions {
  fixture: string;
  outDir: string;
  keepBundle: boolean;
  concurrency?: number;
}

function printHelp(): void {
  console.log(`用法：tsx src/render-fixture.ts [选项]

  --fixture <path>    固定输入 JSON（默认 fixtures/golden-30s.json）
  --out <dir>         输出目录（默认 dist/render-worker/golden-30s）
  --keep-bundle       保留 Remotion 临时 bundle 以便排查
  --concurrency <n>   Remotion 渲染并发数（默认自动）
`);
}

function parseArgs(argv: string[]): CliOptions {
  const options: CliOptions = {
    fixture: defaultFixture,
    outDir: defaultOutDir,
    keepBundle: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--fixture') {
      const value = argv[++index];
      if (!value) throw new Error('--fixture 需要一个路径');
      options.fixture = path.resolve(process.cwd(), value);
    } else if (arg === '--out') {
      const value = argv[++index];
      if (!value) throw new Error('--out 需要一个路径');
      options.outDir = path.resolve(process.cwd(), value);
    } else if (arg === '--keep-bundle') {
      options.keepBundle = true;
    } else if (arg === '--concurrency') {
      const value = Number(argv[++index]);
      if (!Number.isFinite(value) || value < 1) throw new Error('--concurrency 需要正整数');
      options.concurrency = Math.round(value);
    } else if (arg === '--help' || arg === '-h') {
      printHelp();
      process.exit(0);
    } else {
      throw new Error(`未知参数：${arg}`);
    }
  }
  return options;
}

/**
 * Golden-fixture CLI. Kept as a thin wrapper over the shared resumable engine
 * so `pnpm render:fixture` exercises exactly the code the orchestrator runs,
 * while staying non-resumable (a fixture rerun must always render afresh).
 */
async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const { fixture, input } = loadRenderFixture(options.fixture);
  const artifactSlug = path
    .basename(options.fixture, '.json')
    .replace(/[^a-zA-Z0-9]+/g, '_')
    .toLowerCase();
  const jobId = `job_render_${artifactSlug}`;
  const artifactId = `artifact_${artifactSlug}`;
  const outputFileName = `${path.basename(options.fixture, '.json')}.mp4`;
  const jobDigest = await renderJobDigest({
    jobId,
    artifactId,
    renderInput: input,
    media: fixture.media,
  });
  const job: RenderJobInputV1 = {
    schemaVersion: '1',
    kind: 'asvs.render-job',
    jobId,
    artifactId,
    runId: `run_fixture_${artifactSlug}`,
    input,
    media: fixture.media,
    audio: [],
    outputFileName,
    jobDigest,
    createdAt: new Date().toISOString(),
  };

  console.log(`\n渲染样片 · ${artifactSlug}`);
  console.log('─'.repeat(64));
  console.log(`  输入        ${path.relative(workspaceRoot, options.fixture)}`);
  console.log(`  视频        ${fixture.video.title}`);
  console.log(`  Remotion    ${rendererVersion()}`);
  console.log('─'.repeat(64));

  let lastPhase = '';
  const outcome = await runRenderJob({
    job,
    outDir: options.outDir,
    resumable: false,
    keepWorkDirs: options.keepBundle,
    concurrency: options.concurrency,
    storageRefBase: workspaceRoot,
    onEvent: (event) => {
      if (event.type === 'progress' && event.phase !== lastPhase) {
        lastPhase = event.phase;
        console.log(`\n[${event.phase}]`);
      } else if (event.type === 'progress' && event.percent % 10 < 5) {
        process.stdout.write(`  ${event.percent}%\n`);
      }
    },
  });

  // Re-read from disk so the printed receipt is the persisted one, not just
  // the in-memory object that produced it.
  const receipt = artifactReceiptV1Schema.parse(
    JSON.parse((await import('node:fs')).readFileSync(path.join(options.outDir, 'receipt.json'), 'utf8')),
  );
  const manifest = renderManifestV1Schema.parse(
    JSON.parse((await import('node:fs')).readFileSync(path.join(options.outDir, 'manifest.json'), 'utf8')),
  );

  console.log('\n渲染成功');
  console.log('─'.repeat(64));
  console.log(`  MP4        ${receipt.storageRef}`);
  console.log(
    `  ffprobe    ${manifest.ffprobe.codecName} · ${manifest.ffprobe.width}×${manifest.ffprobe.height} · ${manifest.ffprobe.fps}fps · ${manifest.ffprobe.durationMs}ms · ${manifest.ffprobe.frameCount} 帧`,
  );
  console.log(`  SHA256     ${receipt.sha256}`);
  console.log(`  大小       ${(receipt.byteSize / 1024 / 1024).toFixed(2)} MiB`);
  console.log(`  回执       ${path.relative(workspaceRoot, path.join(options.outDir, 'receipt.json'))}`);
  console.log(`  清单       ${path.relative(workspaceRoot, path.join(options.outDir, 'manifest.json'))}`);
  console.log('─'.repeat(64));
  console.log('\n回执 JSON：');
  console.log(JSON.stringify(receipt, null, 2));
  void outcome;
}

main().catch((error: unknown) => {
  console.error('\n渲染失败：');
  console.error(error instanceof Error ? error.message : error);
  if (error instanceof Error && error.stack) console.error(error.stack);
  process.exitCode = 1;
});
