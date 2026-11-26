import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig, devices } from '@playwright/test';

const here = path.dirname(fileURLToPath(import.meta.url));
const appRoot = path.resolve(here, '..');
const workspaceRoot = path.resolve(appRoot, '../..');
const viteBin = path.resolve(workspaceRoot, 'node_modules/vite/bin/vite.js');
const apiDbPath = path.resolve(workspaceRoot, 'dist/e2e/asvs-e2e.sqlite');

export default defineConfig({
  testDir: here,
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 45_000,
  expect: { timeout: 8_000 },
  reporter: [['list']],
  use: {
    baseURL: 'http://localhost:4200',
    viewport: { width: 1440, height: 900 },
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    acceptDownloads: true,
  },
  projects: [
    {
      name: 'chromium',
      // Viewport-specific suites get their own project below.
      testIgnore: [/mobile\.spec\.ts/, /tablet\.spec\.ts/],
      use: { ...devices['Desktop Chrome'], viewport: { width: 1440, height: 900 } },
    },
    {
      name: 'mobile-chromium',
      testMatch: /mobile\.spec\.ts/,
      use: {
        browserName: 'chromium',
        viewport: { width: 390, height: 844 },
        deviceScaleFactor: 3,
        isMobile: true,
        hasTouch: true,
      },
    },
    {
      // 768 is the shell breakpoint between the mobile drawer and the
      // persistent sidebar; it had no automated coverage before.
      name: 'tablet-chromium',
      testMatch: /tablet\.spec\.ts/,
      use: {
        browserName: 'chromium',
        viewport: { width: 768, height: 1024 },
        deviceScaleFactor: 2,
        isMobile: true,
        hasTouch: true,
      },
    },
  ],
  webServer: [
    {
      command: `node "${viteBin}" --config vite.config.ts`,
      cwd: appRoot,
      url: 'http://localhost:4200',
      reuseExistingServer: !process.env.CI,
      timeout: 120_000,
      stdout: 'pipe',
      stderr: 'pipe',
    },
    {
      // The workspace sync spec drives two real browser contexts against the
      // local Fastify API, so e2e starts it with a throwaway SQLite file.
      // Call the tsx CLI directly instead of through pnpm: on Windows a
      // concurrent pnpm invocation can try to rewrite the workspace lockfile.
      command: `node "${path.resolve(workspaceRoot, 'node_modules/tsx/dist/cli.mjs')}" --tsconfig apps/api/tsconfig.json apps/api/src/main.ts`,
      cwd: workspaceRoot,
      url: 'http://127.0.0.1:4300/v1/health',
      env: {
        ...(process.env as Record<string, string>),
        ASVS_API_PORT: '4300',
        ASVS_DB_PATH: apiDbPath,
        ASVS_LOG_LEVEL: 'warn',
      },
      reuseExistingServer: !process.env.CI,
      timeout: 60_000,
      stdout: 'pipe',
      stderr: 'pipe',
    },
  ],
});
