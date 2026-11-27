import { createHash } from 'node:crypto';
import {
  closeSync,
  createReadStream,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { isSafeRelativePath } from '@asvs/domain';

export function sha256File(file: string): string {
  // Artifact files are 5 MB–50 MB; streaming keeps memory flat and yields the
  // same hash the worker computed on its side.
  const hash = createHash('sha256');
  const buffer = Buffer.allocUnsafe(1024 * 1024);
  const fd = openSync(file, 'r');
  try {
    let position = 0;
    for (;;) {
      const bytes = readSync(fd, buffer, 0, buffer.length, position);
      if (bytes <= 0) break;
      hash.update(buffer.subarray(0, bytes));
      position += bytes;
    }
  } finally {
    closeSync(fd);
  }
  return hash.digest('hex');
}

export function writeJsonFile(file: string, value: unknown): void {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

export function readJsonFile<T = unknown>(file: string): T {
  return JSON.parse(readFileSync(file, 'utf8')) as T;
}

export function fileSize(file: string): number {
  return statSync(file).size;
}

export function fileExists(file: string): boolean {
  try {
    return statSync(file).isFile();
  } catch {
    return false;
  }
}

/**
 * Resolves a POSIX `storageRef` under `root` and fails closed when it escapes.
 * Both the lexical check and the resolved-prefix check run, so a `..` inside
 * an id cannot reach the filesystem outside the artifact root.
 */
export function resolveArtifactPath(root: string, storageRef: string): string {
  if (!isSafeRelativePath(storageRef)) {
    throw new Error(`产物路径不安全：${storageRef}`);
  }
  const rootResolved = path.resolve(root);
  const target = path.resolve(rootResolved, ...storageRef.split('/'));
  if (target !== rootResolved && !target.startsWith(`${rootResolved}${path.sep}`)) {
    throw new Error(`产物路径越出 artifactRoot：${storageRef}`);
  }
  return target;
}

export function artifactReadStream(file: string): ReturnType<typeof createReadStream> {
  return createReadStream(file);
}
