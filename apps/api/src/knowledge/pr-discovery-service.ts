import { randomBytes } from 'node:crypto';
import {
  CLAIM_VERIFICATION_ID_PREFIX,
  PR_DISCOVERY_SCHEMA_VERSION,
  claimVerificationInputV1Schema,
  claimVerificationRecordV1Schema,
  evaluateClaimPublishability,
  formatGitHubRepoRef,
  prChangeCandidateV1Schema,
  prDiscoveryReportV1Schema,
  propagateSnapshotStaleness,
  stalenessRefreshResultV1Schema,
  type ClaimCandidateV1,
  type ClaimVerificationInputV1,
  type ClaimVerificationRecordV1,
  type EvidenceRefV1,
  type GitHubRepoRef,
  type KnowledgeSnapshotV1,
  type PRChangeCandidateV1,
  type PRDiscoveryReportV1,
  type StalenessRefreshResultV1,
} from '@asvs/domain';
import type {
  AnalyzePullRequestsOptions,
  GitHubReadOnlyPort,
  ListPRCandidatesOptions,
  PRDiscoveryPort,
  RefreshStalenessOptions,
} from '@asvs/ports';
import type { SqliteKnowledgeSnapshotStore } from '../db/knowledge-store';
import type { SqlitePRDiscoveryStore } from '../db/pr-discovery-store';
import { GitHubApiError, redactSecrets } from '../github/redact';
import { classifyPullRequest } from './pr-classifier';

export type PRDiscoveryErrorCode =
  | 'candidate_not_found'
  | 'claim_not_found'
  | 'snapshot_not_found'
  | 'invalid_request';

export class PRDiscoveryError extends Error {
  readonly code: PRDiscoveryErrorCode;
  readonly httpStatus: number;

  constructor(code: PRDiscoveryErrorCode, httpStatus: number, message: string) {
    super(message);
    this.name = 'PRDiscoveryError';
    this.code = code;
    this.httpStatus = httpStatus;
  }
}

const DEFAULT_LIST_LIMIT = 15;
const MAX_LIST_LIMIT = 50;
const MAX_FILES_PER_PR = 100;
const MAX_RELEASES = 50;
const MAX_CANDIDATE_EVIDENCE = 50;
const MAX_FUTURE_VERIFIED_AT_SKEW_MS = 60_000;

const EVIDENCE_TITLES: Record<ClaimVerificationInputV1['kind'], string> = {
  test: '测试证据',
  runtime: '运行态证据',
  release: '发布证据',
  human: '人工核验',
};

const ENVIRONMENT_RANK: Record<string, number> = {
  production: 4,
  beta: 3,
  staging: 2,
  preview: 1,
};

function compareTimestamps(a: string, b: string): number {
  const ta = Date.parse(a);
  const tb = Date.parse(b);
  if (Number.isFinite(ta) && Number.isFinite(tb)) return ta - tb;
  return a.localeCompare(b);
}

function rankEnvironment(environmentId: string | undefined): number {
  if (!environmentId) return 0;
  return ENVIRONMENT_RANK[environmentId] ?? 0;
}

/**
 * Keeps all digest-bound source evidence plus up to `max` total items.
 * When non-source evidence exceeds the budget, pins the active deciding items
 * (latest human decision, highest-ranked runtime, latest release, latest test
 * run) so noisy logs can never silently evict a rejection or production proof.
 */
function pruneCandidateEvidence(
  allEvidence: EvidenceRefV1[],
  max = MAX_CANDIDATE_EVIDENCE,
): EvidenceRefV1[] {
  const sourceItems = allEvidence.filter((item) => item.kind === 'source').slice(0, max);
  const recordedItems = allEvidence.filter((item) => item.kind !== 'source');
  const budget = Math.max(0, max - sourceItems.length);
  if (recordedItems.length <= budget) {
    return [...sourceItems, ...recordedItems];
  }

  const pinnedIds = new Set<string>();
  const pin = (item: EvidenceRefV1 | undefined): void => {
    if (item && pinnedIds.size < budget) pinnedIds.add(item.id);
  };

  const latestHuman = recordedItems
    .filter((item) => item.kind === 'human' && item.status === 'valid' && item.decision !== undefined)
    .sort((a, b) => compareTimestamps(a.capturedAt, b.capturedAt))
    .at(-1);
  const bestRuntime = recordedItems
    .filter((item) => item.kind === 'runtime' && item.status === 'valid')
    .sort(
      (a, b) =>
        rankEnvironment(b.environmentId) - rankEnvironment(a.environmentId) ||
        compareTimestamps(b.capturedAt, a.capturedAt),
    )[0];
  const latestRelease = recordedItems
    .filter((item) => item.kind === 'release' && item.status === 'valid')
    .sort((a, b) => compareTimestamps(b.capturedAt, a.capturedAt))[0];
  const latestTest = recordedItems
    .filter((item) => item.kind === 'test' && item.status === 'valid' && item.testRunId)
    .sort((a, b) => compareTimestamps(b.capturedAt, a.capturedAt))[0];

  pin(latestHuman);
  pin(bestRuntime);
  pin(latestRelease);
  pin(latestTest);

  const keptIds = new Set(pinnedIds);
  for (let index = recordedItems.length - 1; index >= 0 && keptIds.size < budget; index -= 1) {
    const item = recordedItems[index];
    if (item && !keptIds.has(item.id)) keptIds.add(item.id);
  }

  return [...sourceItems, ...recordedItems.filter((item) => keptIds.has(item.id))];
}

function sourceEvidenceFingerprint(candidate: PRChangeCandidateV1): Map<string, string | undefined> {
  const map = new Map<string, string | undefined>();
  for (const item of candidate.evidence) {
    if (item.kind !== 'source' || !item.filePath) continue;
    map.set(item.filePath, item.sourceDigest);
  }
  return map;
}

function isSourceUnchanged(previous: PRChangeCandidateV1, fresh: PRChangeCandidateV1): boolean {
  if (previous.evidence.some((item) => item.kind === 'source' && item.status === 'stale')) {
    return false;
  }
  const prevMap = sourceEvidenceFingerprint(previous);
  const freshMap = sourceEvidenceFingerprint(fresh);
  if (prevMap.size !== freshMap.size) return false;
  for (const [filePath, digest] of prevMap) {
    if (!freshMap.has(filePath) || freshMap.get(filePath) !== digest) return false;
  }
  return true;
}

function clamp(value: number | undefined, fallback: number, max: number): number {
  if (value === undefined || !Number.isFinite(value)) return fallback;
  return Math.max(1, Math.min(Math.trunc(value), max));
}

function defaultVerificationId(): string {
  return `${CLAIM_VERIFICATION_ID_PREFIX}${randomBytes(8).toString('hex')}`;
}

/**
 * Re-analysis must not erase evidence recorded by humans or external
 * pipelines when nothing substantive changed — AND must never silently carry
 * old approvals across a code/digest change or a stale state (AC-09 / docs/05 §9).
 *
 * Test / runtime / release / human evidence is carried over ONLY when:
 * 1. Previous source evidence was not stale and every (filePath, sourceDigest)
 *    matches the freshly analyzed candidate,
 * 2. The claim statement and commitSha are unchanged.
 * Otherwise old approvals are dropped from the active candidate (their full
 * history stays intact in append-only `claim_verifications`) so the claim must
 * be re-verified against the new code before publication.
 */
export function carryOverRecordedEvidence(
  fresh: PRChangeCandidateV1,
  previous: PRChangeCandidateV1 | null,
  evaluatedAt: string,
): PRChangeCandidateV1 {
  if (!previous || fresh.claims.length === 0) return fresh;
  if (!isSourceUnchanged(previous, fresh)) return fresh;

  const previousClaimsById = new Map(previous.claims.map((claim) => [claim.id, claim]));
  const previousEvidenceById = new Map(previous.evidence.map((item) => [item.id, item]));
  const combinedEvidence: EvidenceRefV1[] = [...fresh.evidence];
  const combinedIds = new Set(combinedEvidence.map((item) => item.id));
  const claimCarriedIds = new Map<string, string[]>();

  for (const freshClaim of fresh.claims) {
    const previousClaim = previousClaimsById.get(freshClaim.id);
    if (
      !previousClaim ||
      previousClaim.statement !== freshClaim.statement ||
      previousClaim.verification.commitSha !== freshClaim.verification.commitSha
    ) {
      continue;
    }
    const recorded = previousClaim.evidenceIds
      .map((id) => previousEvidenceById.get(id))
      .filter((item): item is EvidenceRefV1 => item !== undefined && item.kind !== 'source');
    if (recorded.length === 0) continue;

    const carriedForClaim: string[] = [];
    for (const item of recorded) {
      if (!combinedIds.has(item.id)) {
        combinedEvidence.push(item);
        combinedIds.add(item.id);
      }
      carriedForClaim.push(item.id);
    }
    claimCarriedIds.set(freshClaim.id, carriedForClaim);
  }

  if (claimCarriedIds.size === 0) return fresh;

  const evidence = pruneCandidateEvidence(combinedEvidence);
  const evidenceById = new Map(evidence.map((item) => [item.id, item]));

  const claims: ClaimCandidateV1[] = fresh.claims.map((freshClaim) => {
    const carriedIds = claimCarriedIds.get(freshClaim.id);
    if (!carriedIds) return freshClaim;

    const claimEvidenceIds = Array.from(
      new Set([...freshClaim.evidenceIds, ...carriedIds]),
    ).filter((id) => evidenceById.has(id));
    const claimEvidence = claimEvidenceIds
      .map((id) => evidenceById.get(id))
      .filter((item): item is EvidenceRefV1 => item !== undefined);

    const evaluation = evaluateClaimPublishability({
      classification: fresh.classification,
      evidence: claimEvidence,
      commitSha: freshClaim.verification.commitSha,
      ...(fresh.snapshotId ? { snapshotId: fresh.snapshotId } : {}),
      evaluatedAt,
    });
    return {
      ...freshClaim,
      status: evaluation.status,
      eligibility: evaluation.eligibility,
      verification: evaluation.verification,
      evidenceIds: claimEvidenceIds,
      blockers: evaluation.blockers,
      guidance: evaluation.guidance,
    };
  });

  return prChangeCandidateV1Schema.parse({ ...fresh, evidence, claims });
}

export interface PRDiscoveryServiceOptions {
  github: GitHubReadOnlyPort;
  knowledgeStore: SqliteKnowledgeSnapshotStore;
  store: SqlitePRDiscoveryStore;
  now?: () => Date;
  /** Injectable so tests can produce stable audit / evidence ids. */
  newVerificationId?: () => string;
}

/**
 * Step 4C orchestration: read-only GitHub + 4B snapshots + SQLite.
 * Every classification is deterministic; nothing here calls an external model
 * or writes to GitHub.
 */
export class PRDiscoveryService implements PRDiscoveryPort {
  readonly #github: GitHubReadOnlyPort;
  readonly #knowledgeStore: SqliteKnowledgeSnapshotStore;
  readonly #store: SqlitePRDiscoveryStore;
  readonly #now: () => Date;
  readonly #newVerificationId: () => string;

  constructor(options: PRDiscoveryServiceOptions) {
    this.#github = options.github;
    this.#knowledgeStore = options.knowledgeStore;
    this.#store = options.store;
    this.#now = options.now ?? (() => new Date());
    this.#newVerificationId = options.newVerificationId ?? defaultVerificationId;
  }

  async analyzePullRequests(
    repo: GitHubRepoRef,
    options: AnalyzePullRequestsOptions = {},
  ): Promise<PRDiscoveryReportV1> {
    if (!this.#github.isConfigured()) {
      throw new GitHubApiError({
        code: 'github_not_configured',
        httpStatus: 503,
        message:
          '尚未配置 GitHub App 只读凭证，无法发现 PR；请配置 GITHUB_APP_ID / GITHUB_APP_INSTALLATION_ID / GITHUB_APP_PRIVATE_KEY_PATH。',
      });
    }

    const fullRepo = formatGitHubRepoRef(repo);
    const repository = await this.#github.getRepository(repo);
    const branch = options.branch?.trim() || repository.defaultBranch || 'main';
    const snapshot = await this.#resolveSnapshot(fullRepo, branch, options.snapshotId, false);
    const analyzedAt = this.#now().toISOString();

    const requestedNumbers = options.pullNumbers?.filter(
      (value) => Number.isInteger(value) && value > 0,
    );
    const state = options.state ?? (requestedNumbers && requestedNumbers.length > 0 ? 'all' : 'closed');
    const limit = clamp(options.limit, DEFAULT_LIST_LIMIT, MAX_LIST_LIMIT);
    const pulls = await this.#github.listPullRequests(repo, {
      state,
      limit: requestedNumbers && requestedNumbers.length > 0 ? 100 : limit,
    });
    const selected =
      requestedNumbers && requestedNumbers.length > 0
        ? pulls.filter((pull) => requestedNumbers.includes(pull.number)).slice(0, limit)
        : pulls.slice(0, limit);
    const releases = await this.#github.listReleases(repo, { limit: MAX_RELEASES });

    const candidates: PRChangeCandidateV1[] = [];
    const errors: Array<{ pullNumber: number; message: string }> = [];

    for (const pullRequest of selected) {
      try {
        const files = await this.#github.listPullRequestFiles(repo, pullRequest.number, {
          includePatch: false,
          limit: MAX_FILES_PER_PR,
        });
        const fresh = classifyPullRequest({
          repo: fullRepo,
          pullRequest,
          files,
          filesTruncated: files.length >= MAX_FILES_PER_PR,
          releases,
          snapshot,
          analyzedAt,
        });
        const previous = this.#store.get(fullRepo, fresh.id);
        candidates.push(this.#store.upsert(carryOverRecordedEvidence(fresh, previous, analyzedAt)));
      } catch (error) {
        errors.push({
          pullNumber: pullRequest.number,
          message: redactSecrets(
            error instanceof Error ? error.message : `分析 PR #${pullRequest.number} 失败`,
          ).slice(0, 500),
        });
      }
    }

    const selectedNumbers = new Set(selected.map((pull) => pull.number));
    for (const number of requestedNumbers ?? []) {
      if (!selectedNumbers.has(number)) {
        errors.push({
          pullNumber: number,
          message: '该 PR 未出现在 GitHub 返回的列表中（可能不存在、未授权或超出本次 limit）。',
        });
      }
    }

    const allClaims = candidates.flatMap((candidate) => candidate.claims);
    return prDiscoveryReportV1Schema.parse({
      schemaVersion: PR_DISCOVERY_SCHEMA_VERSION,
      repo: fullRepo,
      // The snapshot is authoritative: a pinned snapshot may belong to a
      // different branch than the requested one.
      branch: snapshot?.branch ?? branch,
      ...(snapshot ? { snapshotId: snapshot.id } : {}),
      requestedState: state,
      analyzedAt,
      summary: {
        analyzed: candidates.length,
        userFacingFeature: candidates.filter(
          (candidate) => candidate.classification === 'user_facing_feature',
        ).length,
        userFacingImprovement: candidates.filter(
          (candidate) => candidate.classification === 'user_facing_improvement',
        ).length,
        internal: candidates.filter(
          (candidate) => candidate.classification === 'internal_non_promotable',
        ).length,
        ambiguous: candidates.filter(
          (candidate) => candidate.classification === 'ambiguous_needs_review',
        ).length,
        claims: allClaims.length,
        claimsBlockedUnverified: allClaims.filter(
          (claim) => claim.eligibility === 'blocked_unverified',
        ).length,
        claimsBlockedStale: allClaims.filter((claim) => claim.eligibility === 'blocked_stale')
          .length,
        claimsPublishable: allClaims.filter((claim) => claim.eligibility === 'publishable')
          .length,
      },
      errors,
      candidates,
    });
  }

  async listCandidates(
    repo: GitHubRepoRef,
    options: ListPRCandidatesOptions = {},
  ): Promise<PRChangeCandidateV1[]> {
    return this.#store.list(formatGitHubRepoRef(repo), options);
  }

  async getCandidate(
    repo: GitHubRepoRef,
    candidateId: string,
  ): Promise<PRChangeCandidateV1 | null> {
    return this.#store.get(formatGitHubRepoRef(repo), candidateId);
  }

  async recordVerification(
    repo: GitHubRepoRef,
    claimId: string,
    input: ClaimVerificationInputV1,
  ): Promise<ClaimCandidateV1 | null> {
    const parsedInput = claimVerificationInputV1Schema.parse(input);
    const fullRepo = formatGitHubRepoRef(repo);
    const now = this.#now();
    const recordedAt = now.toISOString();

    let verifiedAt = recordedAt;
    if (parsedInput.verifiedAt !== undefined) {
      const verifiedAtMs = Date.parse(parsedInput.verifiedAt);
      if (!Number.isFinite(verifiedAtMs) || verifiedAtMs > now.getTime() + MAX_FUTURE_VERIFIED_AT_SKEW_MS) {
        throw new PRDiscoveryError(
          'invalid_request',
          400,
          'verifiedAt 必须是合法的 ISO-8601 时间戳且不能晚于当前时间。',
        );
      }
      verifiedAt = new Date(verifiedAtMs).toISOString();
    }

    return this.#store.runInTransaction(() => {
      const found = this.#store.findClaim(fullRepo, claimId);
      if (!found) return null;

      const { candidate, claim } = found;
      const recordId = this.#newVerificationId();
      const evidenceId = `evd_${recordId.slice(CLAIM_VERIFICATION_ID_PREFIX.length)}`;

      const evidence: EvidenceRefV1 = {
        id: evidenceId,
        kind: parsedInput.kind,
        status: 'valid',
        title: EVIDENCE_TITLES[parsedInput.kind],
        detail: parsedInput.note,
        ...(parsedInput.actor ? { actor: parsedInput.actor } : {}),
        ...(parsedInput.environmentId ? { environmentId: parsedInput.environmentId } : {}),
        ...(parsedInput.releaseTag ? { releaseTag: parsedInput.releaseTag } : {}),
        ...(parsedInput.testRunId ? { testRunId: parsedInput.testRunId } : {}),
        ...(parsedInput.decision ? { decision: parsedInput.decision } : {}),
        commitSha: parsedInput.commitSha ?? claim.verification.commitSha,
        capturedAt: verifiedAt,
      };

      this.#store.appendVerification(
        claimVerificationRecordV1Schema.parse({
          schemaVersion: PR_DISCOVERY_SCHEMA_VERSION,
          id: recordId,
          repo: fullRepo,
          candidateId: candidate.id,
          claimId: claim.id,
          evidence,
          input: parsedInput,
          recordedAt,
        }),
      );

      const evidenceList = pruneCandidateEvidence([...candidate.evidence, evidence]);
      const evidenceById = new Map(evidenceList.map((item) => [item.id, item]));
      const claimEvidenceIds = Array.from(new Set([...claim.evidenceIds, evidence.id])).filter(
        (id) => evidenceById.has(id),
      );
      const claimEvidence = claimEvidenceIds
        .map((id) => evidenceById.get(id))
        .filter((item): item is EvidenceRefV1 => item !== undefined);

      const evaluation = evaluateClaimPublishability({
        classification: candidate.classification,
        evidence: claimEvidence,
        commitSha: claim.verification.commitSha,
        ...(claim.verification.snapshotId ? { snapshotId: claim.verification.snapshotId } : {}),
        evaluatedAt: recordedAt,
      });
      const updatedClaim: ClaimCandidateV1 = {
        ...claim,
        status: evaluation.status,
        eligibility: evaluation.eligibility,
        verification: evaluation.verification,
        evidenceIds: claimEvidenceIds,
        blockers: evaluation.blockers,
        guidance: evaluation.guidance,
      };
      const updatedClaims = candidate.claims.map((item) =>
        item.id === claim.id
          ? updatedClaim
          : { ...item, evidenceIds: item.evidenceIds.filter((id) => evidenceById.has(id)) },
      );

      this.#store.upsert(
        { ...candidate, evidence: evidenceList, claims: updatedClaims },
        recordedAt,
      );
      return updatedClaim;
    });
  }

  async listVerifications(
    repo: GitHubRepoRef,
    claimId: string,
  ): Promise<ClaimVerificationRecordV1[] | null> {
    const fullRepo = formatGitHubRepoRef(repo);
    const found = this.#store.findClaim(fullRepo, claimId);
    const records = this.#store.listVerifications(fullRepo, claimId);
    if (!found && records.length === 0) return null;
    return records;
  }

  async refreshStaleness(
    repo: GitHubRepoRef,
    options: RefreshStalenessOptions = {},
  ): Promise<StalenessRefreshResultV1> {
    const fullRepo = formatGitHubRepoRef(repo);
    const snapshot = await this.#resolveSnapshot(
      fullRepo,
      options.branch,
      options.snapshotId,
      true,
    );
    if (!snapshot) {
      throw new PRDiscoveryError(
        'snapshot_not_found',
        404,
        '该仓库还没有可用的知识快照；请先执行 POST /v1/github/repos/:owner/:repo/index。',
      );
    }

    const refreshedAt = this.#now().toISOString();
    const candidates = this.#store.listAll(fullRepo);
    let candidatesChanged = 0;
    let evidenceMarkedStale = 0;
    const claimsMarkedStale: string[] = [];
    const staleFiles = new Set<string>();

    for (const candidate of candidates) {
      const result = propagateSnapshotStaleness(candidate, snapshot, refreshedAt);
      if (result.changed) {
        this.#store.upsert(result.candidate, refreshedAt);
        candidatesChanged += 1;
      }
      evidenceMarkedStale += result.evidenceMarkedStale;
      claimsMarkedStale.push(...result.claimsMarkedStale);
      for (const file of result.staleFiles) staleFiles.add(file);
    }

    return stalenessRefreshResultV1Schema.parse({
      schemaVersion: PR_DISCOVERY_SCHEMA_VERSION,
      repo: fullRepo,
      snapshotId: snapshot.id,
      gitCommitSha: snapshot.gitCommitSha,
      branch: snapshot.branch,
      refreshedAt,
      candidatesScanned: candidates.length,
      candidatesChanged,
      evidenceMarkedStale,
      claimsMarkedStale: claimsMarkedStale.sort(),
      staleFiles: [...staleFiles].sort(),
    });
  }

  async #resolveSnapshot(
    fullRepo: string,
    branch: string | undefined,
    snapshotId: string | undefined,
    required: boolean,
  ): Promise<KnowledgeSnapshotV1 | null> {
    if (snapshotId) {
      const snapshot = this.#knowledgeStore.get(fullRepo, snapshotId);
      if (!snapshot) {
        throw new PRDiscoveryError(
          'snapshot_not_found',
          404,
          `快照 ${snapshotId} 不存在；请先执行索引或使用该仓库的最新快照。`,
        );
      }
      return snapshot;
    }
    const snapshot = branch
      ? this.#knowledgeStore.getLatest(fullRepo, branch)
      : this.#knowledgeStore.getLatest(fullRepo);
    if (!snapshot && required) {
      throw new PRDiscoveryError(
        'snapshot_not_found',
        404,
        `仓库 ${fullRepo}${branch ? ` 的分支 ${branch}` : ''} 还没有知识快照；请先执行 POST /v1/github/repos/:owner/:repo/index。`,
      );
    }
    return snapshot;
  }
}
