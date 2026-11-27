import type {
  ClaimCandidateV1,
  EvidenceRefV1,
  PRChangeCandidateV1,
} from './pr-discovery';
import type {
  Claim,
  Evidence,
  Feature,
  FeatureStatus,
  PullRequest,
  Release,
  SourceRef,
  VideoProject,
} from './schemas';

/**
 * Pure projection & reconciliation between Step 4C `PRChangeCandidateV1`
 * records and the workspace `StudioSnapshot` (`Feature` / `Claim` / `Evidence`
 * / `PullRequest` / `Release` / `VideoProject`).
 *
 * Uses `import type` only so bundling this module into `libs/state` adds zero
 * Zod / parser weight to the initial browser bundle.
 */

export function workspaceFeatureId(projectId: string, candidateId: string): string {
  return `feat_${projectId}_${candidateId}`;
}

export function workspaceClaimId(projectId: string, claimId: string): string {
  return `claim_${projectId}_${claimId}`;
}

export function workspaceEvidenceId(projectId: string, evidenceId: string): string {
  return `ev_${projectId}_${evidenceId}`;
}

export function workspacePrId(projectId: string, candidateId: string): string {
  return `pr_${projectId}_${candidateId}`;
}

export function workspaceReleaseId(projectId: string, tagName: string): string {
  return `rel_${projectId}_${tagName.replace(/[^A-Za-z0-9._-]/g, '_')}`;
}

const CONVENTIONAL_PREFIX_RE = /^(?:feat|fix|perf|improve|enhancement|ui|docs|refactor|chore|test|ci|build|style)(?:\([^)]+\))?!?:\s*/i;

export function deriveFeatureNameFromTitle(title: string): string {
  const cleaned = title.trim().replace(CONVENTIONAL_PREFIX_RE, '').trim();
  return cleaned || title.trim() || '未命名功能';
}

export function deriveFeatureStatusFromCandidate(candidate: PRChangeCandidateV1): FeatureStatus {
  if (
    candidate.claims.some(
      (claim) => claim.status === 'stale' || claim.eligibility === 'blocked_stale',
    )
  ) {
    return 'stale';
  }
  if (candidate.claims.some((claim) => claim.eligibility === 'publishable')) {
    return 'deployed';
  }
  if (candidate.claims.some((claim) => claim.status === 'verified')) {
    return 'verified';
  }
  return candidate.merged ? 'implemented' : 'proposed';
}

function deriveFeatureCategory(candidate: PRChangeCandidateV1): string {
  if (candidate.diffStats.userFacingFiles > 0) return '界面与交互';
  if (candidate.classification === 'user_facing_improvement') return '体验优化';
  return '产品能力';
}

function buildSourceRefs(candidate: PRChangeCandidateV1): SourceRef[] {
  const refs: SourceRef[] = [
    {
      kind: 'pr',
      label: `PR #${candidate.pullNumber}`,
      detail: `${candidate.title} (${candidate.repo})`,
    },
  ];
  for (const file of candidate.changedFiles.slice(0, 6)) {
    refs.push({
      kind: file.category === 'docs' ? 'doc' : 'file',
      label: file.path,
      detail: `${file.status} · +${file.additions}/-${file.deletions}`,
    });
  }
  if (candidate.release) {
    refs.push({
      kind: 'release',
      label: candidate.release.tagName,
      detail: candidate.release.name ?? '关联 Release',
    });
  }
  const hasRuntime = candidate.evidence.some(
    (item) => item.kind === 'runtime' && item.status === 'valid',
  );
  if (hasRuntime) {
    refs.push({
      kind: 'runtime',
      label: '运行态核验',
      detail: '已记录真实环境运行态证据',
    });
  }
  return refs;
}

function deriveEvidenceRefLabel(item: EvidenceRefV1): string {
  return (
    item.filePath ??
    item.releaseTag ??
    item.testRunId ??
    item.environmentId ??
    (item.commitSha ? item.commitSha.slice(0, 10) : item.id)
  );
}

function projectEvidenceItem(
  projectId: string,
  featureId: string,
  wsClaimId: string,
  item: EvidenceRefV1,
): Evidence {
  return {
    id: workspaceEvidenceId(projectId, item.id),
    projectId,
    featureId,
    claimId: wsClaimId,
    kind: item.kind,
    title: item.title,
    detail: item.detail,
    ref: deriveEvidenceRefLabel(item),
    status: item.status,
    capturedAt: item.capturedAt,
    ...(item.filePath ? { filePath: item.filePath } : {}),
    ...(item.sourceDigest ? { sourceDigest: item.sourceDigest } : {}),
    ...(item.commitSha ? { commitSha: item.commitSha } : {}),
    ...(item.snapshotId ? { snapshotId: item.snapshotId } : {}),
    ...(item.environmentId ? { environmentId: item.environmentId } : {}),
    ...(item.releaseTag ? { releaseTag: item.releaseTag } : {}),
    ...(item.testRunId ? { testRunId: item.testRunId } : {}),
    ...(item.decision ? { decision: item.decision } : {}),
    ...(item.actor ? { actor: item.actor } : {}),
    demo: false,
  };
}

function projectClaim(
  projectId: string,
  featureId: string,
  candidate: PRChangeCandidateV1,
  claim: ClaimCandidateV1,
): Claim {
  const wsClaimId = workspaceClaimId(projectId, claim.id);
  return {
    id: wsClaimId,
    projectId,
    featureId,
    statement: claim.statement,
    audience: claim.audience,
    status: claim.status,
    eligibility: claim.eligibility,
    blockers: [...claim.blockers],
    guidance: claim.guidance,
    evidenceIds: claim.evidenceIds.map((id) => workspaceEvidenceId(projectId, id)),
    verification: {
      environment: claim.verification.environmentId,
      appVersion:
        claim.verification.releaseTag ??
        claim.verification.appVersion ??
        claim.verification.commitSha.slice(0, 7),
      verifiedAt: claim.verification.verifiedAt,
      scope: claim.verification.validityScope,
      commitSha: claim.verification.commitSha,
      ...(claim.verification.snapshotId ? { snapshotId: claim.verification.snapshotId } : {}),
      environmentId: claim.verification.environmentId,
      ...(claim.verification.testRunId ? { testRunId: claim.verification.testRunId } : {}),
      ...(claim.verification.releaseTag ? { releaseTag: claim.verification.releaseTag } : {}),
      deployed: claim.verification.deployed,
    },
    sourceRepo: candidate.repo,
    sourceCandidateId: candidate.id,
    sourceClaimId: claim.id,
    sourcePullNumber: candidate.pullNumber,
    demo: false,
  };
}

function projectTimelineEntry(
  projectId: string,
  candidate: PRChangeCandidateV1,
  linkedFeatureIds: string[],
): PullRequest {
  const kind: PullRequest['kind'] =
    candidate.classification === 'user_facing_feature'
      ? 'feature'
      : candidate.classification === 'user_facing_improvement'
        ? 'improvement'
        : 'internal';
  return {
    id: workspacePrId(projectId, candidate.id),
    projectId,
    number: candidate.pullNumber,
    title: candidate.title,
    author: candidate.author,
    mergedAt: candidate.mergedAt ?? candidate.analyzedAt,
    kind,
    summary: candidate.rationale.join('；'),
    featureIds: candidate.promotable ? linkedFeatureIds : [],
    sourceCandidateId: candidate.id,
    classification: candidate.classification,
    htmlUrl: candidate.htmlUrl,
    headSha: candidate.headSha,
    mergeCommitSha: candidate.mergeCommitSha,
    ...(candidate.snapshotId ? { snapshotId: candidate.snapshotId } : {}),
    promotable: candidate.promotable,
    demo: false,
  };
}

function upsertById<T extends { id: string }>(existing: T[], additions: T[]): T[] {
  const byId = new Map(additions.map((item) => [item.id, item]));
  const kept = existing.filter((item) => !byId.has(item.id));
  return [...additions, ...kept];
}

function mergeReleasesFromCandidates(
  projectId: string,
  candidates: PRChangeCandidateV1[],
  existingReleases: Release[],
): Release[] {
  const releaseBuckets = new Map<
    string,
    { release: NonNullable<PRChangeCandidateV1['release']>; prIds: Set<string>; titles: string[] }
  >();

  for (const candidate of candidates) {
    if (!candidate.release) continue;
    const relId = workspaceReleaseId(projectId, candidate.release.tagName);
    const prId = workspacePrId(projectId, candidate.id);
    const bucket = releaseBuckets.get(relId) ?? {
      release: candidate.release,
      prIds: new Set<string>(),
      titles: [],
    };
    bucket.prIds.add(prId);
    if (candidate.promotable) {
      bucket.titles.push(deriveFeatureNameFromTitle(candidate.title));
    }
    releaseBuckets.set(relId, bucket);
  }

  if (releaseBuckets.size === 0) return existingReleases;

  const existingById = new Map(existingReleases.map((item) => [item.id, item]));
  const updates: Release[] = [];
  for (const [relId, bucket] of releaseBuckets) {
    const prev = existingById.get(relId);
    const mergedPrIds = Array.from(new Set([...(prev?.prIds ?? []), ...bucket.prIds]));
    updates.push({
      id: relId,
      projectId,
      version: bucket.release.tagName,
      name: bucket.release.name ?? bucket.release.tagName,
      releasedAt: bucket.release.publishedAt,
      prIds: mergedPrIds,
      highlight:
        bucket.titles.length > 0
          ? `关联变更：${bucket.titles.slice(0, 3).join('、')}`
          : prev?.highlight ?? `Release ${bucket.release.tagName}`,
      htmlUrl: bucket.release.htmlUrl,
      tagName: bucket.release.tagName,
      demo: false,
    });
  }
  return upsertById(existingReleases, updates);
}

/**
 * Projects all PR candidates (including internal/ambiguous PRs) into the
 * project's PR & Release timeline. Internal PRs never carry `featureIds`.
 */
export function projectCandidateTimeline(
  projectId: string,
  candidates: PRChangeCandidateV1[],
  existingPullRequests: PullRequest[],
  existingReleases: Release[],
  existingFeatures: Feature[] = [],
): { pullRequests: PullRequest[]; releases: Release[] } {
  const featureByCandidate = new Map<string, string>();
  for (const feature of existingFeatures) {
    if (feature.projectId === projectId && feature.sourceCandidateId) {
      featureByCandidate.set(feature.sourceCandidateId, feature.id);
    }
  }

  const nextPrs = candidates.map((candidate) => {
    const linked = featureByCandidate.get(candidate.id);
    return projectTimelineEntry(projectId, candidate, linked ? [linked] : []);
  });

  return {
    pullRequests: upsertById(existingPullRequests, nextPrs),
    releases: mergeReleasesFromCandidates(projectId, candidates, existingReleases),
  };
}

export interface PromoteCandidateInput {
  projectId: string;
  candidate: PRChangeCandidateV1;
  features: Feature[];
  claims: Claim[];
  evidence: Evidence[];
  pullRequests: PullRequest[];
  releases: Release[];
  nowIso: string;
}

export type PromoteCandidateResult =
  | {
      ok: true;
      featureId: string;
      features: Feature[];
      claims: Claim[];
      evidence: Evidence[];
      pullRequests: PullRequest[];
      releases: Release[];
    }
  | { ok: false; reason: string };

function upsertPromotedCandidateEntities(
  projectId: string,
  candidate: PRChangeCandidateV1,
  existingFeatures: Feature[],
  nowIso: string,
): { feature: Feature; claims: Claim[]; evidence: Evidence[] } {
  const featureId = workspaceFeatureId(projectId, candidate.id);
  const existingFeature = existingFeatures.find(
    (item) =>
      item.id === featureId ||
      (item.projectId === projectId && item.sourceCandidateId === candidate.id),
  );
  const targetFeatureId = existingFeature?.id ?? featureId;
  const prId = workspacePrId(projectId, candidate.id);
  const existingPrIds = existingFeature?.prIds ?? [];
  const prIds = existingPrIds.includes(prId) ? existingPrIds : [prId, ...existingPrIds];

  const projectedClaims = candidate.claims.map((claim) =>
    projectClaim(projectId, targetFeatureId, candidate, claim),
  );
  const evidenceById = new Map(candidate.evidence.map((item) => [item.id, item]));
  const projectedEvidence: Evidence[] = [];
  const seenWsEvidenceIds = new Set<string>();

  for (const claim of candidate.claims) {
    const wsClaimId = workspaceClaimId(projectId, claim.id);
    for (const rawId of claim.evidenceIds) {
      const raw = evidenceById.get(rawId);
      if (!raw) continue;
      const projected = projectEvidenceItem(projectId, targetFeatureId, wsClaimId, raw);
      if (!seenWsEvidenceIds.has(projected.id)) {
        seenWsEvidenceIds.add(projected.id);
        projectedEvidence.push(projected);
      }
    }
  }

  const feature: Feature = {
    id: targetFeatureId,
    projectId,
    name: existingFeature?.name ?? deriveFeatureNameFromTitle(candidate.title),
    summary:
      existingFeature?.summary ??
      `PR #${candidate.pullNumber}：${candidate.rationale.join('；')}`,
    category: existingFeature?.category ?? deriveFeatureCategory(candidate),
    status: deriveFeatureStatusFromCandidate(candidate),
    confidence: candidate.confidence,
    userConfirmed: existingFeature?.userConfirmed ?? true,
    sourceRefs: buildSourceRefs(candidate),
    claimIds: projectedClaims.map((claim) => claim.id),
    prIds,
    demoRoute: existingFeature?.demoRoute ?? '/',
    updatedAt: nowIso,
    tags:
      existingFeature?.tags && existingFeature.tags.length > 0
        ? existingFeature.tags
        : Array.from(
            new Set([
              ...candidate.labels,
              candidate.classification === 'user_facing_feature' ? '新功能' : '改进',
            ]),
          ).slice(0, 6),
    sourceRepo: candidate.repo,
    sourceCandidateId: candidate.id,
    sourcePullNumber: candidate.pullNumber,
    sourceClassification: candidate.classification,
    demo: false,
  };

  return { feature, claims: projectedClaims, evidence: projectedEvidence };
}

/**
 * Promotes one `user_facing_*` candidate into the project's Feature Catalog.
 * Enforces AC-02: `internal_non_promotable` and `ambiguous_needs_review` are
 * unconditionally rejected.
 */
export function promoteCandidateToKnowledge(
  input: PromoteCandidateInput,
): PromoteCandidateResult {
  const { projectId, candidate } = input;
  if (!candidate.promotable || candidate.claims.length === 0) {
    return {
      ok: false,
      reason: '非用户可感知变更（内部变更或待人工复核）不得写入功能目录或产出 Claim（AC-02）。',
    };
  }

  const { feature, claims: newClaims, evidence: newEvidence } = upsertPromotedCandidateEntities(
    projectId,
    candidate,
    input.features,
    input.nowIso,
  );

  // Drop obsolete workspace claims/evidence belonging to this candidate before upserting.
  const remainingClaims = input.claims.filter(
    (item) => !(item.projectId === projectId && item.sourceCandidateId === candidate.id),
  );
  const removedClaimIds = new Set(
    input.claims
      .filter((item) => item.projectId === projectId && item.sourceCandidateId === candidate.id)
      .map((item) => item.id),
  );
  const remainingEvidence = input.evidence.filter(
    (item) =>
      !(
        item.projectId === projectId &&
        item.claimId !== undefined &&
        removedClaimIds.has(item.claimId)
      ),
  );

  const features = upsertById(input.features, [feature]);
  const timeline = projectCandidateTimeline(
    projectId,
    [candidate],
    input.pullRequests,
    input.releases,
    features,
  );

  return {
    ok: true,
    featureId: feature.id,
    features,
    claims: upsertById(remainingClaims, newClaims),
    evidence: upsertById(remainingEvidence, newEvidence),
    pullRequests: timeline.pullRequests,
    releases: timeline.releases,
  };
}

export interface ReconcileCandidatesInput {
  projectId: string;
  candidates: PRChangeCandidateV1[];
  features: Feature[];
  claims: Claim[];
  evidence: Evidence[];
  pullRequests: PullRequest[];
  releases: Release[];
  videos: VideoProject[];
  nowIso: string;
}

export interface ReconcileCandidatesResult {
  features: Feature[];
  claims: Claim[];
  evidence: Evidence[];
  pullRequests: PullRequest[];
  releases: Release[];
  videos: VideoProject[];
  summary: {
    updatedClaims: number;
    staleClaims: number;
    invalidatedVideoIds: string[];
  };
}

function isClaimDegraded(prev: Claim | undefined, next: Claim): boolean {
  const nextIsStaleOrRejected =
    next.status === 'stale' ||
    next.eligibility === 'blocked_stale' ||
    next.status === 'rejected' ||
    next.eligibility === 'blocked_rejected';
  if (nextIsStaleOrRejected) return true;
  if (!prev) return false;
  const wasPublishableOrVerified =
    prev.eligibility === 'publishable' || prev.status === 'verified';
  const lostPublishability =
    next.eligibility !== 'publishable' && next.status !== 'verified';
  return wasPublishableOrVerified && lostPublishability;
}

/**
 * Reconciles freshly fetched 4C candidates into the workspace:
 * 1. Updates PR & Release timeline for all candidates.
 * 2. Refreshes already-promoted Features, Claims, and Evidence (preserving
 *    user-edited Feature copy while treating 4C Claim eligibility/status as
 *    authoritative).
 * 3. Propagates AC-09 staleness / rejection / lost approval into referencing
 *    VideoProject scenes (`status = 'review'`) and invalidates approved videos.
 */
export function reconcileCandidatesIntoSnapshot(
  input: ReconcileCandidatesInput,
): ReconcileCandidatesResult {
  const { projectId, candidates, nowIso } = input;
  const candidateById = new Map(candidates.map((candidate) => [candidate.id, candidate]));

  const promotedCandidateIds = new Set<string>();
  for (const feature of input.features) {
    if (feature.projectId === projectId && feature.sourceCandidateId) {
      promotedCandidateIds.add(feature.sourceCandidateId);
    }
  }
  for (const claim of input.claims) {
    if (claim.projectId === projectId && claim.sourceCandidateId) {
      promotedCandidateIds.add(claim.sourceCandidateId);
    }
  }

  let nextFeatures = input.features;
  let nextClaims = input.claims;
  let nextEvidence = input.evidence;

  const previousClaimsById = new Map(
    input.claims
      .filter((claim) => claim.projectId === projectId)
      .map((claim) => [claim.id, claim]),
  );

  let updatedClaims = 0;
  let staleClaims = 0;
  const degradedClaimIds = new Set<string>();

  for (const candidateId of promotedCandidateIds) {
    const candidate = candidateById.get(candidateId);
    if (!candidate) continue;

    if (!candidate.promotable || candidate.claims.length === 0) {
      // Candidate ceased to be promotable on re-analysis: mark existing feature/claims stale/rejected.
      const affectedClaims = nextClaims.filter(
        (claim) => claim.projectId === projectId && claim.sourceCandidateId === candidateId,
      );
      for (const existingClaim of affectedClaims) {
        degradedClaimIds.add(existingClaim.id);
      }
      nextFeatures = nextFeatures.map((feature) =>
        feature.projectId === projectId && feature.sourceCandidateId === candidateId
          ? { ...feature, status: 'stale', updatedAt: nowIso }
          : feature,
      );
      nextClaims = nextClaims.map((claim) =>
        claim.projectId === projectId && claim.sourceCandidateId === candidateId
          ? {
              ...claim,
              status: 'rejected',
              eligibility: 'blocked_rejected',
              blockers: ['PR 在重新分析后不再属于可推广变更（AC-02）。'],
            }
          : claim,
      );
      continue;
    }

    const projected = upsertPromotedCandidateEntities(
      projectId,
      candidate,
      nextFeatures,
      nowIso,
    );

    nextFeatures = upsertById(nextFeatures, [projected.feature]);

    const candidateOldClaimIds = new Set(
      nextClaims
        .filter((item) => item.projectId === projectId && item.sourceCandidateId === candidateId)
        .map((item) => item.id),
    );

    nextClaims = upsertById(
      nextClaims.filter(
        (item) => !(item.projectId === projectId && item.sourceCandidateId === candidateId),
      ),
      projected.claims,
    );
    nextEvidence = upsertById(
      nextEvidence.filter(
        (item) =>
          !(
            item.projectId === projectId &&
            item.claimId !== undefined &&
            candidateOldClaimIds.has(item.claimId)
          ),
      ),
      projected.evidence,
    );

    for (const claim of projected.claims) {
      const prev = previousClaimsById.get(claim.id);
      if (
        !prev ||
        prev.status !== claim.status ||
        prev.eligibility !== claim.eligibility ||
        prev.verification?.verifiedAt !== claim.verification?.verifiedAt ||
        prev.evidenceIds.length !== claim.evidenceIds.length
      ) {
        updatedClaims += 1;
      }
      if (claim.status === 'stale' || claim.eligibility === 'blocked_stale') {
        staleClaims += 1;
      }
      if (isClaimDegraded(prev, claim)) {
        degradedClaimIds.add(claim.id);
      }
    }
  }

  const invalidatedVideoIds: string[] = [];
  const nextVideos = input.videos.map((video) => {
    if (video.projectId !== projectId || degradedClaimIds.size === 0) return video;
    const referencesDegraded = video.scenes.some((scene) =>
      scene.claimIds.some((claimId) => degradedClaimIds.has(claimId)),
    );
    if (!referencesDegraded) return video;

    let sceneChanged = false;
    const scenes = video.scenes.map((scene) => {
      if (
        scene.claimIds.some((claimId) => degradedClaimIds.has(claimId)) &&
        scene.status !== 'review'
      ) {
        sceneChanged = true;
        return { ...scene, status: 'review' as const };
      }
      return scene;
    });

    const wasApproved =
      video.review?.status === 'approved' ||
      video.stage === 'approved' ||
      video.stage === 'exported';

    if (wasApproved) {
      invalidatedVideoIds.push(video.id);
      return {
        ...video,
        scenes,
        stage: 'changes_requested' as const,
        review: {
          status: 'pending' as const,
          note: '关联声明的源码证据已过期或状态变更（AC-09），需在知识中心复核后重新生产并审核。',
        },
        updatedAt: nowIso,
      };
    }

    if (sceneChanged) {
      return { ...video, scenes, updatedAt: nowIso };
    }
    return video;
  });

  const timeline = projectCandidateTimeline(
    projectId,
    candidates,
    input.pullRequests,
    input.releases,
    nextFeatures,
  );

  return {
    features: nextFeatures,
    claims: nextClaims,
    evidence: nextEvidence,
    pullRequests: timeline.pullRequests,
    releases: timeline.releases,
    videos: nextVideos,
    summary: {
      updatedClaims,
      staleClaims,
      invalidatedVideoIds,
    },
  };
}
