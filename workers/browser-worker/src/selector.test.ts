import { describe, expect, it } from 'vitest';
import type { Page } from '@playwright/test';
import { parseSelector } from './selector';

function fakePage(): {
  page: Page;
  calls: Array<{ method: string; args: unknown[] }>;
} {
  const calls: Array<{ method: string; args: unknown[] }> = [];
  const locator = { fake: 'locator' };
  const page = {
    getByRole: (...args: unknown[]) => {
      calls.push({ method: 'getByRole', args });
      return locator;
    },
    getByLabel: (...args: unknown[]) => {
      calls.push({ method: 'getByLabel', args });
      return locator;
    },
    getByText: (...args: unknown[]) => {
      calls.push({ method: 'getByText', args });
      return locator;
    },
    getByTestId: (...args: unknown[]) => {
      calls.push({ method: 'getByTestId', args });
      return locator;
    },
    getByPlaceholder: (...args: unknown[]) => {
      calls.push({ method: 'getByPlaceholder', args });
      return locator;
    },
    getByAltText: (...args: unknown[]) => {
      calls.push({ method: 'getByAltText', args });
      return locator;
    },
  } as unknown as Page;
  return { page, calls };
}

describe('DemoPlan selector DSL', () => {
  it('解析 role=button,name=…', () => {
    const { page, calls } = fakePage();
    parseSelector(page, 'role=button,name=待审核');
    expect(calls[0]).toEqual({ method: 'getByRole', args: ['button', { name: '待审核' }] });
  });

  it('解析 heading / label / text / testid / placeholder / alt', () => {
    const { page, calls } = fakePage();
    parseSelector(page, 'heading=视频库');
    parseSelector(page, 'label=搜索视频');
    parseSelector(page, 'text=1 条结果');
    parseSelector(page, 'testid=task-status-running');
    parseSelector(page, 'placeholder=搜索…');
    parseSelector(page, 'alt=产品截图');
    expect(calls.map((call) => call.method)).toEqual([
      'getByRole',
      'getByLabel',
      'getByText',
      'getByTestId',
      'getByPlaceholder',
      'getByAltText',
    ]);
  });

  it('拒绝 CSS / XPath / nth / 脚本前缀', () => {
    const { page } = fakePage();
    for (const selector of [
      'css=button',
      'xpath=//button',
      'nth=0',
      'js=document.body.click()',
      'button',
    ]) {
      expect(() => parseSelector(page, selector), selector).toThrow(/不支持|前缀/);
    }
  });

  it('拒绝未知或危险的 role', () => {
    const { page } = fakePage();
    expect(() => parseSelector(page, 'role=script,name=x')).toThrow(/role/);
    expect(() => parseSelector(page, 'role=button,name=x,foo=y')).toThrow(/只支持/);
  });

  it('带双引号的 name 表示精确匹配', () => {
    const { page, calls } = fakePage();
    parseSelector(page, 'role=link,name="视频工程"');
    expect(calls[0]).toEqual({
      method: 'getByRole',
      args: ['link', { name: '视频工程', exact: true }],
    });
    expect(() => parseSelector(page, 'role=link,name="未闭合')).toThrow(/引号/);
  });
});
