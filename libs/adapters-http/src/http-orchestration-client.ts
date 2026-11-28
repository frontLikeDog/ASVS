import { z } from 'zod';
import {
  exportBundleDetailV1Schema,
  orchestrationApprovalV1Schema,
  orchestrationArtifactV1Schema,
  orchestrationRunDetailV1Schema,
  orchestrationRunV1Schema,
  qaReportV1Schema,
  type ExportBundleDetailV1,
  type OrchestrationArtifactKind,
  type OrchestrationRunDetailV1,
  type OrchestrationRunV1,
} from '@asvs/domain';
import type {
  CreateExportBundleInput,
  CreateOrchestrationRunRequest,
  CreateOrchestrationRunResponse,
  ExportBundleListOptions,
  ListOrchestrationRunsQuery,
  OrchestrationClientPort,
  UpdateDemoPlanRequest,
} from '@asvs/ports';

export interface HttpOrchestrationClientOptions {
  /** Same-origin `/api` by default; Vite proxies it to the Fastify server. */
  baseUrl?: string;
  fetchImpl?: typeof fetch;
  /** Listing/detail/cancel are fast; rendering itself is polled separately. */
  timeoutMs?: number;
}

export class OrchestrationHttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = 'OrchestrationHttpError';
  }
}

const createRunResponseSchema = z.object({
  run: orchestrationRunV1Schema,
  created: z.boolean(),
});

const runListResponseSchema = z.object({
  runs: z.array(orchestrationRunV1Schema),
});

const runEnvelopeSchema = z.object({ run: orchestrationRunV1Schema });

const approvalEnvelopeSchema = z.object({ approval: orchestrationApprovalV1Schema });

const updateDemoPlanResponseSchema = z.object({
  approval: orchestrationApprovalV1Schema,
  run: orchestrationRunV1Schema.nullable().optional(),
});

const latestArtifactResponseSchema = z.object({
  run: orchestrationRunV1Schema,
  artifact: orchestrationArtifactV1Schema,
  downloadUrl: z.string().min(1),
});

/**
 * Step 5D report envelope. Both QA routes return it; the report itself is
 * re-validated by `qaReportV1Schema`, so a server bug cannot hand the UI a
 * `pass` verdict with blockers in it.
 */
const qaReportResponseSchema = z.object({
  run: orchestrationRunV1Schema,
  report: qaReportV1Schema,
  reportArtifact: orchestrationArtifactV1Schema,
  evidenceArtifacts: z.array(orchestrationArtifactV1Schema),
});

const exportBundleListResponseSchema = z.object({
  bundles: z.array(exportBundleDetailV1Schema),
});

// `/v1/health` is intentionally permissive about unknown fields but requires
// the `tts` block so the UI can render an honest "narration unavailable" state.
const healthResponseSchema = z.object({
  ok: z.boolean().optional(),
  orchestrationReady: z.boolean().optional(),
  tts: z.object({
    configured: z.boolean(),
    provider: z.string(),
    model: z.string().optional(),
    synthetic: z.boolean(),
    license: z.string(),
  }),
  // Absent on a pre-5C server; the UI then treats capture as unavailable
  // rather than assuming it works (fail closed).
  capture: z
    .object({
      enabled: z.boolean(),
      allowedOrigins: z.array(z.string()),
      defaultBaseUrl: z.string(),
      allowAutoServe: z.boolean(),
      policyVersion: z.string(),
    })
    .optional(),
  // Absent on a pre-5D server; `ocrConfigured: false` means image privacy
  // scanning fails closed, which the review page must say out loud.
  qa: z
    .object({
      enabled: z.boolean(),
      ocrProvider: z.string(),
      ocrConfigured: z.boolean(),
      policyVersion: z.string(),
    })
    .optional(),
});

function trimTrailingSlash(value: string): string {
  return value.replace(/\/+$/, '');
}

function workspaceBase(workspaceId: string): string {
  return `/v1/workspaces/${encodeURIComponent(workspaceId)}/orchestration`;
}

async function readError(response: Response): Promise<OrchestrationHttpError> {
  let code = `http_${response.status}`;
  let message = `请求失败（HTTP ${response.status}）`;
  let details: unknown;
  try {
    const body = (await response.json()) as {
      error?: { code?: string; message?: string; details?: unknown };
    };
    if (body.error?.code) code = body.error.code;
    if (body.error?.message) message = body.error.message;
    if (body.error?.details !== undefined) details = body.error.details;
  } catch {
    // Keep the status-based fallback when the body is not JSON.
  }
  return new OrchestrationHttpError(response.status, code, message, details);
}

/**
 * Browser adapter over the 5A orchestration routes. Loaded lazily by
 * `libs/state/src/orchestration.ts`, so it never lands in the initial bundle.
 *
 * Every response is re-validated against the shared `@asvs/domain` contracts —
 * the server is authoritative, but the browser must not render a shape it does
 * not understand.
 */
export class HttpOrchestrationClient implements OrchestrationClientPort {
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;

  constructor(options: HttpOrchestrationClientOptions = {}) {
    this.baseUrl = trimTrailingSlash(options.baseUrl ?? '/api');
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch.bind(globalThis);
    this.timeoutMs = options.timeoutMs ?? 15_000;
  }

  private url(workspaceId: string, suffix: string): string {
    return `${this.baseUrl}${workspaceBase(workspaceId)}${suffix}`;
  }

  private async request(path: string, init: RequestInit = {}): Promise<Response> {
    let response: Response;
    try {
      response = await this.fetchImpl(path, {
        ...init,
        headers: {
          accept: 'application/json',
          ...(init.body ? { 'content-type': 'application/json' } : {}),
          ...(init.headers as Record<string, string> | undefined),
        },
        signal: this.timeoutMs > 0 ? AbortSignal.timeout(this.timeoutMs) : undefined,
      });
    } catch (error) {
      if (error instanceof DOMException && error.name === 'TimeoutError') {
        throw new OrchestrationHttpError(
          0,
          'request_timeout',
          '请求本机编排服务超时，请稍后重试。',
        );
      }
      throw new OrchestrationHttpError(
        0,
        'api_unreachable',
        '无法连接本机 ASVS API（请先运行 pnpm dev:api 或 pnpm dev:stack）。',
      );
    }
    return response;
  }

  async createRun(
    workspaceId: string,
    input: CreateOrchestrationRunRequest,
  ): Promise<CreateOrchestrationRunResponse> {
    const response = await this.request(this.url(workspaceId, '/runs'), {
      method: 'POST',
      body: JSON.stringify(input),
    });
    if (!response.ok) throw await readError(response);
    return createRunResponseSchema.parse(await response.json());
  }

  async listRuns(
    workspaceId: string,
    options: ListOrchestrationRunsQuery = {},
  ): Promise<OrchestrationRunV1[]> {
    const search = new URLSearchParams();
    if (options.videoId) search.set('videoId', options.videoId);
    const query = search.toString();
    const response = await this.request(
      this.url(workspaceId, `/runs${query ? `?${query}` : ''}`),
    );
    if (!response.ok) throw await readError(response);
    return runListResponseSchema.parse(await response.json()).runs;
  }

  async getRun(
    workspaceId: string,
    runId: string,
  ): Promise<OrchestrationRunDetailV1 | null> {
    const response = await this.request(
      this.url(workspaceId, `/runs/${encodeURIComponent(runId)}`),
    );
    if (response.status === 404) return null;
    if (!response.ok) throw await readError(response);
    return orchestrationRunDetailV1Schema.parse(await response.json());
  }

  async cancelRun(workspaceId: string, runId: string): Promise<OrchestrationRunV1> {
    const response = await this.request(
      this.url(workspaceId, `/runs/${encodeURIComponent(runId)}/cancel`),
      { method: 'POST' },
    );
    if (!response.ok) throw await readError(response);
    return runEnvelopeSchema.parse(await response.json()).run;
  }

  async retryRun(workspaceId: string, runId: string): Promise<OrchestrationRunV1> {
    const response = await this.request(
      this.url(workspaceId, `/runs/${encodeURIComponent(runId)}/retry`),
      { method: 'POST' },
    );
    if (!response.ok) throw await readError(response);
    return runEnvelopeSchema.parse(await response.json()).run;
  }

  async approveRun(
    workspaceId: string,
    runId: string,
    input: { approvalId: string; subjectDigest: string; note?: string },
  ) {
    const response = await this.request(
      this.url(workspaceId, `/runs/${encodeURIComponent(runId)}/approve`),
      { method: 'POST', body: JSON.stringify(input) },
    );
    if (!response.ok) throw await readError(response);
    return approvalEnvelopeSchema.parse(await response.json()).approval;
  }

  async rejectRun(
    workspaceId: string,
    runId: string,
    input: { approvalId: string; reason?: string },
  ) {
    const response = await this.request(
      this.url(workspaceId, `/runs/${encodeURIComponent(runId)}/reject`),
      { method: 'POST', body: JSON.stringify(input) },
    );
    if (!response.ok) throw await readError(response);
    return approvalEnvelopeSchema.parse(await response.json()).approval;
  }

  async updateDemoPlan(
    workspaceId: string,
    runId: string,
    input: UpdateDemoPlanRequest,
  ) {
    const response = await this.request(
      this.url(workspaceId, `/runs/${encodeURIComponent(runId)}/demo-plan`),
      { method: 'PUT', body: JSON.stringify(input) },
    );
    if (!response.ok) throw await readError(response);
    return updateDemoPlanResponseSchema.parse(await response.json()).approval;
  }

  artifactDownloadUrl(
    workspaceId: string,
    artifactId: string,
    _kind?: OrchestrationArtifactKind,
  ): string {
    void _kind;
    return this.url(workspaceId, `/artifacts/${encodeURIComponent(artifactId)}/download`);
  }

  artifactInlineUrl(workspaceId: string, artifactId: string): string {
    return this.url(workspaceId, `/artifacts/${encodeURIComponent(artifactId)}?inline=1`);
  }

  async createExportBundle(
    workspaceId: string,
    input: CreateExportBundleInput,
  ): Promise<ExportBundleDetailV1> {
    const response = await this.request(this.url(workspaceId, '/exports'), {
      method: 'POST',
      body: JSON.stringify(input),
    });
    if (!response.ok) throw await readError(response);
    return exportBundleDetailV1Schema.parse(await response.json());
  }

  async listExportBundles(
    workspaceId: string,
    options: ExportBundleListOptions = {},
  ): Promise<ExportBundleDetailV1[]> {
    const search = new URLSearchParams();
    if (options.videoId) search.set('videoId', options.videoId);
    if (options.limit) search.set('limit', String(options.limit));
    const query = search.toString();
    const response = await this.request(
      this.url(workspaceId, `/exports${query ? `?${query}` : ''}`),
    );
    if (!response.ok) throw await readError(response);
    return exportBundleListResponseSchema.parse(await response.json()).bundles;
  }

  /** Latest succeeded run's MP4 for a video, plus its download URL. */
  async getLatestVideoArtifact(
    workspaceId: string,
    videoId: string,
  ): Promise<z.infer<typeof latestArtifactResponseSchema> | null> {
    const response = await this.request(
      this.url(workspaceId, `/videos/${encodeURIComponent(videoId)}/latest-video-artifact`),
    );
    if (response.status === 404) return null;
    if (!response.ok) throw await readError(response);
    return latestArtifactResponseSchema.parse(await response.json());
  }

  async getRunQaReport(
    workspaceId: string,
    runId: string,
    stage?: 'capture' | 'final',
  ): Promise<z.infer<typeof qaReportResponseSchema> | null> {
    const query = stage ? `?stage=${stage}` : '';
    const response = await this.request(
      this.url(workspaceId, `/runs/${encodeURIComponent(runId)}/qa-report${query}`),
    );
    if (response.status === 404) return null;
    if (!response.ok) throw await readError(response);
    return qaReportResponseSchema.parse(await response.json());
  }

  async getLatestQaReport(
    workspaceId: string,
    videoId: string,
  ): Promise<z.infer<typeof qaReportResponseSchema> | null> {
    const response = await this.request(
      this.url(workspaceId, `/videos/${encodeURIComponent(videoId)}/latest-qa-report`),
    );
    if (response.status === 404) return null;
    if (!response.ok) throw await readError(response);
    return qaReportResponseSchema.parse(await response.json());
  }

  async getHealth(): Promise<{
    configured: boolean;
    provider: string;
    synthetic: boolean;
    license: string;
    capture?: {
      enabled: boolean;
      allowedOrigins: string[];
      defaultBaseUrl: string;
      allowAutoServe: boolean;
      policyVersion: string;
    };
    qa?: {
      enabled: boolean;
      ocrProvider: string;
      ocrConfigured: boolean;
      policyVersion: string;
    };
  }> {
    const response = await this.fetchImpl(`${this.baseUrl}/v1/health`, {
      signal: AbortSignal.timeout(5_000),
    });
    if (!response.ok) throw await readError(response);
    const body = healthResponseSchema.parse(await response.json());
    return {
      configured: body.tts.configured,
      provider: body.tts.provider,
      synthetic: body.tts.synthetic,
      license: body.tts.license,
      ...(body.capture ? { capture: body.capture } : {}),
      ...(body.qa ? { qa: body.qa } : {}),
    };
  }

  async isReachable(): Promise<boolean> {
    try {
      const response = await this.fetchImpl(`${this.baseUrl}/v1/health`, {
        signal: AbortSignal.timeout(2_000),
      });
      if (!response.ok) return false;
      const body = (await response.json()) as { orchestrationReady?: boolean };
      return body.orchestrationReady === true;
    } catch {
      return false;
    }
  }
}
