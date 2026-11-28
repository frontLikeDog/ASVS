import { z } from 'zod';
import { sha256Hex, stableJson, stableStringify } from './canonical';
import { ASSET_MEDIA_MIME_TYPES, assetSchema, hexColorSchema, idSchema, isoDateSchema } from './schemas';

/**
 * Step 2 capture contracts (docs/07 §2–3, docs/05 §5).
 *
 * A DemoPlan is data, never code: the executor only understands the actions
 * below and resolves locators from a small, non-CSS selector DSL. Anything
 * unknown must be rejected by the schema before a browser is launched.
 */
export const CAPTURE_SCHEMA_VERSION = '1' as const;

export const DEMO_STEP_ACTIONS = [
  'navigate',
  'click',
  'fill',
  'press',
  'wait_for',
  'assert',
  'capture',
] as const;
export type DemoStepAction = (typeof DEMO_STEP_ACTIONS)[number];

export const DEMO_ASSERTION_KINDS = [
  'visible',
  'hidden',
  'text',
  'url',
  'count',
  'value',
  'attribute',
] as const;
export type DemoAssertionKind = (typeof DEMO_ASSERTION_KINDS)[number];

/**
 * The only selector prefixes a DemoPlan may use. This list is the single
 * source of truth: the schema rejects anything else *before* a browser is
 * launched, and `workers/browser-worker/src/selector.ts` resolves exactly the
 * same DSL at runtime.
 *
 *   role=button,name=Start · heading=视频库 · label=搜索视频 · placeholder=…
 *   testid=task-status-running · text=1 条结果 · alt=产品截图
 */
export const CAPTURE_SELECTOR_PREFIXES = [
  'role',
  'heading',
  'label',
  'placeholder',
  'testid',
  'text',
  'alt',
] as const;
export type CaptureSelectorPrefix = (typeof CAPTURE_SELECTOR_PREFIXES)[number];

/** ARIA roles the DSL allows. Anything else is rejected in schema and runtime. */
export const SAFE_ARIA_ROLES = [
  'alert',
  'article',
  'banner',
  'button',
  'cell',
  'checkbox',
  'columnheader',
  'combobox',
  'complementary',
  'dialog',
  'figure',
  'form',
  'group',
  'heading',
  'img',
  'link',
  'list',
  'listitem',
  'main',
  'menu',
  'menuitem',
  'navigation',
  'note',
  'option',
  'progressbar',
  'radio',
  'region',
  'row',
  'rowheader',
  'search',
  'separator',
  'slider',
  'spinbutton',
  'status',
  'switch',
  'tab',
  'table',
  'tablist',
  'textbox',
  'toolbar',
  'tooltip',
] as const;

const SAFE_ARIA_ROLE_SET = new Set<string>(SAFE_ARIA_ROLES);

function roleSelectorProblem(body: string): string | null {
  const comma = body.indexOf(',');
  const role = (comma === -1 ? body : body.slice(0, comma)).trim();
  if (!role) return 'role selector 缺少角色，例如 role=button,name=Start';
  if (!SAFE_ARIA_ROLE_SET.has(role)) {
    return `不允许的 ARIA role "${role}"。允许的 role：${[...SAFE_ARIA_ROLES].sort().join(', ')}`;
  }
  if (comma === -1) return null;

  const rest = body.slice(comma + 1).trim();
  if (rest.startsWith('name=')) {
    let name = rest.slice('name='.length);
    if (/,[a-z-]+=/i.test(name)) {
      return 'role selector 只支持 name= 或 level=，不接受额外参数';
    }
    if (name.startsWith('"') || name.endsWith('"')) {
      if (!(name.length >= 2 && name.startsWith('"') && name.endsWith('"'))) {
        return `role 的 name 引号不成对，收到 "${name}"`;
      }
      name = name.slice(1, -1);
    }
    if (!name) return 'role selector 的 name 不能为空';
    return null;
  }
  if (rest.startsWith('level=')) {
    const level = Number(rest.slice('level='.length));
    if (!Number.isInteger(level) || level < 1 || level > 6) {
      return `role 的 level 必须是 1–6 的整数，收到 "${rest}"`;
    }
    if (role !== 'heading') return 'level= 只能与 role=heading 一起使用';
    return null;
  }
  return `role selector 只支持 name= 或 level=，收到 "${rest}"`;
}

/**
 * Returns why a selector is invalid, or `null` when the DSL accepts it.
 * Bare CSS (`.btn`), bare XPath (`//button[1]`) and any unknown prefix fail
 * here, which is what makes the pre-browser gate airtight.
 */
export function describeSelectorProblem(raw: string): string | null {
  const selector = raw.trim();
  const equals = selector.indexOf('=');
  if (equals <= 0) {
    return `selector 必须以受支持的前缀开头（${CAPTURE_SELECTOR_PREFIXES.join(' / ')}），收到 "${raw}"`;
  }
  const prefix = selector.slice(0, equals);
  const body = selector.slice(equals + 1);

  switch (prefix) {
    case 'role':
      return roleSelectorProblem(body);
    case 'heading':
    case 'label':
    case 'placeholder':
    case 'testid':
    case 'text':
    case 'alt':
      return body.trim() ? null : `${prefix}= selector 缺少内容`;
    default:
      return `不支持的 selector 前缀 "${prefix}"。DemoPlan 只能使用 ${CAPTURE_SELECTOR_PREFIXES.join(' / ')}；禁止 CSS、XPath、nth-child 与任意脚本。`;
  }
}

export const demoAssertionSchema = z
  .object({
    kind: z.enum(DEMO_ASSERTION_KINDS),
    expected: z.union([z.string(), z.number(), z.boolean()]).optional(),
    /** Only for `attribute`; the attribute name to read. */
    attribute: z.string().min(1).max(80).optional(),
    /** How `expected` is compared with the observed value. */
    match: z.enum(['contains', 'exact', 'regex']).default('contains'),
  })
  .strict()
  .superRefine((assertion, ctx) => {
    const needsExpected =
      assertion.kind === 'text' ||
      assertion.kind === 'url' ||
      assertion.kind === 'count' ||
      assertion.kind === 'value' ||
      assertion.kind === 'attribute';
    if (needsExpected && assertion.expected === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `断言 "${assertion.kind}" 需要 expected`,
        path: ['expected'],
      });
    }
    if (assertion.kind === 'attribute' && !assertion.attribute) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'attribute 断言需要 attribute 名称',
        path: ['attribute'],
      });
    }
    if (assertion.kind === 'count' && typeof assertion.expected !== 'number') {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'count 断言的 expected 必须是数字',
        path: ['expected'],
      });
    }
    if (assertion.match === 'regex' && typeof assertion.expected === 'string') {
      try {
        new RegExp(assertion.expected);
      } catch {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'regex 断言的 expected 不是合法正则',
          path: ['expected'],
        });
      }
    }
  });
export type DemoAssertion = z.infer<typeof demoAssertionSchema>;

export const demoStepSchema = z
  .object({
    id: idSchema,
    action: z.enum(DEMO_STEP_ACTIONS),
    /** Selector DSL: role=button,name=Start · testid=… · label=… · text=… · heading=… */
    target: z.string().min(1).max(500).optional(),
    /** Literal value for `fill` / `press`; never a credential. */
    value: z.string().max(2000).optional(),
    /** Reference into `fixtures`; preferred over `value` for reusable data. */
    valueRef: z.string().min(1).max(200).optional(),
    /** Key for `press`. */
    key: z.string().min(1).max(80).optional(),
    timeoutMs: z.number().int().min(300).max(60_000).default(10_000),
    /** Presentation pacing for the recording, never used for synchronization. */
    dwellMs: z.number().int().min(0).max(15_000).default(0),
    /** Only `wait_for` uses this state. */
    state: z.enum(['visible', 'hidden', 'attached']).default('visible'),
    assertion: demoAssertionSchema.optional(),
    description: z.string().max(300).optional(),
  })
  .strict()
  .superRefine((step, ctx) => {
    const fail = (message: string, path: (string | number)[] = []) =>
      ctx.addIssue({ code: z.ZodIssueCode.custom, message, path });

    const hasValue = step.value !== undefined;
    const hasValueRef = step.valueRef !== undefined;

    switch (step.action) {
      case 'navigate':
        if (!step.target) fail('navigate 需要 target 路径', ['target']);
        if (hasValue || hasValueRef || step.key || step.assertion) {
          fail('navigate 不接受 value / valueRef / key / assertion');
        }
        break;
      case 'click':
        if (!step.target) fail('click 需要 target', ['target']);
        if (hasValue || hasValueRef || step.key || step.assertion) {
          fail('click 不接受 value / valueRef / key / assertion');
        }
        break;
      case 'fill':
        if (!step.target) fail('fill 需要 target', ['target']);
        if (hasValue === hasValueRef) fail('fill 必须且只能提供 value 或 valueRef 之一');
        if (step.key || step.assertion) fail('fill 不接受 key / assertion');
        break;
      case 'press':
        if (!step.target) fail('press 需要 target', ['target']);
        if (hasValue === (step.key !== undefined)) fail('press 必须且只能提供 key 或 value 之一');
        if (hasValueRef || step.assertion) fail('press 不接受 valueRef / assertion');
        break;
      case 'wait_for':
        if (!step.target) fail('wait_for 需要 target', ['target']);
        if (hasValue || hasValueRef || step.key || step.assertion) {
          fail('wait_for 不接受 value / valueRef / key / assertion');
        }
        break;
      case 'assert':
        if (!step.assertion) fail('assert 需要 assertion', ['assertion']);
        if (step.assertion && step.assertion.kind !== 'url' && !step.target) {
          fail(`断言 "${step.assertion.kind}" 需要 target`, ['target']);
        }
        if (hasValue || hasValueRef || step.key) {
          fail('assert 不接受 value / valueRef / key');
        }
        break;
      case 'capture':
        if (hasValue || hasValueRef || step.key || step.assertion) {
          fail('capture 不接受 value / valueRef / key / assertion');
        }
        break;
    }

    // Whitelist gate: every target that will be resolved as a selector must
    // use the semantic DSL. Bare CSS/XPath is rejected here, before any
    // browser is launched (navigate paths and url assertions are exempt).
    const usesSelector =
      step.target !== undefined &&
      step.action !== 'navigate' &&
      !(step.action === 'assert' && step.assertion?.kind === 'url');
    if (usesSelector) {
      const problem = describeSelectorProblem(step.target!);
      if (problem) fail(`target 不合法：${problem}`, ['target']);
    }
  });
export type DemoStep = z.infer<typeof demoStepSchema>;

const originSchema = z
  .string()
  .max(300)
  .refine((value) => {
    try {
      const url = new URL(value);
      return url.origin === value && (url.protocol === 'http:' || url.protocol === 'https:');
    } catch {
      return false;
    }
  }, 'allowedOrigins 必须是精确的 http(s) origin，例如 http://localhost:4200（不含路径）');

const fixtureKeySchema = z
  .string()
  .min(1)
  .max(80)
  .regex(/^[a-z][a-zA-Z0-9_.-]*$/, 'fixture key 必须以小写字母开头');

const forbiddenFixtureKey = /pass(word)?|secret|token|credential|api[-_]?key|private[-_]?key/i;

export const demoPlanV1Schema = z
  .object({
    schemaVersion: z.literal(CAPTURE_SCHEMA_VERSION),
    id: idSchema,
    projectId: idSchema,
    name: z.string().min(1).max(120),
    environmentId: idSchema,
    baseUrl: z.string().url(),
    allowedOrigins: z.array(originSchema).min(1).max(10),
    /** `fixture` clears storage and reloads the seed before recording. */
    resetStrategy: z.enum(['fixture', 'none']).default('fixture'),
    /** Fixed Date for relative-time labels; does not freeze timers/animations. */
    clockTime: isoDateSchema.optional(),
    viewport: z
      .object({
        width: z.number().int().min(320).max(3840),
        height: z.number().int().min(180).max(2160),
        deviceScaleFactor: z.number().min(1).max(3).default(1),
      })
      .strict(),
    locale: z.string().min(2).max(20).default('zh-CN'),
    timezoneId: z.string().min(1).max(80).default('Asia/Shanghai'),
    colorScheme: z.enum(['dark', 'light']).default('dark'),
    reducedMotion: z.enum(['reduce', 'no-preference']).default('no-preference'),
    fixtures: z.record(fixtureKeySchema, z.string().max(2000)).default({}),
    capture: z
      .object({
        width: z.number().int().min(320).max(3840),
        height: z.number().int().min(180).max(2160),
        fps: z.number().int().min(1).max(60).default(30),
        /** Length of the presentation clip cut out of the full recording. */
        clipDurationMs: z.number().int().min(2000).max(60_000).default(14_000),
      })
      .strict(),
    asset: z
      .object({
        id: idSchema,
        name: z.string().min(1).max(120),
        description: z.string().min(1).max(400),
        palette: z.tuple([hexColorSchema, hexColorSchema]),
      })
      .strict(),
    approval: z
      .object({
        approvalId: idSchema,
        /** Digest of the plan with `approval` removed; see docs/08 §9 case 7. */
        approvedPlanDigest: z.string().regex(/^[a-f0-9]{64}$/, '需要 64 位小写十六进制 SHA256'),
        approvedAt: isoDateSchema.optional(),
      })
      .strict(),
    steps: z.array(demoStepSchema).min(1).max(60),
  })
  .strict()
  .superRefine((plan, ctx) => {
    const fail = (message: string, path: (string | number)[] = []) =>
      ctx.addIssue({ code: z.ZodIssueCode.custom, message, path });

    const base = new URL(plan.baseUrl);
    if (!plan.allowedOrigins.includes(base.origin)) {
      fail(`baseUrl 的 origin ${base.origin} 不在 allowedOrigins 中`, ['baseUrl']);
    }
    const uniqueOrigins = new Set(plan.allowedOrigins);
    if (uniqueOrigins.size !== plan.allowedOrigins.length) {
      fail('allowedOrigins 不能重复', ['allowedOrigins']);
    }

    const viewportRatio = plan.viewport.width / plan.viewport.height;
    if (Math.abs(viewportRatio - 16 / 9) > 0.01) {
      fail('Step 2 只支持 16:9 viewport；竖屏需要独立布局', ['viewport']);
    }
    const captureRatio = plan.capture.width / plan.capture.height;
    if (Math.abs(captureRatio - 16 / 9) > 0.01) {
      fail('录制画面必须是 16:9', ['capture', 'width']);
    }
    if (
      Math.abs(
        plan.capture.width / plan.viewport.width - plan.capture.height / plan.viewport.height,
      ) > 0.01
    ) {
      fail('录制画面与 viewport 的宽高比必须一致', ['capture']);
    }
    if (plan.capture.width < plan.viewport.width || plan.capture.height < plan.viewport.height) {
      fail('录制画面不能小于 viewport（避免缩小后模糊）', ['capture']);
    }

    if (plan.clockTime && Number.isNaN(Date.parse(plan.clockTime))) {
      fail('clockTime 不是合法时间', ['clockTime']);
    }

    const stepIds = new Set<string>();
    let assertCount = 0;
    for (const [index, step] of plan.steps.entries()) {
      if (stepIds.has(step.id)) fail(`步骤 id 重复：${step.id}`, ['steps', index, 'id']);
      stepIds.add(step.id);
      if (step.action === 'assert') assertCount += 1;
      if (step.valueRef && !(step.valueRef in plan.fixtures)) {
        fail(`valueRef "${step.valueRef}" 在 fixtures 中不存在`, [
          'steps',
          index,
          'valueRef',
        ]);
      }
    }
    if (assertCount === 0) {
      fail('DemoPlan 必须至少包含一个 assert 步骤（断言优先）', ['steps']);
    }

    for (const key of Object.keys(plan.fixtures)) {
      if (forbiddenFixtureKey.test(key)) {
        fail(`fixture "${key}" 看起来是凭证字段；DemoPlan 不得包含密码/token`, ['fixtures', key]);
      }
    }
  });
export type DemoPlanV1 = z.infer<typeof demoPlanV1Schema>;

/* -------------------------------------------------------------------------- */
/* Gate 2 · draft, digest and risk (Step 5C)                                  */
/* -------------------------------------------------------------------------- */

/**
 * The Gate 2 approval policy this codebase implements (docs/06 §3). Every
 * approval row records it, so an approval taken under a weaker policy can be
 * recognised — and refused — after the policy is tightened.
 */
export const GATE2_POLICY_VERSION = 'gate2-v1' as const;

export const DEMO_PLAN_TEMPLATE_IDS = [
  'web_studio_tour',
  'web_studio_knowledge_claim',
  'web_studio_route_focus',
  'custom',
] as const;
export type DemoPlanTemplateId = (typeof DEMO_PLAN_TEMPLATE_IDS)[number];
export const demoPlanTemplateIdSchema = z.enum(DEMO_PLAN_TEMPLATE_IDS);

/**
 * A DemoPlan before approval: identical to `DemoPlanV1` without the
 * `approval` block. The planner emits this; the orchestrator persists it,
 * hashes it, and only then attaches an approval placeholder.
 *
 * `id`/`projectId` are looser here because a draft is produced from a video
 * whose ids the planner must echo, not invent (see `buildDemoPlanDraft`).
 */
export const demoPlanDraftV1Schema = z
  .object({
    schemaVersion: z.literal(CAPTURE_SCHEMA_VERSION),
    id: idSchema,
    projectId: idSchema,
    name: z.string().min(1).max(120),
    environmentId: idSchema,
    baseUrl: z.string().url(),
    allowedOrigins: z.array(originSchema).min(1).max(10),
    resetStrategy: z.enum(['fixture', 'none']).default('fixture'),
    clockTime: isoDateSchema.optional(),
    viewport: z
      .object({
        width: z.number().int().min(320).max(3840),
        height: z.number().int().min(180).max(2160),
        deviceScaleFactor: z.number().min(1).max(3).default(1),
      })
      .strict(),
    locale: z.string().min(2).max(20).default('zh-CN'),
    timezoneId: z.string().min(1).max(80).default('Asia/Shanghai'),
    colorScheme: z.enum(['dark', 'light']).default('dark'),
    reducedMotion: z.enum(['reduce', 'no-preference']).default('no-preference'),
    fixtures: z.record(fixtureKeySchema, z.string().max(2000)).default({}),
    capture: z
      .object({
        width: z.number().int().min(320).max(3840),
        height: z.number().int().min(180).max(2160),
        fps: z.number().int().min(1).max(60).default(30),
        clipDurationMs: z.number().int().min(2000).max(60_000).default(14_000),
      })
      .strict(),
    asset: z
      .object({
        id: idSchema,
        name: z.string().min(1).max(120),
        description: z.string().min(1).max(400),
        palette: z.tuple([hexColorSchema, hexColorSchema]),
      })
      .strict(),
    steps: z.array(demoStepSchema).min(1).max(60),
  })
  .strict()
  .superRefine((plan, ctx) => {
    const fail = (message: string, path: (string | number)[] = []) =>
      ctx.addIssue({ code: z.ZodIssueCode.custom, message, path });

    const base = new URL(plan.baseUrl);
    if (!plan.allowedOrigins.includes(base.origin)) {
      fail(`baseUrl 的 origin ${base.origin} 不在 allowedOrigins 中`, ['baseUrl']);
    }
    if (new Set(plan.allowedOrigins).size !== plan.allowedOrigins.length) {
      fail('allowedOrigins 不能重复', ['allowedOrigins']);
    }

    const viewportRatio = plan.viewport.width / plan.viewport.height;
    if (Math.abs(viewportRatio - 16 / 9) > 0.01) {
      fail('Step 2 只支持 16:9 viewport；竖屏需要独立布局', ['viewport']);
    }
    if (Math.abs(plan.capture.width / plan.capture.height - 16 / 9) > 0.01) {
      fail('录制画面必须是 16:9', ['capture', 'width']);
    }
    if (plan.capture.width < plan.viewport.width || plan.capture.height < plan.viewport.height) {
      fail('录制画面不能小于 viewport（避免缩小后模糊）', ['capture']);
    }

    const stepIds = new Set<string>();
    let assertCount = 0;
    for (const [index, step] of plan.steps.entries()) {
      if (stepIds.has(step.id)) fail(`步骤 id 重复：${step.id}`, ['steps', index, 'id']);
      stepIds.add(step.id);
      if (step.action === 'assert') assertCount += 1;
      if (step.valueRef && !(step.valueRef in plan.fixtures)) {
        fail(`valueRef "${step.valueRef}" 在 fixtures 中不存在`, ['steps', index, 'valueRef']);
      }
    }
    if (assertCount === 0) {
      fail('DemoPlan 必须至少包含一个 assert 步骤（断言优先）', ['steps']);
    }
    for (const key of Object.keys(plan.fixtures)) {
      if (forbiddenFixtureKey.test(key)) {
        fail(`fixture "${key}" 看起来是凭证字段；DemoPlan 不得包含密码/token`, ['fixtures', key]);
      }
    }
  });
export type DemoPlanDraftV1 = z.infer<typeof demoPlanDraftV1Schema>;

/**
 * Canonical bytes of the plan content the approval binds: every field except
 * `approval`, keys sorted, `undefined` dropped. The browser-worker's
 * `demoPlanDigest` hashes exactly these bytes with `node:crypto`; this module
 * hashes them with WebCrypto so the API and the UI can compute the same value.
 */
export function canonicalDemoPlanJson(plan: DemoPlanDraftV1 | DemoPlanV1): string {
  const { approval: _approval, ...rest } = plan as DemoPlanV1;
  return stableStringify(rest);
}

/** SHA-256 over `canonicalDemoPlanJson`; the only digest Gate 2 may bind. */
export async function computeDemoPlanDigest(
  plan: DemoPlanDraftV1 | DemoPlanV1,
): Promise<string> {
  return sha256Hex(canonicalDemoPlanJson(plan));
}

/** Attaches an approval block without changing the digested bytes. */
export function withDemoPlanApproval(
  draft: DemoPlanDraftV1,
  approval: DemoPlanV1['approval'],
): DemoPlanV1 {
  return demoPlanV1Schema.parse({ ...draft, approval });
}

/* -------------------------------------------------------------------------- */
/* Gate 2 · risk summary                                                      */
/* -------------------------------------------------------------------------- */

export const DEMO_PLAN_RISK_LEVELS = ['low', 'medium', 'high'] as const;
export type DemoPlanRiskLevel = (typeof DEMO_PLAN_RISK_LEVELS)[number];

export const demoPlanRiskFindingV1Schema = z
  .object({
    /** Stable machine code, e.g. `many_origins` or `mutating_action`. */
    code: z.string().min(1).max(80),
    level: z.enum(DEMO_PLAN_RISK_LEVELS),
    message: z.string().min(1).max(400),
    stepId: idSchema.optional(),
  })
  .strict();
export type DemoPlanRiskFindingV1 = z.infer<typeof demoPlanRiskFindingV1Schema>;

/**
 * The summary the approver actually reads. `level` is derived from the worst
 * finding, so an approver can never see "low" next to an unresolved risk.
 */
export const demoPlanRiskSummaryV1Schema = z
  .object({
    level: z.enum(DEMO_PLAN_RISK_LEVELS),
    findings: z.array(demoPlanRiskFindingV1Schema),
    assertionCount: z.number().int().min(0),
    stepCount: z.number().int().min(0),
    originCount: z.number().int().min(1),
    writeScope: z.enum(['none', 'local_ui_state', 'network_write']),
  })
  .strict();
export type DemoPlanRiskSummaryV1 = z.infer<typeof demoPlanRiskSummaryV1Schema>;

const MUTATING_ACTION_PATTERN = /提交|保存|发布|删除|移除|创建|新建|确认|支付|购买|subscribe|delete|remove|publish|create|save|submit/i;

function worstLevel(findings: readonly DemoPlanRiskFindingV1[]): DemoPlanRiskLevel {
  if (findings.some((finding) => finding.level === 'high')) return 'high';
  if (findings.some((finding) => finding.level === 'medium')) return 'medium';
  return 'low';
}

/**
 * Deterministic, rule-based risk assessment — no model in the loop. The rules
 * mirror docs/08 §3 (write operations, origins, credentials) and docs/06 §3
 * (what the approver must be able to see before approving).
 */
export function assessDemoPlanRisk(plan: DemoPlanDraftV1 | DemoPlanV1): DemoPlanRiskSummaryV1 {
  const findings: DemoPlanRiskFindingV1[] = [];
  const add = (finding: DemoPlanRiskFindingV1) => findings.push(finding);

  if (plan.allowedOrigins.length > 1) {
    add({
      code: 'many_origins',
      level: 'medium',
      message: `计划允许 ${plan.allowedOrigins.length} 个 origin；每次新增外部域名都需要重新评估。`,
    });
  }
  if (plan.resetStrategy === 'none') {
    add({
      code: 'fixture_not_reset',
      level: 'medium',
      message: 'resetStrategy=none：录制不会清理本地存储，环境残留可能影响断言。',
    });
  }
  if (plan.steps.some((step) => step.action === 'fill')) {
    add({
      code: 'form_input',
      level: 'medium',
      message: '计划包含填写操作；fixtures 中的值会出现在录屏画面里，不得填写真实凭证。',
    });
  }
  for (const step of plan.steps) {
    if (
      (step.action === 'click' || step.action === 'press') &&
      step.target &&
      MUTATING_ACTION_PATTERN.test(step.target)
    ) {
      add({
        code: 'mutating_action',
        level: 'high',
        message: `步骤 ${step.id} 会触发写操作（${step.target}）；请确认它只修改演示数据。`,
        stepId: step.id,
      });
    }
  }
  if (plan.steps.length > 30) {
    add({
      code: 'long_plan',
      level: 'medium',
      message: `计划包含 ${plan.steps.length} 个步骤，录制时间越长，环境波动导致的失败越多。`,
    });
  }

  const assertionCount = plan.steps.filter((step) => step.action === 'assert').length;
  if (assertionCount < 2) {
    add({
      code: 'few_assertions',
      level: 'medium',
      message: `只有 ${assertionCount} 个 UI 断言；建议每个关键停靠点都至少有一个断言。`,
    });
  }
  for (const [index, step] of plan.steps.entries()) {
    if (step.action === 'assert' || step.action === 'capture') continue;
    const hasFollowingAssertion = plan.steps
      .slice(index + 1)
      .some((later) => later.action === 'assert');
    if (!hasFollowingAssertion) {
      add({
        code: 'unasserted_tail',
        level: 'medium',
        message: `步骤 ${step.id} 之后没有任何断言，最后一段操作无法证明成功。`,
        stepId: step.id,
      });
      break;
    }
  }

  const writeScope = plan.steps.some(
    (step) =>
      (step.action === 'click' || step.action === 'press') &&
      step.target &&
      MUTATING_ACTION_PATTERN.test(step.target),
  )
    ? 'local_ui_state'
    : plan.steps.some((step) => step.action === 'fill' || step.action === 'click' || step.action === 'press')
      ? 'local_ui_state'
      : 'none';

  return {
    level: worstLevel(findings),
    findings,
    assertionCount,
    stepCount: plan.steps.length,
    originCount: plan.allowedOrigins.length,
    writeScope,
  };
}

/* -------------------------------------------------------------------------- */
/* Execution records                                                          */
/* -------------------------------------------------------------------------- */

const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/, '需要 64 位小写十六进制 SHA256');

export const captureEnvironmentV1Schema = z
  .object({
    baseUrl: z.string().url(),
    browser: z.string().min(1),
    viewport: z
      .object({
        width: z.number().int().positive(),
        height: z.number().int().positive(),
        deviceScaleFactor: z.number().positive(),
      })
      .strict(),
    locale: z.string().min(1),
    timezoneId: z.string().min(1),
    colorScheme: z.enum(['dark', 'light']),
    reducedMotion: z.enum(['reduce', 'no-preference']),
    clockTime: isoDateSchema.optional(),
  })
  .strict();

export const captureAssertionResultV1Schema = z
  .object({
    kind: z.enum(DEMO_ASSERTION_KINDS),
    expected: z.string().optional(),
    actual: z.string().optional(),
    passed: z.boolean(),
  })
  .strict();

export const captureStepResultV1Schema = z
  .object({
    id: idSchema,
    action: z.enum(DEMO_STEP_ACTIONS),
    status: z.enum(['passed', 'failed', 'skipped']),
    startedAtMs: z.number().int().nonnegative(),
    durationMs: z.number().int().nonnegative(),
    assertion: captureAssertionResultV1Schema.optional(),
    screenshot: z.string().optional(),
    error: z.string().optional(),
  })
  .strict();

export const captureArtifactFileV1Schema = z
  .object({
    file: z.string().min(1),
    sha256: sha256Schema,
    byteSize: z.number().int().positive(),
    mimeType: z.string().min(1),
  })
  .strict();

export const captureVideoFileV1Schema = captureArtifactFileV1Schema
  .extend({
    width: z.number().int().positive(),
    height: z.number().int().positive(),
    fps: z.number().positive(),
    durationMs: z.number().int().positive(),
    codecName: z.string().min(1),
  })
  .strict();

/** The real-material link written into the render fixture. */
export const captureMediaRefV1Schema = z
  .object({
    assetId: idSchema,
    /** Workspace-relative path to the normalized clip. */
    sourceFile: z.string().min(1),
    sha256: sha256Schema,
    mimeType: z.enum(ASSET_MEDIA_MIME_TYPES),
    width: z.number().int().positive(),
    height: z.number().int().positive(),
    durationMs: z.number().int().positive(),
  })
  .strict();

export const captureReceiptV1Schema = z
  .object({
    schemaVersion: z.literal(CAPTURE_SCHEMA_VERSION),
    kind: z.literal('asvs.capture-receipt'),
    jobId: idSchema,
    planId: idSchema,
    planFile: z.string().min(1),
    planDigest: sha256Schema,
    approvalId: idSchema,
    createdAt: isoDateSchema,
    environment: captureEnvironmentV1Schema,
    assertions: z
      .object({
        total: z.number().int().min(1),
        passed: z.number().int().min(1),
        failed: z.literal(0),
      })
      .strict(),
    steps: z.array(captureStepResultV1Schema).min(1),
    rawVideo: captureVideoFileV1Schema,
    clip: captureVideoFileV1Schema,
    trace: captureArtifactFileV1Schema,
    screenshots: z.array(captureArtifactFileV1Schema).min(1),
    asset: assetSchema,
    media: captureMediaRefV1Schema,
    renderFixture: z
      .object({ file: z.string().min(1), sha256: sha256Schema })
      .strict(),
  })
  .strict()
  .superRefine((receipt, ctx) => {
    const fail = (message: string, path: (string | number)[] = []) =>
      ctx.addIssue({ code: z.ZodIssueCode.custom, message, path });

    if (receipt.assertions.passed !== receipt.assertions.total) {
      fail('回执中的断言总数与通过数不一致', ['assertions']);
    }
    if (receipt.asset.mock) {
      fail('真实录屏的 Asset 必须 mock: false', ['asset', 'mock']);
    }
    if (!receipt.asset.media) {
      fail('真实录屏的 Asset 必须携带 media 元数据', ['asset', 'media']);
    } else {
      if (receipt.asset.media.sha256 !== receipt.clip.sha256) {
        fail('Asset.media.sha256 与 clip.sha256 不一致', ['asset', 'media', 'sha256']);
      }
      if (receipt.asset.media.durationMs !== receipt.clip.durationMs) {
        fail('Asset.media.durationMs 与 clip.durationMs 不一致', [
          'asset',
          'media',
          'durationMs',
        ]);
      }
    }
    if (receipt.media.assetId !== receipt.asset.id) {
      fail('media.assetId 与 asset.id 不一致', ['media', 'assetId']);
    }
    if (receipt.media.sha256 !== receipt.clip.sha256) {
      fail('media.sha256 与 clip.sha256 不一致', ['media', 'sha256']);
    }
    for (const [index, step] of receipt.steps.entries()) {
      if (step.status !== 'passed') {
        fail('成功的 CaptureReceipt 只能包含 passed 步骤', ['steps', index, 'status']);
      }
    }
  });
export type CaptureReceiptV1 = z.infer<typeof captureReceiptV1Schema>;

export const captureFailureV1Schema = z
  .object({
    schemaVersion: z.literal(CAPTURE_SCHEMA_VERSION),
    kind: z.literal('asvs.capture-failure'),
    jobId: idSchema,
    planId: idSchema,
    planFile: z.string().min(1),
    planDigest: sha256Schema,
    approvalId: idSchema,
    createdAt: isoDateSchema,
    failedStepId: idSchema.optional(),
    error: z.string().min(1),
    assertions: z
      .object({
        total: z.number().int().nonnegative(),
        passed: z.number().int().nonnegative(),
        failed: z.number().int().nonnegative(),
      })
      .strict(),
    steps: z.array(captureStepResultV1Schema),
    artifacts: z
      .object({
        rawVideo: captureVideoFileV1Schema.optional(),
        trace: captureArtifactFileV1Schema.optional(),
        screenshots: z.array(captureArtifactFileV1Schema),
      })
      .strict(),
    blockedRequests: z.array(z.string()).default([]),
  })
  .strict();
export type CaptureFailureV1 = z.infer<typeof captureFailureV1Schema>;

export const captureRepeatReportV1Schema = z
  .object({
    schemaVersion: z.literal(CAPTURE_SCHEMA_VERSION),
    kind: z.literal('asvs.capture-repeat'),
    planId: idSchema,
    planDigest: sha256Schema,
    createdAt: isoDateSchema,
    threshold: z.number().min(0).max(1),
    runs: z.array(
      z
        .object({
          run: z.number().int().min(1),
          passed: z.boolean(),
          durationMs: z.number().int().nonnegative(),
          receiptFile: z.string().optional(),
          failureFile: z.string().optional(),
          failedStepId: z.string().optional(),
          assertionFailures: z.number().int().nonnegative(),
          error: z.string().optional(),
        })
        .strict(),
    ),
    passed: z.number().int().nonnegative(),
    failed: z.number().int().nonnegative(),
    passRate: z.number().min(0).max(1),
  })
  .strict();
export type CaptureRepeatReportV1 = z.infer<typeof captureRepeatReportV1Schema>;

/* -------------------------------------------------------------------------- */
/* Capture job protocol (apps/api ⇄ workers/browser-worker) — Step 5C         */
/* -------------------------------------------------------------------------- */

export const CAPTURE_JOB_SCHEMA_VERSION = '1' as const;

/**
 * Written by the orchestrator to `<runDir>/capture-job-input.json` and read by
 * `workers/browser-worker/src/capture-job.ts`. The worker never guesses the
 * workspace layout: every path it may read or write is named here, and every
 * path is absolute so the run survives a caller with a different cwd.
 *
 * `plan` is the complete approved DemoPlanV1 (draft + approval). The worker
 * re-validates it and independently recomputes `planDigest`; a mismatch with
 * `approval.approvedPlanDigest` aborts before Chromium is launched.
 */
export const captureJobInputV1Schema = z
  .object({
    schemaVersion: z.literal(CAPTURE_JOB_SCHEMA_VERSION),
    kind: z.literal('asvs.capture-job'),
    jobId: idSchema,
    runId: idSchema,
    workspaceId: idSchema,
    /** Absolute output dir; the worker owns everything below it. */
    outDir: z.string().min(1),
    /** Absolute path of `<outDir>/checkpoints.json` for this attempt. */
    checkpointFile: z.string().min(1),
    /** Absolute path base used for `storageRef`-style refs in receipts. */
    storageRefBase: z.string().min(1),
    /** Auto-start a web server in front of `plan.baseUrl` when it is down. */
    serve: z.boolean().default(false),
    serveMode: z.enum(['dev', 'preview']).default('preview'),
    /** Server-level origin allowlist; the plan's origins must be a subset. */
    allowedOrigins: z.array(originSchema).min(1).max(20),
    plan: demoPlanV1Schema,
    /** Bind the worker to the exact content it was approved for. */
    planDigest: sha256Schema,
    policyVersion: z.string().min(1).max(40),
    jobDigest: sha256Schema,
    createdAt: isoDateSchema,
  })
  .strict()
  .superRefine((job, ctx) => {
    if (!job.allowedOrigins.includes(new URL(job.plan.baseUrl).origin)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'capture-job 的 allowedOrigins 必须包含 plan.baseUrl 的 origin',
        path: ['allowedOrigins'],
      });
    }
    for (const origin of job.plan.allowedOrigins) {
      if (!job.allowedOrigins.includes(origin)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `计划 origin ${origin} 不在服务端 allowlist 中（SSRF 防护，docs/08 §3）`,
          path: ['plan', 'allowedOrigins'],
        });
      }
    }
  });
export type CaptureJobInputV1 = z.infer<typeof captureJobInputV1Schema>;

/** Digest over the job envelope minus its own digest, so a replay is stable. */
export async function captureJobDigest(input: {
  jobId: string;
  runId: string;
  workspaceId: string;
  plan: unknown;
  planDigest: string;
  allowedOrigins: string[];
  policyVersion: string;
}): Promise<string> {
  return sha256Hex(
    stableJson({
      jobId: input.jobId,
      runId: input.runId,
      workspaceId: input.workspaceId,
      plan: input.plan,
      planDigest: input.planDigest,
      allowedOrigins: [...input.allowedOrigins].sort(),
      policyVersion: input.policyVersion,
    }),
  );
}

/**
 * Persisted by the worker each time it reaches a durable milestone, so a
 * crash mid-capture replays from a phase rather than from zero. Mirrors the
 * render worker's checkpoint file.
 */
export const captureCheckpointFileV1Schema = z
  .object({
    schemaVersion: z.literal(CAPTURE_JOB_SCHEMA_VERSION),
    kind: z.literal('asvs.capture-checkpoint'),
    jobDigest: sha256Schema,
    updatedAt: isoDateSchema,
    phases: z.array(
      z
        .object({
          phase: z.string().min(1),
          at: isoDateSchema,
          payload: z.record(z.unknown()).default({}),
        })
        .strict(),
    ),
  })
  .strict();
export type CaptureCheckpointFileV1 = z.infer<typeof captureCheckpointFileV1Schema>;

/**
 * How the capture pipeline classifies failures. The orchestrator maps these
 * to run-level codes; every one of them is a *real* failure with evidence,
 * never a fabricated receipt.
 */
export const CAPTURE_FAILURE_KINDS = [
  'capture_plan_tampered',
  'capture_origin_blocked',
  'capture_target_unreachable',
  'capture_timeout',
  'capture_assertion_failed',
  'capture_invalid_input',
  'capture_worker_crashed',
  'capture_artifact_mismatch',
] as const;
export type CaptureFailureKind = (typeof CAPTURE_FAILURE_KINDS)[number];

/** JSONL completion event emitted by `capture-job.ts` on success. */
export const captureJobCompletedV1Schema = z
  .object({
    kind: z.literal('asvs.capture-job-completed'),
    jobId: idSchema,
    planId: idSchema,
    planDigest: sha256Schema,
    receiptFile: z.string().min(1),
    receiptSha256: sha256Schema,
    clipFile: z.string().min(1),
    clipSha256: sha256Schema,
    clipDurationMs: z.number().int().positive(),
    clipWidth: z.number().int().positive(),
    clipHeight: z.number().int().positive(),
    assertions: z
      .object({
        total: z.number().int().min(1),
        passed: z.number().int().min(1),
        failed: z.literal(0),
      })
      .strict(),
    screenshotCount: z.number().int().min(1),
    completedAt: isoDateSchema,
  })
  .strict();
export type CaptureJobCompletedV1 = z.infer<typeof captureJobCompletedV1Schema>;

export const captureJobFailedV1Schema = z
  .object({
    kind: z.literal('asvs.capture-job-failed'),
    jobId: idSchema,
    code: z.enum(CAPTURE_FAILURE_KINDS),
    message: z.string().min(1),
    failedStepId: idSchema.optional(),
    /** Storage refs (relative to `storageRefBase`) of evidence files. */
    failureReportRef: z.string().min(1).optional(),
    traceRef: z.string().min(1).optional(),
    screenshotRefs: z.array(z.string()).default([]),
    assertionFailures: z.number().int().nonnegative().default(0),
    retryable: z.boolean(),
    failedAt: isoDateSchema,
  })
  .strict();
export type CaptureJobFailedV1 = z.infer<typeof captureJobFailedV1Schema>;

/** Top-level shape of `<outDir>/job-result.json`, read back by the API. */
export const captureJobResultV1Schema = z
  .object({
    schemaVersion: z.literal(CAPTURE_JOB_SCHEMA_VERSION),
    kind: z.literal('asvs.capture-job-result'),
    jobId: idSchema,
    planId: idSchema,
    planDigest: sha256Schema,
    policyVersion: z.string().min(1).max(40),
    passed: z.boolean(),
    completed: captureJobCompletedV1Schema.optional(),
    failed: captureJobFailedV1Schema.optional(),
    durationMs: z.number().int().nonnegative(),
    writtenAt: isoDateSchema,
  })
  .strict()
  .superRefine((result, ctx) => {
    if (result.passed && !result.completed) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'passed=true 的 capture 结果必须带 completed',
        path: ['completed'],
      });
    }
    if (!result.passed && !result.failed) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'passed=false 的 capture 结果必须带 failed',
        path: ['failed'],
      });
    }
  });
export type CaptureJobResultV1 = z.infer<typeof captureJobResultV1Schema>;

/** Code → retryable. Deterministic input problems never retry. */
export function isRetryableCaptureCode(code: CaptureFailureKind | string): boolean {
  return (
    code === 'capture_assertion_failed' ||
    code === 'capture_timeout' ||
    code === 'capture_target_unreachable' ||
    code === 'capture_worker_crashed' ||
    code === 'capture_artifact_mismatch'
  );
}
