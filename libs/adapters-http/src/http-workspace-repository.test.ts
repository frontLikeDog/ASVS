import { describe, expect, it, vi } from 'vitest';
import type { StudioSnapshot, WorkspaceRecord } from '@asvs/domain';
import { STUDIO_SNAPSHOT_VERSION } from '@asvs/domain';
import { HttpWorkspaceRepository, WorkspaceHttpError } from './http-workspace-repository';

const ISO = '2026-11-27T10:00:00.000Z';

const WORKSPACE: StudioSnapshot = {
  projects: [],
  features: [],
  claims: [],
  evidence: [],
  pullRequests: [],
  releases: [],
  suggestions: [],
  assets: [],
  templates: [],
  videos: [],
  runs: [],
  exports: [],
  activity: [],
};

const RECORD: WorkspaceRecord = {
  kind: 'asvs.workspace',
  id: 'ws_demo',
  revision: 3,
  schemaVersion: STUDIO_SNAPSHOT_VERSION,
  updatedAt: ISO,
  workspace: WORKSPACE,
};

function response(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as Response;
}

describe('HttpWorkspaceRepository', () => {
  it('load 返回 null 表示服务器上还没有工作区', async () => {
    const fetchImpl = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => response({ error: { code: 'not_found' } }, 404));
    const repo = new HttpWorkspaceRepository({
      baseUrl: '/api/',
      fetchImpl: fetchImpl as unknown as typeof fetch,
      timeoutMs: 0,
    });

    await expect(repo.load('ws_missing')).resolves.toBeNull();
    expect(fetchImpl).toHaveBeenCalledWith('/api/v1/workspaces/ws_missing', expect.anything());
  });

  it('load 校验并返回工作区记录', async () => {
    const fetchImpl = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => response(RECORD));
    const repo = new HttpWorkspaceRepository({
      baseUrl: '/api',
      fetchImpl: fetchImpl as unknown as typeof fetch,
      timeoutMs: 0,
    });

    await expect(repo.load('ws_demo')).resolves.toEqual(RECORD);
  });

  it('save 发送 schemaVersion / baseRevision，并接收新 revision', async () => {
    const fetchImpl = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => response({ ...RECORD, revision: 4 }));
    const repo = new HttpWorkspaceRepository({
      baseUrl: '/api',
      fetchImpl: fetchImpl as unknown as typeof fetch,
      timeoutMs: 0,
    });

    const result = await repo.save('ws_demo', { workspace: WORKSPACE, baseRevision: 3 });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.record.revision).toBe(4);

    const [, init] = fetchImpl.mock.calls[0]!;
    expect(init?.method).toBe('PUT');
    expect(JSON.parse(String(init?.body))).toMatchObject({
      schemaVersion: STUDIO_SNAPSHOT_VERSION,
      baseRevision: 3,
    });
  });

  it('409 转换为冲突结果而不是抛错', async () => {
    const fetchImpl = vi.fn(async () =>
      response({ error: { code: 'revision_conflict' }, current: RECORD }, 409),
    );
    const repo = new HttpWorkspaceRepository({
      baseUrl: '/api',
      fetchImpl: fetchImpl as unknown as typeof fetch,
      timeoutMs: 0,
    });

    const result = await repo.save('ws_demo', { workspace: WORKSPACE, baseRevision: 2 });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.conflict?.revision).toBe(3);
  });

  it('其他错误保留状态码与服务器错误码', async () => {
    const fetchImpl = vi.fn(async () =>
      response({ error: { code: 'invalid_workspace', message: '坏数据' } }, 400),
    );
    const repo = new HttpWorkspaceRepository({
      baseUrl: '/api',
      fetchImpl: fetchImpl as unknown as typeof fetch,
      timeoutMs: 0,
    });

    await expect(
      repo.save('ws_demo', { workspace: WORKSPACE, baseRevision: 0 }),
    ).rejects.toMatchObject({
      name: 'WorkspaceHttpError',
      status: 400,
      code: 'invalid_workspace',
      message: '坏数据',
    });
    await expect(
      repo.save('ws_demo', { workspace: WORKSPACE, baseRevision: 0 }),
    ).rejects.toBeInstanceOf(WorkspaceHttpError);
  });
});
