import { afterEach, describe, expect, it, vi } from 'vitest';
import type { OrchestrationClientPort } from '@asvs/ports';
import {
  buildRunIdempotencyKey,
  configureOrchestrationClient,
  getOrchestrationClient,
  resetOrchestrationClient,
} from './orchestration';

afterEach(() => {
  resetOrchestrationClient();
});

const STUB: OrchestrationClientPort = {
  createRun: vi.fn(),
  listRuns: vi.fn(),
  getRun: vi.fn(),
  cancelRun: vi.fn(),
  retryRun: vi.fn(),
  approveRun: vi.fn(),
  getLatestVideoArtifact: vi.fn(),
  artifactDownloadUrl: () => '',
  createExportBundle: vi.fn(),
  listExportBundles: vi.fn(),
  getHealth: vi.fn(),
  isReachable: vi.fn(),
};

describe('orchestration client bridge', () => {
  it('configureOrchestrationClient 覆盖懒加载客户端', async () => {
    configureOrchestrationClient(STUB);
    await expect(getOrchestrationClient()).resolves.toBe(STUB);
  });

  it('reset 后重新按 baseUrl 懒加载 HTTP 客户端', async () => {
    const first = await getOrchestrationClient('http://localhost:4300');
    const second = await getOrchestrationClient('http://localhost:4300');
    expect(first).toBe(second);
    resetOrchestrationClient();
    const third = await getOrchestrationClient('http://localhost:4300');
    expect(third).not.toBe(first);
  });

  it('idempotencyKey 对同一视频的重复点击保持唯一', () => {
    const a = buildRunIdempotencyKey('vid_lumen_release', 1_700_000_000_000);
    const b = buildRunIdempotencyKey('vid_lumen_release', 1_700_000_000_000);
    expect(a).toContain('vid_lumen_release-');
    expect(a).not.toBe(b);
  });
});
