import {
  CAPTURE_SCHEMA_VERSION,
  demoPlanDraftV1Schema,
  type DemoPlanDraftV1,
  type DemoPlanTemplateId,
  type DemoStep,
} from './capture';
import type { Claim, Feature, VideoProject } from './schemas';

/**
 * Rule- and template-driven Demo Planner (Step 5C, WP-14).
 *
 * There is **no model in this loop**. A draft plan is a deterministic function
 * of:
 *
 *   1. the video's `real_demo` scenes and their 4D-verified features/claims;
 *   2. the project's declared routes (`Feature.demoRoute`);
 *   3. the operator's capture options (template, base URL, viewport …).
 *
 * The same inputs always produce byte-identical output — the digest the Gate 2
 * approval binds depends on it. Every template is written against the product's
 * real page landmarks (the same ones the Step 2 tour asserts), never against
 * generated CSS, and every plan carries at least one UI assertion.
 */

export interface DemoPlannerFeatureInput {
  feature: Feature;
  claims: Claim[];
  /** The video scenes that asked for this feature. */
  sceneIds: string[];
}

export interface DemoPlannerInput {
  workspaceId: string;
  video: VideoProject;
  features: DemoPlannerFeatureInput[];
  /** `Feature.demoRoute` targets, resolved against `baseUrl`. */
  routes: Array<{ featureId: string; route: string }>;
  template: DemoPlanTemplateId;
  baseUrl: string;
  /** Exact origins the server is willing to talk to; the plan uses these. */
  allowedOrigins: string[];
  /** Optional override for the demo environment id; default `local_web_studio`. */
  environmentId?: string;
  /** Plan id override; defaults to a deterministic per-video id. */
  planId?: string;
  clockTime?: string;
  viewport?: { width: number; height: number };
  capture?: { width: number; height: number; fps?: number; clipDurationMs?: number };
  resetStrategy?: 'fixture' | 'none';
  /** A caller-provided plan, validated but not otherwise rewritten. */
  customSteps?: DemoStep[];
  /** Shown in the asset description; never part of the digest decision. */
  assetName?: string;
  assetDescription?: string;
  assetPalette?: [string, string];
  locale?: string;
  timezoneId?: string;
  colorScheme?: 'dark' | 'light';
}

export type DemoPlannerResult =
  | { ok: true; draft: DemoPlanDraftV1 }
  | { ok: false; code: 'no_real_demo_scenes' | 'route_missing' | 'invalid_plan'; message: string };

/** Deterministic plan id per (video, template); re-planning keeps the id. */
export function demoPlanIdFor(videoId: string, template: DemoPlanTemplateId): string {
  const slug = `${videoId}_${template}`.replace(/[^A-Za-z0-9_]+/g, '_').slice(0, 80);
  return `plan_${slug}`;
}

/**
 * The verified-feature set that may appear in a demo. A feature is eligible
 * only when at least one of its claims is 4D-publishable (`verified` with no
 * blocking eligibility) — the same rule `verify_claims` enforces at render
 * time, applied here so the plan never depends on an unproven claim.
 */
export function eligiblePlannerFeatures(input: DemoPlannerInput): DemoPlannerFeatureInput[] {
  return input.features.filter((entry) =>
    entry.claims.some(
      (claim) => claim.status === 'verified' && (claim.eligibility ?? 'publishable') === 'publishable',
    ),
  );
}

function normalizeRoute(route: string): string {
  if (!route.startsWith('/')) return `/${route}`;
  return route;
}

function routeUrl(baseUrl: string, route: string): string {
  return new URL(normalizeRoute(route), `${baseUrl.replace(/\/+$/, '')}/`).toString();
}

/** Every plan ends on the product's review surface: proof that it is real. */
function closingSteps(): DemoStep[] {
  return [
    {
      id: 'open-review',
      action: 'click',
      target: 'role=link,name="审核导出"',
      timeoutMs: 15_000,
      dwellMs: 0,
      state: 'visible',
      description: '进入审核导出页，用真实页面证明整条链路',
    },
    {
      id: 'review-evidence',
      action: 'assert',
      target: 'heading=声明与证据',
      assertion: { kind: 'visible', match: 'contains' },
      timeoutMs: 15_000,
      dwellMs: 1200,
      state: 'visible',
      description: '审核页必须展示声明与证据',
    },
  ];
}

function landingSteps(): DemoStep[] {
  return [
    {
      id: 'dashboard-ready',
      action: 'assert',
      target: 'heading=把可信的产品事实，变成可审阅的视频。',
      assertion: { kind: 'visible', match: 'contains' },
      timeoutMs: 20_000,
      dwellMs: 1400,
      state: 'visible',
      description: '录制从工作台首屏开始',
    },
    {
      id: 'featured-video',
      action: 'assert',
      target: 'text=继续上次工作',
      assertion: { kind: 'visible', match: 'contains' },
      timeoutMs: 15_000,
      dwellMs: 500,
      state: 'visible',
      description: '首屏必须有“继续上次工作”入口',
    },
    {
      id: 'open-library',
      action: 'click',
      target: 'role=link,name="视频工程"',
      timeoutMs: 15_000,
      dwellMs: 0,
      state: 'visible',
      description: '从侧边栏进入视频工程（应用内导航，避免整页重载）',
    },
    {
      id: 'library-ready',
      action: 'assert',
      target: 'heading=视频工程',
      assertion: { kind: 'visible', match: 'contains' },
      timeoutMs: 15_000,
      dwellMs: 900,
      state: 'visible',
    },
  ];
}

/**
 * `web_studio_tour` — the product tour that mirrors the Step 2 approved plan's
 * landmarks (filter, search, storyboard, production), but generated per video
 * so it can be approved in-product. It never modifies
 * `plans/web-studio-tour.yaml`; the two may drift in wording, not in gates.
 */
function tourSteps(input: DemoPlannerInput): DemoStep[] {
  const eligible = eligiblePlannerFeatures(input);
  const first = eligible[0];
  const steps: DemoStep[] = [
    ...landingSteps(),
    {
      id: 'filter-review',
      action: 'click',
      target: 'role=button,name=待审核',
      timeoutMs: 10_000,
      dwellMs: 0,
      state: 'visible',
    },
    {
      id: 'review-filter-applied',
      action: 'assert',
      target: 'text=1 条结果',
      assertion: { kind: 'visible', match: 'contains' },
      timeoutMs: 10_000,
      dwellMs: 800,
      state: 'visible',
    },
    {
      id: 'filter-all',
      action: 'click',
      target: 'role=button,name=全部',
      timeoutMs: 10_000,
      dwellMs: 0,
      state: 'visible',
    },
    {
      id: 'all-filter-applied',
      action: 'assert',
      target: 'text=2 条结果',
      assertion: { kind: 'visible', match: 'contains' },
      timeoutMs: 10_000,
      dwellMs: 500,
      state: 'visible',
    },
    {
      id: 'search-library',
      action: 'fill',
      target: 'label=搜索视频',
      valueRef: 'searchTerm',
      timeoutMs: 10_000,
      dwellMs: 0,
      state: 'visible',
    },
    {
      id: 'search-applied',
      action: 'assert',
      target: 'text=1 条结果',
      assertion: { kind: 'visible', match: 'contains' },
      timeoutMs: 10_000,
      dwellMs: 700,
      state: 'visible',
    },
    {
      id: 'clear-search',
      action: 'fill',
      target: 'label=搜索视频',
      value: '',
      timeoutMs: 10_000,
      dwellMs: 0,
      state: 'visible',
    },
    {
      id: 'open-video',
      action: 'click',
      target: 'role=link,name="Lumen 2.8 · 让问题更快被看见"',
      timeoutMs: 15_000,
      dwellMs: 0,
      state: 'visible',
    },
    {
      id: 'review-landing',
      action: 'assert',
      target: 'heading=审核与导出',
      assertion: { kind: 'visible', match: 'contains' },
      timeoutMs: 15_000,
      dwellMs: 800,
      state: 'visible',
    },
    {
      id: 'open-storyboard',
      action: 'click',
      target: 'role=link,name="分镜剧本"',
      timeoutMs: 15_000,
      dwellMs: 0,
      state: 'visible',
    },
    {
      id: 'storyboard-ready',
      action: 'assert',
      target: 'heading=镜头序列',
      assertion: { kind: 'visible', match: 'contains' },
      timeoutMs: 15_000,
      dwellMs: 1200,
      state: 'visible',
    },
    {
      id: 'open-production',
      action: 'click',
      target: 'role=link,name="生产监控 模拟 DAG"',
      timeoutMs: 15_000,
      dwellMs: 0,
      state: 'visible',
    },
    {
      id: 'production-ready',
      action: 'assert',
      target: 'heading=生产监控',
      assertion: { kind: 'visible', match: 'contains' },
      timeoutMs: 15_000,
      dwellMs: 1200,
      state: 'visible',
    },
    ...closingSteps(),
  ];
  if (first) {
    // Keep the tour honest about why it exists: the demo is per-feature even
    // when the route walk itself is shared.
    steps[0] = {
      ...steps[0]!,
      description: `录制从工作台首屏开始（演示功能：${first.feature.name}）`,
    };
  }
  return steps;
}

/**
 * `web_studio_knowledge_claim` — evidence-first demo. It opens the knowledge
 * center and asserts the contract of that page: the heading, the feature list,
 * and — for one eligible feature — its **verified claim statement** rendered
 * verbatim under “声明与证据”. A claim that is not actually in the product
 * cannot pass this plan.
 */
function knowledgeClaimSteps(input: DemoPlannerInput): DemoStep[] | { error: string } {
  const eligible = eligiblePlannerFeatures(input);
  if (eligible.length === 0) {
    return {
      error: '没有任何 4D 可发布的功能声明；知识/声明模板需要至少一个已核验声明。',
    };
  }
  const firstClaim =
    eligible[0]!.claims.find(
      (claim) => claim.status === 'verified' && (claim.eligibility ?? 'publishable') === 'publishable',
    ) ?? eligible[0]!.claims[0]!;
  const steps: DemoStep[] = [
    {
      id: 'dashboard-ready',
      action: 'assert',
      target: 'heading=把可信的产品事实，变成可审阅的视频。',
      assertion: { kind: 'visible', match: 'contains' },
      timeoutMs: 20_000,
      dwellMs: 900,
      state: 'visible',
    },
    {
      id: 'open-knowledge',
      action: 'click',
      target: 'role=link,name="知识中心"',
      timeoutMs: 15_000,
      dwellMs: 0,
      state: 'visible',
      description: '从当前项目的侧边栏进入知识中心',
    },
    {
      id: 'knowledge-ready',
      action: 'assert',
      target: 'heading=知识中心',
      assertion: { kind: 'visible', match: 'contains' },
      timeoutMs: 20_000,
      dwellMs: 1000,
      state: 'visible',
    },
    {
      id: 'knowledge-policy',
      action: 'assert',
      target: 'text=功能、声明与证据是视频卖点的唯一来源',
      assertion: { kind: 'visible', match: 'contains' },
      timeoutMs: 15_000,
      dwellMs: 700,
      state: 'visible',
      description: '知识中心的证据原则必须在首屏可见',
    },
    {
      id: 'select-feature',
      action: 'click',
      target: `text=${eligible[0]!.feature.name}`,
      timeoutMs: 15_000,
      dwellMs: 600,
      state: 'visible',
    },
    {
      id: 'feature-claims',
      action: 'assert',
      target: 'heading=声明与证据',
      assertion: { kind: 'visible', match: 'contains' },
      timeoutMs: 15_000,
      dwellMs: 900,
      state: 'visible',
    },
    {
      id: 'claim-visible',
      action: 'assert',
      target: `text=${firstClaim.statement}`,
      assertion: { kind: 'visible', match: 'contains' },
      timeoutMs: 15_000,
      dwellMs: 1400,
      state: 'visible',
      description: '已核验声明的原文必须出现在页面上，证明这条卖点不是编的',
    },
  ];
  return steps;
}

/**
 * `web_studio_route_focus` — one feature, one route, started by a direct
 * navigation. Useful when the feature's `demoRoute` is the real product entry.
 */
function routeFocusSteps(input: DemoPlannerInput): DemoStep[] | { error: string } {
  const eligible = eligiblePlannerFeatures(input);
  // Prefer the route of a 4D-eligible feature. The fallback is the product's
  // own library route, whose rendering is proven by its heading — a plan that
  // asserts an unknown page's heading would be flaky by construction.
  const route =
    eligible
      .map((entry) => input.routes.find((item) => item.featureId === entry.feature.id))
      .find((item): item is { featureId: string; route: string } => Boolean(item)) ??
    input.routes[0];
  const path = route ? normalizeRoute(route.route) : '/videos';
  const heading = route ? 'role=main' : 'heading=视频库';
  return [
    {
      id: 'navigate-route',
      action: 'navigate',
      target: path,
      timeoutMs: 30_000,
      dwellMs: 0,
      state: 'visible',
      description: route
        ? `直达 ${path}（来自 Feature.demoRoute）`
        : `直达 ${path}（项目尚未声明 demoRoute，回退到视频库）`,
    },
    {
      id: 'route-ready',
      action: 'assert',
      target: heading,
      assertion: { kind: 'visible', match: 'contains' },
      timeoutMs: 20_000,
      dwellMs: 900,
      state: 'visible',
      description: '目标页面必须真的渲染出来，证明路由可达',
    },
    {
      id: 'url-matches',
      action: 'assert',
      assertion: { kind: 'url', expected: path, match: 'contains' },
      timeoutMs: 15_000,
      dwellMs: 500,
      state: 'visible',
    },
    ...closingSteps(),
  ];
}

function assetDefaults(input: DemoPlannerInput): {
  id: string;
  name: string;
  description: string;
  palette: [string, string];
} {
  const name = input.assetName ?? `${input.video.title} · 真实界面录屏`;
  return {
    id: `asset_${demoPlanIdFor(input.video.id, input.template).replace(/^plan_/, '')}`.slice(0, 120),
    name: name.slice(0, 120),
    description:
      input.assetDescription ??
      '由规则驱动的 Demo Plan 生成的受控真实录屏；只有全部 UI 断言通过才会写回执。',
    palette: input.assetPalette ?? ['#E8A44C', '#23262D'],
  };
}

/**
 * Builds the draft. Returns a discriminated result rather than throwing so the
 * orchestrator can fail the step with a stable, user-readable reason.
 */
export function buildDemoPlanDraft(input: DemoPlannerInput): DemoPlannerResult {
  if (!DEMO_TEMPLATE_IDS.has(input.template)) {
    return { ok: false, code: 'invalid_plan', message: `未知模板：${input.template}` };
  }

  const base = new URL(input.baseUrl);
  if (base.protocol !== 'http:' && base.protocol !== 'https:') {
    return { ok: false, code: 'invalid_plan', message: 'baseUrl 必须是 http(s)' };
  }

  let steps: DemoStep[];
  if (input.template === 'custom') {
    if (!input.customSteps || input.customSteps.length === 0) {
      return {
        ok: false,
        code: 'invalid_plan',
        message: 'custom 模板需要提供步骤；没有步骤的计划不能审批。',
      };
    }
    steps = input.customSteps;
  } else if (input.template === 'web_studio_tour') {
    steps = tourSteps(input);
  } else if (input.template === 'web_studio_knowledge_claim') {
    const result = knowledgeClaimSteps(input);
    if ('error' in result) return { ok: false, code: 'invalid_plan', message: result.error };
    steps = result;
  } else {
    const result = routeFocusSteps(input);
    if ('error' in result) return { ok: false, code: 'route_missing', message: result.error };
    steps = result;
  }

  const viewport = input.viewport ?? { width: 1920, height: 1080 };
  const capture = input.capture ?? {
    width: 1920,
    height: 1080,
    fps: 30,
    clipDurationMs: 18_000,
  };
  const asset = assetDefaults(input);
  const allowedOrigins = [...new Set(input.allowedOrigins)];
  if (!allowedOrigins.includes(base.origin)) {
    return {
      ok: false,
      code: 'invalid_plan',
      message: `服务端 allowlist 不包含 ${base.origin}；拒绝生成计划（SSRF 防护）。`,
    };
  }

  const draftInput = {
    schemaVersion: CAPTURE_SCHEMA_VERSION,
    id: input.planId ?? demoPlanIdFor(input.video.id, input.template),
    projectId: input.video.projectId,
    name: `${input.video.title} · ${TEMPLATE_LABELS[input.template]}`.slice(0, 120),
    environmentId: input.environmentId ?? 'local_web_studio',
    baseUrl: input.baseUrl,
    allowedOrigins,
    resetStrategy: input.resetStrategy ?? 'fixture',
    ...(input.clockTime ? { clockTime: input.clockTime } : {}),
    viewport: {
      width: viewport.width,
      height: viewport.height,
      deviceScaleFactor: 1,
    },
    locale: input.locale ?? 'zh-CN',
    timezoneId: input.timezoneId ?? 'Asia/Shanghai',
    colorScheme: input.colorScheme ?? 'dark',
    reducedMotion: 'no-preference' as const,
    // A demo plan may never carry a credential: only the search term is used,
    // and it is a UI label, not a secret.
    fixtures: { searchTerm: '快速上手' },
    capture: {
      width: capture.width,
      height: capture.height,
      fps: capture.fps ?? 30,
      clipDurationMs: capture.clipDurationMs ?? 18_000,
    },
    asset,
    steps,
  };

  const parsed = demoPlanDraftV1Schema.safeParse(draftInput);
  if (!parsed.success) {
    return {
      ok: false,
      code: 'invalid_plan',
      message: `计划未通过 schema：${parsed.error.issues
        .slice(0, 4)
        .map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`)
        .join('；')}`,
    };
  }
  // `routeUrl` is exported for callers that need the absolute target; the plan
  // itself stays relative so the origin check above is the only coupling.
  void routeUrl;
  return { ok: true, draft: parsed.data };
}

const DEMO_TEMPLATE_IDS = new Set<string>(['web_studio_tour', 'web_studio_knowledge_claim', 'web_studio_route_focus', 'custom']);

export const TEMPLATE_LABELS: Record<DemoPlanTemplateId, string> = {
  web_studio_tour: 'web-studio 巡览',
  web_studio_knowledge_claim: '知识/声明验证',
  web_studio_route_focus: '按路由聚焦',
  custom: '自定义计划',
};

/** The options the API accepts for a capture run; mirrored by the UI form. */
export interface DemoPlannerOptions {
  template: DemoPlanTemplateId;
  baseUrl: string;
  resetStrategy?: 'fixture' | 'none';
  viewport?: { width: number; height: number };
  capture?: { width: number; height: number; fps?: number; clipDurationMs?: number };
  customSteps?: DemoStep[];
}

export function defaultPlannerOptions(baseUrl: string): DemoPlannerOptions {
  return { template: 'web_studio_knowledge_claim', baseUrl };
}
