import { spawn } from 'node:child_process';

/**
 * Async child-process helper for the QA engines.
 *
 * Every external tool (ffmpeg, ffprobe, tesseract) goes through here so that
 *
 * - `shell: false` and `windowsHide: true` are non-negotiable (docs/16 §10:
 *   Windows + Linux parity, no shell injection from a crafted filename),
 * - a hard timeout kills the child instead of leaking it,
 * - the process is registered so `abort()` (run cancel / server stop) can
 *   terminate it mid-flight,
 * - output is bounded, so a misbehaving decoder cannot exhaust memory.
 */

export interface QaProcessResult {
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  /** True when the timeout killed the child. */
  timedOut: boolean;
  /** Spawn-level failure (binary missing, EACCES...). */
  spawnError?: Error;
  durationMs: number;
}

export interface QaProcessOptions {
  timeoutMs?: number;
  /** SIGKILL the child when this aborts. */
  signal?: AbortSignal;
  maxStdoutBytes?: number;
  maxStderrBytes?: number;
  cwd?: string;
}

const DEFAULT_TIMEOUT_MS = 60_000;
const DEFAULT_MAX_OUTPUT = 8 * 1024 * 1024;

export function runQaProcess(
  command: string,
  args: string[],
  options: QaProcessOptions = {},
): Promise<QaProcessResult> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxStdout = options.maxStdoutBytes ?? DEFAULT_MAX_OUTPUT;
  const maxStderr = options.maxStderrBytes ?? DEFAULT_MAX_OUTPUT;
  const startedAt = Date.now();

  return new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let settled = false;
    let spawnError: Error | undefined;
    const killTimer: NodeJS.Timeout | undefined = setTimeout(() => {
      if (settled) return;
      timedOut = true;
      child.kill('SIGKILL');
    }, timeoutMs);

    const child = spawn(command, args, {
      shell: false,
      windowsHide: true,
      ...(options.cwd ? { cwd: options.cwd } : {}),
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    const finish = (code: number | null, signal: NodeJS.Signals | null): void => {
      if (settled) return;
      settled = true;
      if (killTimer) clearTimeout(killTimer);
      options.signal?.removeEventListener('abort', onAbort);
      resolve({
        code,
        signal,
        stdout,
        stderr,
        timedOut,
        ...(spawnError ? { spawnError } : {}),
        durationMs: Date.now() - startedAt,
      });
    };

    const onAbort = (): void => {
      if (settled) return;
      timedOut = true;
      child.kill('SIGKILL');
    };

    if (options.signal) {
      if (options.signal.aborted) {
        child.kill('SIGKILL');
      } else {
        options.signal.addEventListener('abort', onAbort, { once: true });
      }
    }

    child.stdout?.setEncoding('utf8');
    child.stderr?.setEncoding('utf8');
    child.stdout?.on('data', (chunk: string) => {
      if (stdout.length < maxStdout) stdout += chunk.slice(0, maxStdout - stdout.length);
    });
    child.stderr?.on('data', (chunk: string) => {
      if (stderr.length < maxStderr) stderr += chunk.slice(0, maxStderr - stderr.length);
    });
    child.on('error', (error) => {
      spawnError = error;
      finish(null, null);
    });
    child.on('close', (code, signal) => finish(code, signal));
  });
}
