import { describe, expect, it } from 'vitest';
import type {
  PRChangeCandidateV1,
  Project,
  Scene,
  VideoProject,
} from './index';
import {
  deriveFeatureNameFromTitle,
  promoteCandidateToKnowledge,
  reconcileCandidatesIntoSnapshot,
  workspaceClaimId,
  workspaceEvidenceId,
  workspaceFeatureId,
} from './knowledge-projection';

const COMMIT_1 = '1111111111111111111111111111111111111111';
const SNAP_1 = 'snap_11111111111111111111111111111111';
const DIGEST_1 = 'a'.repeat(64);
const DIGEST_2 = 'b'.repeat(64);
const ISO_1 = '2026-11-27T10:00:00.000Z';
const ISO_2 = '2026-11-27T11:00:00.000Z';

function makeCandidate(overrides: Partial<PRChangeCandidateV1> = {}): PRChangeCandidateV1 {
  const candidateId = overrides.id ?? 'prc_0000000000000101';
  const claimId = 'claim_0000000000000101';
  const srcEvId = 'evd_0000000000000101';
  return {
    schemaVersion: '1',
    id: candidateId,
    repo: 'acme/livenotes',
    pullNumber: 101,
    title: 'feat(export): add CSV export button',
    author: 'alice',
    state: 'closed',
    draft: false,
    merged: true,
    mergedAt: ISO_1,
    baseBranch: 'main',
    headBranch: 'feat/csv',
    headSha: COMMIT_1,
    mergeCommitSha: COMMIT_1,
    htmlUrl: 'https://github.com/acme/livenotes/pull/101',
    labels: ['feature'],
    classification: 'user_facing_feature',
    promotable: true,
    confidence: 88,
    rationale: ['Conventional feat 前缀', '修改前端界面文件 src/ui/export.tsx'],
    snapshotId: SNAP_1,
    changedFiles: [
      {
        path: 'src/ui/export.tsx',
        status: 'modified',
        additions: 24,
        deletions: 4,
        category: 'ui',
      },
    ],
    diffStats: {
      filesChanged: 1,
      additions: 24,
      deletions: 4,
      userFacingFiles: 1,
      internalFiles: 0,
      renamedOnlyFiles: 0,
    },
    claims: [
      {
        schemaVersion: '1',
        id: claimId,
        candidateId,
        repo: 'acme/livenotes',
        pullNumber: 101,
        statement: '支持导出 CSV 格式报表',
        audience: '所有产品用户',
        status: 'proposed',
        eligibility: 'blocked_unverified',
        verification: {
          commitSha: COMMIT_1,
          snapshotId: SNAP_1,
          environmentId: 'unverified',
          verifiedAt: ISO_1,
          validityScope: 'unverified',
          deployed: false,
        },
        evidenceIds: [srcEvId],
        blockers: ['未命中 Release，也没有任何真实环境的运行态证据；禁止声称「已上线」。'],
        guidance: '可以描述该变更已合并，但不得表述为「已上线 / 已可用」。',
      },
    ],
    evidence: [
      {
        id: srcEvId,
        kind: 'source',
        status: 'valid',
        title: '源码改动：src/ui/export.tsx',
        detail: 'PR #101 修改界面文件',
        filePath: 'src/ui/export.tsx',
        sourceDigest: DIGEST_1,
        commitSha: COMMIT_1,
        snapshotId: SNAP_1,
        capturedAt: ISO_1,
      },
    ],
    analyzedAt: ISO_1,
    ...overrides,
  };
}

function makeInternalCandidate(): PRChangeCandidateV1 {
  return {
    schemaVersion: '1',
    id: 'prc_0000000000000102',
    repo: 'acme/livenotes',
    pullNumber: 102,
    title: 'refactor: cleanup internal helper',
    author: 'bob',
    state: 'closed',
    draft: false,
    merged: true,
    mergedAt: ISO_1,
    baseBranch: 'main',
    headBranch: 'refactor/helper',
    headSha: COMMIT_1,
    mergeCommitSha: COMMIT_1,
    htmlUrl: 'https://github.com/acme/livenotes/pull/102',
    labels: [],
    classification: 'internal_non_promotable',
    promotable: false,
    confidence: 95,
    rationale: ['Conventional refactor 前缀'],
    snapshotId: SNAP_1,
    changedFiles: [
      {
        path: 'src/core/helper.ts',
        status: 'modified',
        additions: 5,
        deletions: 7,
        category: 'source',
      },
    ],
    diffStats: {
      filesChanged: 1,
      additions: 5,
      deletions: 7,
      userFacingFiles: 0,
      internalFiles: 1,
      renamedOnlyFiles: 0,
    },
    claims: [],
    evidence: [],
    analyzedAt: ISO_1,
  };
}

function makeProject(id: string): Project {
  return {
    id,
    name: 'LiveNotes',
    productName: 'LiveNotes',
    description: '',
    website: '',
    stage: 'active',
    brand: {
      logoText: 'LIVENOTES',
      logoMark: 'spark',
      primary: '#D7F36A',
      secondary: '#8B9DFF',
      fontPair: 'grotesk',
      style: 'editorial',
      intro: '',
      outro: '',
    },
    sources: [],
    defaultAspect: '16:9',
    defaultLanguage: 'zh-CN',
    templateId: 'tpl_signal',
    analysisCount: 1,
    createdAt: ISO_1,
    updatedAt: ISO_1,
    demo: false,
  };
}

function makeVideo(projectId: string, claimId: string, approved = true): VideoProject {
  const scene: Scene = {
    id: 'sc_1',
    order: 0,
    revision: 1,
    title: '导出 CSV',
    intent: '演示',
    narration: '旁白',
    caption: '支持导出 CSV 格式报表',
    durationSec: 6,
    visualType: 'motion',
    templateId: 'tpl_signal',
    claimIds: [claimId],
    status: 'approved',
    look: 'clean',
    brightness: 1,
    vignette: false,
  };
  return {
    id: 'vid_real_1',
    projectId,
    title: '版本更新',
    mode: 'release_video',
    stage: approved ? 'approved' : 'review',
    fps: 30,
    brief: {
      objective: '介绍新功能',
      audience: '用户',
      featureIds: [],
      durationSec: 12,
      aspect: '16:9',
      language: 'zh-CN',
      tone: 'confident',
      style: 'editorial',
      templateId: 'tpl_signal',
      useRealCapture: false,
      useGeneratedVisuals: false,
      cta: '立即使用',
      bannedPhrases: [],
    },
    scenes: [scene],
    directorMessages: [],
    scriptVersion: 1,
    createdAt: ISO_1,
    updatedAt: ISO_1,
    review: approved ? { status: 'approved', decidedAt: ISO_1 } : undefined,
    demo: false,
  };
}

describe('knowledge-projection', () => {
  it('deriveFeatureNameFromTitle 会去除 Conventional 前缀', () => {
    expect(deriveFeatureNameFromTitle('feat(export): add CSV export button')).toBe(
      'add CSV export button',
    );
    expect(deriveFeatureNameFromTitle('自定义功能标题')).toBe('自定义功能标题');
  });

  it('AC-02: internal_non_promotable 与 ambiguous_needs_review 候选被硬拒绝写入功能目录', () => {
    const internal = makeInternalCandidate();
    const res1 = promoteCandidateToKnowledge({
      projectId: 'proj_a',
      candidate: internal,
      features: [],
      claims: [],
      evidence: [],
      pullRequests: [],
      releases: [],
      nowIso: ISO_1,
    });
    expect(res1.ok).toBe(false);

    const ambiguous: PRChangeCandidateV1 = {
      ...internal,
      id: 'prc_0000000000000103',
      pullNumber: 103,
      classification: 'ambiguous_needs_review',
    };
    const res2 = promoteCandidateToKnowledge({
      projectId: 'proj_a',
      candidate: ambiguous,
      features: [],
      claims: [],
      evidence: [],
      pullRequests: [],
      releases: [],
      nowIso: ISO_1,
    });
    expect(res2.ok).toBe(false);
  });

  it('幂等写入功能目录时保留人工编辑的功能名称与摘要，但 Claim 以 4C 为唯一事实源', () => {
    const candidate = makeCandidate();
    const first = promoteCandidateToKnowledge({
      projectId: 'proj_a',
      candidate,
      features: [],
      claims: [],
      evidence: [],
      pullRequests: [],
      releases: [],
      nowIso: ISO_1,
    });
    expect(first.ok).toBe(true);
    if (!first.ok) return;

    expect(first.features[0]!.demo).toBe(false);
    expect(first.claims[0]!.eligibility).toBe('blocked_unverified');
    expect(first.evidence[0]!.sourceDigest).toBe(DIGEST_1);

    const editedFeatures = first.features.map((item) => ({
      ...item,
      name: '人工润色名称',
      summary: '人工润色摘要',
    }));

    const verifiedCandidate: PRChangeCandidateV1 = {
      ...candidate,
      claims: [
        {
          ...candidate.claims[0]!,
          status: 'verified',
          eligibility: 'publishable',
          blockers: [],
          verification: {
            ...candidate.claims[0]!.verification,
            environmentId: 'production',
            deployed: true,
            validityScope: 'production_runtime_approved',
          },
        },
      ],
    };

    const second = promoteCandidateToKnowledge({
      projectId: 'proj_a',
      candidate: verifiedCandidate,
      features: editedFeatures,
      claims: first.claims,
      evidence: first.evidence,
      pullRequests: first.pullRequests,
      releases: first.releases,
      nowIso: ISO_2,
    });
    expect(second.ok).toBe(true);
    if (!second.ok) return;

    expect(second.features).toHaveLength(1);
    expect(second.features[0]!.name).toBe('人工润色名称');
    expect(second.features[0]!.summary).toBe('人工润色摘要');
    expect(second.features[0]!.status).toBe('deployed');
    expect(second.claims[0]!.status).toBe('verified');
    expect(second.claims[0]!.eligibility).toBe('publishable');
  });

  it('同工作区内两个项目关联同一仓库时，ID 按 projectId 隔离互不覆盖', () => {
    const projA = makeProject('proj_a');
    const projB = makeProject('proj_b');
    const candidate = makeCandidate();

    const a = promoteCandidateToKnowledge({
      projectId: projA.id,
      candidate,
      features: [],
      claims: [],
      evidence: [],
      pullRequests: [],
      releases: [],
      nowIso: ISO_1,
    });
    expect(a.ok).toBe(true);
    if (!a.ok) return;

    const b = promoteCandidateToKnowledge({
      projectId: projB.id,
      candidate,
      features: a.features,
      claims: a.claims,
      evidence: a.evidence,
      pullRequests: a.pullRequests,
      releases: a.releases,
      nowIso: ISO_1,
    });
    expect(b.ok).toBe(true);
    if (!b.ok) return;

    expect(b.features).toHaveLength(2);
    expect(b.claims).toHaveLength(2);
    expect(workspaceFeatureId('proj_a', candidate.id)).not.toBe(
      workspaceFeatureId('proj_b', candidate.id),
    );
    expect(workspaceClaimId('proj_a', 'claim_0000000000000101')).not.toBe(
      workspaceClaimId('proj_b', 'claim_0000000000000101'),
    );
    expect(workspaceEvidenceId('proj_a', 'evd_0000000000000101')).not.toBe(
      workspaceEvidenceId('proj_b', 'evd_0000000000000101'),
    );
  });

  it('AC-09: 过期传播后工作区同步会将 Feature/Claim/Evidence 置 stale，使引用场景回到 review 并失效已批准视频', () => {
    const candidate = makeCandidate({
      claims: [
        {
          ...makeCandidate().claims[0]!,
          status: 'verified',
          eligibility: 'publishable',
          blockers: [],
        },
      ],
    });
    const promoted = promoteCandidateToKnowledge({
      projectId: 'proj_a',
      candidate,
      features: [],
      claims: [],
      evidence: [],
      pullRequests: [],
      releases: [],
      nowIso: ISO_1,
    });
    expect(promoted.ok).toBe(true);
    if (!promoted.ok) return;

    const wsClaimId = promoted.claims[0]!.id;
    const approvedVideo = makeVideo('proj_a', wsClaimId, true);
    const unrelatedVideo = makeVideo('proj_a', 'claim_other', true);
    unrelatedVideo.id = 'vid_unrelated';

    const staleCandidate: PRChangeCandidateV1 = {
      ...candidate,
      claims: [
        {
          ...candidate.claims[0]!,
          status: 'stale',
          eligibility: 'blocked_stale',
          blockers: ['引用的源文件已变更或删除（AC-09）。'],
        },
      ],
      evidence: [
        {
          ...candidate.evidence[0]!,
          status: 'stale',
          sourceDigest: DIGEST_2,
        },
      ],
    };

    const internal = makeInternalCandidate();
    const reconciled = reconcileCandidatesIntoSnapshot({
      projectId: 'proj_a',
      candidates: [staleCandidate, internal],
      features: promoted.features,
      claims: promoted.claims,
      evidence: promoted.evidence,
      pullRequests: promoted.pullRequests,
      releases: promoted.releases,
      videos: [approvedVideo, unrelatedVideo],
      nowIso: ISO_2,
    });

    expect(reconciled.summary.staleClaims).toBe(1);
    expect(reconciled.summary.invalidatedVideoIds).toEqual([approvedVideo.id]);
    expect(reconciled.features[0]!.status).toBe('stale');
    expect(reconciled.claims[0]!.status).toBe('stale');
    expect(reconciled.claims[0]!.eligibility).toBe('blocked_stale');
    expect(reconciled.evidence[0]!.status).toBe('stale');

    const updatedApproved = reconciled.videos.find((v) => v.id === approvedVideo.id)!;
    expect(updatedApproved.stage).toBe('changes_requested');
    expect(updatedApproved.review?.status).toBe('pending');
    expect(updatedApproved.scenes[0]!.status).toBe('review');

    const keptUnrelated = reconciled.videos.find((v) => v.id === unrelatedVideo.id)!;
    expect(keptUnrelated.stage).toBe('approved');
    expect(keptUnrelated.scenes[0]!.status).toBe('approved');

    // Internal PR appears in timeline without featureIds.
    const internalPr = reconciled.pullRequests.find((pr) => pr.number === 102)!;
    expect(internalPr.kind).toBe('internal');
    expect(internalPr.featureIds).toEqual([]);
  });
});
