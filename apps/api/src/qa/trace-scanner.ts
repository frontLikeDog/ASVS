import type { TextPrivacyRuleId } from './privacy-scanner';
import { scanText } from './privacy-scanner';
import { readZipEntry, listZipEntries, type ZipEntry, type ZipLimits, DEFAULT_ZIP_LIMITS } from './zip-reader';

/**
 * Playwright `trace.zip` scanner (docs/16 §5.2).
 *
 * A trace is two NDJSON files (`*.trace`, `*.network`) plus a `resources/`
 * directory holding response bodies and screencast frames. Scanning every
 * resource would drown the report in false positives — a bundled React/Lucide
 * chunk legitimately contains license banners, sample addresses and
 * `Bearer`-shaped strings — so this scanner deliberately:
 *
 * - scans **all** `.trace` action params, DOM snapshot HTML, console/error
 *   text and **all** `.network` URLs/headers/postData/response headers,
 * - scans response **bodies** only for HTML / JSON / text / XML / SVG,
 * - counts, but never scans, JS / CSS / font / wasm / media bodies
 *   (`coverage.skippedTraceStaticEntries`),
 * - dedupes screencast frames by SHA1 and hands a bounded, evenly sampled set
 *   to the caller for OCR.
 *
 * Every hit carries a `traceEntryPath` (`trace.network#14
 * (request.headers.authorization)`) so Gate 3 can point at the exact entry
 * without exposing the value.
 */

export interface TraceStepWindow {
  stepId: string;
  startMs: number;
  endMs: number;
}

export interface TraceScanContext {
  allowlistedDomains?: string[];
  /** Frames handed to OCR; docs/16 §5.2 default. */
  maxTraceFrames?: number;
  /** Receipt-derived step windows for `stepId` attribution (ms, trace clock). */
  stepWindows?: TraceStepWindow[];
  /** Include `response.headers` scanning (always on) and cookie values. */
  maxScanBytesPerEntry?: number;
}

export interface TraceFindingDraft {
  ruleId: TextPrivacyRuleId;
  matchRedacted: string;
  matchSha256: string;
  traceEntryPath: string;
  timestampMs?: number;
  stepId?: string;
}

export interface TraceScreencastFrame {
  sha1: string;
  /** `resources/<sha1>` inside the archive. */
  resourceName: string;
  bytes: Buffer;
  timestampMs?: number;
  traceEntryPath: string;
}

export interface TraceScanResult {
  findings: TraceFindingDraft[];
  /** NDJSON lines / body text blobs actually scanned. */
  scannedEntries: number;
  skippedStaticEntries: number;
  screencastFrames: TraceScreencastFrame[];
  /** Action intervals, for mapping other timestamps back to a step. */
  actionWindows: TraceStepWindow[];
}

const DEFAULT_MAX_TRACE_FRAMES = 12;
const DEFAULT_MAX_SCAN_BYTES = 2 * 1024 * 1024;

/** Resource MIME types whose bodies are scanned (whitelist, not blacklist). */
const SCANNABLE_MIME_PATTERNS: RegExp[] = [
  /^text\/html\b/i,
  /^application\/json\b/i,
  /^application\/(?:x-)?json\b/i,
  /^text\/plain\b/i,
  /^application\/xml\b/i,
  /^text\/xml\b/i,
  /^image\/svg\+xml\b/i,
  /^application\/xhtml\+xml\b/i,
];

/** Explicitly skipped bodies; counted for honest coverage reporting. */
const STATIC_MIME_PATTERNS: RegExp[] = [
  /^application\/(?:x-)?javascript\b/i,
  /^text\/javascript\b/i,
  /^text\/css\b/i,
  /^font\//i,
  /^application\/font/i,
  /^application\/wasm\b/i,
  /^application\/octet-stream\b/i,
  /^video\//i,
  /^audio\//i,
  /^image\/(?!svg)/i,
];

interface NetworkSnapshot {
  request?: {
    url?: string;
    method?: string;
    headers?: unknown;
    postData?: { text?: string; json?: unknown };
  };
  response?: {
    url?: string;
    status?: number;
    headers?: unknown;
    content?: { mimeType?: string; _sha1?: string; size?: number };
  };
  _sha1?: string;
  resourceSize?: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function mimeKind(mimeType: string | undefined): 'scannable' | 'static' | 'other' {
  if (!mimeType) return 'other';
  if (SCANNABLE_MIME_PATTERNS.some((pattern) => pattern.test(mimeType))) return 'scannable';
  if (STATIC_MIME_PATTERNS.some((pattern) => pattern.test(mimeType))) return 'static';
  return 'other';
}

/** `data:` URIs in DOM snapshots are base64 noise and can trip token rules. */
function stripDataUris(html: string): string {
  return html.replace(/data:[^"'\s)]{16,}/g, '[data-uri]');
}

/**
 * Extract what a viewer could actually read from a Playwright DOM snapshot:
 * text nodes **and** the attribute values that render as text or become form
 * payloads (`value`, `placeholder`, `title`, `aria-label`, `alt`). Emails in
 * `data-*` attributes are not user-visible, but a page can leak them through
 * any `data-*` attribute the app maps into the DOM, so those are scanned too
 * (with data URIs stripped first, since base64 is pure noise for the rules).
 */
function htmlToScanText(html: string): string {
  const cleaned = stripDataUris(html)
    .replace(/<script\b[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style\b[\s\S]*?<\/style>/gi, ' ');

  const attributeValues: string[] = [];
  for (const tag of cleaned.match(/<[a-zA-Z][^>]*>/g) ?? []) {
    for (const attribute of tag.matchAll(/\b([a-zA-Z_:][-a-zA-Z0-9_:.]*)\s*=\s*("([^"]*)"|'([^']*)')/g)) {
      const raw = attribute[3] ?? attribute[4] ?? '';
      // `class`/`style`/`href`/`src` are scanned elsewhere (network) or are
      // pure presentational noise; every other attribute is fair game.
      const name = attribute[1]!.toLowerCase();
      if (name === 'class' || name === 'style' || name === 'href' || name === 'src') continue;
      if (raw.trim()) attributeValues.push(raw);
    }
  }

  const text = cleaned
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return [text, ...attributeValues].join(' \n ').trim();
}

function collectHeaderValues(headers: unknown, into: string[]): void {
  if (Array.isArray(headers)) {
    for (const entry of headers) {
      if (Array.isArray(entry) && entry.length >= 2) {
        into.push(`${String(entry[0])}: ${String(entry[1])}`);
      }
    }
    return;
  }
  if (isRecord(headers)) {
    for (const [key, value] of Object.entries(headers)) {
      into.push(`${key}: ${typeof value === 'string' ? value : JSON.stringify(value)}`);
    }
  }
}

function readNdjson(text: string): unknown[] {
  const events: unknown[] = [];
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      events.push(JSON.parse(trimmed));
    } catch {
      // A truncated last line is normal for a capture that ended mid-write;
      // scanning it as plain text still catches secrets, so do that.
      events.push({ type: 'unparsed', text: trimmed });
    }
  }
  return events;
}

function pickTraceFiles(entries: ZipEntry[]): { trace: ZipEntry[]; network: ZipEntry[]; resources: ZipEntry[] } {
  const trace: ZipEntry[] = [];
  const network: ZipEntry[] = [];
  const resources: ZipEntry[] = [];
  for (const entry of entries) {
    if (entry.name.endsWith('.trace') || entry.name.endsWith('.trace.jsonl')) trace.push(entry);
    else if (entry.name.endsWith('.network')) network.push(entry);
    else if (entry.name.startsWith('resources/')) resources.push(entry);
  }
  return { trace, network, resources };
}

/**
 * Scan a Playwright `trace.zip` held in memory.
 *
 * Never throws for malformed NDJSON (a partially written trace still gets
 * scanned); structural ZIP violations do throw `ZipSafetyError`.
 */
export function scanPlaywrightTrace(
  archive: Buffer,
  context: TraceScanContext = {},
  limits: ZipLimits = DEFAULT_ZIP_LIMITS,
): TraceScanResult {
  const entries = listZipEntries(archive, limits);
  const { trace: traceFiles, network: networkFiles, resources } = pickTraceFiles(entries);
  const resourceByName = new Map(resources.map((entry) => [entry.name, entry]));

  const allowlistedDomains = context.allowlistedDomains ?? [];
  const maxTraceFrames = context.maxTraceFrames ?? DEFAULT_MAX_TRACE_FRAMES;
  const maxScanBytes = context.maxScanBytesPerEntry ?? DEFAULT_MAX_SCAN_BYTES;
  const findings: TraceFindingDraft[] = [];
  const actionWindows: TraceStepWindow[] = [];
  const screencastBySha = new Map<string, TraceScreencastFrame>();
  let scannedEntries = 0;
  let skippedStaticEntries = 0;

  const findStepId = (timestampMs: number | undefined): string | undefined => {
    if (timestampMs === undefined) return undefined;
    const window = (context.stepWindows ?? []).find(
      (candidate) => timestampMs >= candidate.startMs && timestampMs <= candidate.endMs,
    );
    if (window) return window.stepId;
    const action = actionWindows.find(
      (candidate) => timestampMs >= candidate.startMs && timestampMs <= candidate.endMs,
    );
    return action?.stepId;
  };

  const scanInto = (
    text: string,
    traceEntryPath: string,
    timestampMs: number | undefined,
  ): void => {
    if (!text) return;
    const truncated = text.length > maxScanBytes ? text.slice(0, maxScanBytes) : text;
    scannedEntries += 1;
    for (const match of scanText(truncated, { allowlistedDomains })) {
      findings.push({
        ruleId: match.ruleId,
        matchRedacted: match.matchRedacted,
        matchSha256: match.matchSha256,
        traceEntryPath,
        ...(timestampMs !== undefined ? { timestampMs } : {}),
        ...(findStepId(timestampMs) ? { stepId: findStepId(timestampMs)! } : {}),
      });
    }
  };

  // ── 1. `.trace` · action params, DOM snapshots, console/error ────────────
  let eventIndex = 0;
  for (const file of traceFiles) {
    const text = readZipEntry(archive, file, limits).toString('utf8');
    const events = readNdjson(text);
    const pendingCalls = new Map<string, { startMs: number; apiName: string }>();
    for (const event of events) {
      eventIndex += 1;
      if (!isRecord(event)) continue;
      const type = typeof event.type === 'string' ? event.type : '';
      const callId = typeof event.callId === 'string' ? event.callId : undefined;
      const startTime = typeof event.startTime === 'number' ? event.startTime : undefined;
      const endTime = typeof event.endTime === 'number' ? event.endTime : undefined;

      if ((type === 'before' || type === 'action') && callId && startTime !== undefined) {
        const apiName =
          (typeof event.apiName === 'string' && event.apiName) ||
          (typeof event.title === 'string' && event.title) ||
          (typeof event.method === 'string' && event.method) ||
          'action';
        pendingCalls.set(callId, { startMs: Math.round(startTime), apiName });
        // Action params: url, form values, typed text, expressions.
        const params = isRecord(event.params) ? event.params : {};
        for (const key of ['url', 'value', 'text', 'expression', 'selector']) {
          const value = params[key];
          if (typeof value === 'string') {
            scanInto(value, `trace.trace#${eventIndex} (params.${key})`, Math.round(startTime));
          }
        }
        const title = typeof event.title === 'string' ? event.title : '';
        if (title) scanInto(title, `trace.trace#${eventIndex} (title)`, Math.round(startTime));
        if (endTime !== undefined) {
          actionWindows.push({
            stepId: apiName,
            startMs: Math.round(startTime),
            endMs: Math.round(endTime),
          });
        }
        continue;
      }
      if (type === 'after' && callId && endTime !== undefined) {
        const pending = pendingCalls.get(callId);
        if (pending) {
          actionWindows.push({
            stepId: pending.apiName,
            startMs: pending.startMs,
            endMs: Math.round(endTime),
          });
        }
        continue;
      }
      if (type === 'frame-snapshot') {
        const snapshot = isRecord(event.snapshot) ? event.snapshot : {};
        const html = typeof snapshot.html === 'string' ? snapshot.html : '';
        if (html) {
          scanInto(htmlToScanText(html), `trace.trace#${eventIndex} (snapshot)`, startTime !== undefined ? Math.round(startTime) : undefined);
        }
        continue;
      }
      if (type === 'console' || type === 'error' || type === 'unparsed') {
        const textValue = typeof event.text === 'string' ? event.text : typeof event.message === 'string' ? event.message : '';
        if (textValue) {
          scanInto(textValue, `trace.trace#${eventIndex} (${type})`, startTime !== undefined ? Math.round(startTime) : undefined);
        }
        continue;
      }
      if (type === 'screencast-frame') {
        const sha1 = typeof event.sha1 === 'string' ? event.sha1 : '';
        if (!sha1 || screencastBySha.has(sha1)) continue;
        const resource = resourceByName.get(`resources/${sha1}`);
        if (!resource) continue;
        const timestampMs = typeof event.timestamp === 'number' ? Math.round(event.timestamp) : undefined;
        screencastBySha.set(sha1, {
          sha1,
          resourceName: resource.name,
          bytes: readZipEntry(archive, resource, limits),
          ...(timestampMs !== undefined ? { timestampMs } : {}),
          traceEntryPath: `resources/${sha1} (screencast-frame)`,
        });
      }
    }
  }

  // ── 2. `.network` · URLs, headers, postData, response headers/bodies ────
  for (const file of networkFiles) {
    const text = readZipEntry(archive, file, limits).toString('utf8');
    const events = readNdjson(text);
    let lineIndex = 0;
    for (const event of events) {
      lineIndex += 1;
      if (!isRecord(event)) continue;
      const snapshot: NetworkSnapshot = isRecord(event.snapshot)
        ? (event.snapshot as NetworkSnapshot)
        : (event as NetworkSnapshot);
      const request = isRecord(snapshot.request) ? snapshot.request : {};
      const response = isRecord(snapshot.response) ? snapshot.response : {};
      const entryPath = `trace.network#${lineIndex}`;

      if (typeof request.url === 'string') {
        scanInto(request.url, `${entryPath} (request.url)`, undefined);
      }
      const requestHeaders: string[] = [];
      collectHeaderValues(request.headers, requestHeaders);
      for (const header of requestHeaders) {
        scanInto(header, `${entryPath} (request.headers)`, undefined);
      }
      const postText = isRecord(request.postData) && typeof request.postData.text === 'string'
        ? request.postData.text
        : '';
      if (postText) scanInto(postText, `${entryPath} (request.postData)`, undefined);

      const responseHeaders: string[] = [];
      collectHeaderValues(response.headers, responseHeaders);
      for (const header of responseHeaders) {
        scanInto(header, `${entryPath} (response.headers)`, undefined);
      }

      const content = isRecord(response.content) ? response.content : {};
      const mimeType = typeof content.mimeType === 'string' ? content.mimeType : undefined;
      const sha1 = typeof content._sha1 === 'string' ? content._sha1 : undefined;
      const kind = mimeKind(mimeType);
      if (kind === 'static') {
        skippedStaticEntries += 1;
      } else if (kind === 'scannable' && sha1) {
        const resource = resourceByName.get(`resources/${sha1}`);
        if (resource) {
          const body = readZipEntry(archive, resource, limits).toString('utf8');
          scanInto(body, `resources/${sha1} (${mimeType})`, undefined);
        }
      }
    }
  }

  // ── 3. Even sampling of dedicated screencast frames ─────────────────────
  const orderedFrames = [...screencastBySha.values()].sort(
    (left, right) => (left.timestampMs ?? 0) - (right.timestampMs ?? 0),
  );
  let sampled = orderedFrames;
  if (orderedFrames.length > maxTraceFrames) {
    const step = (orderedFrames.length - 1) / (maxTraceFrames - 1);
    const picks = new Set<number>();
    for (let index = 0; index < maxTraceFrames; index += 1) {
      picks.add(Math.round(index * step));
    }
    sampled = [...picks].sort((a, b) => a - b).map((index) => orderedFrames[index]!);
  }

  return {
    findings,
    scannedEntries,
    skippedStaticEntries,
    screencastFrames: sampled,
    actionWindows,
  };
}
