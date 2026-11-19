import type {
  Claim,
  ConnectionResult,
  Evidence,
  EvidenceKind,
  Feature,
  GeneratedKnowledge,
  KnowledgeSuggestion,
  OnboardingDraft,
  Project,
  PullRequest,
  Release,
  SourceConnection,
  SourceKind,
} from '@asvs/domain';
import {
  ONBOARDING_EXTRA_CANDIDATES,
  ONBOARDING_TEMPLATES,
  VIDEO_TEMPLATES,
} from '@asvs/mock-data';
import { newId, nowIso } from './id';

const SOURCE_LABELS: Record<SourceKind, string> = {
  github: 'GitHub 仓库',
  docs: '产品文档',
  website: '线上产品',
};

const CONNECTOR_DETAIL: Record<SourceKind, string> = {
  github: '读取已合并 PR、提交记录与 Release；不会写入仓库。',
  docs: '读取公开文档页面，用于提取功能说明和限制条件。',
  website: '只读访问演示站点，用于核对界面路径与可用状态。',
};

const EVIDENCE_LABEL: Record<EvidenceKind, { title: string; detail: string; ref: string }> = {
  source: {
    title: '合并记录与源码路径',
    detail: '在模拟仓库中找到对应实现与合并记录。',
    ref: 'src/features/*',
  },
  test: {
    title: '自动化测试覆盖',
    detail: '存在与该能力相关的模拟测试用例。',
    ref: 'tests/*.spec.ts',
  },
  runtime: {
    title: '演示环境运行记录',
    detail: '在模拟 staging 环境完成一次界面路径核验。',
    ref: 'atlas.demo.invalid',
  },
  release: {
    title: '版本发布说明',
    detail: 'Release Notes 中出现该能力的用户可感知描述。',
    ref: 'release-notes',
  },
  human: {
    title: '产品负责人确认',
    detail: '由项目成员人工确认，可作为对外表述依据。',
    ref: 'manual-signoff',
  },
};

/**
 * Deterministic connection simulation. A value containing `fail` / `error`
 * reproduces an authorization error, which keeps the onboarding error state
 * demoable without randomness.
 */
export function simulateConnection(input: {
  kind: SourceKind;
  value: string;
  branch?: string;
}): ConnectionResult {
  const value = input.value.trim();
  const timestamp = nowIso();
  const base: SourceConnection = {
    id: newId('src'),
    kind: input.kind,
    name: SOURCE_LABELS[input.kind],
    detail: CONNECTOR_DETAIL[input.kind],
    status: 'pending',
    demo: true,
  };

  if (!value) {
    return {
      ok: false,
      source: {
        ...base,
        error: `请先填写${SOURCE_LABELS[input.kind]}地址。`,
      },
      error: `请先填写${SOURCE_LABELS[input.kind]}地址。`,
    };
  }

  if (/fail|error|denied/i.test(value)) {
    const error = '模拟授权被拒绝：该演示连接器只接受白名单仓库与公开文档地址。';
    return { ok: false, source: { ...base, status: 'error', error }, error };
  }

  if (input.kind === 'github' && !/^[\w.-]+\/[\w.-]+$/.test(value)) {
    const error = '仓库格式应为 owner/repo，例如 lumen-labs/atlas。';
    return { ok: false, source: { ...base, status: 'error', error }, error };
  }

  if (input.kind === 'website' && !/^https?:\/\//i.test(value)) {
    const error = '演示站点需要以 http:// 或 https:// 开头。';
    return { ok: false, source: { ...base, status: 'error', error }, error };
  }

  return {
    ok: true,
    source: {
      ...base,
      name:
        input.kind === 'github'
          ? value
          : input.kind === 'website'
            ? new URL(value).host
            : `${SOURCE_LABELS.docs} · ${value.split('\n').filter(Boolean).length} 个页面`,
      detail:
        input.kind === 'github'
          ? `只读连接 · 分支 ${input.branch || 'main'} · 模拟同步`
          : `${CONNECTOR_DETAIL[input.kind]} · 模拟连接`,
      scope: input.kind === 'github' ? input.branch || 'main' : value,
      status: 'connected',
      lastSyncedAt: timestamp,
    },
  };
}

function featureFromTemplate(
  template: (typeof ONBOARDING_TEMPLATES)[SourceKind][number],
  projectId: string,
  index: number,
): { feature: Feature; claim: Claim; evidence: Evidence[] } {
  const timestamp = nowIso();
  const featureId = newId('feat');
  const claimId = newId('claim');
  const evidence = template.evidenceKinds.map((kind, evidenceIndex) => {
    const label = EVIDENCE_LABEL[kind];
    return {
      id: newId('ev'),
      projectId,
      featureId,
      claimId,
      kind,
      title: `${template.name} · ${label.title}`,
      detail: label.detail,
      ref: `${label.ref}#${index + 1}-${evidenceIndex + 1}`,
      status: 'valid' as const,
      capturedAt: timestamp,
      demo: true,
    } satisfies Evidence;
  });

  const feature: Feature = {
    id: featureId,
    projectId,
    name: template.name,
    summary: template.summary,
    category: template.category,
    status: template.featureStatus,
    confidence: template.confidence,
    userConfirmed: false,
    sourceRefs: template.sourceKinds.map((kind) => ({
      kind,
      label:
        kind === 'pr'
          ? '模拟 PR'
          : kind === 'file'
            ? '源码文件'
            : kind === 'runtime'
              ? '运行记录'
              : kind === 'doc'
                ? '文档页面'
                : '提交记录',
      detail: '由入门模拟分析生成，需要人工确认。',
    })),
    claimIds: [claimId],
    prIds: [],
    demoRoute: `/demo/${template.key}`,
    updatedAt: timestamp,
    tags: template.tags,
    demo: true,
  };

  const claim: Claim = {
    id: claimId,
    projectId,
    featureId,
    statement: template.claim.statement,
    audience: template.claim.audience,
    status: template.claim.status,
    evidenceIds: evidence.map((item) => item.id),
    verification:
      template.claim.status === 'verified'
        ? {
            environment: 'staging',
            appVersion: 'v0.1.0-demo',
            verifiedAt: timestamp,
            scope: '入门模拟分析 · 待真实环境复核',
          }
        : undefined,
    demo: true,
  };

  return { feature, claim, evidence };
}

export interface OnboardingResult {
  project: Project;
  knowledge: GeneratedKnowledge;
}

export function generateProjectKnowledge(draft: OnboardingDraft): OnboardingResult {
  const timestamp = nowIso();
  const projectId = newId('proj');
  const name = draft.name.trim() || `${draft.productName.trim() || '新产品'} 视频项目`;

  const sources: SourceConnection[] = draft.methods.map((kind) => {
    const connection = draft.connections[kind];
    if (connection) {
      return {
        ...connection,
        id: connection.id || newId('src'),
        status: 'connected',
        lastSyncedAt: timestamp,
      };
    }
    const value =
      kind === 'github'
        ? draft.githubRepo
        : kind === 'website'
          ? draft.demoUrl
          : draft.docs[0] ?? '';
    return {
      id: newId('src'),
      kind,
      name:
        kind === 'github'
          ? value || 'owner/repo'
          : kind === 'website'
            ? value
              ? new URL(value.startsWith('http') ? value : `https://${value}`).host
              : '演示站点'
            : `产品文档 · ${Math.min(3, draft.docs.filter(Boolean).length)} 个页面`,
      detail: CONNECTOR_DETAIL[kind],
      status: 'connected',
      scope: kind === 'github' ? draft.branch || 'main' : value,
      lastSyncedAt: timestamp,
      demo: true,
    };
  });

  const templates = draft.methods.flatMap((kind) => ONBOARDING_TEMPLATES[kind]).slice(0, 5);
  const generated = templates.map((template, index) =>
    featureFromTemplate(template, projectId, index),
  );

  const features = generated.map((item) => item.feature);
  const claims = generated.map((item) => item.claim);
  const evidence = generated.flatMap((item) => item.evidence);

  const pullRequests: PullRequest[] =
    draft.methods.includes('github') && features.length > 0
      ? [
          {
            id: newId('pr'),
            projectId,
            number: 128 + features.length,
            title: `feat: ${features[0].name} 的可用路径与状态处理`,
            author: 'demo-maintainer',
            mergedAt: timestamp,
            kind: 'feature',
            summary: `围绕「${features[0].name}」补齐入口与空状态，模拟 PR 用于演示追溯。`,
            featureIds: [features[0].id],
            demo: true,
          },
          {
            id: newId('pr'),
            projectId,
            number: 124 + features.length,
            title: 'chore: 统一演示环境的埋点与断言',
            author: 'demo-platform',
            mergedAt: timestamp,
            kind: 'internal',
            summary: '内部改动，不应直接出现在对外视频里。',
            featureIds: [],
            demo: true,
          },
        ]
      : [];

  if (pullRequests.length > 0 && features[0]) {
    features[0] = { ...features[0], prIds: [pullRequests[0].id] };
  }

  const releases: Release[] =
    draft.methods.includes('github') && features.length > 0
      ? [
          {
            id: newId('rel'),
            projectId,
            version: 'v0.1.0-demo',
            name: '首次同步 · 候选版本',
            releasedAt: timestamp,
            prIds: pullRequests.map((pr) => pr.id),
            highlight: `从模拟来源生成了 ${features.length} 个候选能力，等待人工确认。`,
            demo: true,
          },
        ]
      : [];

  const supported = claims.find((claim) => claim.status === 'supported');
  const supportFeature = supported
    ? features.find((feature) => feature.id === supported.featureId)
    : undefined;
  const suggestions: KnowledgeSuggestion[] = [];
  if (supported && supportFeature) {
    suggestions.push({
      id: newId('sug'),
      projectId,
      kind: 'link_evidence',
      title: `为「${supportFeature.name}」补充运行时验证`,
      rationale:
        '入门分析只找到了源码与文档依据，缺少运行时记录。建议先在演示环境验证，再用于对外视频。',
      confidence: 72,
      targetId: supportFeature.id,
      claimId: supported.id,
      proposedStatus: 'implemented',
      status: 'pending',
      createdAt: timestamp,
      demo: true,
    });
  }
  const extra = ONBOARDING_EXTRA_CANDIDATES[features.length % ONBOARDING_EXTRA_CANDIDATES.length];
  suggestions.push({
    id: newId('sug'),
    projectId,
    kind: 'new_feature',
    title: `发现候选功能：${extra.name}`,
    rationale: `${extra.summary} 该候选来自模拟分析，需确认后再写入知识库。`,
    confidence: extra.confidence,
    proposedFeature: {
      name: extra.name,
      summary: extra.summary,
      category: extra.category,
      confidence: extra.confidence,
    },
    status: 'pending',
    createdAt: timestamp,
    demo: true,
  });

  const templateId = VIDEO_TEMPLATES.some((template) => template.id === draft.templateId)
    ? draft.templateId
    : 'tpl_signal';

  const project: Project = {
    id: projectId,
    name,
    productName: draft.productName.trim() || name,
    description: draft.description.trim(),
    website: draft.website.trim(),
    stage: 'active',
    brand: draft.brand,
    sources,
    defaultAspect: draft.defaultAspect,
    defaultLanguage: draft.defaultLanguage,
    templateId,
    analysisCount: 1,
    createdAt: timestamp,
    updatedAt: timestamp,
    demo: true,
  };

  return {
    project,
    knowledge: { features, claims, evidence, suggestions, pullRequests, releases },
  };
}
