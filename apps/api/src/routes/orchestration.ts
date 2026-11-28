import { createReadStream } from 'node:fs';
import type { FastifyInstance, FastifyReply } from 'fastify';
import { z } from 'zod';
import {
  MAX_SPEECH_SPEED,
  MIN_SPEECH_SPEED,
  narrationTimingPolicySchema,
  orchestrationRunStatusSchema,
} from '@asvs/domain';
import type { OrchestrationServicePort } from '@asvs/ports';
import { fileSize } from '../orchestration/artifacts';
import { OrchestrationHttpError } from '../orchestration/errors';

const runLookupSchema = z.object({
  videoId: z.string().trim().min(1).max(200).optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
  status: orchestrationRunStatusSchema.optional(),
});

const createRunBodySchema = z.object({
  videoId: z.string().trim().min(1).max(200),
  idempotencyKey: z.string().trim().min(8).max(200),
  renderProfile: z
    .object({
      width: z.number().int().min(320).max(4096).optional(),
      height: z.number().int().min(180).max(4096).optional(),
      crf: z.number().int().min(0).max(51).optional(),
    })
    .optional(),
  // 5B: omitted means "narration on with server defaults". An explicit
  // `enabled: false` is the only way to request a silent render.
  narration: z
    .object({
      enabled: z.boolean().optional(),
      voiceId: z.string().trim().min(1).max(200).optional(),
      speed: z.number().min(MIN_SPEECH_SPEED).max(MAX_SPEECH_SPEED).optional(),
      timingPolicy: narrationTimingPolicySchema.optional(),
    })
    .optional(),
});

const createExportBodySchema = z.object({
  videoId: z.string().trim().min(1).max(200),
  runId: z.string().trim().min(1).max(200).optional(),
  approvalNote: z.string().trim().max(500).optional(),
});

const exportLookupSchema = z.object({
  videoId: z.string().trim().min(1).max(200).optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
});

const approveBodySchema = z.object({
  approvalId: z.string().trim().min(1).max(200),
  subjectDigest: z
    .string()
    .regex(/^[a-f0-9]{64}$/)
    .optional(),
});

function errorBody(code: string, message: string, details?: unknown) {
  return { error: { code, message, ...(details === undefined ? {} : { details }) } };
}

function sendOrchestrationError(reply: FastifyReply, error: unknown): void {
  if (error instanceof OrchestrationHttpError) {
    void reply.code(error.httpStatus).send(errorBody(error.code, error.message, error.details));
    return;
  }
  throw error;
}

/**
 * Routes for the 5A server-authoritative orchestrator. Paths are nested under
 * the workspace so every query is scoped by the same id the workspace PUT uses;
 * the service itself refuses cross-workspace reads.
 */
export function registerOrchestrationRoutes(
  app: FastifyInstance,
  service: OrchestrationServicePort,
): void {
  const base = '/v1/workspaces/:workspaceId/orchestration';

  app.post<{ Params: { workspaceId: string } }>(`${base}/runs`, async (request, reply) => {
    const body = createRunBodySchema.safeParse(request.body);
    if (!body.success) {
      return reply
        .code(400)
        .send(errorBody('invalid_request', '创建运行需要 videoId 与 idempotencyKey。', body.error.issues));
    }
    try {
      const result = await service.createRun(request.params.workspaceId, body.data);
      return reply.code(result.created ? 201 : 200).send(result);
    } catch (error) {
      return sendOrchestrationError(reply, error);
    }
  });

  app.get<{ Params: { workspaceId: string } }>(`${base}/runs`, async (request, reply) => {
    const query = runLookupSchema.safeParse(request.query);
    if (!query.success) {
      return reply
        .code(400)
        .send(errorBody('invalid_request', '查询参数无效。', query.error.issues));
    }
    const runs = await service.listRuns(request.params.workspaceId, {
      videoId: query.data.videoId,
      limit: query.data.limit,
    });
    const filtered = query.data.status
      ? runs.filter((run) => run.status === query.data.status)
      : runs;
    return { runs: filtered };
  });

  app.get<{ Params: { workspaceId: string; runId: string } }>(
    `${base}/runs/:runId`,
    async (request, reply) => {
      const detail = await service.getRun(request.params.workspaceId, request.params.runId);
      if (!detail) {
        return reply.code(404).send(errorBody('not_found', `运行 ${request.params.runId} 不存在。`));
      }
      return detail;
    },
  );

  app.post<{ Params: { workspaceId: string; runId: string } }>(
    `${base}/runs/:runId/cancel`,
    async (request, reply) => {
      try {
        const run = await service.cancelRun(request.params.workspaceId, request.params.runId);
        return { run };
      } catch (error) {
        return sendOrchestrationError(reply, error);
      }
    },
  );

  app.post<{ Params: { workspaceId: string; runId: string } }>(
    `${base}/runs/:runId/retry`,
    async (request, reply) => {
      try {
        const run = await service.retryRun(request.params.workspaceId, request.params.runId);
        return { run };
      } catch (error) {
        return sendOrchestrationError(reply, error);
      }
    },
  );

  app.post<{ Params: { workspaceId: string; runId: string } }>(
    `${base}/runs/:runId/approve`,
    async (request, reply) => {
      const body = approveBodySchema.safeParse(request.body);
      if (!body.success) {
        return reply.code(400).send(errorBody('invalid_request', '审批需要 approvalId。', body.error.issues));
      }
      try {
        const approval = await service.approveRun(
          request.params.workspaceId,
          request.params.runId,
          body.data,
        );
        return { approval };
      } catch (error) {
        return sendOrchestrationError(reply, error);
      }
    },
  );

  /**
   * Artifact download. `storageRef` is re-resolved under the artifact root and
   * traversal is refused; the ETag is the stored SHA256, so a client can
   * verify the bytes it received against the receipt. `.srt` keeps its exact
   * `application/x-subrip; charset=utf-8` type so players and editors open it
   * as subtitles rather than as a generic text download.
   */
  const downloadHandler = async (
    request: { params: { workspaceId: string; artifactId: string }; headers: Record<string, unknown> },
    reply: FastifyReply,
  ) => {
    const resolved = await service.resolveArtifactFile(
      request.params.workspaceId,
      request.params.artifactId,
    );
    if (!resolved) {
      return reply
        .code(404)
        .send(errorBody('not_found', `产物 ${request.params.artifactId} 不存在或文件已被清理。`));
    }
    const { artifact, file } = resolved;
    const etag = `"${artifact.sha256}"`;
    if (request.headers['if-none-match'] === etag) {
      return reply.code(304).send();
    }
    const mimeType =
      artifact.kind === 'subtitles_srt'
        ? 'application/x-subrip; charset=utf-8'
        : artifact.mimeType;
    reply.header('etag', etag);
    reply.header('x-content-sha256', artifact.sha256);
    reply.header('content-type', mimeType);
    reply.header('content-length', String(fileSize(file)));
    reply.header(
      'content-disposition',
      `attachment; filename="${artifact.fileName.replace(/["\\]/g, '_')}"`,
    );
    return reply.send(createReadStream(file));
  };

  app.get<{ Params: { workspaceId: string; artifactId: string } }>(
    `${base}/artifacts/:artifactId`,
    downloadHandler,
  );
  // Export bundles carry `downloadUrl`s with an explicit `/download` suffix so
  // the browser never guesses between JSON detail and binary download.
  app.get<{ Params: { workspaceId: string; artifactId: string } }>(
    `${base}/artifacts/:artifactId/download`,
    downloadHandler,
  );

  /**
   * Gate 3 bound export (AC-10). Refuses with 409 unless the video is approved
   * at the current scriptVersion and the run's artifacts still hash correctly.
   */
  app.post<{ Params: { workspaceId: string } }>(`${base}/exports`, async (request, reply) => {
    const body = createExportBodySchema.safeParse(request.body);
    if (!body.success) {
      return reply
        .code(400)
        .send(errorBody('invalid_request', '导出需要 videoId。', body.error.issues));
    }
    try {
      const bundle = await service.createExportBundle(request.params.workspaceId, body.data);
      return reply.code(201).send(bundle);
    } catch (error) {
      return sendOrchestrationError(reply, error);
    }
  });

  app.get<{ Params: { workspaceId: string } }>(`${base}/exports`, async (request, reply) => {
    const query = exportLookupSchema.safeParse(request.query);
    if (!query.success) {
      return reply
        .code(400)
        .send(errorBody('invalid_request', '查询参数无效。', query.error.issues));
    }
    const bundles = await service.listExportBundles(request.params.workspaceId, query.data);
    return { bundles };
  });

  app.get<{ Params: { workspaceId: string; videoId: string } }>(
    `${base}/videos/:videoId/latest-video-artifact`,
    async (request, reply) => {
      const found = service.findLatestSucceededVideo(
        request.params.workspaceId,
        request.params.videoId,
      );
      if (!found) {
        return reply.code(404).send(errorBody('not_found', '该视频还没有服务端渲染产物。'));
      }
      // Path-form URL so the browser can use it directly as an `<a download>`.
      return {
        run: found.run,
        artifact: found.artifact,
        downloadUrl: `${base.replace(':workspaceId', request.params.workspaceId)}/artifacts/${found.artifact.id}`,
      };
    },
  );
}
