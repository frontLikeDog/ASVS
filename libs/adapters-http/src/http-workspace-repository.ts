import {
  STUDIO_SNAPSHOT_VERSION,
  productionRunSchema,
  workspaceRecordSchema,
} from '@asvs/domain';
import type { ProductionRun, StudioSnapshot, WorkspaceRecord } from '@asvs/domain';
import type {
  ProductionRunRepository,
  WorkspaceRepository,
  WorkspaceSaveInput,
  WorkspaceSaveResult,
} from '@asvs/ports';

export interface HttpWorkspaceRepositoryOptions {
  /** Same-origin `/api` by default; Vite proxies it to the Fastify server. */
  baseUrl?: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

export class WorkspaceHttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'WorkspaceHttpError';
  }
}

function trimTrailingSlash(value: string): string {
  return value.replace(/\/+$/, '');
}

async function readError(response: Response): Promise<WorkspaceHttpError> {
  let code = `http_${response.status}`;
  let message = `请求失败（HTTP ${response.status}）`;
  try {
    const body = (await response.json()) as {
      error?: { code?: string; message?: string };
      message?: string;
    };
    if (body.error?.code) code = body.error.code;
    if (body.error?.message ?? body.message) message = body.error?.message ?? body.message!;
  } catch {
    // Keep the status-based message when the body is not JSON.
  }
  return new WorkspaceHttpError(response.status, code, message);
}

function parseRecord(value: unknown): WorkspaceRecord {
  return workspaceRecordSchema.parse(value);
}

export class HttpWorkspaceRepository
  implements WorkspaceRepository, ProductionRunRepository
{
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;

  constructor(options: HttpWorkspaceRepositoryOptions = {}) {
    this.baseUrl = trimTrailingSlash(options.baseUrl ?? '/api');
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch.bind(globalThis);
    this.timeoutMs = options.timeoutMs ?? 10_000;
  }

  private url(path: string): string {
    return `${this.baseUrl}${path}`;
  }

  private request(path: string, init: RequestInit = {}): Promise<Response> {
    return this.fetchImpl(this.url(path), {
      ...init,
      headers: { accept: 'application/json', ...init.headers },
      signal: this.timeoutMs > 0 ? AbortSignal.timeout(this.timeoutMs) : undefined,
    });
  }

  async load(workspaceId: string): Promise<WorkspaceRecord | null> {
    const response = await this.request(`/v1/workspaces/${encodeURIComponent(workspaceId)}`);
    if (response.status === 404) return null;
    if (!response.ok) throw await readError(response);
    return parseRecord(await response.json());
  }

  async save(
    workspaceId: string,
    input: WorkspaceSaveInput,
  ): Promise<WorkspaceSaveResult> {
    const response = await this.request(`/v1/workspaces/${encodeURIComponent(workspaceId)}`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        schemaVersion: STUDIO_SNAPSHOT_VERSION,
        baseRevision: input.baseRevision,
        workspace: input.workspace,
      }),
    });

    if (response.status === 409) {
      const body = (await response.json().catch(() => ({}))) as { current?: unknown };
      return {
        ok: false,
        conflict: body.current ? parseRecord(body.current) : null,
      };
    }
    if (!response.ok) throw await readError(response);
    return { ok: true, record: parseRecord(await response.json()) };
  }

  async list(workspaceId: string): Promise<ProductionRun[]> {
    const response = await this.request(
      `/v1/workspaces/${encodeURIComponent(workspaceId)}/production-runs`,
    );
    if (!response.ok) throw await readError(response);
    const body = (await response.json()) as { runs?: unknown };
    if (!Array.isArray(body.runs)) throw new WorkspaceHttpError(500, 'invalid_response', '缺少 runs 数组。');
    return body.runs.map((run) => productionRunSchema.parse(run));
  }

  async get(workspaceId: string, runId: string): Promise<ProductionRun | null> {
    const response = await this.request(
      `/v1/workspaces/${encodeURIComponent(workspaceId)}/production-runs/${encodeURIComponent(runId)}`,
    );
    if (response.status === 404) return null;
    if (!response.ok) throw await readError(response);
    return productionRunSchema.parse(await response.json());
  }
}

export type { StudioSnapshot };
