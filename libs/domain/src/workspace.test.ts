import { describe, expect, it } from 'vitest';
import type { StudioSnapshot } from './schemas';
import {
  STUDIO_SNAPSHOT_VERSION,
  WorkspaceImportError,
  buildWorkspaceExport,
  createWorkspaceEnvelope,
  migrateStudioSnapshot,
  normalizeWorkspacePayload,
  parseWorkspaceExport,
  workspaceExportFileName,
} from './workspace';

const EMPTY_SNAPSHOT: StudioSnapshot = {
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

function legacyVideo() {
  return {
    id: 'vid_legacy',
    projectId: 'proj_legacy',
    title: 'Legacy',
    mode: 'product_film',
    stage: 'storyboard_ready',
    brief: {
      objective: 'o',
      audience: 'a',
      featureIds: [],
      releaseId: undefined,
      durationSec: 10,
      aspect: '16:9',
      language: 'zh-CN',
      tone: 'confident',
      style: 'product',
      templateId: 'tpl',
      useRealCapture: false,
      useGeneratedVisuals: false,
      cta: 'cta',
      bannedPhrases: [],
    },
    scenes: [
      {
        id: 'scene_legacy',
        order: 1,
        title: 'Intro',
        intent: 'intent',
        narration: 'n',
        caption: 'c',
        durationSec: 4,
        visualType: 'title',
        templateId: 'tpl',
        claimIds: [],
        status: 'draft',
        look: 'clean',
        brightness: 1,
        vignette: false,
      },
    ],
    directorMessages: [],
    scriptVersion: 1,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    demo: true,
  };
}

describe('工作区信封与迁移', () => {
  it('导出与导入往返保留完整工作区', () => {
    const exportedAt = '2026-11-27T10:00:00.000Z';
    const text = buildWorkspaceExport(EMPTY_SNAPSHOT, exportedAt);
    const parsed = parseWorkspaceExport(text);

    expect(parsed.schemaVersion).toBe(STUDIO_SNAPSHOT_VERSION);
    expect(parsed.exportedAt).toBe(exportedAt);
    expect(parsed.workspace.videos).toEqual([]);
    expect(JSON.parse(text).kind).toBe('asvs.workspace');
  });

  it('v1 裸快照补齐 fps / revision / durationFrames / visual 且不丢字段', () => {
    const legacy = {
      ...EMPTY_SNAPSHOT,
      videos: [legacyVideo()],
    } as unknown as StudioSnapshot;

    const migrated = normalizeWorkspacePayload(legacy);
    const video = migrated.workspace.videos[0]!;
    const scene = video.scenes[0]!;

    expect(video.fps).toBe(30);
    expect(scene.revision).toBe(1);
    expect(scene.durationFrames).toBe(120);
    expect(scene.visual).toEqual({ type: 'title' });
    expect(video.title).toBe('Legacy');
  });

  it('接受 Zustand persist 的 { state, version } 备份', () => {
    const legacy = {
      state: {
        ...EMPTY_SNAPSHOT,
        videos: [legacyVideo()],
      },
      version: 1,
    };

    const migrated = normalizeWorkspacePayload(legacy);
    const video = migrated.workspace.videos[0]!;
    expect(video.fps).toBe(30);
    expect(video.scenes[0]!.visual).toEqual({ type: 'title' });
  });

  it('已是当前版本的快照幂等', () => {
    const input = EMPTY_SNAPSHOT;
    expect(migrateStudioSnapshot(input, STUDIO_SNAPSHOT_VERSION)).toBe(input);
  });

  it('拒绝高于当前版本的未来格式', () => {
    expect(() =>
      normalizeWorkspacePayload({
        kind: 'asvs.workspace',
        schemaVersion: STUDIO_SNAPSHOT_VERSION + 1,
        workspace: EMPTY_SNAPSHOT,
      }),
    ).toThrow(WorkspaceImportError);
  });

  it('拒绝结构损坏的 JSON 与工作区', () => {
    expect(() => parseWorkspaceExport('{')).toThrow('文件不是有效的 JSON。');
    expect(() => normalizeWorkspacePayload({ videos: 'broken' })).toThrow(WorkspaceImportError);
  });

  it('信封带固定版本与可选导出时间', () => {
    const envelope = createWorkspaceEnvelope(EMPTY_SNAPSHOT, '2026-11-27T10:00:00.000Z');
    expect(envelope.kind).toBe('asvs.workspace');
    expect(envelope.schemaVersion).toBe(STUDIO_SNAPSHOT_VERSION);
    expect(envelope.workspace).toEqual(EMPTY_SNAPSHOT);
    expect(workspaceExportFileName('2026-11-27T10:00:00.000Z')).toBe(
      'asvs-workspace-2026-11-27_10-00-00-000.json',
    );
  });
});
