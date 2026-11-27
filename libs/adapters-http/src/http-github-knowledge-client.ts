import { z } from 'zod';
import {
  claimCandidateV1Schema,
  claimVerificationInputV1Schema,
  claimVerificationRecordV1Schema,
  formatGitHubRepoRef,
  githubConnectionStatusSchema,
  githubRepositoryMetadataSchema,
  githubWriteProbeResultSchema,
  knowledgeSnapshotSummaryV1Schema,
  knowledgeSnapshotV1Schema,
  prChangeCandidateV1Schema,
  prDiscoveryReportV1Schema,
  stalenessRefreshResultV1Schema,
  type ClaimCandidateV1,
  type ClaimVerificationInputV1,
  type ClaimVerificationRecordV1,
  type GitHubConnectionStatus,
  type GitHubRepoRef,
  type GitHubRepositoryMetadata,
  type GitHubWriteProbeResult,
  type KnowledgeSnapshotSummaryV1,
  type KnowledgeSnapshotV1,
  type PRChangeCandidateV1,
  type PRDiscoveryReportV1,
  type StalenessRefreshResultV1,
} from '@asvs/domain';
import type {
  AnalyzePullRequestsOptions,
  GitHubKnowledgeClientPort,
  IndexRepositoryOptions,
  ListKnowledgeSnapshotsOptions,
  ListPRCandidatesOptions,
  RefreshStalenessOptions,
} from '@asvs/ports';

export interface HttpGitHubKnowledgeClientOptions {
  /** Same-origin `/api` by default; Vite proxies it to the Fastify server. */
  baseUrl?: string;
  fetchImpl?: typeof fetch;
  /** Standard request timeout in ms (status, listing, verification). */
  timeoutMs?: number;
  /** Extended timeout in ms for cold repo indexing & PR discovery. */
  longTimeoutMs?: number;
}

export class KnowledgeHttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = 'KnowledgeHttpError';
  }
}

const indexResponseSchema = z.object({
  repo: z.string(),
  snapshot: knowledgeSnapshotV1Schema,
});

const listSnapshotsResponseSchema = z.object({
  repo: z.string(),
  count: z.number().int().min(0),
  snapshots: z.array(knowledgeSnapshotSummaryV1Schema),
});

const discoverResponseSchema = z.object({
  repo: z.string(),
  report: prDiscoveryReportV1Schema,
});

const listCandidatesResponseSchema = z.object({
  repo: z.string(),
  count: z.number().int().min(0),
  candidates: z.array(prChangeCandidateV1Schema),
});

const verifyClaimResponseSchema = z.object({
  claim: claimCandidateV1Schema,
});

const listVerificationsResponseSchema = z.object({
  repo: z.string(),
  claimId: z.string(),
  count: z.number().int().min(0),
  verifications: z.array(claimVerificationRecordV1Schema),
});

function trimTrailingSlash(value: string): string {
  return value.replace(/\/+$/, '');
}

function repoBasePath(repo: GitHubRepoRef): string {
  return `/v1/github/repos/${encodeURIComponent(repo.owner)}/${encodeURIComponent(repo.repo)}`;
}

function buildQuery(params: Record<string, string | number | undefined>): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== '') {
      search.set(key, String(value));
    }
  }
  const encoded = search.toString();
  return encoded ? `?${encoded}` : '';
}

async function readKnowledgeError(response: Response): Promise<KnowledgeHttpError> {
  let code = `http_${response.status}`;
  let message = `请求失败（HTTP ${response.status}）`;
  let details: unknown;
  try {
    const body = (await response.json()) as {
      error?: { code?: string; message?: string; details?: unknown };
      message?: string;
    };
    if (body.error?.code) code = body.error.code;
    if (body.error?.message ?? body.message) message = body.error?.message ?? body.message!;
    if (body.error?.details !== undefined) details = body.error.details;
  } catch {
    // Keep the status-based fallback when body is not JSON.
  }
  return new KnowledgeHttpError(response.status, code, message, details);
}

/**
 * HTTP adapter implementing `GitHubKnowledgeClientPort` over `apps/api`'s
 * Step 4A/4B/4C routes. Validates every response against `@asvs/domain` Zod
 * contracts so schema drift fails loudly instead of corrupting workspace state.
 */
export class HttpGitHubKnowledgeClient implements GitHubKnowledgeClientPort {
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;
  private readonly longTimeoutMs: number;

  constructor(options: HttpGitHubKnowledgeClientOptions = {}) {
    this.baseUrl = trimTrailingSlash(options.baseUrl ?? '/api');
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch.bind(globalThis);
    this.timeoutMs = options.timeoutMs ?? 15_000;
    this.longTimeoutMs = options.longTimeoutMs ?? 180_000;
  }

  private async requestJson(
    path: string,
    init: RequestInit = {},
    timeoutMs = this.timeoutMs,
  ): Promise<Response> {
    const headers: Record<string, string> = {
      accept: 'application/json',
      ...(init.headers as Record<string, string> | undefined),
    };
    let response: Response;
    try {
      response = await this.fetchImpl(`${this.baseUrl}${path}`, {
        ...init,
        headers,
        signal: timeoutMs > 0 ? AbortSignal.timeout(timeoutMs) : undefined,
      });
    } catch (error) {
      if (error instanceof DOMException && error.name === 'TimeoutError') {
        throw new KnowledgeHttpError(
          0,
          'request_timeout',
          '请求本机 ASVS API 超时，请检查仓库规模或本机服务状态后重试。',
        );
      }
      throw new KnowledgeHttpError(
        0,
        'api_unreachable',
        '无法连接本机 ASVS API（请先运行 pnpm dev:api 或 pnpm dev:stack）。',
      );
    }
    return response;
  }

  async getStatus(repo?: GitHubRepoRef): Promise<GitHubConnectionStatus> {
    const query = buildQuery({ repo: repo ? formatGitHubRepoRef(repo) : undefined });
    const response = await this.requestJson(`/v1/github/status${query}`);
    if (!response.ok) throw await readKnowledgeError(response);
    return githubConnectionStatusSchema.parse(await response.json());
  }

  async getRepository(repo: GitHubRepoRef): Promise<GitHubRepositoryMetadata> {
    const response = await this.requestJson(repoBasePath(repo));
    if (!response.ok) throw await readKnowledgeError(response);
    return githubRepositoryMetadataSchema.parse(await response.json());
  }

  async verifyReadOnly(repo: GitHubRepoRef): Promise<GitHubWriteProbeResult> {
    const response = await this.requestJson(`${repoBasePath(repo)}/verify-readonly`, {
      method: 'POST',
    });
    if (!response.ok) throw await readKnowledgeError(response);
    return githubWriteProbeResultSchema.parse(await response.json());
  }

  async indexRepository(
    repo: GitHubRepoRef,
    options: IndexRepositoryOptions = {},
  ): Promise<KnowledgeSnapshotV1> {
    const response = await this.requestJson(
      `${repoBasePath(repo)}/index`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(options),
      },
      this.longTimeoutMs,
    );
    if (!response.ok) throw await readKnowledgeError(response);
    return indexResponseSchema.parse(await response.json()).snapshot;
  }

  async listSnapshots(
    repo: GitHubRepoRef,
    options: ListKnowledgeSnapshotsOptions = {},
  ): Promise<KnowledgeSnapshotSummaryV1[]> {
    const query = buildQuery({ branch: options.branch, limit: options.limit });
    const response = await this.requestJson(`${repoBasePath(repo)}/snapshots${query}`);
    if (!response.ok) throw await readKnowledgeError(response);
    return listSnapshotsResponseSchema.parse(await response.json()).snapshots;
  }

  async getSnapshot(
    repo: GitHubRepoRef,
    snapshotId: string,
  ): Promise<KnowledgeSnapshotV1 | null> {
    const response = await this.requestJson(
      `${repoBasePath(repo)}/snapshots/${encodeURIComponent(snapshotId)}`,
    );
    if (response.status === 404) return null;
    if (!response.ok) throw await readKnowledgeError(response);
    return knowledgeSnapshotV1Schema.parse(await response.json());
  }

  async discoverPullRequests(
    repo: GitHubRepoRef,
    options: AnalyzePullRequestsOptions = {},
  ): Promise<PRDiscoveryReportV1> {
    const response = await this.requestJson(
      `${repoBasePath(repo)}/discover`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(options),
      },
      this.longTimeoutMs,
    );
    if (!response.ok) throw await readKnowledgeError(response);
    return discoverResponseSchema.parse(await response.json()).report;
  }

  async listCandidates(
    repo: GitHubRepoRef,
    options: ListPRCandidatesOptions = {},
  ): Promise<PRChangeCandidateV1[]> {
    const query = buildQuery({
      classification: options.classification,
      pullNumber: options.pullNumber,
      limit: options.limit,
    });
    const response = await this.requestJson(`${repoBasePath(repo)}/candidates${query}`);
    if (!response.ok) throw await readKnowledgeError(response);
    return listCandidatesResponseSchema.parse(await response.json()).candidates;
  }

  async getCandidate(
    repo: GitHubRepoRef,
    candidateId: string,
  ): Promise<PRChangeCandidateV1 | null> {
    const response = await this.requestJson(
      `${repoBasePath(repo)}/candidates/${encodeURIComponent(candidateId)}`,
    );
    if (response.status === 404) return null;
    if (!response.ok) throw await readKnowledgeError(response);
    return prChangeCandidateV1Schema.parse(await response.json());
  }

  async recordVerification(
    repo: GitHubRepoRef,
    claimId: string,
    input: ClaimVerificationInputV1,
  ): Promise<ClaimCandidateV1> {
    const validatedInput = claimVerificationInputV1Schema.parse(input);
    const response = await this.requestJson(
      `${repoBasePath(repo)}/claims/${encodeURIComponent(claimId)}/verify`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(validatedInput),
      },
    );
    if (!response.ok) throw await readKnowledgeError(response);
    return verifyClaimResponseSchema.parse(await response.json()).claim;
  }

  async listVerifications(
    repo: GitHubRepoRef,
    claimId: string,
  ): Promise<ClaimVerificationRecordV1[]> {
    const response = await this.requestJson(
      `${repoBasePath(repo)}/claims/${encodeURIComponent(claimId)}/verifications`,
    );
    if (!response.ok) throw await readKnowledgeError(response);
    return listVerificationsResponseSchema.parse(await response.json()).verifications;
  }

  async refreshStaleness(
    repo: GitHubRepoRef,
    options: RefreshStalenessOptions = {},
  ): Promise<StalenessRefreshResultV1> {
    const response = await this.requestJson(
      `${repoBasePath(repo)}/candidates/refresh-staleness`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(options),
      },
    );
    if (!response.ok) throw await readKnowledgeError(response);
    return stalenessRefreshResultV1Schema.parse(await response.json());
  }
}
