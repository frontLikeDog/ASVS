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
import type { GitHubReadOnlyPort, KnowledgeIndexPort } from '@asvs/ports';
import type { DatabaseSync } from 'node:sqlite';
import { openDatabase } from './db/database';
import { SqliteKnowledgeSnapshotStore } from './db/knowledge-store';
import { SqliteWorkspaceStore } from './db/workspace-store';
import { UnconfiguredGitHubReadOnlyClient } from './github/github-app-client';
import { GitHubApiError } from './github/redact';
import { GitHubKnowledgeIndexer } from './knowledge/indexer';
import { registerGitHubRoutes } from './routes/github';
import { registerKnowledgeRoutes } from './routes/knowledge';

export interface BuildAppOptions {
  dbPath: string;
  corsOrigins?: string[];
  logger?: boolean | { level: string };
  github?: GitHubReadOnlyPort;
  /** Defaults to a GitHub-backed indexer over the same SQLite file. */
  knowledgeIndexer?: KnowledgeIndexPort;
}

export interface BuiltApp {
  app: FastifyInstance;
  db: DatabaseSync;
  store: SqliteWorkspaceStore;
  knowledgeStore: SqliteKnowledgeSnapshotStore;
  knowledgeIndexer: KnowledgeIndexPort;
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
  const app = Fastify({
    logger: options.logger ?? false,
    bodyLimit: 8 * 1024 * 1024,
  });

  await app.register(cors, {
    origin: options.corsOrigins ?? true,
  });

  app.addHook('onClose', async () => {
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
    if (error instanceof ZodError) {
      return reply
        .code(400)
        .send(errorBody('invalid_workspace', '工作区数据未通过 Schema 校验。', error.issues));
    }
    request.log.error(error);
    return reply.code(500).send(errorBody('internal_error', '服务器处理请求时发生错误。'));
  });

  app.get('/v1/health', async () => ({
    ok: true,
    service: 'asvs-api',
    storage: 'sqlite',
    schemaVersion: STUDIO_SNAPSHOT_VERSION,
    githubConfigured: github.isConfigured(),
  }));

  registerGitHubRoutes(app, github);
  registerKnowledgeRoutes(app, knowledgeIndexer);

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

  return { app, db, store, knowledgeStore, knowledgeIndexer };
}

/** Convenience for the entrypoint: build and return only the server. */
export async function createApp(options: BuildAppOptions): Promise<FastifyInstance> {
  return (await buildApp(options)).app;
}
