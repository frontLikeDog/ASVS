import { z } from 'zod';
import { DEFAULT_VIDEO_FPS, isoDateSchema, studioSnapshotSchema } from './schemas';
import type { Scene, StudioSnapshot, VideoProject } from './schemas';
import { deriveSceneVisual, sceneDurationFrames } from './render';

/**
 * Version of the persisted `StudioSnapshot` payload. Bump this whenever
 * `studioSnapshotSchema` gains a required field and add a step to
 * `migrateStudioSnapshot`. It is shared by browser persist, HTTP storage and
 * workspace import/export so every entry point runs the same migration chain.
 */
export const STUDIO_SNAPSHOT_VERSION = 2;

export const WORKSPACE_KIND = 'asvs.workspace' as const;

/**
 * Versioned envelope used by `GET/PUT /v1/workspaces/:id` and by the JSON file
 * a user can export and re-import on another device.
 */
export const workspaceEnvelopeSchema = z.object({
  kind: z.literal(WORKSPACE_KIND),
  schemaVersion: z.number().int().min(1),
  exportedAt: isoDateSchema.optional(),
  workspace: studioSnapshotSchema,
});
export type WorkspaceEnvelope = z.infer<typeof workspaceEnvelopeSchema>;

/** What `GET/PUT /v1/workspaces/:id` returns. */
export const workspaceRecordSchema = workspaceEnvelopeSchema.extend({
  id: z.string().min(1),
  revision: z.number().int().min(1),
  updatedAt: isoDateSchema,
});
export type WorkspaceRecord = z.infer<typeof workspaceRecordSchema>;

/** Body accepted by `PUT /v1/workspaces/:id`. */
export const workspacePutRequestSchema = z.object({
  schemaVersion: z.number().int().min(1).optional(),
  baseRevision: z.number().int().min(0).default(0),
  workspace: z.unknown(),
});
export type WorkspacePutRequest = z.infer<typeof workspacePutRequestSchema>;

export class WorkspaceImportError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WorkspaceImportError';
  }
}

/**
 * Explicit v1 → v2 migration. v1 scenes only had the flat `visualType`; v2
 * adds the render IR (`visual`), `revision` and a frame cache, and videos get
 * an explicit `fps`. Never drop data here: unknown shapes are left untouched
 * so a validator can reject them instead of silently losing fields.
 */
export function migrateStudioSnapshot(persisted: unknown, fromVersion: number): unknown {
  if (!persisted || typeof persisted !== 'object') return persisted;
  if (fromVersion >= STUDIO_SNAPSHOT_VERSION) return persisted;

  const candidate = persisted as Record<string, unknown> & { videos?: unknown };
  if (!Array.isArray(candidate.videos)) return persisted;

  const videos = (candidate.videos as VideoProject[]).map((video) => {
    const legacy = video as VideoProject & { fps?: number };
    const fps = legacy.fps ?? DEFAULT_VIDEO_FPS;
    return {
      ...legacy,
      fps,
      scenes: legacy.scenes.map((scene) => {
        const legacyScene = scene as Scene & {
          revision?: number;
          durationFrames?: number;
          visual?: Scene['visual'];
        };
        return {
          ...legacyScene,
          revision: legacyScene.revision ?? 1,
          durationFrames:
            legacyScene.durationFrames ?? sceneDurationFrames(legacyScene, fps),
          visual: legacyScene.visual ?? deriveSceneVisual(legacyScene),
        };
      }),
    };
  });

  return { ...candidate, videos };
}

export interface NormalizedWorkspace {
  workspace: StudioSnapshot;
  schemaVersion: number;
  exportedAt?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Accepts either a workspace envelope or a bare `StudioSnapshot` (the format
 * older backups used), applies the migration chain and validates the result.
 */
export function normalizeWorkspacePayload(input: unknown): NormalizedWorkspace {
  if (!isRecord(input)) {
    throw new WorkspaceImportError('工作区数据必须是 JSON 对象。');
  }

  const looksLikeEnvelope = 'workspace' in input;
  // Zustand persist writes `{ state: StudioSnapshot, version: 2 }`. Accept it
  // so a user can restore a raw localStorage backup, not only an app export.
  const looksLikeZustand = !looksLikeEnvelope && isRecord(input.state);
  const rawWorkspace = looksLikeEnvelope
    ? input.workspace
    : looksLikeZustand
      ? input.state
      : input;
  const versionValue = looksLikeEnvelope
    ? input.schemaVersion
    : looksLikeZustand
      ? input.version
      : undefined;
  const schemaVersion =
    typeof versionValue === 'number' && Number.isInteger(versionValue) && versionValue > 0
      ? versionValue
      : 1;

  if (schemaVersion > STUDIO_SNAPSHOT_VERSION) {
    throw new WorkspaceImportError(
      `工作区版本 ${schemaVersion} 高于当前支持的版本 ${STUDIO_SNAPSHOT_VERSION}，请升级应用后再导入。`,
    );
  }

  const migrated = migrateStudioSnapshot(rawWorkspace, schemaVersion);
  const parsed = studioSnapshotSchema.safeParse(migrated);
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    throw new WorkspaceImportError(
      `工作区数据结构无效${first ? `：${first.path.join('.') || 'root'} ${first.message}` : '。'}`,
    );
  }

  const exportedAt =
    looksLikeEnvelope && typeof input.exportedAt === 'string' && input.exportedAt.length > 0
      ? input.exportedAt
      : undefined;

  return {
    workspace: parsed.data,
    schemaVersion: STUDIO_SNAPSHOT_VERSION,
    ...(exportedAt ? { exportedAt } : {}),
  };
}

export function createWorkspaceEnvelope(
  snapshot: StudioSnapshot,
  exportedAt: string = new Date().toISOString(),
): WorkspaceEnvelope {
  return {
    kind: WORKSPACE_KIND,
    schemaVersion: STUDIO_SNAPSHOT_VERSION,
    exportedAt,
    workspace: studioSnapshotSchema.parse(snapshot),
  };
}

/**
 * Full workspace backup. Unlike `buildProjectExport` this contains every
 * project, video, run and activity event, so a fresh browser can restore it.
 */
export function buildWorkspaceExport(
  snapshot: StudioSnapshot,
  exportedAt: string = new Date().toISOString(),
): string {
  return JSON.stringify(
    {
      ...createWorkspaceEnvelope(snapshot, exportedAt),
      notice:
        '这是完整工作区导出文件，包含项目、知识、视频工程、生产与导出记录。媒体文件与浏览器 UI 偏好不在其中。',
    },
    null,
    2,
  );
}

export function parseWorkspaceExport(text: string): NormalizedWorkspace {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch {
    throw new WorkspaceImportError('文件不是有效的 JSON。');
  }
  return normalizeWorkspacePayload(parsed);
}

export function workspaceExportFileName(exportedAt: string = new Date().toISOString()): string {
  const stamp = exportedAt.replace(/[:.]/g, '-').replace('T', '_').replace('Z', '');
  return `asvs-workspace-${stamp}.json`;
}
