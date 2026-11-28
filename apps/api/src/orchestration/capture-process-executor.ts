import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  captureJobResultV1Schema,
  parseWorkerEventLine,
  type CaptureJobInputV1,
  type CaptureJobResultV1,
  type WorkerEvent,
} from '@asvs/domain';
import type {
  CaptureJobExecutorCallbacks,
  CaptureJobExecutionResult,
  CaptureJobExecutorPort,
} from '@asvs/ports';

const here = path.dirname(fileURLToPath(import.meta.url));
/** apps/api/src/orchestration → workspace root */
const workspaceRoot = path.resolve(here, '../../../..');

export interface CaptureProcessExecutorOptions {
  /** Absolute path to `workers/browser-worker/src/capture-job.ts`. */
  workerScript?: string;
  execArgv?: string[];
  onStderrLine?: (line: string) => void;
}

function defaultWorkerScript(): string {
  return path.join(workspaceRoot, 'workers/browser-worker/src/capture-job.ts');
}

/** Same rationale as `render-process-executor.ts`: `--import` needs a file URL. */
function resolveTsxImport(): string {
  const require = createRequire(import.meta.url);
  return pathToFileURL(require.resolve('tsx')).href;
}

/**
 * Runs one capture job as an isolated OS process (Step 5C).
 *
 * The API never imports `workers/browser-worker` — it spawns the tsx entry the
 * same way the render worker is spawned, with `process.execPath` rather than a
 * shell so `child.pid` is the real worker and `taskkill /T` reaches Chromium.
 *
 * Result precedence:
 *   1. exit 0 + a valid `job-result.json`  → ok
 *   2. a valid result file even on a non-zero exit (the worker writes it
 *      before emitting `failed`)          → structured failure, not a crash
 *   3. no result file                      → crashed; the orchestrator decides
 *      whether the attempt is retryable
 */
export class CaptureProcessExecutor implements CaptureJobExecutorPort {
  private child: ChildProcess | null = null;
  private aborted = false;
  private readonly workerScript: string;
  private readonly execArgv: string[];

  constructor(private readonly options: CaptureProcessExecutorOptions = {}) {
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

  /** Windows has no SIGKILL; `taskkill /T` also stops Chromium children. */
  kill(signal: 'SIGKILL' | 'SIGTERM'): void {
    const child = this.child;
    if (!child?.pid) return;
    if (process.platform === 'win32') {
      spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], {
        stdio: 'ignore',
        windowsHide: true,
      }).on('error', () => undefined);
      return;
    }
    try {
      process.kill(child.pid, signal);
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
    job: CaptureJobInputV1,
    inputFile: string,
    outDir: string,
    checkpointFile: string,
    callbacks: CaptureJobExecutorCallbacks,
  ): Promise<CaptureJobExecutionResult> {
    if (this.child) {
      return {
        ok: false,
        workerPid: null,
        exitCode: null,
        signal: null,
        crashed: false,
        code: 'executor_busy',
        message: '执行器已有正在运行的录屏进程',
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
        message: `找不到 browser-worker 入口：${this.workerScript}`,
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
      job.storageRefBase,
      ...(job.serve ? ['--serve', job.serveMode] : []),
    ];
    const child = spawn(process.execPath, args, {
      cwd: workspaceRoot,
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        ...process.env,
        // Resolve `@asvs/domain` through the worker's own tsconfig paths.
        TSX_TSCONFIG_PATH: path.join(workspaceRoot, 'workers/browser-worker/tsconfig.json'),
        ASVS_CAPTURE_WORKER: '1',
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
    const trailing = parseWorkerEventLine(stdoutBuffer);
    if (trailing) handleEvent(trailing);
    this.child = null;

    const completedEvent = completed as Extract<WorkerEvent, { type: 'completed' }> | null;
    const failureEvent = failedEvent as Extract<WorkerEvent, { type: 'failed' }> | null;

    if (this.aborted) {
      return {
        ok: false,
        workerPid,
        exitCode: exit.code,
        signal: exit.signal,
        crashed: false,
        code: 'cancelled',
        message: '录屏进程已被取消',
        checkpoints,
      };
    }

    // The result file is the authority: it exists even when the process was
    // killed after writing it, and it carries the structured failure codes.
    const resultFile = path.join(outDir, 'job-result.json');
    let result: CaptureJobResultV1 | null = null;
    if (existsSync(resultFile)) {
      try {
        result = captureJobResultV1Schema.parse(
          JSON.parse(readFileSync(resultFile, 'utf8')) as unknown,
        );
      } catch {
        result = null;
      }
    }

    if (exit.code === 0 && result?.passed) {
      return { ok: true, workerPid, exitCode: exit.code, checkpoints, result };
    }
    if (result && !result.passed) {
      return {
        ok: false,
        workerPid,
        exitCode: exit.code,
        signal: exit.signal,
        crashed: false,
        code: result.failed?.code ?? 'capture_worker_crashed',
        message: result.failed?.message ?? '录屏失败',
        checkpoints,
        result,
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
          ? `录屏进程被信号 ${exit.signal} 终止`
          : `录屏进程退出码 ${exit.code}${
              stderrTail.length > 0 ? `：${stderrTail.slice(-4).join(' | ')}` : ''
            }`),
      checkpoints,
    };
  }
}

export { workspaceRoot as captureWorkerWorkspaceRoot };
