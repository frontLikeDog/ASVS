import path from 'node:path';
import Fastify, { type FastifyInstance } from 'fastify';
import cors from '@fastify/cors';
import { ZodError, z } from 'zod';
import {
  STUDIO_SNAPSHOT_VERSION,
  WorkspaceImportError,
  buildWorkspaceExport,
  normalizeWorkspacePayload,
  workspaceExportFileName,
  workspacePutRequestSchema,
} from '@asvs/domain';
import type {
  GitHubReadOnlyPort,
  KnowledgeIndexPort,
  PRDiscoveryPort,
  SpeechHealth,
  SpeechRuntimeConfig,
} from '@asvs/ports';
import type { DatabaseSync } from 'node:sqlite';
import type { OrchestrationServicePort, RenderJobExecutorPort } from '@asvs/ports';
import { loadSpeechConfig } from './config';
import { openDatabase } from './db/database';
import { ExportBundleStore } from './db/export-bundle-store';
import { SqliteOrchestrationStore } from './db/orchestration-store';
import { Orchestrator } from './orchestration/orchestrator';
import { RenderProcessExecutor } from './orchestration/render-process-executor';
import { registerOrchestrationRoutes } from './routes/orchestration';
import {
  SpeechCacheStore,
  SpeechService,
  createSpeechPort,
  speechAudioRoot,
} from './speech';
import type { SpeechServiceOptions } from './speech/speech-service';
import { SqliteKnowledgeSnapshotStore } from './db/knowledge-store';
import { SqlitePRDiscoveryStore } from './db/pr-discovery-store';
import { SqliteWorkspaceStore } from './db/workspace-store';
import { UnconfiguredGitHubReadOnlyClient } from './github/github-app-client';
import { GitHubApiError } from './github/redact';
import { OrchestrationHttpError } from './orchestration/errors';
import { GitHubKnowledgeIndexer } from './knowledge/indexer';
import { PRDiscoveryError, PRDiscoveryService } from './knowledge/pr-discovery-service';
import { registerGitHubRoutes } from './routes/github';
import { registerKnowledgeRoutes } from './routes/knowledge';
import { registerPRDiscoveryRoutes } from './routes/pr-discovery';

export interface BuildAppOptions {
  dbPath: string;
  corsOrigins?: string[];
  logger?: boolean | { level: string };
  github?: GitHubReadOnlyPort;
  /** Defaults to a GitHub-backed indexer over the same SQLite file. */
  knowledgeIndexer?: KnowledgeIndexPort;
  /** Defaults to a deterministic service over GitHub + 4B snapshots + SQLite. */
  prDiscovery?: PRDiscoveryPort;
  /** Root for server-rendered MP4/manifest/receipt artifacts. */
  artifactDir?: string;
  /** Defaults to a real child-process render worker; tests inject a fake. */
  renderExecutor?: RenderJobExecutorPort;
  /** Defaults to `buildApp`'s own directory-relative repository root. */
  mediaRoot?: string;
  maxAttempts?: number;
  leaseTtlMs?: number;
  schedulerIntervalMs?: number;
  /** Test hook: pin the instance id and clock used for lease recovery. */
  orchestrationInstanceId?: string;
  orchestrationNow?: () => Date;
  /**
   * Narration synthesis (5B). Defaults to a service over the configured
   * `SpeechRuntimeConfig`; tests inject a deterministic adapter or null.
   */
  speechService?: SpeechService | null;
  /** Overrides `ASVS_TTS_*` env when building the default speech service. */
  speechConfig?: SpeechRuntimeConfig;
}

export interface BuiltApp {
  app: FastifyInstance;
  db: DatabaseSync;
  store: SqliteWorkspaceStore;
  knowledgeStore: SqliteKnowledgeSnapshotStore;
  knowledgeIndexer: KnowledgeIndexPort;
  prDiscoveryStore: SqlitePRDiscoveryStore;
  prDiscovery: PRDiscoveryPort;
  orchestrationStore: SqliteOrchestrationStore;
  orchestration: OrchestrationServicePort;
  orchestrator: Orchestrator;
  exportStore: ExportBundleStore;
  speech: SpeechService | null;
  speechHealth: SpeechHealth;
}

const workspaceIdSchema = z.string().regex(/^[A-Za-z0-9_-]{1,64}$/, 'workspace id 只能包含字母、数字、_ 与 -');

function errorBody(code: string, message: string, details?: unknown) {
  return { error: { code, message, ...(details === undefined ? {} : { details }) } };
}

function parseWorkspaceId(id: string): string | null {
  const parsed = workspaceIdSchema.safeParse(id);
  return parsed.success ? parsed.data : null;
}

/**
 * Builds the Fastify instance without listening, so tests can use
 * `app.inject()` and the entrypoint can own signals/ports.
 */
export async function buildApp(options: BuildAppOptions): Promise<BuiltApp> {
  const db = openDatabase(options.dbPath);
  const store = new SqliteWorkspaceStore(db);
  const github = options.github ?? new UnconfiguredGitHubReadOnlyClient();
  const knowledgeStore = new SqliteKnowledgeSnapshotStore(db);
  const knowledgeIndexer =
    options.knowledgeIndexer ??
    new GitHubKnowledgeIndexer({ github, store: knowledgeStore });
  const prDiscoveryStore = new SqlitePRDiscoveryStore(db);
  const prDiscovery =
    options.prDiscovery ??
    new PRDiscoveryService({ github, knowledgeStore, store: prDiscoveryStore });
  const orchestrationStore = new SqliteOrchestrationStore(db);
  const exportStore = new ExportBundleStore(db);
  const artifactDir =
    options.artifactDir ?? path.resolve(path.dirname(options.dbPath), 'artifacts');
  const speech =
    options.speechService === undefined
      ? createDefaultSpeechService(db, artifactDir, options.speechConfig)
      : options.speechService;
  const orchestrator = new Orchestrator({
    store: orchestrationStore,
    artifactDir,
    mediaRoot: options.mediaRoot,
    loadWorkspace: (workspaceId) => store.get(workspaceId)?.workspace ?? null,
    executor: options.renderExecutor ?? new RenderProcessExecutor(),
    speech,
    exportStore,
    maxAttempts: options.maxAttempts,
    leaseTtlMs: options.leaseTtlMs,
    schedulerIntervalMs: options.schedulerIntervalMs,
    instanceId: options.orchestrationInstanceId,
    now: options.orchestrationNow,
  });
  const app = Fastify({
    logger: options.logger ?? false,
    bodyLimit: 8 * 1024 * 1024,
  });

  await app.register(cors, {
    origin: options.corsOrigins ?? true,
  });

  app.addHook('onClose', async () => {
    // Stop the scheduler and let any render child exit before the DB closes.
    await orchestrator.stop();
    db.close();
  });

  app.setErrorHandler((error, request, reply) => {
    if (error instanceof GitHubApiError) {
      return reply
        .code(error.httpStatus)
        .send(errorBody(error.code, error.message, error.details));
    }
    if (error instanceof WorkspaceImportError) {
      return reply.code(400).send(errorBody('invalid_workspace', error.message));
    }
    if (error instanceof PRDiscoveryError) {
      return reply.code(error.httpStatus).send(errorBody(error.code, error.message));
    }
    if (error instanceof OrchestrationHttpError) {
      return reply
        .code(error.httpStatus)
        .send(errorBody(error.code, error.message, error.details));
    }
    if (error instanceof ZodError) {
      return reply
        .code(400)
        .send(errorBody('invalid_workspace', '工作区数据未通过 Schema 校验。', error.issues));
    }
    request.log.error(error);
    return reply.code(500).send(errorBody('internal_error', '服务器处理请求时发生错误。'));
  });

  const speechHealth = orchestrator.speechHealth();
  app.get('/v1/health', async () => ({
    ok: true,
    service: 'asvs-api',
    storage: 'sqlite',
    schemaVersion: STUDIO_SNAPSHOT_VERSION,
    githubConfigured: github.isConfigured(),
    orchestrationReady: true,
    // `configured: false` is the fail-closed signal the UI uses to tell the
    // reviewer narration is unavailable — never to fake it.
    tts: speechHealth,
  }));

  registerGitHubRoutes(app, github);
  registerKnowledgeRoutes(app, knowledgeIndexer);
  registerPRDiscoveryRoutes(app, prDiscovery);
  registerOrchestrationRoutes(app, orchestrator);

  app.get<{ Params: { id: string } }>('/v1/workspaces/:id', async (request, reply) => {
    const id = parseWorkspaceId(request.params.id);
    if (!id) return reply.code(400).send(errorBody('invalid_workspace_id', '工作区 ID 无效。'));

    const record = store.get(id);
    if (!record) {
      return reply.code(404).send(errorBody('not_found', `工作区 ${id} 不存在。`));
    }
    return record;
  });

  app.put<{ Params: { id: string } }>('/v1/workspaces/:id', async (request, reply) => {
    const id = parseWorkspaceId(request.params.id);
    if (!id) return reply.code(400).send(errorBody('invalid_workspace_id', '工作区 ID 无效。'));

    const body = workspacePutRequestSchema.safeParse(request.body);
    if (!body.success) {
      return reply
        .code(400)
        .send(errorBody('invalid_request', '请求体必须包含 workspace 与 baseRevision。', body.error.issues));
    }

    const normalized = normalizeWorkspacePayload({
      // An omitted version means "current client", not legacy data: only an
      // explicit lower number should trigger the migration chain.
      schemaVersion: body.data.schemaVersion ?? STUDIO_SNAPSHOT_VERSION,
      workspace: body.data.workspace,
    });
    const result = store.put(id, {
      workspace: normalized.workspace,
      baseRevision: body.data.baseRevision,
    });

    if (!result.ok) {
      return reply.code(409).send({
        ...errorBody(
          'revision_conflict',
          '工作区已被其他客户端修改；请拉取最新版本后重试。',
        ),
        current: result.conflict,
      });
    }

    return result.record;
  });

  app.get<{ Params: { id: string } }>('/v1/workspaces/:id/export', async (request, reply) => {
    const id = parseWorkspaceId(request.params.id);
    if (!id) return reply.code(400).send(errorBody('invalid_workspace_id', '工作区 ID 无效。'));

    const record = store.get(id);
    if (!record) {
      return reply.code(404).send(errorBody('not_found', `工作区 ${id} 不存在。`));
    }

    const exportedAt = new Date().toISOString();
    reply.header('content-type', 'application/json; charset=utf-8');
    reply.header(
      'content-disposition',
      `attachment; filename="${workspaceExportFileName(exportedAt)}"`,
    );
    return buildWorkspaceExport(record.workspace, exportedAt);
  });

  app.get<{ Params: { id: string } }>(
    '/v1/workspaces/:id/production-runs',
    async (request, reply) => {
      const id = parseWorkspaceId(request.params.id);
      if (!id) return reply.code(400).send(errorBody('invalid_workspace_id', '工作区 ID 无效。'));

      if (!store.get(id)) {
        return reply.code(404).send(errorBody('not_found', `工作区 ${id} 不存在。`));
      }
      return { runs: store.listRuns(id) };
    },
  );

  app.get<{ Params: { id: string; runId: string } }>(
    '/v1/workspaces/:id/production-runs/:runId',
    async (request, reply) => {
      const id = parseWorkspaceId(request.params.id);
      if (!id) return reply.code(400).send(errorBody('invalid_workspace_id', '工作区 ID 无效。'));

      const run = store.getRun(id, request.params.runId);
      if (!run) {
        return reply.code(404).send(errorBody('not_found', `生产运行 ${request.params.runId} 不存在。`));
      }
      return run;
    },
  );

  await orchestrator.start();

  return {
    app,
    db,
    store,
    knowledgeStore,
    knowledgeIndexer,
    prDiscoveryStore,
    prDiscovery,
    orchestrationStore,
    orchestration: orchestrator,
    orchestrator,
    exportStore,
    speech,
    speechHealth,
  };
}

/**
 * Builds the speech stack from environment config. `unconfigured` yields a
 * service whose `isConfigured()` is false, so narration requests fail closed
 * (503) instead of silently rendering silence.
 */
function createDefaultSpeechService(
  db: DatabaseSync,
  artifactDir: string,
  config?: SpeechRuntimeConfig,
): SpeechService {
  const resolved = config ?? loadSpeechConfig(process.env);
  return new SpeechService({
    port: createSpeechPort(resolved),
    cache: new SpeechCacheStore(db),
    audioRoot: speechAudioRoot(artifactDir),
  } satisfies SpeechServiceOptions);
}

/** Convenience for the entrypoint: build and return only the server. */
export async function createApp(options: BuildAppOptions): Promise<FastifyInstance> {
  return (await buildApp(options)).app;
}
