// @vitest-environment node
import { describe, expect, it } from 'vitest';
import {
  PRIVACY_RULE_META,
  passesLuhn,
  isValidChinaIdNumber,
  redactMatch,
  scanJsonStrings,
  scanText,
  sha256HexOfString,
} from './privacy-scanner';

const FAKE_GITHUB_TOKEN = 'ghp_A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8';
const FAKE_OPENAI_KEY = 'sk-proj-AbCdEf0123456789GhIjKlMnOpQrStUv';
const FAKE_EMAIL = 'alice.secret@corp.internal';
const FAKE_COOKIE = 'Cookie: session=abc123def456; theme=dark';
const FAKE_PEM = '-----BEGIN RSA PRIVATE KEY-----';
const FAKE_ID = '11010519491231002X';
const FAKE_CARD = '6222021234567890128';

function jwt(header: object, payload: object): string {
  const encode = (value: object): string =>
    Buffer.from(JSON.stringify(value), 'utf8').toString('base64url');
  return `${encode(header)}.${encode(payload)}.${'S'.repeat(16)}`;
}

describe('privacy-scanner · 8 类敏感模式', () => {
  it('命中 GitHub Token、API Key 与 Bearer 头，且掩码不含完整原值', () => {
    const matches = scanText(
      `token=${FAKE_GITHUB_TOKEN} key=${FAKE_OPENAI_KEY} header: Bearer ${'Zx9'.repeat(8)}`,
    );
    const rules = matches.map((match) => match.ruleId);
    expect(rules).toContain('privacy.github_token');
    expect(rules).toContain('privacy.api_key');
    expect(rules).toContain('privacy.bearer_or_cookie');
    for (const match of matches) {
      expect(match.matchRedacted).not.toContain(FAKE_GITHUB_TOKEN);
      expect(match.matchRedacted.length).toBeLessThanOrEqual(120);
      expect(match.matchSha256).toMatch(/^[a-f0-9]{64}$/);
    }
    expect(matches.find((match) => match.ruleId === 'privacy.github_token')?.matchRedacted).toBe(
      'ghp_****Q7r8',
    );
  });

  it('JWT 只有在前两段确实解码为 JSON 对象时命中', () => {
    const real = jwt({ alg: 'HS256', typ: 'JWT' }, { sub: 'alice', role: 'admin' });
    const noise = 'eyJhbGciOiJIUzI1NiJ9.notjsonnotjson.signaturepart';
    const matches = scanText(`Authorization: Bearer ${real}`);
    expect(matches.some((match) => match.ruleId === 'privacy.jwt')).toBe(true);
    expect(matches.find((match) => match.ruleId === 'privacy.jwt')?.matchRedacted).toBe(
      'eyJ****.****.****',
    );
    expect(scanText(noise).some((match) => match.ruleId === 'privacy.jwt')).toBe(false);
  });

  it('邮箱命中并豁免 allowlistedDomains；文件名与 URL userinfo 不误报', () => {
    const hits = scanText(`联系人 ${FAKE_EMAIL}，备份 logo@2x.png，见 https://user@host.example/path`);
    expect(hits.filter((match) => match.ruleId === 'privacy.email')).toHaveLength(1);
    expect(hits.find((match) => match.ruleId === 'privacy.email')?.matchRedacted).toBe(
      'a***@corp.internal',
    );

    const allowlisted = scanText(`测试账号 qa@example.invalid`, {
      allowlistedDomains: ['example.invalid'],
    });
    expect(allowlisted.some((match) => match.ruleId === 'privacy.email')).toBe(false);
    // Subdomains of an allowlisted domain are exempt too.
    expect(
      scanText('qa@team.example.invalid', { allowlistedDomains: ['example.invalid'] }).some(
        (match) => match.ruleId === 'privacy.email',
      ),
    ).toBe(false);
  });

  it('PEM 私钥与 Cookie 头命中，使用结构化掩码', () => {
    const matches = scanText(`${FAKE_PEM}\nMIIE...\n-----END RSA PRIVATE KEY-----\n${FAKE_COOKIE}`);
    const pem = matches.find((match) => match.ruleId === 'privacy.private_key');
    const cookie = matches.find((match) => match.ruleId === 'privacy.bearer_or_cookie');
    expect(pem?.matchRedacted).toBe('-----BEGIN PRIVATE KEY [REDACTED]-----');
    expect(cookie?.matchRedacted).toBe('Cookie: [REDACTED]');
  });

  it('secret_assignment 命中真实值，忽略占位符', () => {
    const real = scanText('{"api_key": "Zx9Qw8Er7Ty6Ui5Op4"}');
    expect(real.find((match) => match.ruleId === 'privacy.secret_assignment')?.matchRedacted).toBe(
      'api_key=****5Op4',
    );
    for (const placeholder of ['password = undefined', 'secret: null', 'token = changeme']) {
      expect(scanText(placeholder).some((match) => match.ruleId === 'privacy.secret_assignment')).toBe(
        false,
      );
    }
  });

  it('身份证号必须通过 GB 11643 校验位，银行卡号必须通过 Luhn 且非顺序假号', () => {
    expect(isValidChinaIdNumber(FAKE_ID)).toBe(true);
    expect(isValidChinaIdNumber('110105194912310021')).toBe(false);
    expect(passesLuhn(FAKE_CARD)).toBe(true);
    expect(passesLuhn('6222021234567890123')).toBe(false);

    const matches = scanText(`证件 ${FAKE_ID} 卡号 ${FAKE_CARD}`);
    expect(matches.filter((match) => match.ruleId === 'privacy.sensitive_number')).toHaveLength(2);
    // Timestamps / long order ids / sequential runs never fire.
    expect(scanText('1723456789012345 1234567890123456').some((m) => m.ruleId === 'privacy.sensitive_number')).toBe(false);
    expect(scanText('110105194912310021').some((m) => m.ruleId === 'privacy.sensitive_number')).toBe(false);
  });

  it('每条规则的替换文案齐备（Gate 3 修复建议来源）', () => {
    for (const [ruleId, meta] of Object.entries(PRIVACY_RULE_META)) {
      expect(meta.title.length).toBeGreaterThan(0);
      expect(meta.remediation.length).toBeGreaterThan(0);
      expect(ruleId.startsWith('privacy.')).toBe(true);
    }
  });
});

describe('privacy-scanner · 反向泄密硬约束', () => {
  it('序列化后的命中结果绝不含原始敏感值', () => {
    const text = [
      FAKE_GITHUB_TOKEN,
      FAKE_OPENAI_KEY,
      FAKE_EMAIL,
      FAKE_COOKIE,
      FAKE_PEM,
      FAKE_ID,
      FAKE_CARD,
      jwt({ alg: 'HS256' }, { sub: 'alice' }),
    ].join('\n');
    const serialized = JSON.stringify(scanText(text));
    for (const raw of [
      FAKE_GITHUB_TOKEN,
      FAKE_OPENAI_KEY,
      FAKE_EMAIL,
      'abc123def456',
      FAKE_ID,
      FAKE_CARD,
    ]) {
      expect(serialized).not.toContain(raw);
    }
    // sha256 是确定的：同一命中在两次扫描中一致，可用于去重与审计。
    const first = scanText(FAKE_EMAIL)[0]!;
    const second = scanText(`前缀 ${FAKE_EMAIL}`)[0]!;
    expect(first.matchSha256).toBe(second.matchSha256);
    expect(first.matchSha256).toBe(sha256HexOfString(FAKE_EMAIL));
  });

  it('redactMatch 对短值整体替换，对长值最多保留 4+4 字符', () => {
    expect(redactMatch('privacy.api_key', 'short')).toBe('[REDACTED]');
    expect(redactMatch('privacy.api_key', 'ABCDEFGHIJKLMNOP')).toBe('ABCD****MNOP');
  });

  it('同一规则同一原值只出现一次，且不同规则重叠时保留更具体的一条', () => {
    const text = `${FAKE_EMAIL} 和 ${FAKE_EMAIL}`;
    expect(scanText(text).filter((match) => match.matchSha256 === sha256HexOfString(FAKE_EMAIL))).toHaveLength(1);

    const matches = scanText(`Authorization: Bearer ${jwt({ alg: 'none' }, { sub: 'x' })}`);
    expect(matches.filter((match) => match.ruleId === 'privacy.jwt')).toHaveLength(1);
    // `Bearer <jwt>` also matches the header rule, but the JWT range comes
    // first and the overlapping later hit is dropped.
    expect(matches.some((match) => match.ruleId === 'privacy.bearer_or_cookie')).toBe(false);

    // Anthropic keys match the OpenAI pattern too; only one API-key hit stands.
    const anthropic = scanText('sk-ant-api03-AbCdEf0123456789GhIjKlMn');
    expect(anthropic.filter((match) => match.ruleId === 'privacy.api_key')).toHaveLength(1);
  });

  it('scanJsonStrings 给出 JSON 路径，便于定位 trace 条目', () => {
    const hits = scanJsonStrings({
      request: { url: 'https://app.test/api?mail=x', headers: { authorization: `Bearer ${FAKE_OPENAI_KEY}` } },
      body: [FAKE_EMAIL],
    });
    expect(hits.map((hit) => hit.path)).toEqual(
      expect.arrayContaining(['request.headers.authorization', 'body[0]']),
    );
    expect(JSON.stringify(hits)).not.toContain(FAKE_OPENAI_KEY);
    expect(JSON.stringify(hits)).not.toContain(FAKE_EMAIL);
  });

  it('maxMatches 限制单条文本的产出，杜绝病态输入', () => {
    const text = Array.from({ length: 50 }, (_, index) => `u${index}@corp.internal`).join(' ');
    expect(scanText(text, { maxMatches: 5 })).toHaveLength(5);
  });
});
