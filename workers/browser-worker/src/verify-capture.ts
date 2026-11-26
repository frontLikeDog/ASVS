import { closeSync, existsSync, openSync, readFileSync, readSync, statSync } from 'node:fs';
import path from 'node:path';
import {
  captureReceiptV1Schema,
  renderFixtureV1Schema,
  type CaptureReceiptV1,
} from '@asvs/domain';
import { probeVideo, sha256File } from './media';
import { defaultOutDir, resolveFromWorkspace, storageRefFor } from './paths';
import { loadApprovedDemoPlan, parseDemoPlanFile } from './plan';

interface CliOptions {
  dir: string;
}

function parseArgs(argv: string[]): CliOptions {
  let dir = defaultOutDir;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--dir') {
      const value = argv[++index];
      if (!value) throw new Error('--dir 需要一个目录');
      dir = path.resolve(process.cwd(), value);
    } else if (arg === '--help' || arg === '-h') {
      console.log('用法：tsx src/verify-capture.ts [--dir <capture artifact dir>]');
      process.exit(0);
    } else {
      throw new Error(`未知参数：${arg}`);
    }
  }
  return { dir };
}

function readReceipt(file: string): CaptureReceiptV1 {
  const raw: unknown = JSON.parse(readFileSync(file, 'utf8'));
  return captureReceiptV1Schema.parse(raw);
}

/** Reads magic bytes so a receipt cannot label arbitrary bytes as a video. */
function sniffMime(file: string): string | undefined {
  const buffer = Buffer.alloc(12);
  let bytesRead = 0;
  let fd: number | undefined;
  try {
    fd = openSync(file, 'r');
    bytesRead = readSync(fd, buffer, 0, buffer.length, 0);
  } catch {
    return undefined;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
  if (bytesRead >= 8 && buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
    return 'image/png';
  }
  if (bytesRead >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
    return 'image/jpeg';
  }
  if (bytesRead >= 4 && buffer[0] === 0x1a && buffer[1] === 0x45 && buffer[2] === 0xdf && buffer[3] === 0xa3) {
    return 'video/webm';
  }
  if (bytesRead >= 4 && buffer.subarray(0, 4).equals(Buffer.from([0x50, 0x4b, 0x03, 0x04]))) {
    return 'application/zip';
  }
  if (bytesRead >= 8 && buffer.subarray(4, 8).equals(Buffer.from('ftyp', 'ascii'))) {
    return 'video/mp4';
  }
  return undefined;
}

const MIME_ALIASES: Record<string, string> = {
  'application/x-zip-compressed': 'application/zip',
  'image/jpg': 'image/jpeg',
};

function checkFile(
  failures: string[],
  dir: string,
  relative: string,
  expectedSha: string,
  expectedMime?: string,
  expectedBytes?: number,
): void {
  const file = path.join(dir, relative);
  if (!existsSync(file)) {
    failures.push(`缺少文件：${relative}`);
    return;
  }
  const actualSha = sha256File(file);
  if (actualSha !== expectedSha) {
    failures.push(`${relative} 的 SHA256 不一致（${actualSha} vs ${expectedSha}）`);
  }
  if (expectedBytes !== undefined && statSync(file).size !== expectedBytes) {
    failures.push(`${relative} 的字节数不一致`);
  }
  if (expectedMime) {
    const sniffed = MIME_ALIASES[expectedMime] ?? expectedMime;
    const actual = sniffMime(file);
    if (actual !== sniffed) {
      failures.push(
        `${relative} 的 MIME 与文件头不符：回执 ${expectedMime}，实际 ${actual ?? '无法识别'}`,
      );
    }
  }
}

function main(): void {
  const options = parseArgs(process.argv.slice(2));
  const receiptFile = path.join(options.dir, 'capture-receipt.json');
  if (!existsSync(receiptFile)) {
    console.error(`\n缺少 ${storageRefFor(receiptFile)}。请先运行 pnpm capture:demo。\n`);
    process.exit(1);
  }

  const failures: string[] = [];
  let receipt: CaptureReceiptV1;
  try {
    receipt = readReceipt(receiptFile);
  } catch (error) {
    console.error(`\nCaptureReceipt 校验失败：${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  }

  const planFile = resolveFromWorkspace(receipt.planFile);
  if (!existsSync(planFile)) {
    failures.push(`DemoPlan 不存在：${receipt.planFile}`);
  } else {
    const parsed = parseDemoPlanFile(planFile);
    if (parsed.digest !== receipt.planDigest) {
      failures.push(`DemoPlan 摘要已变化（${parsed.digest} vs ${receipt.planDigest}）`);
    }
    // Re-load with the approval check: a receipt for an unapproved plan is invalid.
    try {
      loadApprovedDemoPlan(planFile);
    } catch (error) {
      failures.push(`DemoPlan 审批无效：${error instanceof Error ? error.message : String(error)}`);
    }
    if (parsed.plan.id !== receipt.planId) {
      failures.push(`planId 不一致（${parsed.plan.id} vs ${receipt.planId}）`);
    }
    if (parsed.plan.approval.approvalId !== receipt.approvalId) {
      failures.push('approvalId 与回执不一致');
    }
  }

  for (const file of [receipt.rawVideo, receipt.clip]) {
    checkFile(failures, options.dir, file.file, file.sha256, file.mimeType, file.byteSize);
  }
  checkFile(failures, options.dir, receipt.trace.file, receipt.trace.sha256, receipt.trace.mimeType, receipt.trace.byteSize);
  for (const screenshot of receipt.screenshots) {
    checkFile(
      failures,
      options.dir,
      screenshot.file,
      screenshot.sha256,
      screenshot.mimeType,
      screenshot.byteSize,
    );
  }

  const rawFile = path.join(options.dir, receipt.rawVideo.file);
  const clipFile = path.join(options.dir, receipt.clip.file);
  if (existsSync(rawFile)) {
    try {
      const raw = probeVideo(rawFile);
      if (
        raw.width !== receipt.rawVideo.width ||
        raw.height !== receipt.rawVideo.height ||
        Math.abs(raw.fps - receipt.rawVideo.fps) > 0.05 ||
        Math.abs(raw.durationMs - receipt.rawVideo.durationMs) > 250
      ) {
        failures.push('rawVideo 的 ffprobe 结果与回执不一致');
      }
    } catch (error) {
      failures.push(`rawVideo 无法探测：${error instanceof Error ? error.message : String(error)}`);
    }
  }
  if (existsSync(clipFile)) {
    try {
      const clip = probeVideo(clipFile);
      if (clip.codecName !== 'h264') failures.push(`clip 编码应为 h264，实际 ${clip.codecName}`);
      if (clip.width !== receipt.clip.width || clip.height !== receipt.clip.height) {
        failures.push('clip 分辨率与回执不一致');
      }
      if (Math.abs(clip.fps - receipt.clip.fps) > 0.05) failures.push('clip 帧率与回执不一致');
      if (Math.abs(clip.durationMs - receipt.clip.durationMs) > 250) {
        failures.push('clip 时长与回执不一致');
      }
      if (receipt.asset.media?.durationMs !== clip.durationMs) {
        failures.push('Asset.media.durationMs 与 clip 实际时长不一致');
      }
      if (sha256File(clipFile) !== receipt.asset.media?.sha256) {
        failures.push('Asset.media.sha256 与 clip 文件不一致');
      }
    } catch (error) {
      failures.push(`clip 无法探测：${error instanceof Error ? error.message : String(error)}`);
    }
  }

  if (receipt.asset.mock) failures.push('Asset.mock 必须为 false');
  if (!receipt.asset.media?.src) failures.push('Asset 缺少 media.src');
  if (receipt.media.assetId !== receipt.asset.id) failures.push('media.assetId 与 asset.id 不一致');
  if (receipt.media.sourceFile !== receipt.clip.file) {
    // Normalize both sides before comparing (receipt files are relative to the
    // capture dir; media.sourceFile is workspace-relative).
    const expectedSource = storageRefFor(clipFile);
    if (receipt.media.sourceFile !== expectedSource) {
      failures.push(
        `media.sourceFile 指向的不是同一片段（${receipt.media.sourceFile} vs ${expectedSource}）`,
      );
    }
  }

  const fixtureFile = resolveFromWorkspace(receipt.renderFixture.file);
  if (!existsSync(fixtureFile)) {
    failures.push(`渲染 fixture 不存在：${receipt.renderFixture.file}`);
  } else {
    if (sha256File(fixtureFile) !== receipt.renderFixture.sha256) {
      failures.push('渲染 fixture 的 SHA256 与回执不一致');
    }
    try {
      const parsed = renderFixtureV1Schema.parse(JSON.parse(readFileSync(fixtureFile, 'utf8')));
      const asset = parsed.assets.find((item) => item.id === receipt.asset.id);
      if (!asset) failures.push('渲染 fixture 未引用录屏 Asset');
      if (asset && asset.mock !== false) failures.push('渲染 fixture 中的 Asset.mock 必须为 false');
      const media = parsed.media.find((item) => item.assetId === receipt.asset.id);
      if (!media) {
        failures.push('渲染 fixture 缺少 media 条目');
      } else {
        if (media.sha256 !== receipt.clip.sha256) failures.push('fixture media 哈希与回执不一致');
        const source = resolveFromWorkspace(media.sourceFile);
        if (!existsSync(source)) failures.push(`fixture media 源文件不存在：${media.sourceFile}`);
        else if (sha256File(source) !== media.sha256) failures.push('fixture media 源文件哈希不一致');
      }
      const realScene = parsed.video.scenes.find((scene) => scene.visual?.type === 'real_demo');
      if (!realScene) failures.push('渲染 fixture 没有 real_demo 镜头');
      if (realScene && realScene.assetId !== receipt.asset.id) {
        failures.push('real_demo 镜头引用的 Asset 与回执不一致');
      }
    } catch (error) {
      failures.push(`渲染 fixture 校验失败：${error instanceof Error ? error.message : String(error)}`);
    }
  }

  console.log('\n录屏产物校验');
  console.log('─'.repeat(72));
  console.log(`  目录     ${storageRefFor(options.dir)}`);
  console.log(`  DemoPlan ${receipt.planFile} · ${receipt.planDigest.slice(0, 16)}…`);
  console.log(`  断言     ${receipt.assertions.passed}/${receipt.assertions.total}`);
  console.log(`  WebM     ${receipt.rawVideo.file} · ${(receipt.rawVideo.byteSize / 1024 / 1024).toFixed(2)} MiB`);
  console.log(`  MP4      ${receipt.clip.file} · ${receipt.clip.width}×${receipt.clip.height} · ${receipt.clip.durationMs}ms`);
  console.log(`  截图     ${receipt.screenshots.length} 张`);
  console.log(`  回执     ${path.basename(receiptFile)}`);
  console.log(`  渲染输入 ${receipt.renderFixture.file}`);
  console.log('─'.repeat(72));

  if (failures.length > 0) {
    console.error('\n校验失败：\n');
    for (const failure of failures) console.error(`  • ${failure}`);
    console.error('');
    process.exitCode = 1;
    return;
  }
  console.log('CaptureReceipt、录屏、trace、截图与渲染 fixture 一致。\n');
}

main();
