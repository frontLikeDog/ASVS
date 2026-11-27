import type {
  ClaimCandidateV1,
  ClaimVerificationInputV1,
  ClaimVerificationRecordV1,
  GitHubRepoRef,
  PRChangeCandidateV1,
  PRChangeClassification,
  PRDiscoveryReportV1,
  StalenessRefreshResultV1,
} from '@asvs/domain';

export interface AnalyzePullRequestsOptions {
  /** Defaults to `closed` (merged changes are the only ones worth verifying). */
  state?: 'open' | 'closed' | 'all';
  /** Max PRs to analyze; clamped by the implementation. */
  limit?: number;
  /** Analyze only these PR numbers (the listing is filtered afterwards). */
  pullNumbers?: number[];
  /** Branch whose latest 4B snapshot supplies source digests. */
  branch?: string;
  /** Pin a specific snapshot instead of the branch's latest one. */
  snapshotId?: string;
}

export interface ListPRCandidatesOptions {
  classification?: PRChangeClassification;
  pullNumber?: number;
  limit?: number;
}

export interface RefreshStalenessOptions {
  branch?: string;
  snapshotId?: string;
}

/**
 * Boundary for Step 4C: turn read-only GitHub PRs into video-worthy Claim
 * candidates with traceable verification context.
 *
 * Implementations must be deterministic: the same PR + files + snapshot must
 * produce the same classification, claims and evidence ids. No external LLM
 * may participate, and no method may write to GitHub.
 */
export interface PRDiscoveryPort {
  analyzePullRequests(
    repo: GitHubRepoRef,
    options?: AnalyzePullRequestsOptions,
  ): Promise<PRDiscoveryReportV1>;
  listCandidates(
    repo: GitHubRepoRef,
    options?: ListPRCandidatesOptions,
  ): Promise<PRChangeCandidateV1[]>;
  getCandidate(repo: GitHubRepoRef, candidateId: string): Promise<PRChangeCandidateV1 | null>;
  /**
   * Appends one audit record (test / runtime / release / human evidence),
   * rebinds the claim's verification context and recomputes publishability.
   * Returns null when the claim id is unknown for this repository.
   */
  recordVerification(
    repo: GitHubRepoRef,
    claimId: string,
    input: ClaimVerificationInputV1,
  ): Promise<ClaimCandidateV1 | null>;
  /**
   * Lists the append-only verification audit records for a claim in
   * chronological order. Returns null when the claim is unknown for this repo.
   */
  listVerifications(
    repo: GitHubRepoRef,
    claimId: string,
  ): Promise<ClaimVerificationRecordV1[] | null>;
  /**
   * AC-09 propagation: compare every digest-bound source evidence with the
   * latest snapshot and mark affected evidence / claims `stale`.
   */
  refreshStaleness(
    repo: GitHubRepoRef,
    options?: RefreshStalenessOptions,
  ): Promise<StalenessRefreshResultV1>;
}
