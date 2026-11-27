import type {
  ClaimCandidateV1,
  ClaimVerificationInputV1,
  ClaimVerificationRecordV1,
  GitHubConnectionStatus,
  GitHubRepoRef,
  GitHubRepositoryMetadata,
  GitHubWriteProbeResult,
  KnowledgeSnapshotSummaryV1,
  KnowledgeSnapshotV1,
  PRChangeCandidateV1,
  PRDiscoveryReportV1,
  StalenessRefreshResultV1,
} from '@asvs/domain';
import type { IndexRepositoryOptions, ListKnowledgeSnapshotsOptions } from './knowledge';
import type {
  AnalyzePullRequestsOptions,
  ListPRCandidatesOptions,
  RefreshStalenessOptions,
} from './pr-discovery';

/**
 * Browser-safe port combining Step 4A (read-only GitHub status & write-block
 * probe), Step 4B (incremental knowledge snapshots) and Step 4C (PR discovery,
 * verification recording, audit listing and staleness propagation).
 *
 * `libs/adapters-http` implements this over `/api/v1/github/*`; UI features
 * access it indirectly through `libs/state` so module boundaries remain intact
 * and the HTTP adapter stays out of the initial JS bundle.
 */
export interface GitHubKnowledgeClientPort {
  getStatus(repo?: GitHubRepoRef): Promise<GitHubConnectionStatus>;
  getRepository(repo: GitHubRepoRef): Promise<GitHubRepositoryMetadata>;
  verifyReadOnly(repo: GitHubRepoRef): Promise<GitHubWriteProbeResult>;
  indexRepository(
    repo: GitHubRepoRef,
    options?: IndexRepositoryOptions,
  ): Promise<KnowledgeSnapshotV1>;
  listSnapshots(
    repo: GitHubRepoRef,
    options?: ListKnowledgeSnapshotsOptions,
  ): Promise<KnowledgeSnapshotSummaryV1[]>;
  getSnapshot(
    repo: GitHubRepoRef,
    snapshotId: string,
  ): Promise<KnowledgeSnapshotV1 | null>;
  discoverPullRequests(
    repo: GitHubRepoRef,
    options?: AnalyzePullRequestsOptions,
  ): Promise<PRDiscoveryReportV1>;
  listCandidates(
    repo: GitHubRepoRef,
    options?: ListPRCandidatesOptions,
  ): Promise<PRChangeCandidateV1[]>;
  getCandidate(
    repo: GitHubRepoRef,
    candidateId: string,
  ): Promise<PRChangeCandidateV1 | null>;
  recordVerification(
    repo: GitHubRepoRef,
    claimId: string,
    input: ClaimVerificationInputV1,
  ): Promise<ClaimCandidateV1>;
  listVerifications(
    repo: GitHubRepoRef,
    claimId: string,
  ): Promise<ClaimVerificationRecordV1[]>;
  refreshStaleness(
    repo: GitHubRepoRef,
    options?: RefreshStalenessOptions,
  ): Promise<StalenessRefreshResultV1>;
}
