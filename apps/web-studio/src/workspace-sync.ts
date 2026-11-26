import { HttpWorkspaceRepository, WorkspaceHttpError } from '@asvs/adapters-http';
import type { WorkspaceRecord } from '@asvs/domain';
import {
  selectStudioSnapshot,
  useStudioStore,
  useUiStore,
  useWorkspaceSyncStore,
} from '@asvs/state';
import type { WorkspaceSyncPhase } from '@asvs/state';

const SAVE_DEBOUNCE_MS = 1200;
const POLL_INTERVAL_MS = 8000;

let started = false;
let repository: HttpWorkspaceRepository | null = null;
let remote: WorkspaceRecord | null = null;
let lastSyncedJson = '';
let saveTimer: number | undefined;
let applyingRemote = false;

function config() {
  return useWorkspaceSyncStore.getState().config;
}

function setStatus(
  patch: Partial<{
    phase: WorkspaceSyncPhase;
    lastSyncedAt: string;
    remoteRevision: number;
    lastError: string | undefined;
  }>,
): void {
  useWorkspaceSyncStore.getState().setStatus(patch);
}

function snapshot() {
  return selectStudioSnapshot(useStudioStore.getState());
}

function snapshotJson(): string {
  return JSON.stringify(snapshot());
}

function toast(tone: 'success' | 'info' | 'warning' | 'danger', title: string, description?: string) {
  useUiStore.getState().pushToast({ tone, title, description });
}

function errorText(error: unknown): string {
  if (error instanceof WorkspaceHttpError) return `${error.message}（HTTP ${error.status}）`;
  if (error instanceof Error) return error.message;
  return '未知同步错误';
}

function ensureRepository(): HttpWorkspaceRepository {
  if (!repository) {
    repository = new HttpWorkspaceRepository({ baseUrl: config().baseUrl });
  }
  return repository;
}

function applyRemote(record: WorkspaceRecord, note: string, quiet = false): void {
  applyingRemote = true;
  useStudioStore.getState().replaceWorkspace(record.workspace, note);
  applyingRemote = false;
  remote = record;
  // Snapshot after `replaceWorkspace` so the synthetic local restore activity
  // does not make the store look dirty immediately and block polling/reconnect.
  lastSyncedJson = snapshotJson();
  setStatus({
    phase: 'synced',
    remoteRevision: record.revision,
    lastSyncedAt: new Date().toISOString(),
    lastError: undefined,
  });
  if (!quiet) {
    toast('success', '工作区已同步', `服务器版本 r${record.revision} · ${note}`);
  }
}

async function connect(): Promise<void> {
  if (!config().enabled) {
    setStatus({ phase: 'disabled' });
    return;
  }
  setStatus({ phase: 'connecting', lastError: undefined });
  const repo = ensureRepository();
  try {
    const loaded = await repo.load(config().workspaceId);
    if (loaded) {
      // Reconnecting must not silently discard edits the debounce has not
      // uploaded yet. Surface the existing conflict actions instead.
      if (lastSyncedJson && snapshotJson() !== lastSyncedJson) {
        remote = loaded;
        setStatus({
          phase: 'conflict',
          remoteRevision: loaded.revision,
          lastError: '本机有未上传的修改；请先选择拉取服务器或以本机覆盖。',
        });
        toast('warning', '本机有未上传的修改', '重新连接未覆盖本机数据，请选择拉取或上传。');
        return;
      }
      applyRemote(loaded, '已从服务器加载');
      return;
    }

    const created = await repo.save(config().workspaceId, {
      workspace: snapshot(),
      baseRevision: 0,
    });
    if (created.ok) {
      remote = created.record;
      lastSyncedJson = JSON.stringify(created.record.workspace);
      setStatus({
        phase: 'synced',
        remoteRevision: created.record.revision,
        lastSyncedAt: new Date().toISOString(),
        lastError: undefined,
      });
      toast('success', '工作区已上传', '服务器上还没有这个工作区，已用本机数据初始化。');
    } else if (created.conflict) {
      applyRemote(created.conflict, '其他客户端刚刚创建了该工作区');
    } else {
      setStatus({ phase: 'error', lastError: '创建服务器工作区失败。' });
    }
  } catch (error) {
    setStatus({ phase: 'error', lastError: errorText(error) });
    toast('danger', '无法连接工作区服务器', errorText(error));
  }
}

async function pull(): Promise<void> {
  setStatus({ phase: 'connecting', lastError: undefined });
  try {
    const loaded = await ensureRepository().load(config().workspaceId);
    if (!loaded) {
      setStatus({ phase: 'error', lastError: '服务器上还没有这个工作区。' });
      return;
    }
    applyRemote(loaded, '已拉取服务器版本');
  } catch (error) {
    setStatus({ phase: 'error', lastError: errorText(error) });
    toast('danger', '拉取失败', errorText(error));
  }
}

/** Deliberately overwrite the server with this browser's current workspace. */
async function push(): Promise<void> {
  setStatus({ phase: 'saving', lastError: undefined });
  try {
    const repo = ensureRepository();
    const current = await repo.load(config().workspaceId);
    const result = await repo.save(config().workspaceId, {
      workspace: snapshot(),
      baseRevision: current?.revision ?? 0,
    });
    if (result.ok) {
      remote = result.record;
      lastSyncedJson = JSON.stringify(result.record.workspace);
      setStatus({
        phase: 'synced',
        remoteRevision: result.record.revision,
        lastSyncedAt: new Date().toISOString(),
        lastError: undefined,
      });
      toast('success', '已用本机工作区覆盖服务器', `服务器版本 r${result.record.revision}`);
    } else {
      if (result.conflict) remote = result.conflict;
      setStatus({ phase: 'conflict', lastError: '上传过程中服务器又被修改，请先拉取。' });
      toast('warning', '出现版本冲突', '服务器版本已变化，请先拉取或再次覆盖。');
    }
  } catch (error) {
    setStatus({ phase: 'error', lastError: errorText(error) });
    toast('danger', '上传失败', errorText(error));
  }
}

async function saveNow(): Promise<void> {
  if (!config().enabled) return;
  const currentPhase = useWorkspaceSyncStore.getState().phase;
  if (currentPhase === 'conflict' || currentPhase === 'connecting' || currentPhase === 'saving') {
    return;
  }

  const workspace = snapshot();
  const json = JSON.stringify(workspace);
  if (json === lastSyncedJson) {
    setStatus({ phase: 'synced' });
    return;
  }

  setStatus({ phase: 'saving' });
  try {
    const result = await ensureRepository().save(config().workspaceId, {
      workspace,
      baseRevision: remote?.revision ?? 0,
    });
    if (result.ok) {
      remote = result.record;
      lastSyncedJson = JSON.stringify(result.record.workspace);
      setStatus({
        phase: 'synced',
        remoteRevision: result.record.revision,
        lastSyncedAt: new Date().toISOString(),
        lastError: undefined,
      });
      return;
    }

    remote = result.conflict ?? remote;
    setStatus({ phase: 'conflict', lastError: '服务器上已有更新版本。' });
    toast('warning', '工作区版本冲突', '本机修改尚未写入服务器。可以拉取服务器版本，或以本机覆盖。');
  } catch (error) {
    setStatus({ phase: 'error', lastError: errorText(error) });
  }
}

function scheduleSave(): void {
  if (saveTimer !== undefined) window.clearTimeout(saveTimer);
  saveTimer = window.setTimeout(() => {
    saveTimer = undefined;
    void saveNow();
  }, SAVE_DEBOUNCE_MS);
}

function stop(): void {
  if (saveTimer !== undefined) window.clearTimeout(saveTimer);
  saveTimer = undefined;
  repository = null;
  remote = null;
  lastSyncedJson = '';
  setStatus({ phase: 'disabled', lastError: undefined });
}

async function poll(): Promise<void> {
  if (!config().enabled || !repository) return;
  if (document.visibilityState !== 'visible') return;
  const phase = useWorkspaceSyncStore.getState().phase;
  if (phase === 'connecting' || phase === 'saving' || phase === 'conflict') return;
  if (snapshotJson() !== lastSyncedJson) return;

  try {
    const loaded = await repository.load(config().workspaceId);
    if (!loaded) return;
    if (remote && loaded.revision <= remote.revision) return;
    if (snapshotJson() !== lastSyncedJson) return;
    applyRemote(loaded, '同步了其他设备的最新修改', true);
  } catch {
    // Polling is best-effort; an explicit command surfaces errors.
  }
}

export function startWorkspaceSync(): void {
  if (started) return;
  started = true;

  useStudioStore.subscribe(() => {
    if (!config().enabled || applyingRemote) return;
    if (snapshotJson() === lastSyncedJson) return;
    if (useWorkspaceSyncStore.getState().phase === 'conflict') return;
    setStatus({ phase: 'dirty' });
    scheduleSave();
  });

  let lastCommandNonce = useWorkspaceSyncStore.getState().command?.nonce ?? 0;
  useWorkspaceSyncStore.subscribe((state) => {
    const command = state.command;
    if (!command || command.nonce === lastCommandNonce) return;
    lastCommandNonce = command.nonce;
    if (command.kind === 'connect') void connect();
    else if (command.kind === 'pull') void pull();
    else if (command.kind === 'push') void push();
    else stop();
  });

  let lastConfigKey = JSON.stringify(config());
  useWorkspaceSyncStore.subscribe((state) => {
    const key = JSON.stringify(state.config);
    if (key === lastConfigKey) return;
    lastConfigKey = key;
    if (!state.config.enabled) {
      stop();
      return;
    }
    // Enabling from the settings panel is accompanied by an explicit command
    // (connect or push). Only a server/ID change while already connected needs
    // an automatic reconnect.
    if (repository) {
      repository = null;
      remote = null;
      lastSyncedJson = '';
      void connect();
    }
  });

  window.addEventListener('focus', () => void poll());
  window.setInterval(() => void poll(), POLL_INTERVAL_MS);

  if (config().enabled) {
    void connect();
  } else {
    setStatus({ phase: 'disabled' });
  }
}
