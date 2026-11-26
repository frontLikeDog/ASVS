import type { Locator, Page } from '@playwright/test';
import { DemoPlanError } from './plan';

/**
 * A deliberately small locator DSL. DemoPlans are data, so a plan may never
 * smuggle CSS/XPath/JS into the browser: only the prefixes below are resolved,
 * and they all map to Playwright's semantic locators.
 *
 *   role=button,name=Start
 *   role=link,name="视频工程"      ← 带双引号的 name 表示精确匹配
 *   heading=视频库
 *   label=搜索视频
 *   placeholder=搜索…
 *   testid=task-status-running
 *   text=Lumen 2.8
 *   alt=产品截图
 */
export const SELECTOR_PREFIXES = [
  'role',
  'heading',
  'label',
  'placeholder',
  'testid',
  'text',
  'alt',
] as const;
export type SelectorPrefix = (typeof SELECTOR_PREFIXES)[number];

/** Roles we allow. This keeps plans away from exotic/unsafe role games. */
export const SAFE_ROLES = new Set([
  'alert',
  'article',
  'banner',
  'button',
  'cell',
  'checkbox',
  'columnheader',
  'combobox',
  'complementary',
  'dialog',
  'figure',
  'form',
  'group',
  'heading',
  'img',
  'link',
  'list',
  'listitem',
  'main',
  'menu',
  'menuitem',
  'navigation',
  'note',
  'option',
  'progressbar',
  'radio',
  'region',
  'row',
  'rowheader',
  'search',
  'separator',
  'slider',
  'spinbutton',
  'status',
  'switch',
  'tab',
  'table',
  'tablist',
  'textbox',
  'toolbar',
  'tooltip',
]);

interface ParsedRoleSelector {
  role: string;
  name?: string;
  exact?: boolean;
  level?: number;
}

function parseRoleBody(body: string): ParsedRoleSelector {
  const comma = body.indexOf(',');
  const role = (comma === -1 ? body : body.slice(0, comma)).trim();
  if (!role) throw new DemoPlanError('role selector 缺少角色，例如 role=button,name=Start');
  if (!SAFE_ROLES.has(role)) {
    throw new DemoPlanError(
      `不允许的 ARIA role "${role}"。允许的 role：${Array.from(SAFE_ROLES).sort().join(', ')}`,
    );
  }

  const result: ParsedRoleSelector = { role };
  if (comma === -1) return result;

  const rest = body.slice(comma + 1).trim();
  if (rest.startsWith('name=')) {
    let name = rest.slice('name='.length);
    if (/,[a-z-]+=/i.test(name)) {
      throw new DemoPlanError('role selector 只支持 name= 或 level=，不接受额外参数');
    }
    // A quoted name opts into exact matching, so `name="视频工程"` does not
    // also match the dashboard card "创建或调整视频策划 · 2 个视频工程".
    if (name.startsWith('"') || name.endsWith('"')) {
      if (!(name.length >= 2 && name.startsWith('"') && name.endsWith('"'))) {
        throw new DemoPlanError(`role 的 name 引号不成对，收到 "${name}"`);
      }
      name = name.slice(1, -1);
      if (!name) throw new DemoPlanError('role selector 的 name 不能为空');
      result.exact = true;
    }
    result.name = name;
  } else if (rest.startsWith('level=')) {
    const level = Number(rest.slice('level='.length));
    if (!Number.isInteger(level) || level < 1 || level > 6) {
      throw new DemoPlanError(`role 的 level 必须是 1–6 的整数，收到 "${rest}"`);
    }
    result.level = level;
  } else {
    throw new DemoPlanError(`role selector 只支持 name= 或 level=，收到 "${rest}"`);
  }
  return result;
}

function requireBody(prefix: SelectorPrefix, body: string): string {
  const trimmed = body.trim();
  if (!trimmed) throw new DemoPlanError(`${prefix}= selector 缺少内容`);
  return trimmed;
}

export function parseSelector(page: Page, raw: string): Locator {
  const selector = raw.trim();
  const equals = selector.indexOf('=');
  if (equals <= 0) {
    throw new DemoPlanError(
      `selector 必须以受支持的前缀开头（${SELECTOR_PREFIXES.join(' / ')}），收到 "${raw}"`,
    );
  }
  const prefix = selector.slice(0, equals);
  const body = selector.slice(equals + 1);

  switch (prefix) {
    case 'role': {
      const parsed = parseRoleBody(body);
      if (parsed.level !== undefined && parsed.role !== 'heading') {
        throw new DemoPlanError('level= 只能与 role=heading 一起使用');
      }
      return page.getByRole(parsed.role as Parameters<Page['getByRole']>[0], {
        ...(parsed.name !== undefined ? { name: parsed.name } : {}),
        ...(parsed.exact ? { exact: true } : {}),
        ...(parsed.level !== undefined ? { level: parsed.level } : {}),
      });
    }
    case 'heading':
      return page.getByRole('heading', { name: requireBody('heading', body) });
    case 'label':
      return page.getByLabel(requireBody('label', body));
    case 'placeholder':
      return page.getByPlaceholder(requireBody('placeholder', body));
    case 'testid':
      return page.getByTestId(requireBody('testid', body));
    case 'text':
      return page.getByText(requireBody('text', body));
    case 'alt':
      return page.getByAltText(requireBody('alt', body));
    default:
      throw new DemoPlanError(
        `不支持的 selector 前缀 "${prefix}"。DemoPlan 只能使用 ${SELECTOR_PREFIXES.join(' / ')}；禁止 CSS、XPath、nth-child 与任意脚本。`,
      );
  }
}

export function describeSelector(raw: string): string {
  return raw.trim();
}
