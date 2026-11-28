import { inflateRawSync } from 'node:zlib';

/**
 * Minimal, defensive ZIP reader for Playwright `trace.zip` (docs/16 §5.2).
 *
 * Playwright writes stored (method 0) and deflated (method 8) entries, which
 * is exactly what `node:zlib` can inflate, so Step 5D needs no new dependency
 * (and no native module on Windows). Because the archive is attacker-ish input
 * — it comes from whatever page was recorded — every read is bounded:
 *
 * - at most `maxEntries` central-directory entries (zip-bomb entries),
 * - at most 10 MB uncompressed per entry,
 * - at most 100 MB uncompressed in total per archive,
 * - entry names must be relative, NUL-free, and contain no `..` segment.
 *
 * Violations throw `ZipSafetyError`; nothing is ever written to disk.
 */

export interface ZipLimits {
  maxEntries: number;
  maxEntryUncompressedBytes: number;
  maxTotalUncompressedBytes: number;
}

export const DEFAULT_ZIP_LIMITS: ZipLimits = {
  maxEntries: 2000,
  maxEntryUncompressedBytes: 10 * 1024 * 1024,
  maxTotalUncompressedBytes: 100 * 1024 * 1024,
};

export class ZipSafetyError extends Error {
  readonly code:
    | 'zip_invalid'
    | 'zip_unsupported_method'
    | 'zip_too_many_entries'
    | 'zip_entry_too_large'
    | 'zip_total_too_large'
    | 'zip_unsafe_path'
    | 'zip_encrypted';

  constructor(code: ZipSafetyError['code'], message: string) {
    super(message);
    this.name = 'ZipSafetyError';
    this.code = code;
  }
}

export interface ZipEntry {
  name: string;
  /** Bytes as stored in the archive. */
  compressedSize: number;
  /** Bytes after inflation. */
  uncompressedSize: number;
  method: number;
  /** Offset of the local file header. */
  localHeaderOffset: number;
}

const EOCD_SIGNATURE = 0x06054b50;
const CENTRAL_SIGNATURE = 0x02014b50;
const LOCAL_SIGNATURE = 0x04034b50;
const EOCD_MIN_SIZE = 22;
const CENTRAL_HEADER_SIZE = 46;
const LOCAL_HEADER_SIZE = 30;
/** ZIP64 markers: we refuse them rather than mis-parse an archive this big. */
const ZIP64_SENTINEL = 0xffffffff;

function findEndOfCentralDirectory(buffer: Buffer): number {
  // The EOCD record is the last 22 bytes plus an optional comment (≤ 64 KiB).
  const stop = Math.max(0, buffer.length - EOCD_MIN_SIZE - 0xffff);
  for (let offset = buffer.length - EOCD_MIN_SIZE; offset >= stop; offset -= 1) {
    if (buffer.readUInt32LE(offset) === EOCD_SIGNATURE) return offset;
  }
  throw new ZipSafetyError('zip_invalid', 'ZIP 缺少中央目录结尾记录');
}

function assertSafePath(name: string): void {
  if (name.length === 0 || name.includes('\0')) {
    throw new ZipSafetyError('zip_unsafe_path', 'ZIP 条目名为空或包含空字节');
  }
  const normalized = name.replace(/\\/g, '/');
  if (normalized.startsWith('/') || /^[A-Za-z]:/.test(normalized)) {
    throw new ZipSafetyError('zip_unsafe_path', `ZIP 条目使用绝对路径：${name}`);
  }
  // eslint-disable-next-line no-control-regex
  const segments = normalized.split('/');
  if (segments.some((segment) => segment === '..')) {
    throw new ZipSafetyError('zip_unsafe_path', `ZIP 条目包含路径穿越：${name}`);
  }
}

/** Parse the central directory. Cheap: no inflation happens here. */
export function listZipEntries(buffer: Buffer, limits: ZipLimits = DEFAULT_ZIP_LIMITS): ZipEntry[] {
  const eocd = findEndOfCentralDirectory(buffer);
  const entryCount = buffer.readUInt16LE(eocd + 10);
  const directoryOffset = buffer.readUInt32LE(eocd + 16);
  if (entryCount > limits.maxEntries) {
    throw new ZipSafetyError('zip_too_many_entries', `ZIP 条目 ${entryCount} 超过上限 ${limits.maxEntries}`);
  }
  if (directoryOffset === ZIP64_SENTINEL) {
    throw new ZipSafetyError('zip_invalid', '暂不支持 ZIP64 归档');
  }
  if (directoryOffset + entryCount * CENTRAL_HEADER_SIZE > buffer.length) {
    throw new ZipSafetyError('zip_invalid', 'ZIP 中央目录越界');
  }

  const entries: ZipEntry[] = [];
  let offset = directoryOffset;
  for (let index = 0; index < entryCount; index += 1) {
    if (offset + CENTRAL_HEADER_SIZE > buffer.length) {
      throw new ZipSafetyError('zip_invalid', 'ZIP 中央目录条目被截断');
    }
    if (buffer.readUInt32LE(offset) !== CENTRAL_SIGNATURE) {
      throw new ZipSafetyError('zip_invalid', `第 ${index} 个中央目录条目签名错误`);
    }
    const flags = buffer.readUInt16LE(offset + 8);
    const method = buffer.readUInt16LE(offset + 10);
    const compressedSize = buffer.readUInt32LE(offset + 20);
    const uncompressedSize = buffer.readUInt32LE(offset + 24);
    const nameLength = buffer.readUInt16LE(offset + 28);
    const extraLength = buffer.readUInt16LE(offset + 30);
    const commentLength = buffer.readUInt16LE(offset + 32);
    const localHeaderOffset = buffer.readUInt32LE(offset + 42);
    const nameStart = offset + CENTRAL_HEADER_SIZE;
    const nameEnd = nameStart + nameLength;
    if (nameEnd > buffer.length) {
      throw new ZipSafetyError('zip_invalid', 'ZIP 条目名越界');
    }
    const name = buffer.toString('utf8', nameStart, nameEnd);
    if (flags & 0x1) {
      throw new ZipSafetyError('zip_encrypted', `ZIP 条目已加密：${name}`);
    }
    if (method !== 0 && method !== 8) {
      throw new ZipSafetyError('zip_unsupported_method', `ZIP 条目压缩方式不受支持：${name} (${method})`);
    }
    if (compressedSize === ZIP64_SENTINEL || uncompressedSize === ZIP64_SENTINEL) {
      throw new ZipSafetyError('zip_invalid', `暂不支持 ZIP64 条目：${name}`);
    }
    if (uncompressedSize > limits.maxEntryUncompressedBytes) {
      throw new ZipSafetyError(
        'zip_entry_too_large',
        `ZIP 条目 ${name} 解压后 ${uncompressedSize} 字节，超过单条上限`,
      );
    }
    assertSafePath(name);
    entries.push({ name, compressedSize, uncompressedSize, method, localHeaderOffset });
    offset = nameEnd + extraLength + commentLength;
  }

  const total = entries.reduce((sum, entry) => sum + entry.uncompressedSize, 0);
  if (total > limits.maxTotalUncompressedBytes) {
    throw new ZipSafetyError('zip_total_too_large', `ZIP 解压总量 ${total} 字节超过上限`);
  }
  return entries;
}

/** Inflate one entry. Bounded by the limits already checked in `listZipEntries`. */
export function readZipEntry(
  buffer: Buffer,
  entry: ZipEntry,
  limits: ZipLimits = DEFAULT_ZIP_LIMITS,
): Buffer {
  const offset = entry.localHeaderOffset;
  if (offset + LOCAL_HEADER_SIZE > buffer.length) {
    throw new ZipSafetyError('zip_invalid', `ZIP 本地头越界：${entry.name}`);
  }
  if (buffer.readUInt32LE(offset) !== LOCAL_SIGNATURE) {
    throw new ZipSafetyError('zip_invalid', `ZIP 本地头签名错误：${entry.name}`);
  }
  const nameLength = buffer.readUInt16LE(offset + 26);
  const extraLength = buffer.readUInt16LE(offset + 28);
  const dataStart = offset + LOCAL_HEADER_SIZE + nameLength + extraLength;
  const dataEnd = dataStart + entry.compressedSize;
  if (dataEnd > buffer.length) {
    throw new ZipSafetyError('zip_invalid', `ZIP 条目数据越界：${entry.name}`);
  }
  const raw = buffer.subarray(dataStart, dataEnd);
  const data = entry.method === 0 ? Buffer.from(raw) : inflateRawSync(raw, {
    maxOutputLength: Math.min(limits.maxEntryUncompressedBytes, Math.max(entry.uncompressedSize, 1) * 2),
  });
  if (data.length > limits.maxEntryUncompressedBytes) {
    throw new ZipSafetyError('zip_entry_too_large', `ZIP 条目 ${entry.name} 解压后超限`);
  }
  return data;
}

/** Convenience map for archives whose total size is already bounded. */
export function readZipEntriesAsMap(
  buffer: Buffer,
  limits: ZipLimits = DEFAULT_ZIP_LIMITS,
): Map<string, Buffer> {
  const entries = listZipEntries(buffer, limits);
  const map = new Map<string, Buffer>();
  for (const entry of entries) {
    if (entry.name.endsWith('/')) continue;
    map.set(entry.name, readZipEntry(buffer, entry, limits));
  }
  return map;
}
