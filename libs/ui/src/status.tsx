import type {
  ClaimPublishEligibility,
  ClaimStatus,
  EvidenceStatus,
  ExportStatus,
  FeatureStatus,
  PRChangeClassification,
  RunStatus,
  SceneStatus,
  SuggestionStatus,
  VideoStage,
} from '@asvs/domain';
import { Badge, type BadgeTone } from './badge';

interface StatusMeta {
  label: string;
  tone: BadgeTone;
}

export const FEATURE_STATUS_META: Record<FeatureStatus, StatusMeta> = {
  proposed: { label: '候选', tone: 'neutral' },
  implemented: { label: '已实现', tone: 'neutral' },
  verified: { label: '已验证', tone: 'success' },
  deployed: { label: '已上线', tone: 'success' },
  stale: { label: '证据过期', tone: 'warn' },
  deprecated: { label: '已废弃', tone: 'neutral' },
};

export const CLAIM_STATUS_META: Record<ClaimStatus, StatusMeta> = {
  proposed: { label: '待确认', tone: 'warn' },
  supported: { label: '待验证', tone: 'warn' },
  verified: { label: '已核验', tone: 'success' },
  stale: { label: '已过期', tone: 'warn' },
  rejected: { label: '未通过', tone: 'danger' },
};

export const EVIDENCE_STATUS_META: Record<EvidenceStatus, StatusMeta> = {
  valid: { label: '有效', tone: 'success' },
  stale: { label: '已过期', tone: 'warn' },
  missing: { label: '缺失', tone: 'danger' },
};

export const VIDEO_STAGE_META: Record<VideoStage, StatusMeta> = {
  draft: { label: '草稿', tone: 'neutral' },
  planning: { label: '策划中', tone: 'neutral' },
  script_review: { label: '脚本待确认', tone: 'warn' },
  storyboard_ready: { label: '分镜就绪', tone: 'accent' },
  producing: { label: '模拟生产中', tone: 'accent' },
  review: { label: '待审核', tone: 'warn' },
  changes_requested: { label: '需修改', tone: 'warn' },
  approved: { label: '已通过', tone: 'success' },
  exported: { label: '已导出', tone: 'success' },
};

export const RUN_STATUS_META: Record<RunStatus, StatusMeta> = {
  queued: { label: '排队中', tone: 'neutral' },
  running: { label: '运行中', tone: 'accent' },
  paused: { label: '已暂停', tone: 'warn' },
  awaiting_approval: { label: '待审批', tone: 'warn' },
  succeeded: { label: '已完成', tone: 'success' },
  failed: { label: '失败', tone: 'danger' },
  cancelled: { label: '已取消', tone: 'neutral' },
};

export const SCENE_STATUS_META: Record<SceneStatus, StatusMeta> = {
  draft: { label: '草稿', tone: 'neutral' },
  approved: { label: '已确认', tone: 'success' },
  review: { label: '待确认', tone: 'warn' },
};

export const SUGGESTION_STATUS_META: Record<SuggestionStatus, StatusMeta> = {
  pending: { label: '待确认', tone: 'warn' },
  accepted: { label: '已接受', tone: 'success' },
  rejected: { label: '已拒绝', tone: 'neutral' },
};

export const EXPORT_STATUS_META: Record<ExportStatus, StatusMeta> = {
  queued: { label: '排队中', tone: 'neutral' },
  processing: { label: '导出中', tone: 'accent' },
  completed: { label: '已完成', tone: 'success' },
  failed: { label: '失败', tone: 'danger' },
};

export function StatusBadge({ meta, className }: { meta: StatusMeta; className?: string }) {
  return (
    <Badge tone={meta.tone} className={className}>
      {meta.label}
    </Badge>
  );
}

export function FeatureStatusBadge({ status, className }: { status: FeatureStatus; className?: string }) {
  return <StatusBadge meta={FEATURE_STATUS_META[status]} className={className} />;
}

export function ClaimStatusBadge({ status, className }: { status: ClaimStatus; className?: string }) {
  return <StatusBadge meta={CLAIM_STATUS_META[status]} className={className} />;
}

export function VideoStageBadge({ stage, className }: { stage: VideoStage; className?: string }) {
  return <StatusBadge meta={VIDEO_STAGE_META[stage]} className={className} />;
}

export function RunStatusBadge({ status, className }: { status: RunStatus; className?: string }) {
  return <StatusBadge meta={RUN_STATUS_META[status]} className={className} />;
}

export const CLAIM_ELIGIBILITY_META: Record<ClaimPublishEligibility, StatusMeta> = {
  publishable: { label: '可发布', tone: 'success' },
  needs_qualification: { label: '需限定表述', tone: 'warn' },
  blocked_unverified: { label: '未核验阻断', tone: 'danger' },
  blocked_stale: { label: '证据过期阻断', tone: 'danger' },
  blocked_rejected: { label: '人工驳回阻断', tone: 'danger' },
};

export const PR_CLASSIFICATION_META: Record<PRChangeClassification, StatusMeta> = {
  user_facing_feature: { label: '用户新功能', tone: 'success' },
  user_facing_improvement: { label: '用户改进', tone: 'accent' },
  internal_non_promotable: { label: '内部变更 · 不建议宣传', tone: 'warn' },
  ambiguous_needs_review: { label: '待人工复核', tone: 'neutral' },
};

export function ClaimEligibilityBadge({
  eligibility,
  className,
}: {
  eligibility: ClaimPublishEligibility;
  className?: string;
}) {
  return <StatusBadge meta={CLAIM_ELIGIBILITY_META[eligibility]} className={className} />;
}

export function PRClassificationBadge({
  classification,
  className,
}: {
  classification: PRChangeClassification;
  className?: string;
}) {
  return <StatusBadge meta={PR_CLASSIFICATION_META[classification]} className={className} />;
}

export function ExportStatusBadge({ status, className }: { status: ExportStatus; className?: string }) {
  return <StatusBadge meta={EXPORT_STATUS_META[status]} className={className} />;
}
