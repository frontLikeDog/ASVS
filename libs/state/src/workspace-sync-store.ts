import { create } from 'zustand';
import { persist } from 'zustand/middleware';

export interface WorkspaceSyncConfig {
  enabled: boolean;
  /** `/api` is proxied by Vite; a full origin works for a remote server. */
  baseUrl: string;
  workspaceId: string;
}

export type WorkspaceSyncPhase =
  | 'disabled'
  | 'connecting'
  | 'synced'
  | 'dirty'
  | 'saving'
  | 'conflict'
  | 'error';

export type WorkspaceSyncCommandKind = 'connect' | 'pull' | 'push' | 'disconnect';

export interface WorkspaceSyncCommand {
  kind: WorkspaceSyncCommandKind;
  nonce: number;
}

export interface WorkspaceSyncState {
  config: WorkspaceSyncConfig;
  phase: WorkspaceSyncPhase;
  lastSyncedAt?: string;
  remoteRevision?: number;
  lastError?: string;
  command: WorkspaceSyncCommand | null;
  updateConfig: (patch: Partial<WorkspaceSyncConfig>) => void;
  setStatus: (
    patch: Partial<Pick<WorkspaceSyncState, 'phase' | 'lastSyncedAt' | 'remoteRevision' | 'lastError'>>,
  ) => void;
  requestCommand: (kind: WorkspaceSyncCommandKind) => void;
}

export const DEFAULT_WORKSPACE_SYNC_CONFIG: WorkspaceSyncConfig = {
  enabled: false,
  baseUrl: '/api',
  workspaceId: 'default',
};

export const useWorkspaceSyncStore = create<WorkspaceSyncState>()(
  persist(
    (set) => ({
      config: DEFAULT_WORKSPACE_SYNC_CONFIG,
      phase: 'disabled',
      lastSyncedAt: undefined,
      remoteRevision: undefined,
      lastError: undefined,
      command: null,
      updateConfig: (patch) =>
        set((state) => {
          const config = { ...state.config, ...patch };
          return {
            config,
            phase: config.enabled ? state.phase : 'disabled',
          };
        }),
      setStatus: (patch) => set(patch),
      requestCommand: (kind) =>
        set((state) => ({
          command: { kind, nonce: (state.command?.nonce ?? 0) + 1 },
        })),
    }),
    {
      name: 'asvs.workspace-sync.v1',
      version: 1,
      partialize: (state) => ({ config: state.config }),
      merge: (persisted, current) => {
        const candidate = persisted as { config?: Partial<WorkspaceSyncConfig> } | undefined;
        if (!candidate?.config) return current;
        return {
          ...current,
          config: { ...DEFAULT_WORKSPACE_SYNC_CONFIG, ...candidate.config },
          phase: candidate.config.enabled ? current.phase : 'disabled',
        };
      },
    },
  ),
);
