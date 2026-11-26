import { describe, expect, it } from 'vitest';
import type { DemoPlanV1 } from '@asvs/domain';
import { assertFinalUrlAllowed, isAllowedUrl, resolveNavigationUrl } from './allowlist';

const plan = {
  baseUrl: 'http://localhost:4200',
  allowedOrigins: ['http://localhost:4200'],
} as DemoPlanV1;

describe('allowlist', () => {
  it('只允许显式 origin，localhost 也不例外', () => {
    expect(isAllowedUrl('http://localhost:4200/videos', plan.allowedOrigins)).toBe(true);
    expect(isAllowedUrl('http://127.0.0.1:4200/', plan.allowedOrigins)).toBe(false);
    expect(isAllowedUrl('https://example.invalid/', plan.allowedOrigins)).toBe(false);
    expect(isAllowedUrl('ftp://localhost:4200/', plan.allowedOrigins)).toBe(false);
    expect(isAllowedUrl('data:text/plain,ok', plan.allowedOrigins)).toBe(true);
    expect(isAllowedUrl('javascript:alert(1)', plan.allowedOrigins)).toBe(false);
  });

  it('解析相对路径与同源绝对 URL', () => {
    expect(resolveNavigationUrl(plan, '/videos').href).toBe('http://localhost:4200/videos');
    expect(resolveNavigationUrl(plan, 'http://localhost:4200/review').href).toBe(
      'http://localhost:4200/review',
    );
  });

  it('在发出请求前拒绝未授权导航', () => {
    expect(() => resolveNavigationUrl(plan, 'https://example.invalid/')).toThrow(/allowlist|阻断/);
    expect(() => resolveNavigationUrl(plan, 'javascript:alert(1)')).toThrow(/http/);
  });

  it('拒绝重定向后的未授权最终地址', () => {
    expect(() => assertFinalUrlAllowed(plan, 'http://localhost:4200/videos')).not.toThrow();
    expect(() => assertFinalUrlAllowed(plan, 'https://example.invalid/')).toThrow(/未授权/);
  });
});
