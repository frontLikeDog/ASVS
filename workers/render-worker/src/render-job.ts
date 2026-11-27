import { readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import {
  encodeWorkerEvent,
  renderCheckpointFileV1Schema,
  renderJobInputV1Schema,
  type RenderJobInputV1,
  type WorkerEvent,
} from '@asvs/domain';
import { RenderJobError, runRenderJob } from './run-render-job';

interface CliOptions {
  inputFile: string;
  outDir: string;
  checkpointFile?: string;
  storageRefBase?: string;
  concurrency?: number;
  keepWorkDirs: boolean;
}

function printHelp(): void {
  process.stdout.write(`用法：tsx src/render-job.ts --input <render-job-input.json> --out <dir> [选项]

  --input <path>        orchestrator 写出的 RenderJobInputV1（必填）
  --out <dir>           产物目录：MP4 / receipt.json / manifest.json / .bundle（必填）
  --checkpoint <path>   断点文件；缺失时从零渲染，存在时按阶段续跑
  --storage-ref-base    receipt.storageRef 的相对基准目录（默认仓库根）
  --concurrency <n>     Remotion 渲染并发数（默认自动）
  --keep-work-dirs      成功后保留 .bundle / .public（排查用）
  --help                显示帮助

stdout 只输出 ASVS_EVENT 前缀的 JSONL 事件；其余日志走 stderr。
`);
}

function parseArgs(argv: string[]): CliOptions {
  const options: Partial<CliOptions> = { keepWorkDirs: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const value = () => {
      const next = argv[++index];
      if (!next) throw new Error(`${arg} 需要一个值`);
      return next;
    };
    switch (arg) {
      case '--input':
        options.inputFile = path.resolve(process.cwd(), value());
        break;
      case '--out':
        options.outDir = path.resolve(process.cwd(), value());
        break;
      case '--checkpoint':
        options.checkpointFile = path.resolve(process.cwd(), value());
        break;
      case '--storage-ref-base':
        options.storageRefBase = path.resolve(process.cwd(), value());
        break;
      case '--concurrency': {
        const parsed = Number(value());
        if (!Number.isInteger(parsed) || parsed < 1) throw new Error('--concurrency 需要正整数');
        options.concurrency = parsed;
        break;
      }
      case '--keep-work-dirs':
        options.keepWorkDirs = true;
        break;
      case '--help':
      case '-h':
        printHelp();
        process.exit(0);
        break;
      default:
        throw new Error(`未知参数：${arg}`);
    }
  }
  if (!options.inputFile) throw new Error('缺少 --input');
  if (!options.outDir) throw new Error('缺少 --out');
  return options as CliOptions;
}

function emit(event: WorkerEvent): void {
  // Never write free-form output to stdout: the orchestrator parses it as JSONL.
  process.stdout.write(`${encodeWorkerEvent(event)}\n`);
}

function logError(message: string): void {
  process.stderr.write(`${message}\n`);
}

function loadJob(file: string): RenderJobInputV1 {
  const raw = JSON.parse(readFileSync(file, 'utf8')) as unknown;
  const parsed = renderJobInputV1Schema.safeParse(raw);
  if (!parsed.success) {
    throw new RenderJobError(
      'invalid_input',
      `render-job 输入未通过 Schema 校验：${JSON.stringify(parsed.error.issues)}`,
      false,
    );
  }
  return parsed.data;
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const job = loadJob(options.inputFile);
  logError(
    `[render-job] ${job.jobId} · ${job.input.storyboard.scenes.length} 镜 · out=${path.relative(process.cwd(), options.outDir)}`,
  );

  const outcome = await runRenderJob({
    job,
    outDir: options.outDir,
    checkpointFile: options.checkpointFile,
    storageRefBase: options.storageRefBase,
    concurrency: options.concurrency,
    keepWorkDirs: options.keepWorkDirs,
    resumable: Boolean(options.checkpointFile),
    onEvent: (event) => {
      if (event.type === 'log') {
        logError(`[render-job] ${event.level} · ${event.message}`);
        return;
      }
      emit(event);
    },
  });

  if (options.checkpointFile) {
    // Keep the on-disk checkpoint consistent with what the orchestrator will
    // persist, even though the worker already wrote it incrementally.
    try {
      statSync(options.checkpointFile);
    } catch {
      // The orchestrator treats a missing checkpoint as a fresh job; nothing
      // to reconcile here.
    }
  }
  const checkpoint = options.checkpointFile
    ? renderCheckpointFileV1Schema.safeParse(
        JSON.parse(readFileSync(options.checkpointFile, 'utf8')) as unknown,
      )
    : null;

  emit({
    type: 'completed',
    receiptPath: path.join(options.outDir, 'receipt.json'),
    manifestPath: path.join(options.outDir, 'manifest.json'),
    outputPath: outcome.outputFile,
    outputSha256: outcome.receipt.sha256,
    byteSize: outcome.receipt.byteSize,
    at: new Date().toISOString(),
  });
  logError(
    `[render-job] 完成 · resume=${outcome.resumePoint} · phases=${
      checkpoint?.success ? checkpoint.data.phases.length : outcome.resumePoint === 'video_rendered' ? 'receipt' : '0'
    }`,
  );
}

main().catch((error: unknown) => {
  const code = error instanceof RenderJobError ? error.code : 'render_failed';
  const message = error instanceof Error ? error.message : String(error);
  emit({ type: 'failed', code, message, at: new Date().toISOString() });
  logError(message);
  if (error instanceof Error && error.stack) logError(error.stack);
  process.exitCode = 1;
});
