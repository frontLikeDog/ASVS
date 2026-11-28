/**
 * Canonical serialization and hashing shared by every runtime.
 *
 * Digests in this codebase must be reproducible across the browser bundle,
 * the API and the workers. These helpers therefore use only WebCrypto and
 * plain JS — no `node:crypto`, no `node:buffer` — and every digest in the
 * system is defined as SHA-256 over `stableStringify(value)`.
 *
 * `stableStringify` is kept as a distinct name from `stableJson` because the
 * Step 2 approved DemoPlan digest was defined over it; both produce identical
 * bytes (sorted keys, dropped `undefined`) and exist only for readability.
 */

function normalizeForStableJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(normalizeForStableJson);
  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, entry]) => entry !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return Object.fromEntries(entries.map(([key, entry]) => [key, normalizeForStableJson(entry)]));
  }
  return value;
}

/** Deterministic JSON used for input/scene digests (sorted keys). */
export function stableStringify(value: unknown): string {
  return JSON.stringify(normalizeForStableJson(value));
}

/** Alias of `stableStringify`; the orchestration layer grew up with this name. */
export function stableJson(value: unknown): string {
  return JSON.stringify(normalizeForStableJson(value));
}

/**
 * SHA-256 of a UTF-8 string. WebCrypto is available in Node 22 (API, worker,
 * tests) and in the browser, so the same implementation serves every runtime
 * without pulling `node:crypto` into the browser bundle.
 */
export async function sha256Hex(text: string): Promise<string> {
  const bytes = new TextEncoder().encode(text);
  const subtle = globalThis.crypto?.subtle;
  if (!subtle) throw new Error('当前运行时没有可用的 SHA-256 实现');
  const digest = await subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
}

/** Synchronous-looking helper for call sites that already build a canonical string. */
export async function sha256OfCanonical(value: unknown): Promise<string> {
  return sha256Hex(stableStringify(value));
}
