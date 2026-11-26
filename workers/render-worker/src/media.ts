import { copyFileSync, existsSync, mkdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import type { RenderInputV1, RenderMediaAssetV1 } from '@asvs/domain';
import { sha256File } from './hash';
import { probeVideo } from './ffprobe';
import { workspaceRoot } from './paths';

/**
 * Remotion serves media through `staticFile`, which requires the file to live
 * under the bundle's public directory. Real captures stay immutable in
 * `dist/browser-worker/…`; this copies the exact bytes into a temporary public
 * dir after verifying the SHA256 recorded by the capture receipt.
 */
export function preparePublicDir({
  input,
  media,
  publicDir,
}: {
  input: RenderInputV1;
  media: RenderMediaAssetV1[];
  publicDir: string;
}): RenderMediaAssetV1[] {
  rmSync(publicDir, { recursive: true, force: true });
  mkdirSync(publicDir, { recursive: true });

  const mediaById = new Map(media.map((entry) => [entry.assetId, entry]));
  const used: RenderMediaAssetV1[] = [];
  const seen = new Set<string>();

  for (const asset of input.assets) {
    if (!asset.media) {
      if (!asset.mock) {
        throw new Error(`Asset ${asset.id} 标记为真实（mock:false）但没有 media 元数据`);
      }
      continue;
    }
    if (asset.mock) {
      throw new Error(`Asset ${asset.id} 仍是 mock:true，不能携带真实 media`);
    }
    if (seen.has(asset.id)) continue;
    seen.add(asset.id);

    const entry = mediaById.get(asset.id);
    if (!entry) {
      throw new Error(`Asset ${asset.id} 缺少 render fixture 的 media 条目，无法定位真实文件`);
    }
    if (entry.mimeType !== asset.media.mimeType) {
      throw new Error(`Asset ${asset.id} 的 media.mimeType 与 fixture 不一致`);
    }
    if (asset.media.sha256 && asset.media.sha256 !== entry.sha256) {
      throw new Error(`Asset ${asset.id} 的 media.sha256 与 fixture 不一致`);
    }

    const sourceFile = path.isAbsolute(entry.sourceFile)
      ? entry.sourceFile
      : path.join(workspaceRoot, entry.sourceFile);
    if (!existsSync(sourceFile)) {
      throw new Error(`真实素材不存在：${entry.sourceFile}`);
    }
    const sourceSha = sha256File(sourceFile);
    if (sourceSha !== entry.sha256) {
      throw new Error(
        `真实素材 SHA256 不一致：${entry.sourceFile}（${sourceSha} vs ${entry.sha256}）`,
      );
    }

    const probe = probeVideo(sourceFile);
    if (probe.width !== entry.width || probe.height !== entry.height) {
      throw new Error(
        `真实素材分辨率不一致：${entry.sourceFile}（${probe.width}×${probe.height} vs ${entry.width}×${entry.height}）`,
      );
    }
    if (Math.abs(probe.durationMs - entry.durationMs) > 250) {
      throw new Error(
        `真实素材时长不一致：${entry.sourceFile}（${probe.durationMs}ms vs ${entry.durationMs}ms）`,
      );
    }

    const relative = asset.media.src.split('/').join(path.sep);
    const target = path.resolve(publicDir, relative);
    const publicRoot = path.resolve(publicDir);
    if (target !== publicRoot && !target.startsWith(`${publicRoot}${path.sep}`)) {
      throw new Error(`Asset ${asset.id} 的 media.src 越出 public 目录：${asset.media.src}`);
    }
    mkdirSync(path.dirname(target), { recursive: true });
    copyFileSync(sourceFile, target);
    const copiedSha = sha256File(target);
    if (copiedSha !== entry.sha256) {
      throw new Error(`复制后的素材哈希不一致：${asset.media.src}`);
    }

    used.push(entry);
  }

  for (const entry of media) {
    if (!seen.has(entry.assetId)) {
      throw new Error(`fixture media 引用了未进入 RenderInput 的 Asset：${entry.assetId}`);
    }
  }

  return used;
}
