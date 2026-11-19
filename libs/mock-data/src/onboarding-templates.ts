import type {
  ClaimStatus,
  EvidenceKind,
  FeatureStatus,
  SourceKind,
  SourceRef,
} from '@asvs/domain';

export interface OnboardingTemplate {
  key: string;
  name: string;
  summary: string;
  category: string;
  tags: string[];
  featureStatus: FeatureStatus;
  confidence: number;
  claim: {
    statement: string;
    audience: string;
    status: ClaimStatus;
  };
  sourceKinds: SourceRef['kind'][];
  evidenceKinds: EvidenceKind[];
}

/**
 * Generic capabilities used to synthesize a believable knowledge base for a
 * brand-new demo project. They are intentionally generic enough for any SaaS,
 * and every generated entity is labelled as demo data.
 */
export const ONBOARDING_TEMPLATES: Record<SourceKind, OnboardingTemplate[]> = {
  github: [
    {
      key: 'workspace',
      name: '智能工作区',
      summary: '把最近项目、常用视图与团队动态集中在一个可自定义的工作区中。',
      category: '工作区',
      tags: ['工作区', '导航'],
      featureStatus: 'verified',
      confidence: 86,
      claim: {
        statement: '团队可以在统一工作区中组织项目、视图和最近操作。',
        audience: '日常使用产品的团队成员',
        status: 'verified',
      },
      sourceKinds: ['pr', 'file', 'runtime'],
      evidenceKinds: ['source', 'test', 'runtime'],
    },
    {
      key: 'automation',
      name: '自动化流程',
      summary: '通过条件与动作配置，自动推进重复的任务和通知。',
      category: '自动化',
      tags: ['自动化', '规则'],
      featureStatus: 'implemented',
      confidence: 74,
      claim: {
        statement: '用户可以配置规则，让重复任务在满足条件时自动推进。',
        audience: '运营与项目管理者',
        status: 'supported',
      },
      sourceKinds: ['pr', 'doc'],
      evidenceKinds: ['source', 'source'],
    },
    {
      key: 'collaboration',
      name: '团队协作',
      summary: '成员可以共享视图、留下评论，并在同一对象上协同编辑。',
      category: '协作',
      tags: ['协作', '评论'],
      featureStatus: 'deployed',
      confidence: 88,
      claim: {
        statement: '成员可以在共享对象上评论并看到彼此的更新。',
        audience: '跨职能项目团队',
        status: 'verified',
      },
      sourceKinds: ['pr', 'file', 'runtime'],
      evidenceKinds: ['source', 'test', 'runtime'],
    },
    {
      key: 'open_api',
      name: '开放 API',
      summary: '提供读取项目与事件数据的接口，便于接入内部系统。',
      category: '平台',
      tags: ['API', '集成'],
      featureStatus: 'implemented',
      confidence: 69,
      claim: {
        statement: '开发者可以通过 API 读取项目与事件数据。',
        audience: '平台与集成开发者',
        status: 'supported',
      },
      sourceKinds: ['doc', 'commit'],
      evidenceKinds: ['source'],
    },
  ],
  website: [
    {
      key: 'dashboard',
      name: '核心工作台',
      summary: '登录后进入的主工作台，集中展示待办、最近访问和关键指标。',
      category: '工作台',
      tags: ['工作台', '概览'],
      featureStatus: 'implemented',
      confidence: 66,
      claim: {
        statement: '工作台会集中展示待办与最近访问内容。',
        audience: '首次访问产品的用户',
        status: 'proposed',
      },
      sourceKinds: ['runtime'],
      evidenceKinds: ['runtime'],
    },
    {
      key: 'search',
      name: '全局搜索',
      summary: '通过顶部搜索入口跨对象查找项目、成员和记录。',
      category: '检索',
      tags: ['搜索', '导航'],
      featureStatus: 'implemented',
      confidence: 58,
      claim: {
        statement: '搜索入口可以跨项目查找对象。',
        audience: '需要快速定位信息的用户',
        status: 'proposed',
      },
      sourceKinds: ['runtime'],
      evidenceKinds: ['runtime'],
    },
    {
      key: 'report_share',
      name: '报表分享',
      summary: '从报表页面生成分享入口，可控制访问范围。',
      category: '报表',
      tags: ['分享', '报表'],
      featureStatus: 'proposed',
      confidence: 55,
      claim: {
        statement: '报表可以生成可访问的分享链接。',
        audience: '需要同步数据的团队成员',
        status: 'proposed',
      },
      sourceKinds: ['runtime'],
      evidenceKinds: ['runtime'],
    },
  ],
  docs: [
    {
      key: 'permissions',
      name: '权限与角色',
      summary: '通过角色控制成员对项目、数据与敏感操作的访问范围。',
      category: '权限',
      tags: ['权限', '角色'],
      featureStatus: 'implemented',
      confidence: 73,
      claim: {
        statement: '管理员可以为成员分配角色并限制敏感操作。',
        audience: '管理员与安全负责人',
        status: 'supported',
      },
      sourceKinds: ['doc'],
      evidenceKinds: ['source'],
    },
    {
      key: 'integrations',
      name: '集成中心',
      summary: '集中查看并配置第三方集成，管理连接状态与授权范围。',
      category: '集成',
      tags: ['集成', '连接器'],
      featureStatus: 'implemented',
      confidence: 64,
      claim: {
        statement: '用户可以在集成中心查看已连接服务的状态。',
        audience: '平台管理员',
        status: 'supported',
      },
      sourceKinds: ['doc'],
      evidenceKinds: ['source'],
    },
    {
      key: 'templates',
      name: '模板库',
      summary: '使用预置模板快速创建项目、视图或报表。',
      category: '效率',
      tags: ['模板', '效率'],
      featureStatus: 'proposed',
      confidence: 61,
      claim: {
        statement: '模板库提供可复用的项目与视图模板。',
        audience: '需要快速启动的新用户',
        status: 'proposed',
      },
      sourceKinds: ['doc'],
      evidenceKinds: ['source'],
    },
  ],
};

export const ONBOARDING_EXTRA_CANDIDATES = [
  {
    name: '批量导出',
    summary: '将筛选后的记录批量导出为表格，便于离线分析。',
    category: '数据',
    confidence: 57,
  },
  {
    name: '移动端快捷视图',
    summary: '在移动端快速查看关注对象的核心指标。',
    category: '移动体验',
    confidence: 54,
  },
  {
    name: '操作审计日志',
    summary: '记录关键配置变更与成员操作，支持按时间筛选。',
    category: '安全',
    confidence: 63,
  },
];
