// @vitest-environment node
import { afterEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { ProductionRun, StudioSnapshot } from '@asvs/domain';
import { STUDIO_SNAPSHOT_VERSION } from '@asvs/domain';
import type { DatabaseSync } from 'node:sqlite';
import { buildApp } from './app';

const ISO = '2026-11-27T10:00:00.000Z';

const EMPTY_WORKSPACE: StudioSnapshot = {
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

const RUN: ProductionRun = {
  id: 'run_1',
  projectId: 'proj_1',
  videoId: 'vid_1',
  scenario: 'happy_path',
  status: 'running',
  steps: [],
  logs: [],
  elapsedMs: 1200,
  startedAt: ISO,
  speed: 1,
  input: { sceneCount: 0, durationSec: 0, aspect: '16:9', claimCount: 0 },
  demo: true,
};

let app: FastifyInstance | undefined;
let db: DatabaseSync | undefined;

async function start() {
  const built = await buildApp({ dbPath: ':memory:' });
  app = built.app;
  db = built.db;
  return built;
}

afterEach(async () => {
  await app?.close();
  app = undefined;
  db = undefined;
});

function putBody(workspace: StudioSnapshot, baseRevision: number) {
  return {
    schemaVersion: STUDIO_SNAPSHOT_VERSION,
    baseRevision,
    workspace,
  };
}

describe('ASVS API · 工作区', () => {
  it('health 报告 SQLite 与当前 schema 版本', async () => {
    await start();
    const response = await app!.inject({ method: 'GET', url: '/v1/health' });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      ok: true,
      storage: 'sqlite',
      schemaVersion: STUDIO_SNAPSHOT_VERSION,
    });
  });

  it('不存在的 workspace 返回 404，不泄露内部细节', async () => {
    await start();
    const response = await app!.inject({ method: 'GET', url: '/v1/workspaces/ws_missing' });
    expect(response.statusCode).toBe(404);
    expect(response.json().error.code).toBe('not_found');
  });

  it('PUT 创建后 GET 返回相同内容与 revision 1', async () => {
    await start();
    const created = await app!.inject({
      method: 'PUT',
      url: '/v1/workspaces/ws_demo',
      payload: putBody(EMPTY_WORKSPACE, 0),
    });
    expect(created.statusCode).toBe(200);
    const record = created.json();
    expect(record).toMatchObject({
      kind: 'asvs.workspace',
      id: 'ws_demo',
      revision: 1,
      schemaVersion: STUDIO_SNAPSHOT_VERSION,
    });

    const loaded = await app!.inject({ method: 'GET', url: '/v1/workspaces/ws_demo' });
    expect(loaded.statusCode).toBe(200);
    expect(loaded.json().workspace).toEqual(EMPTY_WORKSPACE);
  });

  it('第二个客户端能读到第一个客户端的修改（跨设备恢复的最小证据）', async () => {
    await start();
    await app!.inject({
      method: 'PUT',
      url: '/v1/workspaces/ws_shared',
      payload: putBody(EMPTY_WORKSPACE, 0),
    });

    const changed: StudioSnapshot = {
      ...EMPTY_WORKSPACE,
      activity: [
        {
          id: 'act_1',
          kind: 'system',
          title: '来自客户端 A',
          at: ISO,
        },
      ],
    };
    const saved = await app!.inject({
      method: 'PUT',
      url: '/v1/workspaces/ws_shared',
      payload: putBody(changed, 1),
    });
    expect(saved.statusCode).toBe(200);

    const otherClient = await app!.inject({ method: 'GET', url: '/v1/workspaces/ws_shared' });
    expect(otherClient.json().revision).toBe(2);
    expect(otherClient.json().workspace.activity[0].title).toBe('来自客户端 A');
  });

  it('过期 baseRevision 返回 409 并附带当前版本', async () => {
    await start();
    await app!.inject({
      method: 'PUT',
      url: '/v1/workspaces/ws_conflict',
      payload: putBody(EMPTY_WORKSPACE, 0),
    });

    const stale = await app!.inject({
      method: 'PUT',
      url: '/v1/workspaces/ws_conflict',
      payload: putBody(EMPTY_WORKSPACE, 0),
    });
    expect(stale.statusCode).toBe(409);
    expect(stale.json().error.code).toBe('revision_conflict');
    expect(stale.json().current.revision).toBe(1);
  });

  it('非法工作区被 Schema 拒绝，且不写入', async () => {
    await start();
    const invalid = await app!.inject({
      method: 'PUT',
      url: '/v1/workspaces/ws_invalid',
      payload: { schemaVersion: 2, baseRevision: 0, workspace: { projects: 'nope' } },
    });
    expect(invalid.statusCode).toBe(400);

    const malformedV1 = await app!.inject({
      method: 'PUT',
      url: '/v1/workspaces/ws_invalid',
      payload: {
        schemaVersion: 1,
        baseRevision: 0,
        workspace: { ...EMPTY_WORKSPACE, videos: [{ id: 'vid_bad', scenes: null }] },
      },
    });
    expect(malformedV1.statusCode).toBe(400);
    expect(malformedV1.json().error.code).toBe('invalid_workspace');

    const missing = await app!.inject({ method: 'GET', url: '/v1/workspaces/ws_invalid' });
    expect(missing.statusCode).toBe(404);
  });

  it('v1 持久化数据在读取时升级到 v2 并写回', async () => {
    const built = await start();
    db!
      .prepare(
        'INSERT INTO workspaces (id, revision, schema_version, payload, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)',
      )
      .run('ws_legacy', 3, 1, JSON.stringify(EMPTY_WORKSPACE), ISO, ISO);

    const loaded = await app!.inject({ method: 'GET', url: '/v1/workspaces/ws_legacy' });
    expect(loaded.statusCode).toBe(200);
    expect(loaded.json().schemaVersion).toBe(STUDIO_SNAPSHOT_VERSION);
    expect(loaded.json().revision).toBe(3);

    const row = db!
      .prepare('SELECT schema_version FROM workspaces WHERE id = ?')
      .get('ws_legacy') as { schema_version: number };
    expect(row.schema_version).toBe(STUDIO_SNAPSHOT_VERSION);
    expect(built.store.get('ws_legacy')?.revision).toBe(3);
  });

  it('生产运行状态可从工作区快照重建并查询', async () => {
    await start();
    const workspace: StudioSnapshot = { ...EMPTY_WORKSPACE, runs: [RUN] };
    await app!.inject({
      method: 'PUT',
      url: '/v1/workspaces/ws_runs',
      payload: putBody(workspace, 0),
    });

    const list = await app!.inject({
      method: 'GET',
      url: '/v1/workspaces/ws_runs/production-runs',
    });
    expect(list.statusCode).toBe(200);
    expect(list.json().runs).toHaveLength(1);
    expect(list.json().runs[0]).toMatchObject({ id: 'run_1', status: 'running', elapsedMs: 1200 });

    const one = await app!.inject({
      method: 'GET',
      url: '/v1/workspaces/ws_runs/production-runs/run_1',
    });
    expect(one.statusCode).toBe(200);
    expect(one.json().videoId).toBe('vid_1');

    const missing = await app!.inject({
      method: 'GET',
      url: '/v1/workspaces/ws_runs/production-runs/run_missing',
    });
    expect(missing.statusCode).toBe(404);
  });

  it('不同工作区可以保存相同 id 的生产运行', async () => {
    await start();
    const workspace: StudioSnapshot = { ...EMPTY_WORKSPACE, runs: [RUN] };
    for (const id of ['ws_a', 'ws_b']) {
      const saved = await app!.inject({
        method: 'PUT',
        url: `/v1/workspaces/${id}`,
        payload: putBody(workspace, 0),
      });
      expect(saved.statusCode).toBe(200);
    }

    const listA = await app!.inject({ method: 'GET', url: '/v1/workspaces/ws_a/production-runs' });
    const listB = await app!.inject({ method: 'GET', url: '/v1/workspaces/ws_b/production-runs' });
    expect(listA.json().runs).toHaveLength(1);
    expect(listB.json().runs).toHaveLength(1);
  });

  it('省略 schemaVersion 的 PUT 按当前版本处理', async () => {
    await start();
    const saved = await app!.inject({
      method: 'PUT',
      url: '/v1/workspaces/ws_current',
      payload: { baseRevision: 0, workspace: EMPTY_WORKSPACE },
    });
    expect(saved.statusCode).toBe(200);
    expect(saved.json().schemaVersion).toBe(STUDIO_SNAPSHOT_VERSION);
  });

  it('导出返回带版本与 kind 的完整工作区信封', async () => {
    await start();
    await app!.inject({
      method: 'PUT',
      url: '/v1/workspaces/ws_export',
      payload: putBody(EMPTY_WORKSPACE, 0),
    });

    const exported = await app!.inject({
      method: 'GET',
      url: '/v1/workspaces/ws_export/export',
    });
    expect(exported.statusCode).toBe(200);
    expect(exported.headers['content-disposition']).toContain('asvs-workspace-');
    const envelope = JSON.parse(exported.body);
    expect(envelope.kind).toBe('asvs.workspace');
    expect(envelope.schemaVersion).toBe(STUDIO_SNAPSHOT_VERSION);
    expect(envelope.workspace).toEqual(EMPTY_WORKSPACE);
  });

  it('拒绝非法 workspace id 路径参数', async () => {
    await start();
    const response = await app!.inject({ method: 'GET', url: '/v1/workspaces/bad%20id' });
    expect(response.statusCode).toBe(400);
  });
});
