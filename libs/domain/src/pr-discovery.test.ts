import { describe, expect, it } from 'vitest';
import {
  claimVerificationInputV1Schema,
  evaluateClaimPublishability,
  prChangeCandidateV1Schema,
  propagateSnapshotStaleness,
  type ClaimCandidateV1,
  type EvidenceRefV1,
  type PRChangeCandidateV1,
} from './pr-discovery';

const REPO = 'frontLikeDog/livenotes';
const COMMIT = '1'.repeat(40);
const MERGE_COMMIT = '2'.repeat(40);
const SNAPSHOT_ID = `snap_${'a'.repeat(32)}`;
const LATEST_SNAPSHOT_ID = `snap_${'b'.repeat(32)}`;
const CANDIDATE_ID = `prc_${'c'.repeat(16)}`;
const CLAIM_ID = `claim_${'d'.repeat(16)}`;
const SOURCE_EVIDENCE_ID = `evd_${'e'.repeat(16)}`;
const ANALYZED_AT = '2026-11-27T10:00:00.000Z';

function sourceEvidence(overrides: Partial<EvidenceRefV1> = {}): EvidenceRefV1 {
  return {
    id: SOURCE_EVIDENCE_ID,
    kind: 'source',
    status: 'valid',
    title: 'app/main.py',
    detail: '变更文件（modified）作为源码证据',
    filePath: 'app/main.py',
    sourceDigest: 'e'.repeat(64),
    commitSha: MERGE_COMMIT,
    snapshotId: SNAPSHOT_ID,
    capturedAt: '2026-11-27T09:00:00.000Z',
    ...overrides,
  };
}

function buildClaim(
  evidence: EvidenceRefV1[],
  overrides: Partial<ClaimCandidateV1> = {},
): ClaimCandidateV1 {
  const evaluation = evaluateClaimPublishability({
    classification: 'user_facing_feature',
    evidence,
    commitSha: MERGE_COMMIT,
    snapshotId: SNAPSHOT_ID,
    evaluatedAt: ANALYZED_AT,
  });
  return {
    schemaVersion: '1',
    id: CLAIM_ID,
    candidateId: CANDIDATE_ID,
    repo: REPO,
    pullNumber: 12,
    statement: '支持笔记增量同步',
    audience: '现有用户',
    status: evaluation.status,
    eligibility: evaluation.eligibility,
    verification: evaluation.verification,
    evidenceIds: evidence.map((item) => item.id),
    blockers: evaluation.blockers,
    guidance: evaluation.guidance,
    ...overrides,
  };
}

function buildCandidate(
  evidence: EvidenceRefV1[] = [sourceEvidence()],
  overrides: Partial<PRChangeCandidateV1> = {},
): PRChangeCandidateV1 {
  const claim = buildClaim(evidence);
  return {
    schemaVersion: '1',
    id: CANDIDATE_ID,
    repo: REPO,
    pullNumber: 12,
    title: 'feat: 支持笔记增量同步',
    author: 'frontLikeDog',
    state: 'closed',
    draft: false,
    merged: true,
    mergedAt: '2026-11-26T08:00:00.000Z',
    baseBranch: 'main',
    headBranch: 'feat/sync',
    headSha: COMMIT,
    mergeCommitSha: MERGE_COMMIT,
    htmlUrl: 'https://github.com/frontLikeDog/livenotes/pull/12',
    labels: ['feature'],
    classification: 'user_facing_feature',
    promotable: true,
    confidence: 85,
    rationale: ['Conventional 前缀 feat 表明用户可感知的新功能'],
    snapshotId: SNAPSHOT_ID,
    changedFiles: [
      {
        path: 'app/main.py',
        status: 'modified',
        additions: 20,
        deletions: 2,
        category: 'source',
      },
    ],
    diffStats: {
      filesChanged: 1,
      additions: 20,
      deletions: 2,
      userFacingFiles: 1,
      internalFiles: 0,
      renamedOnlyFiles: 0,
    },
    claims: [claim],
    evidence,
    analyzedAt: ANALYZED_AT,
    ...overrides,
  };
}

describe('PR 变更候选 Schema 不变量', () => {
  it('接受可推广候选，并绑定 Claim 与证据', () => {
    const parsed = prChangeCandidateV1Schema.parse(buildCandidate());
    expect(parsed.claims).toHaveLength(1);
    expect(parsed.claims[0]?.evidenceIds).toEqual([SOURCE_EVIDENCE_ID]);
  });

  it('AC-02：内部变更声明 promotable 或携带 Claim 都会被拒绝', () => {
    const withClaim = buildCandidate(undefined, {
      classification: 'internal_non_promotable',
      promotable: false,
    });
    // Claims were built for a user-facing candidate; an internal candidate
    // keeping them must fail the cross-field invariant.
    const invalid = prChangeCandidateV1Schema.safeParse(withClaim);
    expect(invalid.success).toBe(false);

    const stillPromotable = prChangeCandidateV1Schema.safeParse(
      buildCandidate(undefined, { classification: 'internal_non_promotable', promotable: true }),
    );
    expect(stillPromotable.success).toBe(false);
  });

  it('合并的候选必须带 mergedAt，且不能引用不存在的证据', () => {
    expect(
      prChangeCandidateV1Schema.safeParse(buildCandidate(undefined, { mergedAt: null })).success,
    ).toBe(false);

    const brokenClaim = buildClaim([sourceEvidence()]);
    brokenClaim.evidenceIds = [`evd_${'f'.repeat(16)}`];
    expect(
      prChangeCandidateV1Schema.safeParse(buildCandidate(undefined, { claims: [brokenClaim] }))
        .success,
    ).toBe(false);
  });
});

describe('Claim 发布守门（AC-03 / docs/08 §5）', () => {
  const base = {
    classification: 'user_facing_feature' as const,
    commitSha: MERGE_COMMIT,
    snapshotId: SNAPSHOT_ID,
    evaluatedAt: ANALYZED_AT,
  };

  it('已合并但无发布/运行态证据：blocked_unverified，禁止「已上线」', () => {
    const result = evaluateClaimPublishability({ ...base, evidence: [sourceEvidence()] });
    expect(result.eligibility).toBe('blocked_unverified');
    expect(result.status).toBe('proposed');
    expect(result.verification.deployed).toBe(false);
    expect(result.verification.environmentId).toBe('unverified');
    expect(result.blockers.join(' ')).toContain('禁止声称「已上线」');
    expect(result.guidance).toContain('不得表述');
  });

  it('只有 Release 证据：needs_qualification，仍不得声称已上线', () => {
    const result = evaluateClaimPublishability({
      ...base,
      evidence: [
        sourceEvidence(),
        {
          id: `evd_${'1'.repeat(16)}`,
          kind: 'release',
          status: 'valid',
          title: 'Release v1.4.0',
          detail: 'Release body 显式提及 #12',
          releaseTag: 'v1.4.0',
          environmentId: 'release',
          capturedAt: '2026-11-27T09:30:00.000Z',
        },
      ],
    });
    expect(result.eligibility).toBe('needs_qualification');
    expect(result.verification.deployed).toBe(true);
    expect(result.verification.releaseTag).toBe('v1.4.0');
    expect(result.verification.validityScope).toBe('release_only:v1.4.0');
    expect(result.blockers.join(' ')).toContain('没有真实环境运行态证据');
  });

  it('仅 staging 运行态：needs_qualification 且必须标注环境', () => {
    const result = evaluateClaimPublishability({
      ...base,
      evidence: [
        sourceEvidence(),
        {
          id: `evd_${'2'.repeat(16)}`,
          kind: 'runtime',
          status: 'valid',
          title: 'staging 手工验收',
          detail: '在 staging 完整走通笔记同步',
          environmentId: 'staging',
          capturedAt: '2026-11-27T09:40:00.000Z',
        },
      ],
    });
    expect(result.eligibility).toBe('needs_qualification');
    expect(result.verification.environmentId).toBe('staging');
    expect(result.guidance).toContain('仅 staging');
  });

  it('生产运行态但缺人工批准：blocked_unverified', () => {
    const result = evaluateClaimPublishability({
      ...base,
      evidence: [
        sourceEvidence(),
        {
          id: `evd_${'3'.repeat(16)}`,
          kind: 'runtime',
          status: 'valid',
          title: 'production 运行确认',
          detail: '生产环境真实操作成功',
          environmentId: 'production',
          testRunId: 'run_42',
          capturedAt: '2026-11-27T09:45:00.000Z',
        },
      ],
    });
    expect(result.eligibility).toBe('blocked_unverified');
    expect(result.verification.environmentId).toBe('production');
    expect(result.verification.testRunId).toBe('run_42');
    expect(result.blockers.join(' ')).toContain('人工批准');
  });

  it('生产运行态 + 人工批准：publishable / verified', () => {
    const result = evaluateClaimPublishability({
      ...base,
      evidence: [
        sourceEvidence(),
        {
          id: `evd_${'4'.repeat(16)}`,
          kind: 'runtime',
          status: 'valid',
          title: 'production 运行确认',
          detail: '生产环境真实操作成功',
          environmentId: 'production',
          capturedAt: '2026-11-27T09:45:00.000Z',
        },
        {
          id: `evd_${'5'.repeat(16)}`,
          kind: 'human',
          status: 'valid',
          title: '产品负责人批准',
          detail: '已审核 Claim 文案与演示画面一致',
          decision: 'approve',
          capturedAt: '2026-11-27T09:50:00.000Z',
        },
      ],
    });
    expect(result.eligibility).toBe('publishable');
    expect(result.status).toBe('verified');
    expect(result.verification.validityScope).toBe('production_runtime_approved');
    expect(result.blockers).toEqual([]);
  });

  it('最新人工决定是驳回时：blocked_rejected 且 status = rejected', () => {
    const result = evaluateClaimPublishability({
      ...base,
      evidence: [
        sourceEvidence(),
        {
          id: `evd_${'6'.repeat(16)}`,
          kind: 'human',
          status: 'valid',
          title: '产品负责人驳回',
          detail: '文案夸大，需要改写',
          decision: 'reject',
          capturedAt: '2026-11-27T09:50:00.000Z',
        },
      ],
    });
    expect(result.eligibility).toBe('blocked_rejected');
    expect(result.status).toBe('rejected');
  });

  it('存在过期证据：blocked_stale 优先于未部署', () => {
    const result = evaluateClaimPublishability({
      ...base,
      evidence: [sourceEvidence({ status: 'stale' })],
    });
    expect(result.eligibility).toBe('blocked_stale');
    expect(result.status).toBe('stale');
  });

  it('内部变更即使有证据也不得发布', () => {
    const result = evaluateClaimPublishability({
      ...base,
      classification: 'internal_non_promotable',
      evidence: [sourceEvidence()],
    });
    expect(result.eligibility).toBe('blocked_rejected');
  });

  it('跨时区 ISO 时间戳按真实时间比较，避免字典序误判人工决定顺序', () => {
    // 17:00+08:00 == 09:00Z（更早），但字符串字典序大于 09:30Z；真正的最新决定是 reject。
    const result = evaluateClaimPublishability({
      ...base,
      evidence: [
        sourceEvidence(),
        {
          id: `evd_${'7'.repeat(16)}`,
          kind: 'runtime',
          status: 'valid',
          title: 'production 运行确认',
          detail: 'ok',
          environmentId: 'production',
          capturedAt: '2026-11-27T08:50:00.000Z',
        },
        {
          id: `evd_${'8'.repeat(16)}`,
          kind: 'human',
          status: 'valid',
          title: '人工批准',
          detail: 'approve',
          decision: 'approve',
          actor: 'alice',
          capturedAt: '2026-11-27T17:00:00+08:00',
        },
        {
          id: `evd_${'9'.repeat(16)}`,
          kind: 'human',
          status: 'valid',
          title: '人工驳回',
          detail: 'reject',
          decision: 'reject',
          actor: 'bob',
          capturedAt: '2026-11-27T09:30:00.000Z',
        },
      ],
    });
    expect(result.eligibility).toBe('blocked_rejected');
    expect(result.status).toBe('rejected');
  });

  it('test 证据的 testRunId 写入核验上下文，runtime 证据优先覆盖', () => {
    const withTestOnly = evaluateClaimPublishability({
      ...base,
      evidence: [
        sourceEvidence(),
        {
          id: `evd_${'a'.repeat(16)}`,
          kind: 'test',
          status: 'valid',
          title: 'CI 测试',
          detail: '通过',
          testRunId: 'gha-100',
          capturedAt: '2026-11-27T09:10:00.000Z',
        },
      ],
    });
    expect(withTestOnly.eligibility).toBe('blocked_unverified');
    expect(withTestOnly.verification.testRunId).toBe('gha-100');

    const withRuntime = evaluateClaimPublishability({
      ...base,
      evidence: [
        sourceEvidence(),
        {
          id: `evd_${'a'.repeat(16)}`,
          kind: 'test',
          status: 'valid',
          title: 'CI 测试',
          detail: '通过',
          testRunId: 'gha-100',
          capturedAt: '2026-11-27T09:10:00.000Z',
        },
        {
          id: `evd_${'b'.repeat(16)}`,
          kind: 'runtime',
          status: 'valid',
          title: 'staging 运行态',
          detail: 'ok',
          environmentId: 'staging',
          testRunId: 'demo-run-7',
          capturedAt: '2026-11-27T09:20:00.000Z',
        },
      ],
    });
    expect(withRuntime.verification.testRunId).toBe('demo-run-7');
  });

  it('核验输入校验：human 必带 decision，verifiedAt 必须为合法 ISO-8601', () => {
    expect(
      claimVerificationInputV1Schema.safeParse({
        kind: 'human',
        note: '缺少决定',
      }).success,
    ).toBe(false);

    expect(
      claimVerificationInputV1Schema.safeParse({
        kind: 'test',
        note: '非法时间',
        verifiedAt: 'not-a-date',
      }).success,
    ).toBe(false);

    expect(
      claimVerificationInputV1Schema.safeParse({
        kind: 'human',
        note: '批准发布',
        actor: 'pm-chen',
        decision: 'approve',
        verifiedAt: '2026-11-27T17:30:00+08:00',
      }).success,
    ).toBe(true);
  });
});

describe('AC-09 快照过期传播', () => {
  it('引用文件内容变化：证据与 Claim 标记 stale', () => {
    const candidate = buildCandidate();
    const result = propagateSnapshotStaleness(
      candidate,
      {
        id: LATEST_SNAPSHOT_ID,
        sourceDigests: { 'app/main.py': '9'.repeat(64) },
      },
      '2026-11-28T10:00:00.000Z',
    );

    expect(result.changed).toBe(true);
    expect(result.staleFiles).toEqual(['app/main.py']);
    expect(result.evidenceMarkedStale).toBe(1);
    expect(result.claimsMarkedStale).toEqual([CLAIM_ID]);
    expect(result.candidate.evidence[0]?.status).toBe('stale');
    expect(result.candidate.claims[0]?.status).toBe('stale');
    expect(result.candidate.claims[0]?.eligibility).toBe('blocked_stale');
  });

  it('引用文件被删除：同样标记 stale', () => {
    const candidate = buildCandidate();
    const result = propagateSnapshotStaleness(
      candidate,
      { id: LATEST_SNAPSHOT_ID, sourceDigests: { 'README.md': '8'.repeat(64) } },
      '2026-11-28T10:00:00.000Z',
    );

    expect(result.staleFiles).toEqual(['app/main.py']);
    expect(result.candidate.claims[0]?.status).toBe('stale');
  });

  it('指纹未变：证据与 Claim 保持原状', () => {
    const candidate = buildCandidate();
    const result = propagateSnapshotStaleness(
      candidate,
      { id: LATEST_SNAPSHOT_ID, sourceDigests: { 'app/main.py': 'e'.repeat(64) } },
      ANALYZED_AT,
    );

    expect(result.changed).toBe(false);
    expect(result.staleFiles).toEqual([]);
    expect(result.candidate.evidence).toEqual(candidate.evidence);
    expect(result.candidate.claims).toEqual(candidate.claims);
  });

  it('未绑定指纹的证据不会被误判', () => {
    const unbound = sourceEvidence({
      sourceDigest: undefined,
      snapshotId: undefined,
    });
    const candidate = buildCandidate([unbound]);
    const result = propagateSnapshotStaleness(
      candidate,
      { id: LATEST_SNAPSHOT_ID, sourceDigests: {} },
      ANALYZED_AT,
    );

    expect(result.changed).toBe(false);
    expect(result.candidate.claims[0]?.status).toBe(candidate.claims[0]?.status);
  });
});
