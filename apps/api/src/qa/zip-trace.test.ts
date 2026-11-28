// @vitest-environment node
import { deflateRawSync, crc32 } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { ZipSafetyError, listZipEntries, readZipEntriesAsMap } from './zip-reader';
import { scanPlaywrightTrace } from './trace-scanner';

const FAKE_EMAIL = 'alice.secret@corp.internal';
const JWT =
  `${Buffer.from('{"alg":"HS256"}').toString('base64url')}` +
  `.${Buffer.from('{"sub":"alice","role":"admin"}').toString('base64url')}` +
  '.c2lnbmF0dXJlLXBhcnQ';

/** Builds a real ZIP (deflate or stored) so the reader is exercised for real. */
function buildZip(files: Record<string, string | Buffer>, method: 0 | 8 = 8): Buffer {
  const localParts: Buffer[] = [];
  const centralParts: Buffer[] = [];
  let offset = 0;
  const written = new Map<
    string,
    { crc: number; size: number; compressedSize: number; offset: number; method: number }
  >();

  for (const [name, content] of Object.entries(files)) {
    const data = Buffer.isBuffer(content) ? content : Buffer.from(content, 'utf8');
    const nameBytes = Buffer.from(name, 'utf8');
    const compressed = method === 8 ? deflateRawSync(data) : data;
    const checksum = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt32LE(0, 10);
    local.writeUInt32LE(checksum, 14);
    local.writeUInt32LE(compressed.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBytes.length, 26);
    local.writeUInt16LE(0, 28);
    const localData = Buffer.concat([local, nameBytes, compressed]);
    localParts.push(localData);
    written.set(name, {
      crc: checksum,
      size: data.length,
      compressedSize: compressed.length,
      offset,
      method,
    });
    offset += localData.length;
  }

  for (const [name, meta] of written) {
    const nameBytes = Buffer.from(name, 'utf8');
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(meta.method, 10);
    central.writeUInt32LE(0, 12);
    central.writeUInt32LE(meta.crc, 16);
    central.writeUInt32LE(meta.compressedSize, 20);
    central.writeUInt32LE(meta.size, 24);
    central.writeUInt16LE(nameBytes.length, 28);
    central.writeUInt32LE(meta.offset, 42);
    centralParts.push(Buffer.concat([central, nameBytes]));
  }
  const directory = Buffer.concat(centralParts);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(written.size, 8);
  eocd.writeUInt16LE(written.size, 10);
  eocd.writeUInt32LE(directory.length, 12);
  eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...localParts, directory, eocd]);
}

function ndjson(events: unknown[]): string {
  return events.map((event) => JSON.stringify(event)).join('\n');
}

function traceArchive(): Buffer {
  const trace = ndjson([
    {
      type: 'before',
      callId: 'call@1',
      startTime: 1000.5,
      endTime: 1200.9,
      apiName: 'page.openKnowledgeCard',
      params: { url: 'https://app.test/studio?token=ghp_A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8' },
    },
    {
      type: 'frame-snapshot',
      startTime: 1300,
      snapshot: {
        html: `<div class="card" data-note="${FAKE_EMAIL}"><span>Alice</span><input value="${FAKE_EMAIL}" /></div>`,
      },
    },
    { type: 'console', startTime: 1400, text: `debug token ${JWT}` },
    { type: 'screencast-frame', sha1: 'aaaa1111', timestamp: 1500 },
    { type: 'screencast-frame', sha1: 'aaaa1111', timestamp: 1600 },
    { type: 'screencast-frame', sha1: 'bbbb2222', timestamp: 1700 },
  ]);
  const network = ndjson([
    {
      type: 'resource-snapshot',
      snapshot: {
        request: {
          url: 'https://api.test/session?key=sk-proj-AbCdEf0123456789GhIjKlMnOpQrStUv',
          headers: [['authorization', `Bearer ${JWT}`]],
          postData: { text: `{"password":"Zx9Qw8Er7Ty6Ui5Op4"}` },
        },
        response: {
          headers: [['set-cookie', 'session=abc123def456; HttpOnly']],
          content: { mimeType: 'application/json', _sha1: 'json0001' },
        },
      },
    },
    {
      type: 'resource-snapshot',
      snapshot: {
        request: { url: 'https://app.test/assets/index-abc.js', headers: [] },
        response: {
          headers: [],
          content: { mimeType: 'application/javascript', _sha1: 'js000001' },
        },
      },
    },
  ]);
  return buildZip({
    'trace.trace': trace,
    'trace.network': network,
    'resources/aaaa1111': 'frame-one',
    'resources/bbbb2222': 'frame-two',
    'resources/json0001': JSON.stringify({ owner: FAKE_EMAIL, ok: true }),
    'resources/js000001': '/* license contact dev@example.com */ const a = 1;',
  });
}

describe('zip-reader · 安全上限', () => {
  it('解包 stored 与 deflate 条目', () => {
    const zip = buildZip({ 'a.txt': 'hello', 'dir/b.txt': 'world' }, 0);
    expect([...readZipEntriesAsMap(zip).keys()]).toEqual(['a.txt', 'dir/b.txt']);
    const deflated = buildZip({ 'a.txt': 'x'.repeat(500) }, 8);
    expect(readZipEntriesAsMap(deflated).get('a.txt')?.toString()).toBe('x'.repeat(500));
  });

  it('拒绝路径穿越、绝对路径与空字节条目名', () => {
    for (const name of ['../evil.txt', '/etc/passwd', 'C:/windows/x', 'a\0b.txt']) {
      expect(() => listZipEntries(buildZip({ [name]: 'x' }))).toThrow(ZipSafetyError);
    }
  });

  it('条目数量与单条/总量上限触发结构化异常', () => {
    const many = buildZip(Object.fromEntries(Array.from({ length: 5 }, (_, i) => [`f${i}`, 'x'])));
    expect(() => listZipEntries(many, { maxEntries: 3, maxEntryUncompressedBytes: 10_000, maxTotalUncompressedBytes: 10_000 })).toThrow(/条目/);

    const big = buildZip({ 'big.bin': 'y'.repeat(2048) });
    expect(() => listZipEntries(big, { maxEntries: 10, maxEntryUncompressedBytes: 1024, maxTotalUncompressedBytes: 10_000 })).toThrow(/单条上限/);

    const twoBig = buildZip({ 'a.bin': 'y'.repeat(800), 'b.bin': 'y'.repeat(800) });
    expect(() => listZipEntries(twoBig, { maxEntries: 10, maxEntryUncompressedBytes: 1024, maxTotalUncompressedBytes: 1000 })).toThrow(/总量/);
  });

  it('非 ZIP 字节给出可解释错误，而不是崩溃', () => {
    expect(() => listZipEntries(Buffer.from('not a zip at all'))).toThrow(ZipSafetyError);
  });
});

describe('trace-scanner · Playwright trace 精确扫描', () => {
  it('命中 URL / 表单值 / DOM 快照 / 控制台 / 请求头 / postData / 响应体', () => {
    const result = scanPlaywrightTrace(traceArchive(), {
      stepWindows: [{ stepId: 'step-open-card', startMs: 900, endMs: 1500 }],
    });
    const rules = new Set(result.findings.map((finding) => finding.ruleId));
    expect(rules.has('privacy.github_token')).toBe(true);
    expect(rules.has('privacy.email')).toBe(true);
    expect(rules.has('privacy.jwt')).toBe(true);
    expect(rules.has('privacy.api_key')).toBe(true);
    expect(rules.has('privacy.secret_assignment')).toBe(true);
    expect(rules.has('privacy.bearer_or_cookie')).toBe(true);

    // Every finding is locatable to a trace entry and carries no raw value.
    for (const finding of result.findings) {
      expect(finding.traceEntryPath.length).toBeGreaterThan(0);
      expect(finding.matchRedacted).not.toContain(FAKE_EMAIL);
      expect(finding.matchRedacted).not.toContain(JWT);
    }
    expect(JSON.stringify(result.findings)).not.toContain(FAKE_EMAIL);
    expect(JSON.stringify(result.findings)).not.toContain('Zx9Qw8Er7Ty6Ui5Op4');

    const urlHit = result.findings.find((finding) => finding.traceEntryPath.includes('request.url'));
    expect(urlHit?.traceEntryPath).toContain('trace.network');
    const domHit = result.findings.find((finding) => finding.traceEntryPath.includes('(snapshot)'));
    expect(domHit?.stepId).toBe('step-open-card');
    expect(domHit?.timestampMs).toBe(1300);
    const headerHit = result.findings.find((finding) => finding.traceEntryPath.includes('request.headers'));
    expect(headerHit).toBeDefined();
  });

  it('跳过 JS/CSS 等静态资源并如实计入 skippedTraceStaticEntries', () => {
    const result = scanPlaywrightTrace(traceArchive());
    expect(result.skippedStaticEntries).toBe(1);
    // The JS license email must not become a finding.
    expect(
      result.findings.some((finding) => finding.traceEntryPath.includes('js000001')),
    ).toBe(false);
    // JSON body *is* scanned.
    expect(
      result.findings.some((finding) => finding.traceEntryPath.includes('json0001')),
    ).toBe(true);
  });

  it('screencast 帧按 sha1 去重并带上资源字节', () => {
    const result = scanPlaywrightTrace(traceArchive(), { maxTraceFrames: 12 });
    expect(result.screencastFrames.map((frame) => frame.sha1)).toEqual(['aaaa1111', 'bbbb2222']);
    expect(result.screencastFrames[0]!.bytes.toString()).toBe('frame-one');
  });

  it('样例行被截断时仍以纯文本扫描，不静默丢弃', () => {
    const truncated = buildZip({
      'trace.trace': `${JSON.stringify({ type: 'console', text: `mail ${FAKE_EMAIL}` }).slice(0, 12)}"text":"mail ${FAKE_EMAIL}`,
    });
    const result = scanPlaywrightTrace(truncated);
    expect(result.findings.some((finding) => finding.ruleId === 'privacy.email')).toBe(true);
  });

  it('采样上限作用于大量 screencast 帧', () => {
    const events = Array.from({ length: 40 }, (_, index) => ({
      type: 'screencast-frame',
      sha1: `f${String(index).padStart(4, '0')}`,
      timestamp: index * 100,
    }));
    const archive = buildZip({
      'trace.trace': ndjson(events),
      ...Object.fromEntries(Array.from({ length: 40 }, (_, index) => [`resources/f${String(index).padStart(4, '0')}`, `bytes-${index}`])),
    });
    const result = scanPlaywrightTrace(archive, { maxTraceFrames: 5 });
    expect(result.screencastFrames).toHaveLength(5);
    expect(result.screencastFrames[0]!.sha1).toBe('f0000');
    expect(result.screencastFrames.at(-1)!.sha1).toBe('f0039');
  });
});
