import { useCallback, useEffect, useState } from 'react';
import type { OrchestrationArtifactV1, OrchestrationRunV1 } from '@asvs/domain';
import { Download, Film, HardDrive, Loader2, ShieldCheck } from 'lucide-react';
import { Badge, Button, Callout, Panel, PanelHeader, cn } from '@asvs/ui';
import { getOrchestrationClient, useUiStore, useWorkspaceSyncStore } from '@asvs/state';
import { formatArtifactSize, formatDurationMs, shortSha } from './server-orchestration';

const NO_AUDIO_NOTE = '16:9 · H.264 · 无音轨（5B 接入配音与 SRT）';

interface LatestVideoArtifact {
  run: OrchestrationRunV1;
  artifact: OrchestrationArtifactV1;
  downloadUrl: string;
}

type ProbeState = 'probing' | 'unavailable' | 'none' | 'ready';

/**
 * Real server-rendered MP4 for a video, if one exists.
 *
 * Deliberately read-only: approval still happens on the review page's own
 * checks, and this panel never fakes a file. When the API is unreachable or the
 * video was never rendered server-side it says so and leaves the existing
 * simulated export flow untouched.
 */
export function ReviewArtifactPanel({ videoId }: { videoId: string }) {
  const syncConfig = useWorkspaceSyncStore((state) => state.config);
  const pushToast = useUiStore((state) => state.pushToast);
  const [state, setState] = useState<ProbeState>('probing');
  const [latest, setLatest] = useState<LatestVideoArtifact | null>(null);
  const [manifest, setManifest] = useState<OrchestrationArtifactV1 | null>(null);
  const [downloading, setDownloading] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    if (!syncConfig.enabled || !videoId) {
      setState('unavailable');
      return;
    }
    void (async () => {
      try {
        const client = await getOrchestrationClient(syncConfig.baseUrl);
        if (!(await client.isReachable())) {
          if (!cancelled) setState('unavailable');
          return;
        }
        const found = await client.getLatestVideoArtifact(syncConfig.workspaceId, videoId);
        if (cancelled) return;
        if (!found) {
          setState('none');
          return;
        }
        setLatest(found);
        const detail = await client.getRun(syncConfig.workspaceId, found.run.id);
        if (cancelled) return;
        setManifest(detail?.artifacts.find((artifact) => artifact.kind === 'render_manifest') ?? null);
        setState('ready');
      } catch {
        if (!cancelled) setState('unavailable');
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [syncConfig.enabled, syncConfig.baseUrl, syncConfig.workspaceId, videoId]);

  const download = useCallback(
    async (artifact: OrchestrationArtifactV1) => {
      setDownloading(artifact.id);
      setError(null);
      try {
        const client = await getOrchestrationClient(syncConfig.baseUrl);
        const response = await fetch(client.artifactDownloadUrl(syncConfig.workspaceId, artifact.id));
        if (!response.ok) throw new Error(`下载失败（HTTP ${response.status}）`);
        // The server sets ETag to the stored SHA256; verify the bytes match
        // before handing them to the user.
        const buffer = await response.arrayBuffer();
        const digest = await crypto.subtle.digest('SHA-256', buffer);
        const hex = Array.from(new Uint8Array(digest))
          .map((byte) => byte.toString(16).padStart(2, '0'))
          .join('');
        if (hex !== artifact.sha256) {
          throw new Error(`下载内容 SHA256 不匹配（${hex.slice(0, 12)}… vs ${artifact.sha256.slice(0, 12)}…）`);
        }
        const url = URL.createObjectURL(new Blob([buffer], { type: artifact.mimeType }));
        const anchor = document.createElement('a');
        anchor.href = url;
        anchor.download = artifact.fileName;
        document.body.appendChild(anchor);
        anchor.click();
        anchor.remove();
        window.setTimeout(() => URL.revokeObjectURL(url), 1200);
        pushToast({
          tone: 'success',
          title: `已下载 ${artifact.fileName}`,
          description: `已校验 SHA256 ${shortSha(artifact.sha256)}`,
        });
      } catch (caught) {
        setError(caught instanceof Error ? caught.message : String(caught));
      } finally {
        setDownloading(null);
      }
    },
    [syncConfig.baseUrl, syncConfig.workspaceId, pushToast],
  );

  if (state === 'probing') {
    return (
      <Panel>
        <div className="flex items-center gap-2 p-4 text-[10.5px] text-faint">
          <Loader2 size={12} className="animate-spin" /> 正在检查服务端渲染产物…
        </div>
      </Panel>
    );
  }

  if (state === 'unavailable') {
    return (
      <Callout tone="info" size="sm" title="没有连接服务端编排">
        连接本机工作区后，这里会显示真实的 16:9 MP4（含 SHA256 / 时长 / 分辨率）与 manifest.json；当前仅提供下方浏览器内的导出。
      </Callout>
    );
  }

  if (state === 'none') {
    return (
      <Callout tone="warning" size="sm" title="还没有服务端渲染的真实 MP4">
        到 <span className="font-mono">生产监控</span> 启动一次服务端渲染后，这里会出现可下载的 MP4 与 manifest。
        当前导出记录里的 MP4/WebM 仍是模拟任务状态。
      </Callout>
    );
  }

  if (!latest) return null;
  const videoArtifact = latest.artifact;
  const width = typeof videoArtifact.metadata.width === 'number' ? videoArtifact.metadata.width : null;
  const height = typeof videoArtifact.metadata.height === 'number' ? videoArtifact.metadata.height : null;
  const durationMs = typeof videoArtifact.metadata.durationMs === 'number' ? videoArtifact.metadata.durationMs : null;
  const fps = typeof videoArtifact.metadata.fps === 'number' ? videoArtifact.metadata.fps : null;
  const codec = typeof videoArtifact.metadata.codecName === 'string' ? videoArtifact.metadata.codecName : 'h264';
  const usingPlaceholder = videoArtifact.metadata.usingPlaceholder === true;

  return (
    <Panel>
      <PanelHeader
        title="服务端真实产物"
        description="由 render-worker 子进程渲染，经 ffprobe 校验并登记为可下载产物。"
        actions={
          <Badge tone="success" dot={false}>
            <ShieldCheck size={9} className="mr-1" />
            已核验
          </Badge>
        }
      />
      <div className="space-y-3 border-t border-line p-4">
        <div className="flex flex-wrap items-start gap-3">
          <span className="grid size-10 shrink-0 place-items-center rounded-sm border border-success/25 bg-success-soft text-success">
            <Film size={18} />
          </span>
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2">
              <span className="font-mono text-[11px] text-fg">{videoArtifact.fileName}</span>
              <Badge tone="outline" dot={false}>{NO_AUDIO_NOTE}</Badge>
              {usingPlaceholder ? <Badge tone="warn" dot={false}>含占位画面</Badge> : null}
            </div>
            <div className="mt-1 flex flex-wrap gap-x-4 gap-y-1 text-[9.5px] text-faint">
              <span>
                分辨率 <span className="font-mono text-muted">{width && height ? `${width}×${height}` : '—'}</span>
              </span>
              <span>
                时长 <span className="font-mono text-muted">{durationMs !== null ? formatDurationMs(durationMs) : '—'}</span>
              </span>
              <span>
                帧率 <span className="font-mono text-muted">{fps ?? '—'}</span>
              </span>
              <span>
                编码 <span className="font-mono text-muted">{codec}</span>
              </span>
              <span>
                大小 <span className="font-mono text-muted">{formatArtifactSize(videoArtifact.byteSize)}</span>
              </span>
            </div>
            <div className="mt-1 break-all font-mono text-[9px] text-faint">
              SHA256 {videoArtifact.sha256}
            </div>
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <Button
            variant="primary"
            size="sm"
            icon={<Download size={12} />}
            disabled={downloading !== null}
            onClick={() => void download(videoArtifact)}
          >
            {downloading === videoArtifact.id ? '下载并校验中…' : '下载 MP4'}
          </Button>
          {manifest ? (
            <Button
              variant="ghost"
              size="sm"
              icon={<HardDrive size={12} />}
              disabled={downloading !== null}
              onClick={() => void download(manifest)}
            >
              下载 manifest.json
            </Button>
          ) : null}
          <span className="ml-auto font-mono text-[9px] text-faint">
            运行 {latest.run.id} · 尝试 {latest.run.steps.find((step) => step.stepKey === 'render_video')?.attempt ?? 1}
          </span>
        </div>

        <p className="text-[9px] leading-4 text-faint">
          下载会先按登记的 SHA256 校验字节，再交给浏览器保存。5A 只产出画面；配音与 SRT 在 5B 接入，当前 MP4 无音轨。
        </p>

        {error ? (
          <div className={cn('rounded-sm border border-danger/25 bg-danger-soft/20 px-2.5 py-2 text-[9.5px] text-danger')}>
            {error}
          </div>
        ) : null}
      </div>
    </Panel>
  );
}
