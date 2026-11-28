/**
 * Pure formatting + verified-download helpers shared by the production panel,
 * the lazily loaded Gate 2 panel and the review page.
 *
 * These live in their own module on purpose: the Gate 2 panel must be its own
 * chunk (the `production` route has a 24 kB gzip budget), and Rollup merges two
 * dynamic entries that share a module into one chunk when that module also
 * pulls in React state. Keeping the shared surface here — no hooks, no
 * components — lets the route chunk and the Gate 2 chunk stay separate.
 */

export function formatArtifactSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function formatDurationMs(ms: number): string {
  const totalSeconds = Math.max(0, ms) / 1000;
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = Math.round(totalSeconds % 60);
  return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
}

export function shortSha(sha: string, length = 12): string {
  return sha.length > length ? `${sha.slice(0, length)}…` : sha;
}

/**
 * Downloads an artifact and verifies its bytes against the registered SHA256
 * before the browser saves it. A mismatch is treated as a failure, never as a
 * warning: a tampered MP4 must not reach the user's disk silently.
 */
export async function downloadVerifiedArtifact(
  url: string,
  artifact: { fileName: string; mimeType: string; sha256: string },
): Promise<void> {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`下载失败（HTTP ${response.status}）`);
  const buffer = await response.arrayBuffer();
  const digest = await crypto.subtle.digest('SHA-256', buffer);
  const hex = Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
  if (hex !== artifact.sha256) {
    throw new Error(
      `下载内容 SHA256 不匹配（${hex.slice(0, 12)}… vs ${artifact.sha256.slice(0, 12)}…）`,
    );
  }
  const objectUrl = URL.createObjectURL(new Blob([buffer], { type: artifact.mimeType }));
  const anchor = document.createElement('a');
  anchor.href = objectUrl;
  anchor.download = artifact.fileName;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  window.setTimeout(() => URL.revokeObjectURL(objectUrl), 1200);
}
