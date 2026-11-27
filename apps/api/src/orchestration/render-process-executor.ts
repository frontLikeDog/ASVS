import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  parseWorkerEventLine,
  type RenderJobInputV1,
  type WorkerEvent,
} from '@asvs/domain';
import type {
  RenderJobExecutionResult,
  RenderJobExecutorCallbacks,
  RenderJobExecutorPort,
} from '@asvs/ports';

const here = path.dirname(fileURLToPath(import.meta.url));
/** apps/api/src/orchestration → workspace root */
const workspaceRoot = path.resolve(here, '../../../..');

export interface RenderProcessExecutorOptions {
  /** Absolute path to `workers/render-worker/src/render-job.ts`. */
  workerScript?: string;
  /** Extra args inserted before the script (none by default). */
  execArgv?: string[];
  /** Only used for diagnostics in tests; the worker pipes JSONL either way. */
  onStderrLine?: (line: string) => void;
}

function defaultWorkerScript(): string {
  return path.join(workspaceRoot, 'workers/render-worker/src/render-job.ts');
}

/**
 * Resolves tsx's ESM loader with `createRequire`, so the executor works
 * whether it is imported from `apps/api/src` (monorepo) or a built bundle.
 *
 * `--import` is parsed by Node as a module specifier, so on Windows the bare
 * `D:\…` path would be read as a URL with protocol `d:`
 * (`ERR_UNSUPPORTED_ESM_URL_SCHEME`); a `file://` URL is correct everywhere.
 */
function resolveTsxImport(): string {
  const require = createRequire(import.meta.url);
  return pathToFileURL(require.resolve('tsx')).href;
}

/**
 * Runs one render job as a genuinely separate OS process.
 *
 * Spawns `process.execPath` directly (never a shell or pnpm) so `child.pid` is
 * the actual worker on Windows *and* Linux, which is what makes the AC-06
 * `SIGKILL` test meaningful. Events are parsed from stdout JSONL lines with
 * the `ASVS_EVENT` prefix; all other output goes to `onStderrLine`.
 */
export class RenderProcessExecutor implements RenderJobExecutorPort {
  private child: ChildProcess | null = null;
  private aborted = false;
  private readonly workerScript: string;
  private readonly execArgv: string[];

  constructor(private readonly options: RenderProcessExecutorOptions = {}) {
    this.workerScript = options.workerScript ?? defaultWorkerScript();
    this.execArgv = options.execArgv ?? ['--import', resolveTsxImport()];
  }

  isRunning(): boolean {
    return this.child !== null;
  }

  abort(): void {
    this.aborted = true;
    this.kill('SIGTERM');
  }

  /** Windows has no real SIGKILL; `taskkill` is the deterministic equivalent. */
  kill(signal: 'SIGKILL' | 'SIGTERM'): void {
    const child = this.child;
    if (!child?.pid) return;
    if (process.platform === 'win32') {
      // `child.kill()` on Windows terminates only the immediate process; use
      // taskkill with /T to also stop any Chrome children Remotion launched.
      spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], {
        stdio: 'ignore',
        windowsHide: true,
      }).on('error', () => undefined);
      return;
    }
    try {
      process.kill(child.pid, signal);
      // SIGTERM can be swallowed by a hung Remotion render; follow up.
      if (signal === 'SIGTERM') {
        setTimeout(() => {
          if (this.child === child && child.exitCode === null) {
            try {
              process.kill(child.pid!, 'SIGKILL');
            } catch {
              // already gone
            }
          }
        }, 2000).unref();
      }
    } catch {
      // Process already exited between the check and the signal.
    }
  }

  async execute(
    job: RenderJobInputV1,
    inputFile: string,
    outDir: string,
    checkpointFile: string,
    callbacks: RenderJobExecutorCallbacks,
  ): Promise<RenderJobExecutionResult> {
    if (this.child) {
      return {
        ok: false,
        workerPid: null,
        exitCode: null,
        signal: null,
        crashed: false,
        code: 'executor_busy',
        message: '执行器已有正在运行的渲染进程',
        checkpoints: [],
      };
    }
    if (!existsSync(this.workerScript)) {
      return {
        ok: false,
        workerPid: null,
        exitCode: null,
        signal: null,
        crashed: false,
        code: 'worker_missing',
        message: `找不到 render-worker 入口：${this.workerScript}`,
        checkpoints: [],
      };
    }

    this.aborted = false;
    const args = [
      ...this.execArgv,
      this.workerScript,
      '--input',
      inputFile,
      '--out',
      outDir,
      '--checkpoint',
      checkpointFile,
      '--storage-ref-base',
      workspaceRoot,
    ];
    const child = spawn(process.execPath, args, {
      cwd: workspaceRoot,
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        ...process.env,
        // Make sure the worker's tsconfig path aliases (@asvs/domain) resolve.
        TSX_TSCONFIG_PATH: path.join(workspaceRoot, 'workers/render-worker/tsconfig.json'),
        ASVS_RENDER_WORKER: '1',
      },
    });
    this.child = child;
    const workerPid = child.pid ?? null;
    if (workerPid) callbacks.onSpawn?.(workerPid);

    const checkpoints: Array<{ phase: string; payload: Record<string, unknown> }> = [];
    let completed: Extract<WorkerEvent, { type: 'completed' }> | null = null;
    let failedEvent: Extract<WorkerEvent, { type: 'failed' }> | null = null;

    const handleEvent = (event: WorkerEvent) => {
      switch (event.type) {
        case 'heartbeat':
          callbacks.onHeartbeat?.(event.pid);
          break;
        case 'progress':
          callbacks.onProgress?.(event.phase, event.percent);
          break;
        case 'checkpoint':
          // Persist synchronously: a crash after this line must keep it.
          checkpoints.push({ phase: event.phase, payload: event.payload });
          callbacks.onCheckpoint?.(event.phase, event.payload);
          break;
        case 'log':
          callbacks.onLog?.(event.level, event.message);
          break;
        case 'completed':
          completed = event;
          break;
        case 'failed':
          failedEvent = event;
          break;
      }
    };

    let stdoutBuffer = '';
    child.stdout?.setEncoding('utf8');
    child.stdout?.on('data', (chunk: string) => {
      stdoutBuffer += chunk;
      let index = stdoutBuffer.indexOf('\n');
      while (index >= 0) {
        const line = stdoutBuffer.slice(0, index);
        stdoutBuffer = stdoutBuffer.slice(index + 1);
        const event = parseWorkerEventLine(line);
        if (event) handleEvent(event);
        index = stdoutBuffer.indexOf('\n');
      }
    });

    let stderrTail: string[] = [];
    child.stderr?.setEncoding('utf8');
    child.stderr?.on('data', (chunk: string) => {
      for (const line of chunk.split(/\r?\n/)) {
        if (!line.trim()) continue;
        this.options.onStderrLine?.(line);
        callbacks.onLog?.('info', line);
        stderrTail.push(line);
        if (stderrTail.length > 40) stderrTail = stderrTail.slice(-40);
      }
    });

    const exit = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
      (resolve) => {
        child.once('error', (error) => {
          stderrTail.push(error.message);
          resolve({ code: null, signal: null });
        });
        child.once('close', (code, signal) => resolve({ code, signal }));
      },
    );
    // A final line without a trailing newline must still be honoured.
    const trailing = parseWorkerEventLine(stdoutBuffer);
    if (trailing) handleEvent(trailing);
    this.child = null;
    void job;

    const completedEvent = completed as Extract<WorkerEvent, { type: 'completed' }> | null;
    const failureEvent = failedEvent as Extract<WorkerEvent, { type: 'failed' }> | null;

    if (exit.code === 0 && completedEvent) {
      return {
        ok: true,
        workerPid,
        exitCode: exit.code,
        checkpoints,
        completed: completedEvent,
      };
    }

    if (this.aborted) {
      return {
        ok: false,
        workerPid,
        exitCode: exit.code,
        signal: exit.signal,
        crashed: false,
        code: 'cancelled',
        message: '渲染进程已被取消',
        checkpoints,
      };
    }

    const cleanFailure = exit.code !== 0 && failureEvent !== null && exit.signal === null;
    return {
      ok: false,
      workerPid,
      exitCode: exit.code,
      signal: exit.signal,
      crashed: !cleanFailure,
      code: failureEvent?.code ?? (exit.signal ? `signal_${exit.signal}` : 'worker_exit'),
      message:
        failureEvent?.message ??
        (exit.signal
          ? `渲染进程被信号 ${exit.signal} 终止`
          : `渲染进程退出码 ${exit.code}${stderrTail.length > 0 ? `：${stderrTail.slice(-4).join(' | ')}` : ''}`),
      checkpoints,
    };
  }
}

export { workspaceRoot as renderWorkerWorkspaceRoot };
