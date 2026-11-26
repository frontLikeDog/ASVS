import { describe, expect, it } from 'vitest';
import {
  captureReceiptV1Schema,
  captureRepeatReportV1Schema,
  demoPlanV1Schema,
  type DemoPlanV1,
} from './capture';

function basePlan(): Record<string, unknown> {
  return {
    schemaVersion: '1',
    id: 'plan_test',
    projectId: 'proj_test',
    name: '测试计划',
    environmentId: 'local_web_studio',
    baseUrl: 'http://localhost:4200',
    allowedOrigins: ['http://localhost:4200'],
    resetStrategy: 'fixture',
    clockTime: '2026-11-20T12:00:00.000Z',
    viewport: { width: 1920, height: 1080, deviceScaleFactor: 1 },
    locale: 'zh-CN',
    timezoneId: 'Asia/Shanghai',
    colorScheme: 'dark',
    reducedMotion: 'no-preference',
    fixtures: { searchTerm: '快速上手' },
    capture: { width: 1920, height: 1080, fps: 30, clipDurationMs: 14_000 },
    asset: {
      id: 'asset_test',
      name: '测试录屏',
      description: '测试用真实录屏',
      palette: ['#000000', '#FFFFFF'],
    },
    approval: {
      approvalId: 'appr_test',
      approvedPlanDigest: '0'.repeat(64),
    },
    steps: [
      {
        id: 'ready',
        action: 'assert',
        target: 'heading=视频库',
        assertion: { kind: 'visible' },
      },
    ],
  };
}

function parse(plan: Record<string, unknown>): DemoPlanV1 {
  return demoPlanV1Schema.parse(plan);
}

function failedPaths(plan: Record<string, unknown>): string[] {
  const result = demoPlanV1Schema.safeParse(plan);
  return result.success ? [] : result.error.issues.map((issue) => issue.path.join('.'));
}

const hex = 'a'.repeat(64);

const receiptCandidate = {
  schemaVersion: '1',
  kind: 'asvs.capture-receipt',
  jobId: 'job_capture_test',
  planId: 'plan_test',
  planFile: 'workers/browser-worker/plans/test.yaml',
  planDigest: hex,
  approvalId: 'appr_test',
  createdAt: '2026-11-20T12:00:00.000Z',
  environment: {
    baseUrl: 'http://localhost:4200',
    browser: 'Chromium',
    viewport: { width: 1920, height: 1080, deviceScaleFactor: 1 },
    locale: 'zh-CN',
    timezoneId: 'Asia/Shanghai',
    colorScheme: 'dark',
    reducedMotion: 'no-preference',
  },
  assertions: { total: 3, passed: 3, failed: 0 },
  steps: [
    {
      id: 'ready',
      action: 'assert',
      status: 'passed',
      startedAtMs: 100,
      durationMs: 20,
      assertion: { kind: 'visible', passed: true },
    },
  ],
  rawVideo: {
    file: 'raw/capture.webm',
    sha256: hex,
    byteSize: 1000,
    mimeType: 'video/webm',
    width: 1920,
    height: 1080,
    fps: 25,
    durationMs: 20_000,
    codecName: 'vp8',
  },
  clip: {
    file: 'capture.mp4',
    sha256: hex,
    byteSize: 2000,
    mimeType: 'video/mp4',
    width: 1920,
    height: 1080,
    fps: 30,
    durationMs: 14_000,
    codecName: 'h264',
  },
  trace: {
    file: 'trace.zip',
    sha256: hex,
    byteSize: 500,
    mimeType: 'application/zip',
  },
  screenshots: [
    { file: 'screenshots/01-ready.png', sha256: hex, byteSize: 100, mimeType: 'image/png' },
  ],
  asset: {
    id: 'asset_test',
    projectId: 'proj_test',
    name: '测试录屏',
    kind: 'capture',
    durationSec: 14,
    description: '测试用真实录屏',
    palette: ['#000000', '#FFFFFF'],
    mock: false,
    media: {
      src: 'captures/asset_test.mp4',
      mimeType: 'video/mp4',
      width: 1920,
      height: 1080,
      durationMs: 14_000,
      sha256: hex,
    },
  },
  media: {
    assetId: 'asset_test',
    sourceFile: 'dist/browser-worker/test/capture.mp4',
    sha256: hex,
    mimeType: 'video/mp4',
    width: 1920,
    height: 1080,
    durationMs: 14_000,
  },
  renderFixture: { file: 'dist/browser-worker/test/captured-30s.json', sha256: hex },
};

describe('demoPlanV1Schema', () => {
  it('接受带断言、allowlist 与审批的最小计划，并补默认值', () => {
    const plan = parse(basePlan());
    expect(plan.steps[0]?.timeoutMs).toBe(10_000);
    expect(plan.steps[0]?.dwellMs).toBe(0);
    expect(plan.steps[0]?.assertion?.match).toBe('contains');
    expect(plan.resetStrategy).toBe('fixture');
  });

  it('拒绝未识别的 action', () => {
    const plan = basePlan();
    plan.steps = [{ id: 'eval', action: 'eval', target: 'document.body' }];
    expect(failedPaths(plan)).toContain('steps.0.action');
  });

  it('拒绝零断言计划（断言优先）', () => {
    const plan = basePlan();
    plan.steps = [{ id: 'nav', action: 'navigate', target: '/' }];
    expect(failedPaths(plan)).toContain('steps');
  });

  it('拒绝带路径的 origin 与未列入 allowlist 的 baseUrl', () => {
    const withPath = basePlan();
    withPath.allowedOrigins = ['http://localhost:4200/app'];
    expect(failedPaths(withPath)).toContain('allowedOrigins.0');

    const outside = basePlan();
    outside.baseUrl = 'http://127.0.0.1:4200';
    expect(failedPaths(outside)).toContain('baseUrl');
  });

  it('拒绝 fill 缺少值或同时提供 value/valueRef', () => {
    const missing = basePlan();
    missing.steps = [
      ...(missing.steps as Record<string, unknown>[]),
      { id: 'fill', action: 'fill', target: 'label=搜索视频' },
    ];
    expect(failedPaths(missing)).toContain('steps.1');

    const both = basePlan();
    both.steps = [
      ...(both.steps as Record<string, unknown>[]),
      {
        id: 'fill',
        action: 'fill',
        target: 'label=搜索视频',
        value: 'x',
        valueRef: 'searchTerm',
      },
    ];
    expect(failedPaths(both)).toContain('steps.1');
  });

  it('拒绝不存在的 valueRef', () => {
    const plan = basePlan();
    plan.steps = [
      ...(plan.steps as Record<string, unknown>[]),
      { id: 'fill', action: 'fill', target: 'label=搜索视频', valueRef: 'missing' },
    ];
    expect(failedPaths(plan)).toContain('steps.1.valueRef');
  });

  it('拒绝凭证样式的 fixture key', () => {
    const plan = basePlan();
    plan.fixtures = { loginPassword: 'hunter2' };
    expect(failedPaths(plan)).toContain('fixtures.loginPassword');
  });

  it('拒绝 CSS / nth-child / :has 选择器', () => {
    for (const target of ['css=button', 'div >> nth=0', 'button:has-text("x")', 'nth-child=2']) {
      const plan = basePlan();
      plan.steps = [
        {
          id: 'click',
          action: 'click',
          target,
        },
        ...(plan.steps as Record<string, unknown>[]),
      ];
      expect(failedPaths(plan), target).toContain('steps.0.target');
    }
  });

  it('拒绝裸 XPath / 裸 CSS（白名单前缀之前就拦截）', () => {
    for (const target of [
      '//button[1]',
      '.btn',
      '#submit',
      'button[type=submit]',
      'div > button',
      'button',
      'xpath=//button[1]',
      'css=.btn',
    ]) {
      const plan = basePlan();
      plan.steps = [
        {
          id: 'click',
          action: 'click',
          target,
        },
        ...(plan.steps as Record<string, unknown>[]),
      ];
      expect(failedPaths(plan), target).toContain('steps.0.target');
    }
  });

  it('接受全部受支持的前缀与合法 role', () => {
    for (const target of [
      'role=button,name=待审核',
      'role=link,name="视频工程"',
      'role=heading,level=2',
      'heading=视频库',
      'label=搜索视频',
      'placeholder=搜索…',
      'testid=task-status-running',
      'text=1 条结果',
      'alt=产品截图',
    ]) {
      const plan = basePlan();
      plan.steps = [
        ...(plan.steps as Record<string, unknown>[]),
        { id: 'click', action: 'click', target },
      ];
      expect(() => parse(plan), target).not.toThrow();
    }
  });

  it('拒绝非法 role / level 与额外参数', () => {
    for (const target of [
      'role=script,name=x',
      'role=button,level=2',
      'role=button,name=x,foo=y',
      'role=heading,level=7',
      'role=button,name="未闭合',
      'role=',
    ]) {
      const plan = basePlan();
      plan.steps = [
        ...(plan.steps as Record<string, unknown>[]),
        { id: 'click', action: 'click', target },
      ];
      expect(failedPaths(plan), target).toContain('steps.1.target');
    }
  });

  it('拒绝非 16:9 的 viewport', () => {
    const plan = basePlan();
    plan.viewport = { width: 1080, height: 1920, deviceScaleFactor: 1 };
    expect(failedPaths(plan)).toContain('viewport');
  });

  it('url 断言不需要 target', () => {
    const plan = basePlan();
    plan.steps = [
      { id: 'url', action: 'assert', assertion: { kind: 'url', expected: '/videos', match: 'contains' } },
    ];
    expect(() => parse(plan)).not.toThrow();
  });
});

describe('captureReceiptV1Schema', () => {
  it('接受断言全部通过的完整回执', () => {
    expect(() => captureReceiptV1Schema.parse(receiptCandidate)).not.toThrow();
  });

  it('拒绝 failed > 0、零断言与 mock asset', () => {
    const failed = structuredClone(receiptCandidate);
    failed.assertions = { total: 3, passed: 2, failed: 1 };
    expect(captureReceiptV1Schema.safeParse(failed).success).toBe(false);

    const zero = structuredClone(receiptCandidate);
    zero.assertions = { total: 0, passed: 0, failed: 0 };
    expect(captureReceiptV1Schema.safeParse(zero).success).toBe(false);

    const mock = structuredClone(receiptCandidate);
    mock.asset.mock = true;
    expect(captureReceiptV1Schema.safeParse(mock).success).toBe(false);
  });

  it('拒绝 asset / media / clip 哈希不一致', () => {
    const mismatch = structuredClone(receiptCandidate);
    mismatch.media.sha256 = 'b'.repeat(64);
    expect(captureReceiptV1Schema.safeParse(mismatch).success).toBe(false);
  });
});

describe('captureRepeatReportV1Schema', () => {
  it('记录通过率与失败原因', () => {
    const report = captureRepeatReportV1Schema.parse({
      schemaVersion: '1',
      kind: 'asvs.capture-repeat',
      planId: 'plan_test',
      planDigest: hex,
      createdAt: '2026-11-20T12:00:00.000Z',
      threshold: 0.8,
      runs: [
        { run: 1, passed: true, durationMs: 1000, assertionFailures: 0 },
        {
          run: 2,
          passed: false,
          durationMs: 900,
          failedStepId: 'ready',
          assertionFailures: 1,
          error: '断言失败',
        },
      ],
      passed: 1,
      failed: 1,
      passRate: 0.5,
    });
    expect(report.passRate).toBe(0.5);
  });
});
