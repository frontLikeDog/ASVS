import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { bundle, type WebpackOverrideFn } from '@remotion/bundler';
import { renderMedia, selectComposition } from '@remotion/renderer';
import {
  COMPOSITION_ID,
  storyboardDurationMs,
  totalStoryboardFrames,
} from '@asvs/domain';
import { assertDecodable, probeVideo, validateProbe } from './ffprobe';
import { buildArtifactRecords, storageRefFor } from './manifest';
import { defaultFixture, defaultOutDir, renderEntry, workspaceRoot } from './paths';
import { rendererVersion } from './renderer-version';
import { loadRenderFixture } from './load-fixture';

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

const webpackOverride: WebpackOverrideFn = (current) => ({
  ...current,
  resolve: {
    ...current.resolve,
    alias: {
      ...(current.resolve?.alias ?? {}),
      '@asvs/domain': path.join(workspaceRoot, 'libs/domain/src/index.ts'),
    },
  },
});

function progressLogger(label: string) {
  let last = -10;
  return (progress: number) => {
    // Remotion's bundler reports 0–100 while renderMedia reports 0–1.
    const percent = Math.floor(progress <= 1 ? progress * 100 : progress);
    if (percent >= last + 10) {
      last = percent;
      console.log(`  ${label} ${percent}%`);
    }
  };
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const { fixture, input } = loadRenderFixture(options.fixture);
  const version = rendererVersion();
  const totalFrames = totalStoryboardFrames(input.storyboard);
  const expectedDurationMs = storyboardDurationMs(input.storyboard);
  const fileName = `${path.basename(options.fixture, '.json')}.mp4`;
  const outputFile = path.join(options.outDir, fileName);

  console.log('\n渲染黄金样片');
  console.log('─'.repeat(64));
  console.log(`  输入        ${path.relative(workspaceRoot, options.fixture)}`);
  console.log(`  视频        ${fixture.video.title}`);
  console.log(`  分镜        ${input.storyboard.scenes.length} 个 / ${totalFrames} 帧`);
  console.log(`  规格        ${input.renderProfile.width}×${input.renderProfile.height} · ${input.storyboard.fps}fps · ${expectedDurationMs}ms`);
  console.log(`  Remotion    ${version}`);
  console.log('─'.repeat(64));

  mkdirSync(options.outDir, { recursive: true });
  const bundleDir = path.join(options.outDir, '.bundle');
  rmSync(bundleDir, { recursive: true, force: true });

  try {
    console.log('\n[1/4] 打包 Remotion composition…');
    const serveUrl = await bundle({
      entryPoint: renderEntry,
      outDir: bundleDir,
      publicDir: null,
      webpackOverride,
      onProgress: progressLogger('打包'),
    });

    console.log('\n[2/4] 解析 composition 并核对元数据…');
    // The composition receives `{ input }`, not the storyboard itself. Passing
    // the bare storyboard makes calculateMetadata see `props.input === undefined`
    // and silently report a 1-frame composition.
    const inputProps = { input } as unknown as Record<string, unknown>;
    const composition = await selectComposition({
      serveUrl,
      id: COMPOSITION_ID,
      inputProps,
    });

    const metadataErrors: string[] = [];
    if (composition.durationInFrames !== totalFrames) {
      metadataErrors.push(`时长帧数应为 ${totalFrames}，composition 报告 ${composition.durationInFrames}`);
    }
    if (composition.fps !== input.storyboard.fps) {
      metadataErrors.push(`帧率应为 ${input.storyboard.fps}，composition 报告 ${composition.fps}`);
    }
    if (
      composition.width !== input.renderProfile.width ||
      composition.height !== input.renderProfile.height
    ) {
      metadataErrors.push(
        `尺寸应为 ${input.renderProfile.width}×${input.renderProfile.height}，composition 报告 ${composition.width}×${composition.height}`,
      );
    }
    if (metadataErrors.length > 0) {
      throw new Error(`composition 元数据与 Storyboard 不一致：\n- ${metadataErrors.join('\n- ')}`);
    }

    console.log('\n[3/4] 渲染 MP4…');
    const renderProgress = progressLogger('渲染');
    await renderMedia({
      composition,
      serveUrl,
      codec: 'h264',
      outputLocation: outputFile,
      inputProps,
      crf: input.renderProfile.crf,
      overwrite: true,
      concurrency: options.concurrency ?? null,
      onProgress: ({ progress }) => renderProgress(progress),
    });

    console.log('\n[4/4] ffprobe / 全片解码 / 回执校验…');
    assertDecodable(outputFile);
    const probe = probeVideo(outputFile);
    const probeErrors = validateProbe(probe, {
      width: input.renderProfile.width,
      height: input.renderProfile.height,
      fps: input.storyboard.fps,
      durationMs: expectedDurationMs,
      frameCount: totalFrames,
    });
    if (probeErrors.length > 0) {
      throw new Error(`ffprobe 校验失败：\n- ${probeErrors.join('\n- ')}`);
    }

    const createdAt = new Date().toISOString();
    const { receipt, manifest } = buildArtifactRecords({
      jobId: 'job_render_golden_30s',
      artifactId: 'artifact_golden_30s',
      input,
      file: outputFile,
      storageRef: storageRefFor(outputFile),
      probe,
      rendererVersion: version,
      createdAt,
    });

    writeFileSync(path.join(options.outDir, 'receipt.json'), `${JSON.stringify(receipt, null, 2)}\n`);
    writeFileSync(path.join(options.outDir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);

    console.log('\n渲染成功');
    console.log('─'.repeat(64));
    console.log(`  MP4        ${receipt.storageRef}`);
    console.log(`  ffprobe    ${probe.codecName} · ${probe.width}×${probe.height} · ${probe.fps}fps · ${probe.durationMs}ms · ${probe.frameCount} 帧`);
    console.log(`  SHA256     ${receipt.sha256}`);
    console.log(`  大小       ${(receipt.byteSize / 1024 / 1024).toFixed(2)} MiB`);
    console.log(`  回执       ${path.relative(workspaceRoot, path.join(options.outDir, 'receipt.json'))}`);
    console.log(`  清单       ${path.relative(workspaceRoot, path.join(options.outDir, 'manifest.json'))}`);
    console.log('─'.repeat(64));
    console.log('\n回执 JSON：');
    console.log(JSON.stringify(receipt, null, 2));
  } finally {
    if (!options.keepBundle) rmSync(bundleDir, { recursive: true, force: true });
  }
}

main().catch((error: unknown) => {
  console.error('\n渲染失败：');
  console.error(error instanceof Error ? error.message : error);
  if (error instanceof Error && error.stack) console.error(error.stack);
  process.exitCode = 1;
});
