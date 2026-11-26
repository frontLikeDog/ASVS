import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { chromium, type Browser, type BrowserContext, type Page } from '@playwright/test';
import type { DemoPlanV1 } from '@asvs/domain';
import { installNetworkGuard } from './allowlist';
import { DemoPlanError } from './plan';
import { viteBin, webStudioDist, webStudioRoot } from './paths';

const SERVER_READY_TIMEOUT_MS = 120_000;
const SERVER_POLL_MS = 300;

async function isServerReady(url: string): Promise<boolean> {
  try {
    const response = await fetch(url, {
      method: 'GET',
      signal: AbortSignal.timeout(1500),
      redirect: 'manual',
    });
    return response.status >= 200 && response.status < 500;
  } catch {
    return false;
  }
}

export interface WebServerHandle {
  started: boolean;
  stop: () => Promise<void>;
}

/**
 * `preview` serves the production build. Dev mode compiles route modules on
 * first visit, which shows up as multi-second loading screens in the recording;
 * the shipped build paints each route immediately, so captures look like the
 * product rather than like Vite's module graph.
 */
export type WebServerMode = 'dev' | 'preview';

/** Starts the local fixture app unless it is already listening. */
export async function ensureWebServer(
  baseUrl: string,
  options: { serve: boolean; log: (line: string) => void; mode?: WebServerMode },
): Promise<WebServerHandle> {
  if (await isServerReady(baseUrl)) {
    options.log(`复用已运行的 web-studio：${baseUrl}`);
    return { started: false, stop: async () => {} };
  }
  if (!options.serve) {
    throw new DemoPlanError(
      `目标环境未启动：${baseUrl}。请先运行 pnpm dev，或去掉 --no-serve 让 worker 自行启动 web-studio。`,
    );
  }

  const mode = options.mode ?? 'preview';
  const target = new URL(baseUrl);
  const args =
    mode === 'preview'
      ? [
          viteBin,
          'preview',
          '--config',
          'vite.config.ts',
          '--host',
          target.hostname,
          '--port',
          target.port || '4200',
          '--strictPort',
        ]
      : [viteBin, '--config', 'vite.config.ts'];
  if (mode === 'preview' && !existsSync(path.join(webStudioDist, 'index.html'))) {
    throw new DemoPlanError(
      `未找到 web-studio 构建产物：${webStudioDist}。请先运行 pnpm build（Nx 会缓存），再录屏；或使用 --serve=dev 直接跑开发服务器。`,
    );
  }

  options.log(
    `启动 web-studio（${mode === 'preview' ? 'production build' : 'dev server'}）：${baseUrl}`,
  );
  const child: ChildProcess = spawn(process.execPath, args, {
    cwd: webStudioRoot,
    env: { ...process.env, BROWSER: 'none', CI: 'true' },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });

  let output = '';
  child.stdout?.on('data', (chunk: Buffer) => {
    output += chunk.toString();
    if (output.length > 20_000) output = output.slice(-20_000);
  });
  child.stderr?.on('data', (chunk: Buffer) => {
    output += chunk.toString();
    if (output.length > 20_000) output = output.slice(-20_000);
  });

  let exited = false;
  child.once('exit', () => {
    exited = true;
  });

  const stop = async (): Promise<void> => {
    if (exited) return;
    child.kill();
    await Promise.race([
      new Promise<void>((resolve) => child.once('exit', () => resolve())),
      new Promise<void>((resolve) => setTimeout(resolve, 5000)),
    ]);
  };

  const deadline = Date.now() + SERVER_READY_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (exited) {
      throw new DemoPlanError(`web-studio 启动失败：\n${output.trim()}`);
    }
    if (await isServerReady(baseUrl)) return { started: true, stop };
    await new Promise((resolve) => setTimeout(resolve, SERVER_POLL_MS));
  }

  await stop();
  throw new DemoPlanError(
    `web-studio 在 ${SERVER_READY_TIMEOUT_MS / 1000}s 内未就绪：${baseUrl}\n${output.trim()}`,
  );
}

export interface CaptureBrowser {
  browser: Browser;
  context: BrowserContext;
  page: Page;
  video: ReturnType<Page['video']>;
  blockedRequests: string[];
  recordingStartedAt: number;
  close: () => Promise<string | undefined>;
}

export async function launchCaptureBrowser(
  plan: DemoPlanV1,
  rawVideoDir: string,
): Promise<CaptureBrowser> {
  mkdirSync(rawVideoDir, { recursive: true });
  const browser = await chromium.launch({ headless: true });

  // Playwright starts the video clock when the context is created; record that
  // instant so the presentation clip can be cut right before the first
  // assertion instead of at the blank first frame.
  const recordingStartedAt = performance.now();

  const context = await browser.newContext({
    viewport: { width: plan.viewport.width, height: plan.viewport.height },
    deviceScaleFactor: plan.viewport.deviceScaleFactor,
    locale: plan.locale,
    timezoneId: plan.timezoneId,
    colorScheme: plan.colorScheme,
    reducedMotion: plan.reducedMotion,
    serviceWorkers: 'block',
    acceptDownloads: false,
    recordVideo: {
      dir: rawVideoDir,
      size: { width: plan.capture.width, height: plan.capture.height },
    },
  });

  const blockedRequests: string[] = [];
  await installNetworkGuard(context, plan, blockedRequests);

  const page = await context.newPage();
  const video = page.video();

  const close = async (): Promise<string | undefined> => {
    let videoPath: string | undefined;
    try {
      await context.close();
      videoPath = await video?.path();
    } finally {
      await browser.close().catch(() => undefined);
    }
    return videoPath;
  };

  return { browser, context, page, video, blockedRequests, recordingStartedAt, close };
}
