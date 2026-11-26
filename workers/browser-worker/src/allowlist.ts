import type { BrowserContext } from '@playwright/test';
import type { DemoPlanV1 } from '@asvs/domain';
import { DemoPlanError } from './plan';

/** Non-network schemes used by the page itself; never an origin escape. */
const LOCAL_SCHEMES = new Set(['data:', 'blob:', 'about:']);

export function isAllowedUrl(raw: string, allowedOrigins: string[]): boolean {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return false;
  }
  if (LOCAL_SCHEMES.has(url.protocol)) return true;
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return false;
  return allowedOrigins.includes(url.origin);
}

/**
 * Resolves a plan target against the base URL and refuses anything that is
 * not an allowlisted http(s) origin *before* a request is made.
 */
export function resolveNavigationUrl(plan: DemoPlanV1, target: string): URL {
  let url: URL;
  try {
    url = new URL(target, plan.baseUrl);
  } catch {
    throw new DemoPlanError(`navigate target 不是合法 URL：${target}`);
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new DemoPlanError(`navigate 只允许 http(s)，收到 ${url.protocol}`);
  }
  if (!plan.allowedOrigins.includes(url.origin)) {
    throw new DemoPlanError(
      `导航被 allowlist 阻断：${url.origin} 不在 [${plan.allowedOrigins.join(', ')}]（docs/08 §9 用例 2）`,
    );
  }
  return url;
}

export function assertFinalUrlAllowed(plan: DemoPlanV1, raw: string): void {
  const url = new URL(raw);
  if (!plan.allowedOrigins.includes(url.origin)) {
    throw new DemoPlanError(
      `页面最终停在未授权 origin：${url.origin}；allowlist 为 [${plan.allowedOrigins.join(', ')}]`,
    );
  }
}

/**
 * Enforces the allowlist at the network layer, not just on `navigate`. Fonts,
 * images, XHR and redirects to any other origin are aborted and recorded.
 */
export async function installNetworkGuard(
  context: BrowserContext,
  plan: DemoPlanV1,
  blocked: string[],
): Promise<void> {
  await context.route('**/*', async (route) => {
    const url = route.request().url();
    if (isAllowedUrl(url, plan.allowedOrigins)) {
      await route.continue();
      return;
    }
    blocked.push(url);
    await route.abort('blockedbyclient');
  });
}
