import {
  GATE2_POLICY_VERSION,
  TEMPLATE_LABELS,
  assessDemoPlanRisk,
  buildDemoPlanDraft,
  computeDemoPlanDigest,
  type Claim,
  type DemoPlanDraftV1,
  type DemoPlanRiskSummaryV1,
  type DemoPlanTemplateId,
  type Feature,
  type StudioSnapshot,
  type VideoProject,
} from '@asvs/domain';
import type { CaptureHealth, CaptureRunOptions } from '@asvs/ports';
import { OrchestrationHttpError } from './errors';

/**
 * Server-side Demo Planner (Step 5C, layer 2).
 *
 * The pure rules live in `@asvs/domain/demo-planner`; this service adds the
 * three things that need server state:
 *
 *   1. the **server origin allowlist** (`ASVS_CAPTURE_ALLOWED_ORIGINS`), which
 *      every plan's origins must be a subset of (SSRF / inner-network guard,
 *      docs/08 §3);
 *   2. resolution of the video's 4D-verified features/claims and routes;
 *   3. digest + risk, computed from the same canonical bytes the worker will
 *      re-check before it launches Chromium.
 */
export interface CaptureServiceConfig {
  enabled: boolean;
  allowedOrigins: string[];
  defaultBaseUrl: string;
  /**
   * Allow the worker to start a local web server when the target is down.
   * Off by default: a capture against an unknown host must fail loudly.
   */
  allowAutoServe: boolean;
}

export interface PlannedCapture {
  draft: DemoPlanDraftV1;
  digest: string;
  risk: DemoPlanRiskSummaryV1;
  template: DemoPlanTemplateId;
  templateLabel: string;
  policyVersion: string;
  baseUrl: string;
  allowedOrigins: string[];
  /** True when the worker should bring the target up itself. */
  serve: boolean;
}

export interface DemoPlannerServiceOptions {
  config: CaptureServiceConfig;
  /** Resolves origins against the plan's base URL; defaults to localhost. */
  now?: () => Date;
}

export const DEFAULT_CAPTURE_CONFIG: CaptureServiceConfig = {
  enabled: true,
  allowedOrigins: ['http://localhost:4200', 'http://127.0.0.1:4200'],
  defaultBaseUrl: 'http://localhost:4200',
  allowAutoServe: false,
};

/** Resolves the video's features/claims to the planner's input shape. */
export function resolvePlannerFeatures(
  snapshot: StudioSnapshot,
  video: VideoProject,
): Array<{ feature: Feature; claims: Claim[]; sceneIds: string[] }> {
  const featureIds = new Set(video.brief.featureIds);
  const sceneIdsByFeature = new Map<string, string[]>();
  for (const scene of video.scenes) {
    if (!scene.featureId) continue;
    const list = sceneIdsByFeature.get(scene.featureId) ?? [];
    list.push(scene.id);
    sceneIdsByFeature.set(scene.featureId, list);
    featureIds.add(scene.featureId);
  }
  const features = snapshot.features.filter(
    (feature) => feature.projectId === video.projectId && featureIds.has(feature.id),
  );
  return features.map((feature) => ({
    feature,
    claims: snapshot.claims.filter(
      (claim) => claim.projectId === video.projectId && claim.featureId === feature.id,
    ),
    sceneIds: sceneIdsByFeature.get(feature.id) ?? [],
  }));
}

/** Routes the planner may navigate to, taken only from real feature records. */
export function resolvePlannerRoutes(
  snapshot: StudioSnapshot,
  video: VideoProject,
): Array<{ featureId: string; route: string }> {
  return snapshot.features
    .filter(
      (feature) =>
        feature.projectId === video.projectId &&
        typeof feature.demoRoute === 'string' &&
        feature.demoRoute.trim().length > 0,
    )
    .map((feature) => ({ featureId: feature.id, route: feature.demoRoute.trim() }));
}

/** Scenes whose visual is a real demo; these are what a capture run serves. */
export function realDemoScenes(video: VideoProject): VideoProject['scenes'] {
  return video.scenes.filter(
    (scene) => scene.visualType === 'real_demo' || scene.visual?.type === 'real_demo',
  );
}

export class DemoPlannerService {
  constructor(private readonly options: DemoPlannerServiceOptions) {}

  get config(): CaptureServiceConfig {
    return this.options.config;
  }

  get policyVersion(): string {
    return GATE2_POLICY_VERSION;
  }

  health(): CaptureHealth {
    return {
      enabled: this.options.config.enabled,
      allowedOrigins: [...this.options.config.allowedOrigins],
      defaultBaseUrl: this.options.config.defaultBaseUrl,
      allowAutoServe: this.options.config.allowAutoServe,
      policyVersion: GATE2_POLICY_VERSION,
    };
  }

  /**
   * Validates the creation-time options and fails closed. Called by
   * `createRun` before any row is written, so a rejected capture request
   * leaves no half-created run behind.
   */
  validateCreateOptions(
    video: VideoProject,
    options: CaptureRunOptions | undefined,
  ): { enabled: boolean; resolved: ResolvedCaptureOptions | null } {
    const enabled = options?.enabled === true;
    if (!enabled) return { enabled: false, resolved: null };

    if (!this.options.config.enabled) {
      throw new OrchestrationHttpError(
        503,
        'capture_not_configured',
        '服务端未启用真实录屏（ASVS_CAPTURE_ENABLED=false）。请显式开启，或关闭 capture 选项。',
      );
    }
    const scenes = realDemoScenes(video);
    if (scenes.length === 0) {
      // Fail closed: requesting capture for a video with nothing to capture is
      // a client bug, never something to skip silently.
      throw new OrchestrationHttpError(
        400,
        'no_real_demo_scenes',
        `视频 ${video.id} 没有 real_demo 镜头；capture.enabled=true 时无法生成演示计划。请先在生产监控前把至少一个镜头设为 real_demo。`,
      );
    }
    const baseUrl = (options.baseUrl ?? this.options.config.defaultBaseUrl).trim();
    let origin: string;
    try {
      const parsed = new URL(baseUrl);
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
        throw new Error('protocol');
      }
      origin = parsed.origin;
    } catch {
      throw new OrchestrationHttpError(
        400,
        'capture_invalid_base_url',
        `capture.baseUrl 不是合法的 http(s) 地址：${baseUrl}`,
      );
    }
    if (!this.options.config.allowedOrigins.includes(origin)) {
      throw new OrchestrationHttpError(
        400,
        'capture_origin_not_allowed',
        `capture.baseUrl 的 origin ${origin} 不在服务端 allowlist（${this.options.config.allowedOrigins.join('、')}）中；拒绝发起录屏（SSRF 防护）。`,
      );
    }
    const template = options.template ?? 'web_studio_knowledge_claim';
    if (template === 'custom' && !options.customSteps?.length) {
      throw new OrchestrationHttpError(
        400,
        'capture_invalid_plan',
        'custom 模板需要提供步骤；没有步骤的计划不能审批。',
      );
    }
    return {
      enabled: true,
      resolved: {
        template,
        baseUrl,
        resetStrategy: options.resetStrategy ?? 'fixture',
        ...(options.viewport ? { viewport: options.viewport } : {}),
        ...(options.capture ? { capture: options.capture } : {}),
        ...(options.customSteps ? { customSteps: options.customSteps } : {}),
      },
    };
  }

  /**
   * Builds the draft the Gate 2 approval binds. Throws `OrchestrationHttpError`
   * (400 `capture_invalid_plan`) when no valid plan can be produced — the
   * `plan_demo` step then fails with the same reason instead of inventing one.
   */
  async plan(
    snapshot: StudioSnapshot,
    video: VideoProject,
    options: ResolvedCaptureOptions,
  ): Promise<PlannedCapture> {
    const result = buildDemoPlanDraft({
      workspaceId: video.projectId,
      video,
      features: resolvePlannerFeatures(snapshot, video),
      routes: resolvePlannerRoutes(snapshot, video),
      template: options.template,
      baseUrl: options.baseUrl,
      allowedOrigins: this.options.config.allowedOrigins,
      resetStrategy: options.resetStrategy,
      ...(options.viewport ? { viewport: options.viewport } : {}),
      ...(options.capture ? { capture: options.capture } : {}),
      ...(options.customSteps ? { customSteps: options.customSteps } : {}),
      assetName: `${video.title} · 真实界面录屏`,
      assetDescription:
        '由规则驱动的 Demo Plan 生成的受控真实录屏；只有全部 UI 断言通过才会写回执并进入成片。',
    });
    if (!result.ok) {
      throw new OrchestrationHttpError(
        400,
        result.code === 'no_real_demo_scenes' ? 'no_real_demo_scenes' : 'capture_invalid_plan',
        result.message,
      );
    }
    const digest = await computeDemoPlanDigest(result.draft);
    const risk = assessDemoPlanRisk(result.draft);
    const origin = new URL(result.draft.baseUrl).origin;
    return {
      draft: result.draft,
      digest,
      risk,
      template: options.template,
      templateLabel: TEMPLATE_LABELS[options.template],
      policyVersion: GATE2_POLICY_VERSION,
      baseUrl: result.draft.baseUrl,
      allowedOrigins: [origin],
      // Auto-serve is only meaningful for a local origin the server trusts.
      serve:
        this.options.config.allowAutoServe &&
        /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin),
    };
  }
}

/** Normalized capture options after validation. */
export interface ResolvedCaptureOptions {
  template: DemoPlanTemplateId;
  baseUrl: string;
  resetStrategy: 'fixture' | 'none';
  viewport?: { width: number; height: number };
  capture?: { width: number; height: number; fps?: number; clipDurationMs?: number };
  customSteps?: DemoPlanDraftV1['steps'];
}
