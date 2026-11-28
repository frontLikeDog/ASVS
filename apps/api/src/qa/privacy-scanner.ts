import { createHash } from 'node:crypto';

/**
 * AC-07 · deterministic sensitive-data scanner (Step 5D, docs/16 §5.1).
 *
 * Three rules govern every function in this module:
 *
 * 1. **The raw match never leaves this file.** `scanText` returns only a masked
 *    sample (`matchRedacted`) and an irreversible digest (`matchSha256`); the
 *    matched substring itself is dropped before returning. Reports, SQLite,
 *    event logs, HTTP responses and the DOM can then never echo a secret.
 * 2. **No engine beyond the JS regex/string API**, so the same rules run on
 *    Windows and Linux without native deps. The privacy rule library lives
 *    here (apps/api), never in `libs/domain`, to keep the browser bundle free
 *    of it (docs/16 §2.2, red line 1).
 * 3. **False positives are as dangerous as misses.** Long numeric strings are
 *    only card numbers when Luhn passes, ID numbers only when the GB 11643
 *    checksum passes, JWTs only when the first two base64url segments decode
 *    to JSON objects, and asset filenames (`logo@2x.png`) are never emails.
 */

export const PRIVACY_RULE_IDS = [
  'privacy.email',
  'privacy.github_token',
  'privacy.api_key',
  'privacy.jwt',
  'privacy.bearer_or_cookie',
  'privacy.private_key',
  'privacy.secret_assignment',
  'privacy.sensitive_number',
  'privacy.ocr_unavailable',
] as const;
export type PrivacyRuleId = (typeof PRIVACY_RULE_IDS)[number];
/** Rules emitted by text scanning; `privacy.ocr_unavailable` is runner-only. */
export type TextPrivacyRuleId = Exclude<PrivacyRuleId, 'privacy.ocr_unavailable'>;

export interface PrivacyRuleMeta {
  title: string;
  remediation: string;
}

export const PRIVACY_RULE_META: Record<PrivacyRuleId, PrivacyRuleMeta> = {
  'privacy.email': {
    title: '检测到疑似邮箱地址',
    remediation: '请使用脱敏测试账号（如 example.invalid 域名）重录，或在编辑器中移除包含邮箱的画面/文案。',
  },
  'privacy.github_token': {
    title: '检测到疑似 GitHub Token',
    remediation: '撤销该 Token，改用脱敏占位值或测试账号重新录制录屏。',
  },
  'privacy.api_key': {
    title: '检测到疑似 API Key',
    remediation: '立即轮换该密钥，演示环境改用假密钥并重新录制录屏。',
  },
  'privacy.jwt': {
    title: '检测到疑似 JWT 令牌',
    remediation: '从演示数据中清除该令牌，改用过期/伪造的测试令牌后重新录制。',
  },
  'privacy.bearer_or_cookie': {
    title: '检测到认证头或会话 Cookie',
    remediation: '演示页面不得展示 Authorization / Cookie；请隐藏开发者工具或改用脱敏会话后重录。',
  },
  'privacy.private_key': {
    title: '检测到 PEM 私钥',
    remediation: '私钥绝不能出现在演示数据中；请从磁盘与页面移除并重新录制。',
  },
  'privacy.secret_assignment': {
    title: '检测到明文凭证键值对',
    remediation: '将 password / token / secret 等值替换为脱敏占位符后重新录制或编辑文案。',
  },
  'privacy.sensitive_number': {
    title: '检测到疑似身份证号或银行卡号',
    remediation: '使用合成测试证件号（校验位不成立）或打码后的号码重新录制。',
  },
  'privacy.ocr_unavailable': {
    title: 'OCR 不可用，图像隐私检查未能执行',
    remediation: '在服务端安装并配置 Tesseract（ASVS_QA_TESSERACT_BIN），或显式接受风险前修复环境后重跑。',
  },
};

/** A masked hit. Deliberately has no `raw` field — see rule 1 above. */
export interface PrivacyMatch {
  ruleId: TextPrivacyRuleId;
  matchRedacted: string;
  matchSha256: string;
  /** Offsets in the scanned text; used to derive locations, never serialized. */
  start: number;
  end: number;
}

export interface PrivacyScanOptions {
  /** Synthetic test-mail domains exempted from `privacy.email` (default none). */
  allowlistedDomains?: string[];
  /** Hard cap per scanned text so a pathological blob cannot exhaust memory. */
  maxMatches?: number;
}

const MAX_MATCHES_DEFAULT = 200;
/** Bytes of a masked sample; `qaFindingV1Schema.matchRedacted` caps at 120. */
const MAX_REDACTED_LENGTH = 120;

/** Asset extensions that occasionally follow an `@` in filenames/urls. */
const NON_TLD_EXTENSIONS = new Set([
  'png', 'jpg', 'jpeg', 'gif', 'webp', 'avif', 'svg', 'ico', 'bmp',
  'css', 'js', 'mjs', 'cjs', 'jsx', 'ts', 'tsx', 'json', 'map', 'html', 'htm',
  'woff', 'woff2', 'ttf', 'otf', 'eot',
  'mp4', 'webm', 'mov', 'mp3', 'wav', 'm4a', 'vtt', 'srt',
  'txt', 'md', 'yaml', 'yml', 'xml', 'toml', 'zip', 'wasm',
]);

const SECRET_ASSIGNMENT_KEYWORDS = [
  'password',
  'passwd',
  'secret',
  'api[_-]?key',
  'access[_-]?token',
  'refresh[_-]?token',
  'private[_-]?key',
  'client[_-]?secret',
];

/** Values that are syntactically present but obviously not credentials. */
const PLACEHOLDER_VALUES = new Set([
  'undefined',
  'null',
  'true',
  'false',
  '[redacted]',
  'redacted',
  'changeme',
  'password',
  'secret',
  'placeholder',
  'example',
  'dummy',
]);

export function sha256HexOfString(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

/**
 * Mask a matched secret down to at most 4 leading + 4 trailing characters.
 *
 * Structural rules (JWT / PEM / Cookie) use their own fixed masks — they
 * describe the shape of the secret, not its content. Every branch is
 * non-reversible in practice: even the retained characters require the
 * (discarded) middle to reconstruct the original.
 */
export function redactMatch(ruleId: TextPrivacyRuleId, raw: string): string {
  const clip = (value: string): string =>
    value.length <= MAX_REDACTED_LENGTH ? value : value.slice(0, MAX_REDACTED_LENGTH);

  if (raw.length <= 8) return '[REDACTED]';

  switch (ruleId) {
    case 'privacy.email': {
      const at = raw.lastIndexOf('@');
      if (at <= 0) return '[REDACTED]';
      const local = raw.slice(0, at);
      const domain = raw.slice(at + 1);
      // `alice.secret@corp.internal` → `a***@corp.internal` (docs/16 §5.1).
      const masked = `${local.slice(0, 1)}***@${domain}`;
      return clip(masked.length <= MAX_REDACTED_LENGTH ? masked : `${local.slice(0, 1)}***@****`);
    }
    case 'privacy.jwt':
      return 'eyJ****.****.****';
    case 'privacy.private_key':
      return '-----BEGIN PRIVATE KEY [REDACTED]-----';
    case 'privacy.bearer_or_cookie': {
      if (/^\s*(?:cookie|set-cookie)\s*:/i.test(raw)) return 'Cookie: [REDACTED]';
      return clip(`Bearer ****${raw.slice(-4)}`);
    }
    case 'privacy.secret_assignment': {
      const separator = raw.search(/[:=]/);
      if (separator <= 0) return '[REDACTED]';
      const key = raw
        .slice(0, separator)
        .trim()
        .replace(/^["']|["']$/g, '');
      const value = raw
        .slice(separator + 1)
        .trim()
        .replace(/^["']|["']$/g, '');
      return clip(`${key}=****${value.slice(-4)}`);
    }
    case 'privacy.github_token':
    case 'privacy.api_key':
    case 'privacy.sensitive_number':
    default:
      // At most 4 + 4 characters retained; the rest is the marker.
      return clip(`${raw.slice(0, 4)}****${raw.slice(-4)}`);
  }
}

function isAllowlistedEmailDomain(domain: string, allowlist: readonly string[]): boolean {
  const normalized = domain.toLowerCase();
  return allowlist.some((entry) => {
    const suffix = entry.trim().toLowerCase().replace(/^\./, '');
    if (!suffix) return false;
    return normalized === suffix || normalized.endsWith(`.${suffix}`);
  });
}

/** GB 11643-1999 checksum for 18-digit resident ID numbers. */
export function isValidChinaIdNumber(value: string): boolean {
  if (!/^\d{17}[\dXx]$/.test(value)) return false;
  // Plausible birth date (1900–2099) — rejects timestamp-ish digit runs.
  const year = Number(value.slice(6, 10));
  const month = Number(value.slice(10, 12));
  const day = Number(value.slice(12, 14));
  if (year < 1900 || year > 2099 || month < 1 || month > 12 || day < 1 || day > 31) return false;
  const weights = [7, 9, 10, 5, 8, 4, 2, 1, 6, 3, 7, 9, 10, 5, 8, 4, 2];
  const checkChars = '10X98765432';
  let sum = 0;
  for (let index = 0; index < 17; index += 1) {
    sum += Number(value[index]) * weights[index]!;
  }
  const expected = checkChars[sum % 11]!;
  return value[17]!.toUpperCase() === expected;
}

/** Luhn checksum; card numbers are 13–19 digits after separator stripping. */
export function passesLuhn(value: string): boolean {
  const digits = value.replace(/[\s-]/g, '');
  if (!/^\d{13,19}$/.test(digits)) return false;
  if (/^0+$/.test(digits)) return false;
  let sum = 0;
  let double = false;
  for (let index = digits.length - 1; index >= 0; index -= 1) {
    let digit = Number(digits[index]);
    if (double) {
      digit *= 2;
      if (digit > 9) digit -= 9;
    }
    sum += digit;
    double = !double;
  }
  return sum % 10 === 0;
}

/** Rejects runs like `1234567890123456` that pass Luhn but are obviously fake. */
function isSequentialOrRepeated(digits: string): boolean {
  const stripped = digits.replace(/[\s-]/g, '');
  if (/^(\d)\1+$/.test(stripped)) return true;
  let ascending = true;
  let descending = true;
  for (let index = 1; index < stripped.length; index += 1) {
    const previous = Number(stripped[index - 1]);
    const current = Number(stripped[index]);
    if (current !== (previous + 1) % 10) ascending = false;
    if (current !== (previous + 9) % 10) descending = false;
  }
  return ascending || descending;
}

function decodeBase64UrlJsonPrefix(segment: string): boolean {
  try {
    const decoded = Buffer.from(segment, 'base64url').toString('utf8').trimStart();
    return decoded.startsWith('{');
  } catch {
    return false;
  }
}

/**
 * Scan one text blob for every rule and return masked hits.
 *
 * Matches are collected rule-by-rule in specificity order; a later match that
 * intersects an earlier one is dropped, so `sk-ant-…` yields one API-key hit
 * (not also an OpenAI hit) and `Bearer eyJ…` yields one JWT hit that already
 * explains the header. Identical (ruleId, sha256) pairs collapse to one.
 */
export function scanText(text: string, options: PrivacyScanOptions = {}): PrivacyMatch[] {
  if (!text) return [];
  const allowlist = options.allowlistedDomains ?? [];
  const maxMatches = options.maxMatches ?? MAX_MATCHES_DEFAULT;
  const matches: PrivacyMatch[] = [];
  const ranges: Array<{ start: number; end: number }> = [];
  const seen = new Set<string>();

  const push = (ruleId: TextPrivacyRuleId, raw: string, start: number, end: number): void => {
    if (matches.length >= maxMatches) return;
    if (ranges.some((range) => start < range.end && end > range.start)) return;
    const digest = sha256HexOfString(raw);
    const key = `${ruleId}:${digest}`;
    if (seen.has(key)) return;
    seen.add(key);
    ranges.push({ start, end });
    matches.push({
      ruleId,
      matchRedacted: redactMatch(ruleId, raw),
      matchSha256: digest,
      start,
      end,
    });
  };

  const run = (
    ruleId: TextPrivacyRuleId,
    pattern: RegExp,
    accept: (raw: string, match: RegExpExecArray) => boolean = () => true,
  ): void => {
    for (const found of text.matchAll(pattern)) {
      if (matches.length >= maxMatches) return;
      const raw = found[0];
      const start = found.index ?? 0;
      if (!accept(raw, found)) continue;
      push(ruleId, raw, start, start + raw.length);
    }
  };  // 1 · PEM private keys (the clearest signal of all).
  run('privacy.private_key', /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----/g);

  // 2 · JWT, validated structurally so `eyJ...`-shaped noise never fires.
  run('privacy.jwt', /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g, (raw) => {
    const [header, payload] = raw.split('.');
    return Boolean(
      header && payload && decodeBase64UrlJsonPrefix(header) && decodeBase64UrlJsonPrefix(payload),
    );
  });

  // 3 · GitHub tokens.
  run('privacy.github_token', /\b(?:gh[pousr])_[A-Za-z0-9_]{20,}\b/g);
  run('privacy.github_token', /\bgithub_pat_[A-Za-z0-9_]{20,}\b/g);

  // 4 · Vendor API keys — most specific pattern first (overlap suppresses dupes).
  run('privacy.api_key', /\bsk-ant-[A-Za-z0-9_-]{20,}\b/g);
  run('privacy.api_key', /\bsk-(?:proj-)?[A-Za-z0-9_-]{20,}\b/g);
  run('privacy.api_key', /\bAKIA[0-9A-Z]{16}\b/g);
  run('privacy.api_key', /\bAIza[0-9A-Za-z_-]{35}\b/g);
  run('privacy.api_key', /\b(?:sk|rk)_live_[A-Za-z0-9]{16,}\b/g);
  run('privacy.api_key', /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g);

  // 5 · Authorization headers / session cookies.
  run('privacy.bearer_or_cookie', /\bBearer\s+[A-Za-z0-9._~+/-]{16,}\b/gi);
  run(
    'privacy.bearer_or_cookie',
    /(?:^|[\r\n])\s*(?:cookie|set-cookie)\s*:\s*[^\r\n]*(?:session|token|auth|jwt|sid)[^\r\n]*/gi,
  );

  // 6 · Email (allowlisted synthetic domains exempted).
  run(
    'privacy.email',
    /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,24}\b/g,
    (raw, found) => {
      const at = raw.lastIndexOf('@');
      if (at <= 0) return false;
      const domain = raw.slice(at + 1);
      const tld = domain.slice(domain.lastIndexOf('.') + 1);
      if (tld.length < 2 || tld.length > 24) return false;
      if (NON_TLD_EXTENSIONS.has(tld.toLowerCase())) return false;
      // A preceding `/` signals URL userinfo (`https://user@host`) rather than
      // a statement about a person; an asset filename never reaches here
      // anyway because `logo@2x.png` fails the TLD check above.
      const index = found.index ?? 0;
      if (index > 0 && text[index - 1] === '/') return false;
      return !isAllowlistedEmailDomain(domain, allowlist);
    },
  );

  // 7 · `key = value` pairs with credential-shaped keys. The closing quote
  //     after the key is optional (`"api_key": "…"` is JSON, `api_key=…` a URL).
  run(
    'privacy.secret_assignment',
    new RegExp(
      `\\b(?:${SECRET_ASSIGNMENT_KEYWORDS.join('|')})\\b["']?\\s*[:=]\\s*["']?([A-Za-z0-9._/+=-]{8,})["']?`,
      'gi',
    ),
    (raw) => {
      const separator = raw.search(/[:=]/);
      const value = raw
        .slice(separator + 1)
        .trim()
        .replace(/^["']|["']$/g, '');
      if (value.length < 8) return false;
      if (PLACEHOLDER_VALUES.has(value.toLowerCase())) return false;
      if (/^\*+$/.test(value) || /^(.)\1+$/.test(value)) return false;
      return true;
    },
  );

  // 8 · Sensitive numbers: resident ID (GB 11643) before bank cards (Luhn),
  //     so an 18-digit ID cannot also surface as a card number.
  run('privacy.sensitive_number', /\b\d{17}[\dXx]\b/g, (raw) => isValidChinaIdNumber(raw));
  run(
    'privacy.sensitive_number',
    /(?<!\d)(?:\d[ -]?){12,18}\d(?!\d)/g,
    (raw) => passesLuhn(raw) && !isSequentialOrRepeated(raw),
  );

  return matches;
}

/**
 * Walk any JSON-ish value and scan every string leaf. Returns hits with the
 * JSON-ish path (`request.headers.authorization`, `values[3]`) so findings can
 * point at a trace entry without ever copying the value into the report.
 */
export function scanJsonStrings(
  value: unknown,
  options: PrivacyScanOptions & { maxDepth?: number } = {},
): Array<PrivacyMatch & { path: string }> {
  const hits: Array<PrivacyMatch & { path: string }> = [];
  const maxDepth = options.maxDepth ?? 24;
  const walk = (node: unknown, path: string, depth: number): void => {
    if (depth > maxDepth) return;
    if (typeof node === 'string') {
      for (const match of scanText(node, options)) {
        hits.push({ ...match, path });
      }
      return;
    }
    if (Array.isArray(node)) {
      node.forEach((entry, index) => walk(entry, `${path}[${index}]`, depth + 1));
      return;
    }
    if (node && typeof node === 'object') {
      for (const [key, entry] of Object.entries(node as Record<string, unknown>)) {
        // Header *names* matter (`authorization`); scan key+value together so a
        // bare `authorization: <opaque>` still matches the bearer rule text.
        walk(entry, path ? `${path}.${key}` : key, depth + 1);
      }
    }
  };
  walk(value, '', 0);
  return hits;
}
