import { useCallback, useEffect, useState } from 'react';
import type {
  ExportBundleDetailV1,
  OrchestrationArtifactV1,
  OrchestrationRunV1,
} from '@asvs/domain';
import {
  Download,
  FileText,
  Film,
  HardDrive,
  Loader2,
  PackageCheck,
  ShieldCheck,
} from 'lucide-react';
import { Badge, Button, Callout, Panel, PanelHeader, cn } from '@asvs/ui';
import { getOrchestrationClient, useUiStore, useWorkspaceSyncStore } from '@asvs/state';
import {
  downloadVerifiedArtifact,
  formatArtifactSize,
  formatDurationMs,
  shortSha,
} from './orchestration-format';

interface LatestVideoArtifact {
  run: OrchestrationRunV1;
  artifact: OrchestrationArtifactV1;
  downloadUrl: string;
}

type ProbeState = 'probing' | 'unavailable' | 'none' | 'ready';

const FILE_LABEL: Record<string, string> = {
  video_mp4: 'MP4',
  subtitles_srt: 'SRT',
  render_manifest: 'manifest.json',
  artifact_receipt: 'receipt.json',
  // 5D: the bundle now carries the QA report it was released under.
  qa_report: 'QA 报告',
};

/**
 * Gate-3 bound delivery (AC-10).
 *
 * Read-only until the review page's own checks pass: the export button appears
 * only for an approved video, and the server re-verifies the gate and re-hashes
 * every file before it inserts a bundle. Downloads always verify the bytes
 * against the registered SHA256, so a truncated or swapped file never lands on
 * the user's disk silently.
 */
export function ReviewArtifactPanel({
  videoId,
  gateApproved,
}: {
  videoId: string;
  /** Mirror of Gate 3 as the review page sees it; the server re-checks anyway. */
  gateApproved: boolean;
}) {
  const syncConfig = useWorkspaceSyncStore((state) => state.config);
  const pushToast = useUiStore((state) => state.pushToast);
  const [state, setState] = useState<ProbeState>('probing');
  const [latest, setLatest] = useState<LatestVideoArtifact | null>(null);
  const [manifest, setManifest] = useState<OrchestrationArtifactV1 | null>(null);
  const [srt, setSrt] = useState<OrchestrationArtifactV1 | null>(null);
  // 5C: the approved plan + receipt that produced the embedded real clip.
  const [captureReceipt, setCaptureReceipt] = useState<OrchestrationArtifactV1 | null>(null);
  const [captureClip, setCaptureClip] = useState<OrchestrationArtifactV1 | null>(null);
  const [bundles, setBundles] = useState<ExportBundleDetailV1[]>([]);
  const [exporting, setExporting] = useState(false);
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
        const [found, existing] = await Promise.all([
          client.getLatestVideoArtifact(syncConfig.workspaceId, videoId),
          client.listExportBundles(syncConfig.workspaceId, { videoId, limit: 10 }),
        ]);
        if (cancelled) return;
        setBundles(existing);
        if (!found) {
          setState('none');
          return;
        }
        setLatest(found);
        const detail = await client.getRun(syncConfig.workspaceId, found.run.id);
        if (cancelled) return;
        setManifest(detail?.artifacts.find((artifact) => artifact.kind === 'render_manifest') ?? null);
        setSrt(detail?.artifacts.find((artifact) => artifact.kind === 'subtitles_srt') ?? null);
        setCaptureReceipt(detail?.artifacts.find((artifact) => artifact.kind === 'capture_receipt') ?? null);
        setCaptureClip(detail?.artifacts.find((artifact) => artifact.kind === 'capture_clip') ?? null);
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
    async (artifact: { id: string; fileName: string; mimeType: string; sha256: string }) => {
      setDownloading(artifact.id);
      setError(null);
      try {
        const client = await getOrchestrationClient(syncConfig.baseUrl);
        await downloadVerifiedArtifact(
          client.artifactDownloadUrl(syncConfig.workspaceId, artifact.id),
          artifact,
        );
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

  const createBundle = useCallback(async () => {
    if (!latest) return;
    setExporting(true);
    setError(null);
    try {
      const client = await getOrchestrationClient(syncConfig.baseUrl);
      const created = await client.createExportBundle(syncConfig.workspaceId, {
        videoId,
        runId: latest.run.id,
      });
      setBundles((current) => [created, ...current]);
      pushToast({
        tone: 'success',
        title: '交付包已生成',
        description: `MP4 ${shortSha(created.bundle.mp4Sha256)} · SRT ${shortSha(created.bundle.srtSha256)}`,
      });
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setExporting(false);
    }
  }, [latest, syncConfig.baseUrl, syncConfig.workspaceId, videoId, pushToast]);

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
        连接本机工作区后，这里会显示真实的 16:9 MP4（含 AAC 旁白）与 SRT，并在批准后生成带 SHA256 回执的交付包；
        当前仅提供下方浏览器内的导出。
      </Callout>
    );
  }

  if (state === 'none') {
    return (
      <Callout tone="warning" size="sm" title="还没有服务端渲染的真实 MP4">
        到 <span className="font-mono">生产监控</span> 启动一次服务端渲染后，这里会出现可导出的 MP4、SRT 与 manifest。
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
  const hasAudio = videoArtifact.metadata.hasAudio === true;
  const narration = videoArtifact.metadata.narration as
    | { provider?: string; voiceId?: string; license?: string; synthetic?: boolean; timingPolicy?: string; language?: string }
    | undefined;
  const latestBundle = bundles[0] ?? null;
  const latestBundleCoversThisRun = latestBundle?.bundle.runId === latest.run.id;
  // Real-capture provenance (5C). `usingPlaceholder` already reflects the
  // render input; the receipt adds which approved plan produced the clip.
  const captureAssertions = captureReceipt?.metadata.assertions as
    | { total?: number; passed?: number }
    | undefined;
  const capturePlanDigest =
    typeof captureReceipt?.metadata.planDigest === 'string'
      ? captureReceipt.metadata.planDigest
      : typeof captureClip?.metadata.planDigest === 'string'
        ? captureClip.metadata.planDigest
        : null;
  const realCaptureEmbedded = !usingPlaceholder && captureClip !== null;

  return (
    <Panel>
      <PanelHeader
        title="服务端真实产物"
        description="由 render-worker 子进程渲染，经 ffprobe 校验音画与非静音后登记为可下载产物。"
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
              <Badge tone="outline" dot={false}>
                {hasAudio ? '16:9 · H.264 + AAC 48kHz' : '16:9 · H.264 · 无音轨'}
              </Badge>
              {narration?.synthetic ? (
                <Badge tone="warn" dot={false}>测试合成音轨 · 非真人配音</Badge>
              ) : null}
              {usingPlaceholder ? <Badge tone="warn" dot={false}>含占位画面</Badge> : null}
              {realCaptureEmbedded ? (
                <Badge tone="accent" dot={false}>
                  <ShieldCheck size={9} className="mr-1" />
                  真实录屏已嵌入 · Gate 2 已审批
                </Badge>
              ) : null}
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
                编码 <span className="font-mono text-muted">{codec}{hasAudio ? ' + aac' : ''}</span>
              </span>
              <span>
                大小 <span className="font-mono text-muted">{formatArtifactSize(videoArtifact.byteSize)}</span>
              </span>
              {srt ? (
                <span>
                  字幕 <span className="font-mono text-muted">{String(srt.metadata.cueCount ?? '?')} 条</span>
                </span>
              ) : null}
            </div>
            <div className="mt-1 break-all font-mono text-[9px] text-faint">
              SHA256 {videoArtifact.sha256}
            </div>
            {narration ? (
              <div className="mt-1 text-[9px] text-faint">
                旁白 {narration.voiceId} · {narration.language} · {narration.provider} · 许可 {narration.license} · 策略{' '}
                {narration.timingPolicy}
              </div>
            ) : null}
            {realCaptureEmbedded || captureClip ? (
              <div className="mt-1 flex flex-wrap gap-x-3 gap-y-0.5 text-[9px] text-faint">
                <span>
                  录屏溯源{' '}
                  <span className="font-mono text-muted">
                    {captureAssertions?.passed !== undefined && captureAssertions?.total !== undefined
                      ? `${captureAssertions.passed}/${captureAssertions.total} 断言通过`
                      : '断言已通过'}
                  </span>
                </span>
                {captureClip ? (
                  <span>
                    clip SHA256{' '}
                    <span className="font-mono text-muted">{shortSha(captureClip.sha256, 16)}</span>
                  </span>
                ) : null}
                {capturePlanDigest ? (
                  <span>
                    planDigest{' '}
                    <span className="font-mono text-muted" title={capturePlanDigest}>
                      {shortSha(capturePlanDigest, 12)}
                    </span>
                  </span>
                ) : null}
              </div>
            ) : null}
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          {srt ? (
            <Button
              variant="secondary"
              size="sm"
              icon={<FileText size={12} />}
              disabled={downloading !== null}
              onClick={() => void download(srt)}
            >
              {downloading === srt.id ? '校验中…' : '下载 SRT'}
            </Button>
          ) : null}
          {captureReceipt ? (
            <Button
              variant="ghost"
              size="sm"
              icon={<ShieldCheck size={12} />}
              disabled={downloading !== null}
              onClick={() => void download(captureReceipt)}
            >
              {downloading === captureReceipt.id ? '校验中…' : '下载录屏回执'}
            </Button>
          ) : null}
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

        <div className="rounded-sm border border-line bg-raised/20 p-3">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-[10.5px] font-medium text-fg">Gate 3 交付包</span>
            {latestBundleCoversThisRun ? (
              <Badge tone="success" dot={false}>已生成 · {formatRelative(latestBundle!.bundle.createdAt)}</Badge>
            ) : (
              <Badge tone="warn" dot={false}>尚未生成</Badge>
            )}
            {latestBundle?.narration?.synthetic ? (
              <Badge tone="warn" dot={false}>测试合成音轨 · 非真人配音</Badge>
            ) : null}
            <Button
              variant="primary"
              size="sm"
              className="ml-auto"
              icon={<PackageCheck size={12} />}
              disabled={exporting || latestBundleCoversThisRun || !gateApproved}
              onClick={() => void createBundle()}
            >
              {exporting
                ? '正在校验产物…'
                : latestBundleCoversThisRun
                  ? '交付包已生成'
                  : gateApproved
                    ? '生成交付包'
                    : '需先通过 Gate 3'}
            </Button>
          </div>
          <p className="mt-1.5 text-[9px] leading-4 text-faint">
            需要视频已通过 Gate 3（stage = approved/exported 且审核通过），并且当前脚本版本有一份通过的独立 QA
            报告。服务端会重新核对脚本版本、QA 结论与每个文件的 SHA256，任一不符返回 409（
            <span className="font-mono">export_qa_missing / export_qa_blocked / export_qa_stale / export_hash_mismatch</span>
            ），不会放行过期或篡改的产物。
          </p>
        </div>

        {bundles.length > 0 ? (
          <div className="space-y-2">
            {bundles.map((detail) => (
              <div key={detail.bundle.id} className="rounded-sm border border-line p-2.5">
                <div className="flex flex-wrap items-center gap-2 text-[9.5px]">
                  <span className="font-mono text-muted">{detail.bundle.id}</span>
                  <span className="text-faint">脚本 v{detail.bundle.scriptVersion}</span>
                  <span className="text-faint">{formatRelative(detail.bundle.createdAt)}</span>
                  {detail.videoDurationMs !== undefined ? (
                    <span className="text-faint">
                      视频 <span className="font-mono text-muted">{formatDurationMs(detail.videoDurationMs)}</span>
                    </span>
                  ) : null}
                  {detail.audioDurationMs !== undefined ? (
                    <span className="text-faint">
                      音轨 <span className="font-mono text-muted">{formatDurationMs(detail.audioDurationMs)}</span>
                    </span>
                  ) : null}
                </div>
                {detail.bundle.approvalNote ? (
                  <div className="mt-1 text-[9px] text-faint">备注：{detail.bundle.approvalNote}</div>
                ) : null}
                <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
                  {detail.files.map((file) => (
                    <Button
                      key={file.artifactId}
                      variant={file.kind === 'video_mp4' ? 'secondary' : 'ghost'}
                      size="sm"
                      icon={<Download size={11} />}
                      disabled={downloading !== null}
                      title={`SHA256 ${file.sha256}`}
                      onClick={() =>
                        void download({
                          id: file.artifactId,
                          fileName: file.fileName,
                          mimeType: file.mimeType,
                          sha256: file.sha256,
                        })
                      }
                    >
                      {downloading === file.artifactId ? '校验中…' : `${FILE_LABEL[file.kind] ?? file.kind} · ${formatArtifactSize(file.byteSize)}`}
                    </Button>
                  ))}
                </div>
                <div className="mt-1.5 flex flex-wrap gap-x-4 gap-y-0.5 font-mono text-[8.5px] text-faint">
                  <span>MP4 {shortSha(detail.bundle.mp4Sha256, 16)}</span>
                  <span>SRT {shortSha(detail.bundle.srtSha256, 16)}</span>
                  <span>manifest {shortSha(detail.bundle.manifestSha256, 16)}</span>
                </div>
                {detail.narration ? (
                  <div className="mt-1 text-[8.5px] text-faint">
                    旁白 {detail.narration.voiceId} · {detail.narration.language} · 许可 {detail.narration.license}
                    {detail.narration.synthetic ? ' · 测试合成' : ''}
                  </div>
                ) : null}
              </div>
            ))}
          </div>
        ) : (
          <p className="text-[9px] leading-4 text-faint">
            还没有交付包。批准后点击「生成交付包」，即可分别下载 MP4、SRT 与 manifest.json；每个文件都附带 SHA256 回执。
          </p>
        )}

        <p className="text-[9px] leading-4 text-faint">
          每次下载都会先按登记的 SHA256 校验字节，再交给浏览器保存。旁白为合成音轨时会在本页与 manifest 中明确标注；
          {gateApproved ? ' 当前 Gate 3 已通过。' : ' 当前尚未通过 Gate 3，服务端会以 409 拒绝导出。'}
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

function formatRelative(iso: string): string {
  const then = new Date(iso).getTime();
  if (!Number.isFinite(then)) return iso;
  const diffMinutes = Math.round((Date.now() - then) / 60_000);
  if (diffMinutes < 1) return '刚刚';
  if (diffMinutes < 60) return `${diffMinutes} 分钟前`;
  const diffHours = Math.round(diffMinutes / 60);
  if (diffHours < 24) return `${diffHours} 小时前`;
  return `${Math.round(diffHours / 24)} 天前`;
}
