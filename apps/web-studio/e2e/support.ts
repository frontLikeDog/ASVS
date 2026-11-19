import type { Page } from '@playwright/test';

/**
 * Captures uncaught runtime errors and console errors. Network noise from the
 * Vite dev client (favicon, HMR websocket) is ignored; app-level failures are not.
 */
export function collectRuntimeErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on('pageerror', (error) => {
    errors.push(`pageerror: ${error.message}`);
  });
  page.on('console', (message) => {
    if (message.type() !== 'error') return;
    const text = message.text();
    if (/favicon|WebSocket|\[vite\]/i.test(text)) return;
    errors.push(`console: ${text}`);
  });
  return errors;
}
