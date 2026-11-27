import type { KnowledgeSkipReason } from '@asvs/domain';

/**
 * Scan policy is a pure function of the path, size and (for the last check)
 * the first bytes of a file. It is intentionally conservative: anything that
 * could be huge, binary or a credential store is skipped and *named* in
 * `snapshot.skipped`, never silently dropped.
 */

export interface KnowledgeIndexLimits {
  /** Largest file we will download and parse. */
  maxFileBytes: number;
  /** Largest total index we will build before failing closed. */
  maxFiles: number;
  /** First-bytes sample used for binary detection. */
  sniffBytes: number;
}

export const DEFAULT_KNOWLEDGE_INDEX_LIMITS: KnowledgeIndexLimits = {
  maxFileBytes: 256 * 1024,
  maxFiles: 2000,
  sniffBytes: 8000,
};

/**
 * Directory names that never contain product knowledge, plus vendored trees.
 * Compared case-insensitively against every path segment.
 */
const EXCLUDED_DIRECTORIES = new Set([
  'node_modules',
  '.git',
  '.venv',
  'venv',
  'env',
  '__pycache__',
  '.mypy_cache',
  '.pytest_cache',
  '.ruff_cache',
  '.tox',
  'site-packages',
  'dist',
  'build',
  'out',
  'target',
  'coverage',
  '.next',
  '.nuxt',
  '.turbo',
  '.nx',
  '.cache',
  'vendor',
  'bower_components',
  '.idea',
  '.vscode',
]);

/** Individual files that carry secrets or generated noise. */
const EXCLUDED_FILE_PATTERNS: RegExp[] = [
  /^\.env(?:\.|$)/i,
  /\.pem$/i,
  /\.key$/i,
  /\.p12$/i,
  /\.pfx$/i,
  /\.jks$/i,
  /^id_(?:rsa|dsa|ecdsa|ed25519)(?:\.pub)?$/i,
  /^\.npmrc$/i,
  /^\.pypirc$/i,
  /^\.netrc$/i,
  /^credentials(?:\.json)?$/i,
  /^\.ds_store$/i,
  /\.(?:png|jpe?g|gif|webp|avif|ico|bmp|tiff?)$/i,
  /\.(?:mp[34]|wav|ogg|flac|m4a|aac)$/i,
  /\.(?:mov|avi|mkv|webm)$/i,
  /\.(?:pdf|docx?|xlsx?|pptx?)$/i,
  /\.(?:zip|tar|gz|tgz|bz2|xz|7z|rar|jar|war)$/i,
  /\.(?:exe|dll|so|dylib|bin|o|obj|pyc|pyo|class|wasm)$/i,
  /\.(?:woff2?|ttf|otf|eot)$/i,
  /\.(?:sqlite|sqlite3|db|lock)$/i,
  /\.min\.(?:js|css)$/i,
  /\.map$/i,
];

const SECRET_FILE_PATTERNS: RegExp[] = [
  /^\.env(?:\.|$)/i,
  /\.pem$/i,
  /\.key$/i,
  /\.p12$/i,
  /\.pfx$/i,
  /\.jks$/i,
  /^id_(?:rsa|dsa|ecdsa|ed25519)(?:\.pub)?$/i,
  /^\.npmrc$/i,
  /^\.pypirc$/i,
  /^\.netrc$/i,
  /^credentials(?:\.json)?$/i,
];

export interface PathPolicyDecision {
  action: 'index' | 'skip';
  reason?: KnowledgeSkipReason;
}

/**
 * Rejects absolute paths, traversal, backslashes and empty segments. GitHub
 * tree paths are always POSIX-relative, so anything else is treated as hostile
 * input rather than normalized into something plausible.
 */
export function isSafeRepositoryPath(filePath: string): boolean {
  if (!filePath || filePath.length > 1024) return false;
  if (filePath.includes('\\') || filePath.includes('\0')) return false;
  if (filePath.startsWith('/') || filePath.endsWith('/')) return false;
  const segments = filePath.split('/');
  return segments.every((seg) => seg.length > 0 && seg !== '.' && seg !== '..');
}

export function evaluateRepositoryPath(filePath: string, byteSize: number, limits = DEFAULT_KNOWLEDGE_INDEX_LIMITS): PathPolicyDecision {
  if (!isSafeRepositoryPath(filePath)) {
    return { action: 'skip', reason: 'invalid_path' };
  }

  const segments = filePath.split('/');
  const base = segments[segments.length - 1] ?? '';

  for (const segment of segments.slice(0, -1)) {
    if (EXCLUDED_DIRECTORIES.has(segment.toLowerCase())) {
      return { action: 'skip', reason: 'excluded_directory' };
    }
  }
  for (const pattern of SECRET_FILE_PATTERNS) {
    if (pattern.test(base)) return { action: 'skip', reason: 'secret_file' };
  }
  for (const pattern of EXCLUDED_FILE_PATTERNS) {
    if (pattern.test(base)) return { action: 'skip', reason: 'excluded_file' };
  }
  if (byteSize > limits.maxFileBytes) {
    return { action: 'skip', reason: 'too_large' };
  }
  return { action: 'index' };
}

/**
 * Binary detection without a full parse: NUL bytes, control-character density
 * and invalid UTF-8 are all signals that the file is not text. Kept separate
 * from the path policy because it needs the downloaded bytes.
 */
export function looksBinary(sample: Uint8Array): boolean {
  if (sample.length === 0) return false;
  const probe = sample.subarray(0, DEFAULT_KNOWLEDGE_INDEX_LIMITS.sniffBytes);

  let controlChars = 0;
  let decoded: string;
  try {
    decoded = new TextDecoder('utf-8', { fatal: true }).decode(probe);
  } catch {
    // A truncated multi-byte sequence at the sample boundary is expected; only
    // fail when the sample as a whole cannot be decoded as UTF-8.
    try {
      decoded = new TextDecoder('utf-8', { fatal: false }).decode(probe);
      if (decoded.includes('�')) return true;
    } catch {
      return true;
    }
  }

  for (const char of decoded) {
    const code = char.charCodeAt(0);
    if (code === 0) return true;
    if (code < 32 && code !== 9 && code !== 10 && code !== 13) controlChars += 1;
  }
  return controlChars / Math.max(1, decoded.length) > 0.02;
}

