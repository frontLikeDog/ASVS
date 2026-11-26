import type {
  Claim,
  Evidence,
  Feature,
  KnowledgeSuggestion,
  Project,
} from '@asvs/domain';
import type {
  ClaimReverification,
  KnowledgeSuggestionResolution,
  KnowledgeSyncResult,
} from '@asvs/ports';
import { newId, nowIso } from './id';

export type ReverifyResult = ClaimReverification;

export function reverifyClaim(claim: Claim, feature: Feature): ReverifyResult {
  const timestamp = nowIso();
  const evidence: Evidence = {
    id: newId('ev'),
    projectId: claim.projectId,
    featureId: feature.id,
    claimId: claim.id,
    kind: 'runtime',
    title: '重新验证 · staging 演示环境',
    detail: '人工触发重新验证，运行时断言与界面状态一致（模拟数据，不包含真实客户信息）。',
    ref: `reverify-${claim.id.slice(-6)}`,
    status: 'valid',
    capturedAt: timestamp,
    demo: true,
  };
  const updatedClaim: Claim = {
    ...claim,
    status: 'verified',
    evidenceIds: [...claim.evidenceIds, evidence.id],
    verification: {
      environment: 'staging',
      appVersion: claim.verification?.appVersion ?? 'v2.8.0-demo',
      verifiedAt: timestamp,
      scope: '重新验证 · Demo 演示环境',
    },
  };
  const updatedFeature: Feature = {
    ...feature,
    status:
      feature.status === 'deployed' || feature.status === 'verified'
        ? feature.status
        : 'verified',
    confidence: Math.min(100, feature.confidence + 6),
    userConfirmed: true,
    updatedAt: timestamp,
    sourceRefs: [
      ...feature.sourceRefs,
      {
        kind: 'runtime',
        label: '重新验证 · 人工触发',
        detail: `通过模拟运行时断言 · ${timestamp.slice(0, 10)}`,
      },
    ],
  };
  return { claim: updatedClaim, feature: updatedFeature, evidence };
}

export type SuggestionResolution = KnowledgeSuggestionResolution;

export function acceptSuggestion(
  suggestion: KnowledgeSuggestion,
  features: Feature[],
  claims: Claim[],
): SuggestionResolution | null {
  const timestamp = nowIso();
  const accepted: KnowledgeSuggestion = { ...suggestion, status: 'accepted' };

  if (suggestion.kind === 'link_evidence') {
    const feature = features.find((item) => item.id === suggestion.targetId);
    const claim = claims.find((item) => item.id === suggestion.claimId);
    if (!feature || !claim) return null;
    const evidence: Evidence = {
      id: newId('ev'),
      projectId: suggestion.projectId,
      featureId: feature.id,
      claimId: claim.id,
      kind: 'runtime',
      title: suggestion.title,
      detail: '接受模拟 AI 建议后新增的运行时证据；仅用于演示证据流转。',
      ref: `ai-suggestion-${suggestion.id.slice(-6)}`,
      status: 'valid',
      capturedAt: timestamp,
      demo: true,
    };
    const nextClaim: Claim = {
      ...claim,
      status:
        suggestion.proposedStatus === 'verified' || suggestion.proposedStatus === 'deployed'
          ? 'verified'
          : claim.status,
      evidenceIds: [...claim.evidenceIds, evidence.id],
      verification:
        suggestion.proposedStatus === 'verified' || suggestion.proposedStatus === 'deployed'
          ? {
              environment: 'staging',
              appVersion: 'v2.8.0-demo',
              verifiedAt: timestamp,
              scope: 'AI 建议 + 人工接受 · 待真实环境复核',
            }
          : claim.verification,
    };
    const nextFeature: Feature = {
      ...feature,
      status: suggestion.proposedStatus ?? feature.status,
      confidence: Math.min(100, feature.confidence + 4),
      userConfirmed: true,
      updatedAt: timestamp,
    };
    return {
      suggestion: accepted,
      feature: nextFeature,
      claim: nextClaim,
      evidence,
      message: `已接受建议并新增模拟证据；「${feature.name}」的声明状态更新为 ${nextClaim.status}。`,
    };
  }

  if (suggestion.kind === 'new_feature') {
    if (!suggestion.proposedFeature) return null;
    const feature: Feature = {
      id: newId('feat'),
      projectId: suggestion.projectId,
      name: suggestion.proposedFeature.name,
      summary: suggestion.proposedFeature.summary,
      category: suggestion.proposedFeature.category,
      status: 'proposed',
      confidence: suggestion.proposedFeature.confidence,
      userConfirmed: false,
      sourceRefs: [
        {
          kind: 'doc',
          label: 'AI 候选建议',
          detail: '来自模拟分析，需要人工确认',
        },
      ],
      claimIds: [],
      prIds: [],
      demoRoute: '/demo',
      updatedAt: timestamp,
      tags: ['AI 建议'],
      demo: true,
    };
    return {
      suggestion: accepted,
      feature,
      message: `已创建候选功能「${feature.name}」，状态为 proposed，等待补充证据。`,
    };
  }

  if (suggestion.kind === 'status_change') {
    const feature = features.find((item) => item.id === suggestion.targetId);
    if (!feature) return null;
    const nextFeature: Feature = {
      ...feature,
      status: suggestion.proposedStatus ?? feature.status,
      updatedAt: timestamp,
      userConfirmed: true,
    };
    return {
      suggestion: accepted,
      feature: nextFeature,
      message: `已接受状态建议；「${feature.name}」更新为 ${nextFeature.status}。`,
    };
  }

  return null;
}

export function rejectSuggestion(suggestion: KnowledgeSuggestion): KnowledgeSuggestion {
  return { ...suggestion, status: 'rejected' };
}

export type SyncKnowledgeResult = KnowledgeSyncResult;

/**
 * Deterministic "re-analysis": refreshes timestamps and proposes one new thing
 * to confirm. It never mutates existing facts silently.
 */
export function syncKnowledge(input: {
  project: Project;
  features: Feature[];
  claims: Claim[];
  suggestions: KnowledgeSuggestion[];
}): SyncKnowledgeResult {
  const { project, features, claims, suggestions } = input;
  const timestamp = nowIso();
  const nextProject: Project = {
    ...project,
    analysisCount: project.analysisCount + 1,
    updatedAt: timestamp,
    sources: project.sources.map((source) =>
      source.status === 'connected' || source.status === 'syncing'
        ? { ...source, status: 'connected', lastSyncedAt: timestamp }
        : source,
    ),
  };

  const existingTitles = new Set(suggestions.map((suggestion) => suggestion.title));
  const candidates: KnowledgeSuggestion[] = [];
  const supportedClaim = claims.find(
    (claim) =>
      claim.projectId === project.id && claim.status === 'supported' && claim.featureId,
  );
  const supportedFeature = supportedClaim
    ? features.find((feature) => feature.id === supportedClaim.featureId)
    : undefined;
  if (supportedClaim && supportedFeature) {
    candidates.push({
      id: newId('sug'),
      projectId: project.id,
      kind: 'link_evidence',
      title: `为「${supportedFeature.name}」补充提交后的验证记录`,
      rationale:
        '最新同步发现该功能有新的合并记录，但仍缺少运行时验证。建议先补充证据，不要直接升级对外声明。',
      confidence: 76,
      targetId: supportedFeature.id,
      claimId: supportedClaim.id,
      proposedStatus: 'implemented',
      status: 'pending',
      createdAt: timestamp,
      demo: true,
    });
  }

  const implementedFeature = features.find(
    (feature) => feature.projectId === project.id && feature.status === 'implemented',
  );
  if (implementedFeature) {
    candidates.push({
      id: newId('sug'),
      projectId: project.id,
      kind: 'status_change',
      title: `「${implementedFeature.name}」可能已进入可验证状态`,
      rationale:
        '同步记录显示部署路径有更新，但测试与运行时证据尚未补齐。建议人工确认后更新状态。',
      confidence: 64,
      targetId: implementedFeature.id,
      proposedStatus: 'verified',
      status: 'pending',
      createdAt: timestamp,
      demo: true,
    });
  }

  candidates.push({
    id: newId('sug'),
    projectId: project.id,
    kind: 'new_feature',
    title: '发现候选功能：操作审计日志',
    rationale:
      '文档更新中出现了“审计日志”入口说明，但功能目录尚无对应条目。建议先作为候选功能，补充证据后再用于视频。',
    confidence: 57,
    proposedFeature: {
      name: '操作审计日志',
      summary: '记录关键配置变更与成员操作，支持按时间筛选。',
      category: '安全',
      confidence: 57,
    },
    status: 'pending',
    createdAt: timestamp,
    demo: true,
  });

  const order = project.analysisCount % Math.max(1, candidates.length);
  const rotated = [...candidates.slice(order), ...candidates.slice(0, order)];
  const suggestion = rotated.find((candidate) => !existingTitles.has(candidate.title));

  return {
    project: nextProject,
    suggestion,
    message: suggestion
      ? `知识同步完成；新增 1 条待确认建议：${suggestion.title}`
      : '知识同步完成；没有发现新的待确认变化。',
  };
}
