import { z } from 'zod';
import { GITHUB_FILE_STATUSES } from './github';
import {
  gitObjectShaSchema,
  knowledgeSnapshotIdSchema,
  sha256HexSchema,
  type KnowledgeSnapshotV1,
} from './knowledge';
import {
  CLAIM_PUBLISH_ELIGIBILITIES,
  CLAIM_VERIFICATION_DECISIONS,
  PR_CHANGE_CLASSIFICATIONS,
  claimPublishEligibilitySchema,
  claimStatusSchema,
  claimVerificationDecisionSchema,
  evidenceKindSchema,
  evidenceStatusSchema,
  prChangeClassificationSchema,
  type ClaimPublishEligibility,
  type ClaimStatus,
  type ClaimVerificationDecision,
  type PRChangeClassification,
} from './schemas';

/**
 * Step 4C · PR 变更发现、Claim 候选与发布守门契约。
 *
 * 与 `knowledge.ts` 一样，本模块只依赖 zod：所有规则都是纯函数，不做 I/O、
 * 不读时钟、不访问网络，因此浏览器与 Node 都能安全引用。
 *
 * 数据流：`PRChangeCandidateV1`（一次 PR 分析）→ 若干 `ClaimCandidateV1`
 * （可拍视频的声明候选）→ `EvidenceRefV1`（源码 / 测试 / 运行态 / 发布 / 人工）。
 * 发布资格永远由 `evaluateClaimPublishability` 推导，绝不手写。
 */

export const PR_DISCOVERY_SCHEMA_VERSION = '1' as const;

export const PR_CANDIDATE_ID_PREFIX = 'prc_' as const;
export const CLAIM_CANDIDATE_ID_PREFIX = 'claim_' as const;
export const EVIDENCE_REF_ID_PREFIX = 'evd_' as const;
export const CLAIM_VERIFICATION_ID_PREFIX = 'vrf_' as const;

export const prCandidateIdSchema = z
  .string()
  .regex(/^prc_[0-9a-f]{16}$/, '候选 ID 必须是 prc_ 加 16 位小写十六进制');
export type PRCandidateId = z.infer<typeof prCandidateIdSchema>;

export const claimCandidateIdSchema = z
  .string()
  .regex(/^claim_[0-9a-f]{16}$/, 'Claim ID 必须是 claim_ 加 16 位小写十六进制');
export type ClaimCandidateId = z.infer<typeof claimCandidateIdSchema>;

export const evidenceRefIdSchema = z
  .string()
  .regex(/^evd_[0-9a-f]{16}$/, '证据 ID 必须是 evd_ 加 16 位小写十六进制');

export const claimVerificationRecordIdSchema = z
  .string()
  .regex(/^vrf_[0-9a-f]{16}$/, '核验记录 ID 必须是 vrf_ 加 16 位小写十六进制');

export const discoveryRepoSchema = z
  .string()
  .min(3)
  .max(201)
  .regex(/^[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}$/, 'repo 必须是 owner/repo 格式');

/** 默认环境：尚未绑定任何真实运行环境。 */
export const UNVERIFIED_ENVIRONMENT_ID = 'unverified' as const;
export const PRODUCTION_ENVIRONMENT_ID = 'production' as const;

export const verificationEnvironmentIdSchema = z
  .string()
  .transform((value) => value.trim().toLowerCase())
  .pipe(
    z
      .string()
      .min(1)
      .max(80)
      .regex(/^[a-z0-9][a-z0-9._-]*$/, '环境标识只能包含小写字母、数字、.、_ 与 -'),
  );

export {
  PR_CHANGE_CLASSIFICATIONS,
  prChangeClassificationSchema,
  type PRChangeClassification,
};

const USER_FACING_CLASSIFICATIONS: ReadonlySet<PRChangeClassification> = new Set([
  'user_facing_feature',
  'user_facing_improvement',
]);

export function isPromotableClassification(classification: PRChangeClassification): boolean {
  return USER_FACING_CLASSIFICATIONS.has(classification);
}

export {
  CLAIM_PUBLISH_ELIGIBILITIES,
  claimPublishEligibilitySchema,
  type ClaimPublishEligibility,
};

/**
 * `deployed` 只表示「存在发布证据或真实环境运行态证据」，不等于「生产可用」。
 * `environmentId` 记录运行态验证发生的环境；只有 `production` 才能支撑
 * 「已上线」的表述。
 */
export const verificationContextV1Schema = z.object({
  commitSha: gitObjectShaSchema,
  snapshotId: knowledgeSnapshotIdSchema.optional(),
  environmentId: verificationEnvironmentIdSchema.default(UNVERIFIED_ENVIRONMENT_ID),
  appVersion: z.string().min(1).max(120).optional(),
  releaseTag: z.string().min(1).max(120).optional(),
  testRunId: z.string().min(1).max(200).optional(),
  verifiedAt: z.string().min(1),
  /** 该 Claim 的核验范围，如 `production_runtime_approved`。 */
  validityScope: z.string().min(1).max(240),
  deployed: z.boolean(),
});
export type VerificationContextV1 = z.infer<typeof verificationContextV1Schema>;

export {
  CLAIM_VERIFICATION_DECISIONS,
  claimVerificationDecisionSchema,
  type ClaimVerificationDecision,
};

export const evidenceRefV1Schema = z.object({
  id: evidenceRefIdSchema,
  kind: evidenceKindSchema,
  status: evidenceStatusSchema,
  title: z.string().min(1).max(200),
  detail: z.string().max(1000),
  /** test / runtime / release 证据对应的环境。 */
  environmentId: verificationEnvironmentIdSchema.optional(),
  /** source 证据绑定的文件与 SHA256 指纹（来自 4B 快照）。 */
  filePath: z.string().min(1).max(1024).optional(),
  sourceDigest: sha256HexSchema.optional(),
  commitSha: gitObjectShaSchema.optional(),
  snapshotId: knowledgeSnapshotIdSchema.optional(),
  releaseTag: z.string().min(1).max(120).optional(),
  testRunId: z.string().min(1).max(200).optional(),
  /** 仅 human 证据使用：人工批准或驳回。 */
  decision: claimVerificationDecisionSchema.optional(),
  /** 审核人或自动化执行主体标识（docs/08 §5–§6）。 */
  actor: z.string().min(1).max(120).optional(),
  capturedAt: z.string().min(1),
});
export type EvidenceRefV1 = z.infer<typeof evidenceRefV1Schema>;

export const PR_FILE_CATEGORIES = [
  'ui',
  'source',
  'test',
  'ci',
  'build',
  'config',
  'docs',
  'other',
] as const;
export const prFileCategorySchema = z.enum(PR_FILE_CATEGORIES);
export type PRFileCategory = z.infer<typeof prFileCategorySchema>;

export const prChangedFileSchema = z.object({
  path: z.string().min(1).max(1024),
  status: z.enum(GITHUB_FILE_STATUSES),
  additions: z.number().int().min(0),
  deletions: z.number().int().min(0),
  previousPath: z.string().min(1).max(1024).optional(),
  category: prFileCategorySchema,
});
export type PRChangedFile = z.infer<typeof prChangedFileSchema>;

export const claimCandidateV1Schema = z.object({
  schemaVersion: z.literal(PR_DISCOVERY_SCHEMA_VERSION),
  id: claimCandidateIdSchema,
  candidateId: prCandidateIdSchema,
  repo: discoveryRepoSchema,
  pullNumber: z.number().int().positive(),
  statement: z.string().min(1).max(400),
  audience: z.string().min(1).max(200),
  status: claimStatusSchema,
  eligibility: claimPublishEligibilitySchema,
  verification: verificationContextV1Schema,
  evidenceIds: z.array(evidenceRefIdSchema).max(50),
  blockers: z.array(z.string().min(1).max(300)).max(20),
  guidance: z.string().min(1).max(500),
});
export type ClaimCandidateV1 = z.infer<typeof claimCandidateV1Schema>;

const releaseMatchSchema = z.object({
  tagName: z.string().min(1).max(120),
  name: z.string().max(200).nullable(),
  publishedAt: z.string().min(1),
  matchedBy: z.enum(['merge_commit', 'body_reference']),
  htmlUrl: z.string().url(),
});

export const prChangeCandidateV1Schema = z
  .object({
    schemaVersion: z.literal(PR_DISCOVERY_SCHEMA_VERSION),
    id: prCandidateIdSchema,
    repo: discoveryRepoSchema,
    pullNumber: z.number().int().positive(),
    title: z.string().max(400),
    author: z.string().max(120),
    state: z.enum(['open', 'closed']),
    draft: z.boolean(),
    merged: z.boolean(),
    mergedAt: z.string().min(1).nullable(),
    baseBranch: z.string().min(1).max(255),
    headBranch: z.string().max(255),
    headSha: gitObjectShaSchema,
    mergeCommitSha: gitObjectShaSchema.nullable(),
    htmlUrl: z.string().url(),
    labels: z.array(z.string().max(120)).max(50),
    classification: prChangeClassificationSchema,
    /** 只有 user_facing_* 才允许为 true；恒等于分类的可推广性。 */
    promotable: z.boolean(),
    confidence: z.number().int().min(0).max(100),
    rationale: z.array(z.string().min(1).max(400)).min(1).max(20),
    snapshotId: knowledgeSnapshotIdSchema.optional(),
    changedFiles: z.array(prChangedFileSchema).max(200),
    diffStats: z.object({
      filesChanged: z.number().int().min(0),
      additions: z.number().int().min(0),
      deletions: z.number().int().min(0),
      userFacingFiles: z.number().int().min(0),
      internalFiles: z.number().int().min(0),
      renamedOnlyFiles: z.number().int().min(0),
    }),
    release: releaseMatchSchema.optional(),
    claims: z.array(claimCandidateV1Schema).max(5),
    evidence: z.array(evidenceRefV1Schema).max(50),
    analyzedAt: z.string().min(1),
  })
  .superRefine((candidate, ctx) => {
    const { id, repo, pullNumber, classification, promotable, claims, evidence } = candidate;

    // AC-02：内部变更 / 待复核变更绝不能自称可推广，更不能产出 Claim。
    if (promotable !== isPromotableClassification(classification)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['promotable'],
        message: 'promotable 必须与 classification 一致（仅 user_facing_* 可推广）',
      });
    }
    if (!isPromotableClassification(classification) && claims.length > 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['claims'],
        message: '内部或待复核变更不得产出 Claim 候选',
      });
    }
    if (candidate.merged && !candidate.mergedAt) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['mergedAt'],
        message: 'merged 为 true 时必须记录 mergedAt',
      });
    }

    const evidenceIds = new Set(evidence.map((item) => item.id));
    if (evidenceIds.size !== evidence.length) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['evidence'],
        message: '证据 ID 不能重复',
      });
    }
    const claimIds = new Set(claims.map((claim) => claim.id));
    if (claimIds.size !== claims.length) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['claims'],
        message: 'Claim ID 不能重复',
      });
    }

    for (const claim of claims) {
      if (claim.candidateId !== id || claim.repo !== repo || claim.pullNumber !== pullNumber) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['claims'],
          message: 'Claim 必须属于其所属候选（candidateId / repo / pullNumber 一致）',
        });
      }
      for (const evidenceId of claim.evidenceIds) {
        if (!evidenceIds.has(evidenceId)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ['claims'],
            message: `Claim ${claim.id} 引用了不存在的证据 ${evidenceId}`,
          });
        }
      }
    }
  });
export type PRChangeCandidateV1 = z.infer<typeof prChangeCandidateV1Schema>;

export const prDiscoveryReportV1Schema = z.object({
  schemaVersion: z.literal(PR_DISCOVERY_SCHEMA_VERSION),
  repo: discoveryRepoSchema,
  branch: z.string().min(1).max(255),
  snapshotId: knowledgeSnapshotIdSchema.optional(),
  requestedState: z.enum(['open', 'closed', 'all']),
  analyzedAt: z.string().min(1),
  summary: z.object({
    analyzed: z.number().int().min(0),
    userFacingFeature: z.number().int().min(0),
    userFacingImprovement: z.number().int().min(0),
    internal: z.number().int().min(0),
    ambiguous: z.number().int().min(0),
    claims: z.number().int().min(0),
    claimsBlockedUnverified: z.number().int().min(0),
    claimsBlockedStale: z.number().int().min(0),
    claimsPublishable: z.number().int().min(0),
  }),
  /** 单个 PR 分析失败不阻断整体发现，但会被如实列出。 */
  errors: z.array(
    z.object({
      pullNumber: z.number().int().positive(),
      message: z.string().min(1).max(500),
    }),
  ),
  candidates: z.array(prChangeCandidateV1Schema),
});
export type PRDiscoveryReportV1 = z.infer<typeof prDiscoveryReportV1Schema>;

export const stalenessRefreshResultV1Schema = z.object({
  schemaVersion: z.literal(PR_DISCOVERY_SCHEMA_VERSION),
  repo: discoveryRepoSchema,
  snapshotId: knowledgeSnapshotIdSchema,
  gitCommitSha: z.string().min(1),
  branch: z.string().min(1),
  refreshedAt: z.string().min(1),
  candidatesScanned: z.number().int().min(0),
  candidatesChanged: z.number().int().min(0),
  evidenceMarkedStale: z.number().int().min(0),
  claimsMarkedStale: z.array(claimCandidateIdSchema),
  staleFiles: z.array(z.string().min(1).max(1024)),
});
export type StalenessRefreshResultV1 = z.infer<typeof stalenessRefreshResultV1Schema>;

export const CLAIM_VERIFICATION_KINDS = ['test', 'runtime', 'release', 'human'] as const;
export const claimVerificationKindSchema = z.enum(CLAIM_VERIFICATION_KINDS);
export type ClaimVerificationKind = z.infer<typeof claimVerificationKindSchema>;

/** `POST …/claims/:claimId/verify` 的请求体。source 证据只能由分类器绑定。 */
export const claimVerificationInputV1Schema = z
  .object({
    kind: claimVerificationKindSchema,
    note: z.string().trim().min(1).max(1000),
    actor: z.string().trim().min(1).max(120).optional(),
    environmentId: verificationEnvironmentIdSchema.optional(),
    releaseTag: z.string().trim().min(1).max(120).optional(),
    testRunId: z.string().trim().min(1).max(200).optional(),
    commitSha: gitObjectShaSchema.optional(),
    decision: claimVerificationDecisionSchema.optional(),
    verifiedAt: z
      .string()
      .trim()
      .datetime({ offset: true, message: 'verifiedAt 必须是合法的 ISO-8601 时间戳' })
      .optional(),
  })
  .strict()
  .superRefine((input, ctx) => {
    if (input.decision !== undefined && input.kind !== 'human') {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['decision'],
        message: '只有 human 证据可以携带 approve / reject 决定',
      });
    }
    if (input.kind === 'human' && input.decision === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['decision'],
        message: '人工核验必须明确指定 decision（approve 或 reject）',
      });
    }
    if (input.kind === 'runtime' && input.environmentId === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['environmentId'],
        message: '运行态证据必须声明 environmentId（如 staging / production）',
      });
    }
    if (input.kind === 'release' && input.releaseTag === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['releaseTag'],
        message: '发布证据必须声明 releaseTag',
      });
    }
  });
export type ClaimVerificationInputV1 = z.infer<typeof claimVerificationInputV1Schema>;

/** 追加写入 `claim_verifications` 的核验审计记录。 */
export const claimVerificationRecordV1Schema = z.object({
  schemaVersion: z.literal(PR_DISCOVERY_SCHEMA_VERSION),
  id: claimVerificationRecordIdSchema,
  repo: discoveryRepoSchema,
  candidateId: prCandidateIdSchema,
  claimId: claimCandidateIdSchema,
  evidence: evidenceRefV1Schema,
  input: claimVerificationInputV1Schema,
  recordedAt: z.string().min(1),
});
export type ClaimVerificationRecordV1 = z.infer<typeof claimVerificationRecordV1Schema>;

export interface ClaimPublishabilityInput {
  classification: PRChangeClassification;
  evidence: EvidenceRefV1[];
  commitSha: string;
  snapshotId?: string;
  /** 计算结果的稳定时钟来源，由调用方注入。 */
  evaluatedAt: string;
  /** 当前 Claim 状态；人工驳回后保持 rejected。 */
  currentStatus?: ClaimStatus;
}

export interface ClaimPublishabilityEvaluation {
  eligibility: ClaimPublishEligibility;
  blockers: string[];
  guidance: string;
  /** 推导出的核验上下文，调用方必须原样保存，不能自行改写。 */
  verification: VerificationContextV1;
  status: ClaimStatus;
}

const ENVIRONMENT_RANK: Record<string, number> = {
  production: 4,
  beta: 3,
  staging: 2,
  preview: 1,
};

function rankEnvironment(environmentId: string | undefined): number {
  if (!environmentId) return 0;
  return ENVIRONMENT_RANK[environmentId] ?? 0;
}

function compareTimestamps(a: string, b: string): number {
  const ta = Date.parse(a);
  const tb = Date.parse(b);
  if (Number.isFinite(ta) && Number.isFinite(tb)) {
    return ta - tb;
  }
  return a.localeCompare(b);
}

function latestHumanDecision(evidence: EvidenceRefV1[]): EvidenceRefV1 | undefined {
  const humans = evidence
    .filter((item) => item.kind === 'human' && item.status === 'valid' && item.decision !== undefined)
    .sort((a, b) => compareTimestamps(a.capturedAt, b.capturedAt));
  return humans[humans.length - 1];
}

/**
 * AC-03 / docs/08 §5 守门：Claim 的可发布资格只由证据推导。
 *
 * - 人工驳回 → blocked_rejected
 * - 任一证据过期（AC-09）→ blocked_stale
 * - 无发布 / 运行态证据 → blocked_unverified，明确禁止「已上线」表述
 * - 有运行态证据但仅限非生产环境（或只有 Release）→ needs_qualification
 * - 生产运行态 + 人工批准 → publishable
 */
export function evaluateClaimPublishability(
  input: ClaimPublishabilityInput,
): ClaimPublishabilityEvaluation {
  const { classification, evidence, evaluatedAt } = input;
  const blockers: string[] = [];

  const hasStaleEvidence = evidence.some((item) => item.status === 'stale');
  const hasMissingEvidence = evidence.some((item) => item.status === 'missing');

  const runtimeEvidence = evidence.filter(
    (item) => item.kind === 'runtime' && item.status === 'valid',
  );
  const bestRuntime = [...runtimeEvidence].sort(
    (a, b) =>
      rankEnvironment(b.environmentId) - rankEnvironment(a.environmentId) ||
      compareTimestamps(b.capturedAt, a.capturedAt),
  )[0];
  const latestTest = evidence
    .filter((item) => item.kind === 'test' && item.status === 'valid' && item.testRunId)
    .sort((a, b) => compareTimestamps(b.capturedAt, a.capturedAt))[0];
  const releaseEvidence = evidence
    .filter((item) => item.kind === 'release' && item.status === 'valid')
    .sort((a, b) => compareTimestamps(b.capturedAt, a.capturedAt))[0];
  const human = latestHumanDecision(evidence);
  const humanRejected = human?.decision === 'reject' || input.currentStatus === 'rejected';
  const humanApproved = human?.decision === 'approve';

  const deployed = Boolean(releaseEvidence) || Boolean(bestRuntime);
  const environmentId = bestRuntime?.environmentId ?? UNVERIFIED_ENVIRONMENT_ID;
  const releaseTag = releaseEvidence?.releaseTag;
  const testRunId = bestRuntime?.testRunId ?? latestTest?.testRunId;
  // `verifiedAt` 是「证据被采集的时间」，不是「本次重新计算的时间」，因此
  // 重复刷新过期状态不会无故改写核验上下文。
  const evidenceTimes = evidence.map((item) => item.capturedAt).sort(compareTimestamps);
  const verifiedAt = evidenceTimes[evidenceTimes.length - 1] ?? evaluatedAt;
  const verification: VerificationContextV1 = {
    commitSha: input.commitSha,
    ...(input.snapshotId ? { snapshotId: input.snapshotId } : {}),
    environmentId,
    ...(releaseTag ? { releaseTag } : {}),
    ...(testRunId ? { testRunId } : {}),
    verifiedAt,
    validityScope: 'unverified',
    deployed,
  };

  const finish = (
    eligibility: ClaimPublishEligibility,
    guidance: string,
    status: ClaimStatus,
    validityScope: string,
  ): ClaimPublishabilityEvaluation => ({
    eligibility,
    blockers,
    guidance,
    verification: { ...verification, validityScope },
    status,
  });

  if (humanRejected) {
    blockers.push('Claim 已被人工驳回，不得发布。');
    return finish(
      'blocked_rejected',
      '该 Claim 已被人工驳回；如需恢复，必须重新提交核验并明确撤销驳回。',
      'rejected',
      'rejected',
    );
  }

  if (!isPromotableClassification(classification)) {
    blockers.push('PR 被判定为内部变更或待人工复核，不产生可发布 Claim。');
    return finish(
      'blocked_rejected',
      '先由人工确认该 PR 属于用户可感知变更，再重新分析。',
      'rejected',
      'non_promotable',
    );
  }

  if (hasStaleEvidence) {
    blockers.push('引用的源文件已变更或删除，证据指纹与最新快照不一致（AC-09）。');
    return finish(
      'blocked_stale',
      '重新绑定最新快照并复核 Claim 文案后，才能再次发布。',
      'stale',
      'stale',
    );
  }

  if (!deployed) {
    blockers.push('未命中 Release，也没有任何真实环境的运行态证据；禁止声称「已上线」。');
    if (hasMissingEvidence) {
      blockers.push('部分源码证据缺少可核验的指纹或文件。');
    }
    return finish(
      'blocked_unverified',
      '可以描述该变更已合并，但不得表述为「已上线 / 已可用」；补齐发布与运行态证据后再评估。',
      'proposed',
      'unverified',
    );
  }

  const scopeLimited = !bestRuntime || bestRuntime.environmentId !== PRODUCTION_ENVIRONMENT_ID;
  if (scopeLimited) {
    if (!bestRuntime) {
      blockers.push('只有发布证据，没有真实环境运行态证据；不得声称「已上线」。');
      return finish(
        'needs_qualification',
        '只能表述为「随 Release 发布」，并注明版本；补充生产运行态证据后才可声明已上线。',
        'supported',
        `release_only:${releaseTag ?? 'unknown'}`,
      );
    }
    blockers.push(`运行态证据仅限 ${bestRuntime.environmentId} 环境，不属于生产可用。`);
    return finish(
      'needs_qualification',
      `文案必须标注「仅 ${bestRuntime.environmentId} 环境」，不得表述为已上线。`,
      'supported',
      `runtime_only:${bestRuntime.environmentId}`,
    );
  }

  // 已具备生产运行态证据。
  if (!humanApproved) {
    blockers.push('缺少人工批准（docs/08 §5 要求公开发布必须人工明确批准）。');
    return finish(
      'blocked_unverified',
      '生产运行态已通过，但发布前必须取得人工批准。',
      'supported',
      'production_runtime_pending_approval',
    );
  }

  return finish(
    'publishable',
    '生产运行态证据与人工批准齐备，可按审核通过的范围发布。',
    'verified',
    'production_runtime_approved',
  );
}

export interface StalenessPropagationResult {
  candidate: PRChangeCandidateV1;
  changed: boolean;
  staleFiles: string[];
  claimsMarkedStale: string[];
  evidenceMarkedStale: number;
}

/**
 * AC-09：把最新 4B 快照的 `sourceDigests` 与 Claim 引用的源码证据逐一比对。
 * 文件被修改或删除即把证据标为 `stale`，并同步重算 Claim 状态与可发布资格。
 * 未绑定指纹的证据（例如仓库尚未建立快照）不会被误判为过期。
 */
export function propagateSnapshotStaleness(
  candidate: PRChangeCandidateV1,
  latestSnapshot: Pick<KnowledgeSnapshotV1, 'id' | 'sourceDigests'>,
  evaluatedAt: string,
): StalenessPropagationResult {
  const staleFiles = new Set<string>();
  let evidenceMarkedStale = 0;

  const evidence = candidate.evidence.map((item) => {
    if (item.kind !== 'source' || !item.filePath || !item.sourceDigest) return item;
    if (item.status === 'stale') return item;
    const current = latestSnapshot.sourceDigests[item.filePath];
    if (current === undefined) {
      staleFiles.add(item.filePath);
      evidenceMarkedStale += 1;
      return {
        ...item,
        status: 'stale' as const,
        detail: `${item.detail}｜文件已从最新快照中删除，证据过期`.trim(),
      };
    }
    if (current !== item.sourceDigest) {
      staleFiles.add(item.filePath);
      evidenceMarkedStale += 1;
      return {
        ...item,
        status: 'stale' as const,
        detail: `${item.detail}｜文件内容已变化（快照 ${latestSnapshot.id}），证据过期`.trim(),
      };
    }
    return item;
  });

  const evidenceById = new Map(evidence.map((item) => [item.id, item]));
  const claimsMarkedStale: string[] = [];
  const claims = candidate.claims.map((claim) => {
    const claimEvidence = claim.evidenceIds
      .map((evidenceId) => evidenceById.get(evidenceId))
      .filter((item): item is EvidenceRefV1 => item !== undefined);
    const evaluation = evaluateClaimPublishability({
      classification: candidate.classification,
      evidence: claimEvidence,
      commitSha: claim.verification.commitSha,
      ...(claim.verification.snapshotId ? { snapshotId: claim.verification.snapshotId } : {}),
      evaluatedAt,
    });
    // Only a transition counts as "marked stale"; a claim that was already
    // stale must not make every later refresh look like it changed something.
    if (evaluation.status === 'stale' && claim.status !== 'stale') {
      claimsMarkedStale.push(claim.id);
    }
    return {
      ...claim,
      eligibility: evaluation.eligibility,
      status: evaluation.status,
      verification: evaluation.verification,
      blockers: evaluation.blockers,
      guidance: evaluation.guidance,
    };
  });

  const changed =
    evidenceMarkedStale > 0 ||
    claimsMarkedStale.length > 0 ||
    JSON.stringify(evidence) !== JSON.stringify(candidate.evidence) ||
    JSON.stringify(claims) !== JSON.stringify(candidate.claims);

  return {
    candidate: { ...candidate, evidence, claims },
    changed,
    staleFiles: [...staleFiles].sort(),
    claimsMarkedStale,
    evidenceMarkedStale,
  };
}
