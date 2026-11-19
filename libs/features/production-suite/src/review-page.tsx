import { useEffect, useMemo, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import type { ExportFormat, ReviewCheck } from '@asvs/domain';
import {
  buildExportFileName,
  buildProjectExport,
  buildSrt,
  formatRelativeTime,
  orderedScenes,
  totalDuration,
} from '@asvs/domain';
import {
  AlertTriangle,
  ArrowRight,
  Check,
  CheckCircle2,
  CircleAlert,
  Download,
  FileJson,
  FileText,
  Film,
  Info,
  MonitorPlay,
  RefreshCw,
  ShieldCheck,
  Video,
  XCircle,
} from 'lucide-react';
import {
  Badge,
  Button,
  Callout,
  ClaimStatusBadge,
  Dialog,
  DialogContent,
  ExportStatusBadge,
  FeatureStatusBadge,
  Field,
  Page,
  Panel,
  PanelHeader,
  ProgressBar,
  RunStatusBadge,
  Textarea,
  VideoStageBadge,
  buttonStyles,
  cn,
} from '@asvs/ui';
import { selectReviewBundle, useStudioStore, useUiStore } from '@asvs/state';
import { NotFoundInline } from './not-found-inline';

const CHECK_ICON = {
  pass: CheckCircle2,
  warn: AlertTriangle,
  fail: XCircle,
} as const;

const CHECK_TONE = {
  pass: 'text-success',
  warn: 'text-warn',
  fail: 'text-danger',
} as const;

const FORMAT_INFO: Record<
  ExportFormat,
  { label: string; detail: string; simulated: boolean; icon: typeof Film }
> = {
  mp4: { label: 'MP4', detail: 'H.264 · 模拟任务状态，不生成文件', simulated: true, icon: Film },
  webm: { label: 'WebM', detail: 'VP9 · 模拟任务状态，不生成文件', simulated: true, icon: Video },
  json: { label: '工程 JSON', detail: '真实下载 · 可重建的工程与知识快照', simulated: false, icon: FileJson },
  srt: { label: '字幕 SRT', detail: '真实下载 · 与镜头时长对齐', simulated: false, icon: FileText },
};

const ACTION_LINK: Record<ReviewCheck['action'], { label: string; path: 'knowledge' | 'editor' | 'production' | null }> = {
  knowledge: { label: '去知识中心', path: 'knowledge' },
  editor: { label: '去编辑器', path: 'editor' },
  production: { label: '去生产监控', path: 'production' },
  none: { label: '', path: null },
};

export function ReviewPage() {
  const { videoId = '' } = useParams();
  const storeState = useStudioStore((state) => state);
  const bundle = useMemo(() => selectReviewBundle(storeState, videoId), [storeState, videoId]);
  const video = storeState.videos.find((item) => item.id === videoId);
  const project = storeState.projects.find((item) => item.id === video?.projectId);
  const features = storeState.features.filter((item) => item.projectId === video?.projectId);
  const claims = storeState.claims.filter((item) => item.projectId === video?.projectId);
  const evidence = storeState.evidence.filter((item) => item.projectId === video?.projectId);
  const runs = storeState.runs
    .filter((run) => run.videoId === videoId)
    .sort((a, b) => new Date(b.startedAt).getTime() - new Date(a.startedAt).getTime());
  const exports = storeState.exports
    .filter((record) => record.videoId === videoId)
    .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
  const approveVideo = useStudioStore((state) => state.approveVideo);
  const requestVideoChanges = useStudioStore((state) => state.requestVideoChanges);
  const startExport = useStudioStore((state) => state.startExport);
  const pushToast = useUiStore((state) => state.pushToast);

  const [approveOpen, setApproveOpen] = useState(false);
  const [changesOpen, setChangesOpen] = useState(false);
  const [approveNote, setApproveNote] = useState('');
  const [changesNote, setChangesNote] = useState('');
  const [format, setFormat] = useState<ExportFormat>('mp4');
  const [resolution, setResolution] = useState('1920×1080');

  const aspect = video?.brief.aspect ?? '16:9';
  const resolutions = useMemo(() => {
    if (aspect === '9:16') return ['1080×1920', '720×1280'];
    if (aspect === '1:1') return ['1080×1080', '720×720'];
    return ['1920×1080', '1280×720'];
  }, [aspect]);

  useEffect(() => {
    if (!resolutions.includes(resolution)) setResolution(resolutions[0] ?? '');
  }, [resolutions, resolution]);

  if (!video || !project || !bundle) {
    return <NotFoundInline label="视频工程不存在或已被删除。" />;
  }

  const scenes = orderedScenes(video.scenes);
  const relatedClaimIds = Array.from(new Set(scenes.flatMap((scene) => scene.claimIds)));
  const relatedClaims = relatedClaimIds
    .map((id) => claims.find((claim) => claim.id === id))
    .filter((claim): claim is NonNullable<typeof claim> => Boolean(claim));
  const relatedFeatures = features.filter(
    (feature) =>
      video.brief.featureIds.includes(feature.id) ||
      scenes.some((scene) => scene.featureId === feature.id),
  );
  const riskyClaims = relatedClaims.filter((claim) => claim.status !== 'verified');
  const latestSuccess = runs.find((run) => run.status === 'succeeded');
  const latestRun = runs[0];
  const approved =
    video.review?.status === 'approved' &&
    !bundle.checks.some((check) => check.id === 'approval-freshness' && check.status === 'fail');
  const exportUnlocked = video.stage === 'approved' || video.stage === 'exported';
  const failCount = bundle.checks.filter((check) => check.status === 'fail').length;
  const warnCount = bundle.checks.filter((check) => check.status === 'warn').length;
  const passCount = bundle.checks.filter((check) => check.status === 'pass').length;
  const formatInfo = FORMAT_INFO[format];

  const actionHref = (check: ReviewCheck): string | null => {
    const target = ACTION_LINK[check.action].path;
    if (!target) return null;
    if (target === 'knowledge') return `/projects/${project.id}/knowledge`;
    return `/videos/${video.id}/${target}`;
  };

  const downloadRealFile = (extension: 'json' | 'srt') => {
    const content =
      extension === 'json'
        ? buildProjectExport({
            video,
            project,
            features,
            claims,
            evidence,
            exportedAt: new Date().toISOString(),
          })
        : buildSrt(video);
    const fileName = buildExportFileName(video, extension);
    const blob = new Blob([content], {
      type: extension === 'json' ? 'application/json;charset=utf-8' : 'text/plain;charset=utf-8',
    });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = fileName;
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 1200);
    return fileName;
  };

  const handleExport = () => {
    const result = startExport(video.id, { format, aspect: video.brief.aspect, resolution });
    if (!result.ok) {
      pushToast({ tone: 'danger', title: '无法导出', description: result.message });
      return;
    }
    if (!formatInfo.simulated) {
      const fileName = downloadRealFile(format === 'json' ? 'json' : 'srt');
      pushToast({
        tone: 'success',
        title: '真实文件已下载',
        description: `${fileName} · 不依赖后端，由浏览器直接生成。`,
      });
    } else {
      pushToast({
        tone: 'info',
        title: `已开始模拟 ${formatInfo.label} 导出`,
        description: '只会推进任务状态，不会生成或下载媒体文件。',
      });
    }
  };

  return (
    <Page wide>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[10.5px] text-faint">
        <Link to={`/projects/${project.id}/videos`} className="hover:text-accent">{project.name}</Link>
        <span>/</span>
        <Link to={`/videos/${video.id}/editor`} className="hover:text-accent">{video.title}</Link>
        <span>/</span>
        <span>审核与导出</span>
        <span className="ml-auto rounded-sm border border-line px-1.5 py-0.5 text-[9px]">Demo · 本地工程</span>
      </div>

      <div className="mt-2 flex flex-wrap items-start justify-between gap-4">
        <div>
          <div className="flex flex-wrap items-center gap-2">
            <h1 className="font-display text-[24px] font-medium tracking-[-0.02em] text-fg">审核与导出</h1>
            <VideoStageBadge stage={video.stage} />
            <Badge tone="outline" dot={false}>脚本 v{video.scriptVersion}</Badge>
          </div>
          <p className="mt-1 text-[11.5px] text-muted">
            {scenes.length} 个镜头 · {totalDuration(scenes)} 秒 · {video.brief.aspect} · {video.brief.language}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Link to={`/videos/${video.id}/editor`} className={buttonStyles({ variant: 'ghost', size: 'sm' })}>
            <MonitorPlay size={12} /> 打开编辑器
          </Link>
          <Link to={`/videos/${video.id}/production`} className={buttonStyles({ variant: 'ghost', size: 'sm' })}>
            <RefreshCw size={12} /> 生产记录
          </Link>
          <Button
            variant="secondary"
            size="sm"
            onClick={() => { setChangesNote(''); setChangesOpen(true); }}
          >
            请求修改
          </Button>
          <Button
            variant="primary"
            size="sm"
            disabled={!bundle.canApprove || approved}
            onClick={() => { setApproveNote(''); setApproveOpen(true); }}
            icon={<ShieldCheck size={13} />}
          >
            {approved ? '已通过审核' : '批准视频'}
          </Button>
        </div>
      </div>

      <div className="mt-4 grid grid-cols-[minmax(0,1fr)] gap-4 xl:grid-cols-[minmax(0,1fr)_350px]">
        <div className="space-y-4">
          <Panel className="overflow-hidden">
            <div
              className={cn(
                'flex flex-wrap items-center gap-4 border-b border-line px-4 py-3.5',
                approved
                  ? 'bg-success-soft/25'
                  : failCount > 0
                    ? 'bg-danger-soft/20'
                    : warnCount > 0
                      ? 'bg-warn-soft/20'
                      : 'bg-accent-soft/15',
              )}
            >
              <span
                className={cn(
                  'grid size-9 place-items-center rounded-full border',
                  approved || failCount === 0
                    ? 'border-success/30 bg-success-soft text-success'
                    : 'border-danger/30 bg-danger-soft text-danger',
                )}
              >
                {approved ? <ShieldCheck size={18} /> : failCount > 0 ? <XCircle size={18} /> : <CheckCircle2 size={18} />}
              </span>
              <div className="min-w-0 flex-1">
                <div className="text-[13px] font-medium text-fg">
                  {approved
                    ? '当前工程版本已通过审核'
                    : failCount > 0
                      ? `${failCount} 项阻断，暂时不能批准`
                      : warnCount > 0
                        ? '可以批准，但有需要知悉的提醒'
                        : '所有检查通过，可以批准'}
                </div>
                <div className="mt-0.5 text-[10.5px] text-muted">
                  {approved
                    ? `审核绑定 v${video.scriptVersion}，工程修改后会自动失效。`
                    : '批准会绑定当前脚本版本与最近一次成功生产，不会触发真实渲染。'}
                </div>
              </div>
              <div className="flex gap-2 text-center">
                <Count label="通过" value={passCount} tone="success" />
                <Count label="提醒" value={warnCount} tone="warn" />
                <Count label="阻断" value={failCount} tone="danger" />
              </div>
            </div>
            <div className="divide-y divide-line">
              {bundle.checks.map((check) => {
                const Icon = CHECK_ICON[check.status];
                const href = actionHref(check);
                return (
                  <div key={check.id} className="flex items-start gap-3 px-4 py-3">
                    <Icon size={16} className={cn('mt-0.5 shrink-0', CHECK_TONE[check.status])} />
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="text-[11.5px] font-medium text-fg">{check.label}</span>
                        <Badge
                          tone={check.status === 'pass' ? 'success' : check.status === 'warn' ? 'warn' : 'danger'}
                          dot={false}
                        >
                          {check.status === 'pass' ? '通过' : check.status === 'warn' ? '提醒' : '阻断'}
                        </Badge>
                      </div>
                      <p className="mt-0.5 text-[10px] leading-4 text-faint">{check.description}</p>
                      {check.detail ? (
                        <p
                          className={cn(
                            'mt-1 text-[10px] leading-[17px]',
                            check.status === 'fail'
                              ? 'text-danger'
                              : check.status === 'warn'
                                ? 'text-warn'
                                : 'text-muted',
                          )}
                        >
                          {check.detail}
                        </p>
                      ) : null}
                    </div>
                    {href ? (
                      <Link to={href} className={buttonStyles({ variant: 'ghost', size: 'sm', className: 'shrink-0' })}>
                        {ACTION_LINK[check.action].label} <ArrowRight size={10} />
                      </Link>
                    ) : null}
                  </div>
                );
              })}
            </div>
          </Panel>

          <Panel>
            <PanelHeader
              title="声明与证据"
              description="审核不会相信文案本身，只相信可追溯的事实。"
              actions={
                <Link to={`/projects/${project.id}/knowledge`} className="text-[10.5px] text-muted hover:text-accent">
                  知识中心 →
                </Link>
              }
            />
            <div className="border-t border-line p-4">
              {relatedFeatures.length === 0 ? (
                <div className="text-[11px] text-faint">没有关联功能。</div>
              ) : (
                <div className="space-y-3">
                  {relatedFeatures.map((feature) => {
                    const featureClaims = relatedClaims.filter((claim) => claim.featureId === feature.id);
                    return (
                      <div key={feature.id} className="rounded-md border border-line bg-raised/20 p-3">
                        <div className="flex flex-wrap items-center gap-2">
                          <span className="text-[11.5px] font-medium text-fg">{feature.name}</span>
                          <FeatureStatusBadge status={feature.status} />
                        </div>
                        <div className="mt-2 space-y-1.5">
                          {featureClaims.map((claim) => {
                            const claimEvidence = evidence.filter((item) => item.claimId === claim.id);
                            return (
                              <div key={claim.id} className="flex flex-wrap items-start gap-1.5 text-[10px]">
                                <ClaimStatusBadge status={claim.status} />
                                <span className="min-w-0 flex-1 leading-4 text-muted">{claim.statement}</span>
                                <span className="shrink-0 text-[9px] text-faint">{claimEvidence.length} 条证据</span>
                              </div>
                            );
                          })}
                          {featureClaims.length === 0 ? (
                            <div className="text-[9.5px] text-warn">没有声明引用。</div>
                          ) : null}
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
              {riskyClaims.length > 0 ? (
                <Callout tone="danger" size="sm" className="mt-3" title={`${riskyClaims.length} 条声明仍需处理`}>
                  待验证声明只有保留限定表述才能通过；过期或未通过声明会阻断发布。审核不会修改知识状态。
                </Callout>
              ) : (
                <div className="mt-3 flex items-center gap-2 rounded-sm border border-success/20 bg-success-soft/30 px-2.5 py-2 text-[10px] text-success">
                  <Check size={11} /> 所有引用的声明都已核验。
                </div>
              )}
            </div>
          </Panel>

          <Panel>
            <PanelHeader
              title="导出"
              description="媒体格式只模拟任务状态；JSON / SRT 是真实可下载文件。"
              actions={
                exportUnlocked ? (
                  <Badge tone="success" dot={false}>已解锁</Badge>
                ) : (
                  <Badge tone="warn" dot={false}>需先批准</Badge>
                )
              }
            />
            <div className="border-t border-line p-4">
              {!exportUnlocked ? (
                <div className="mb-3 flex flex-wrap items-center justify-between gap-2 rounded-md border border-line bg-raised/30 px-3 py-2.5">
                  <div className="text-[10.5px] text-muted">
                    {bundle.canApprove
                      ? '工程检查已通过，批准后即可导出。'
                      : '仍有阻断项。修复并通过审核后才能导出。'}
                  </div>
                  {bundle.canApprove ? (
                    <Button
                      variant="secondary"
                      size="sm"
                      onClick={() => { setApproveNote(''); setApproveOpen(true); }}
                    >
                      去批准
                    </Button>
                  ) : (
                    <Link to={`/videos/${video.id}/production`} className={buttonStyles({ variant: 'ghost', size: 'sm' })}>
                      处理阻断 <ArrowRight size={10} />
                    </Link>
                  )}
                </div>
              ) : null}

              <div className="grid gap-2 sm:grid-cols-2">
                {(Object.keys(FORMAT_INFO) as ExportFormat[]).map((value) => {
                  const info = FORMAT_INFO[value];
                  const Icon = info.icon;
                  const selected = format === value;
                  return (
                    <button
                      key={value}
                      type="button"
                      onClick={() => setFormat(value)}
                      className={cn(
                        'rounded-md border p-3 text-left transition-colors',
                        selected ? 'border-accent/45 bg-accent-soft/25' : 'border-line hover:border-line-strong',
                      )}
                    >
                      <div className="flex items-center gap-2">
                        <Icon size={14} className={selected ? 'text-accent' : 'text-faint'} />
                        <span className="text-[11.5px] font-medium text-fg">{info.label}</span>
                        <Badge tone={info.simulated ? 'warn' : 'success'} dot={false} className="ml-auto">
                          {info.simulated ? '模拟' : '真实文件'}
                        </Badge>
                      </div>
                      <p className="mt-1 text-[9.5px] leading-4 text-faint">{info.detail}</p>
                    </button>
                  );
                })}
              </div>

              <div className="mt-3 flex flex-wrap items-end gap-3">
                <div>
                  <div className="mb-1 text-[10px] text-faint">分辨率</div>
                  <div className="flex gap-1">
                    {resolutions.map((value) => (
                      <button
                        key={value}
                        type="button"
                        onClick={() => setResolution(value)}
                        className={cn(
                          'rounded-sm border px-2 py-1 font-mono text-[9.5px]',
                          resolution === value
                            ? 'border-accent/40 bg-accent-soft text-accent'
                            : 'border-line text-faint',
                        )}
                      >
                        {value}
                      </button>
                    ))}
                  </div>
                </div>
                <div>
                  <div className="mb-1 text-[10px] text-faint">画幅</div>
                  <div className="rounded-sm border border-line px-2 py-1 font-mono text-[9.5px] text-muted">
                    {video.brief.aspect}
                  </div>
                </div>
                <Button
                  variant="primary"
                  size="sm"
                  className="ml-auto"
                  disabled={!exportUnlocked}
                  onClick={handleExport}
                  icon={<Download size={12} />}
                >
                  开始导出
                </Button>
              </div>

              {formatInfo.simulated ? (
                <div className="mt-3 flex items-start gap-1.5 rounded-sm border border-warn/25 bg-warn-soft/20 px-2.5 py-2 text-[9px] leading-4 text-warn">
                  <Info size={10} className="mt-0.5 shrink-0" />
                  不会生成 MP4/WebM，不会上传存储，也不会提供下载按钮。任务完成后只保留一条模拟记录。
                </div>
              ) : (
                <div className="mt-3 flex items-start gap-1.5 rounded-sm border border-success/25 bg-success-soft/20 px-2.5 py-2 text-[9px] leading-4 text-success">
                  <Download size={10} className="mt-0.5 shrink-0" />
                  文件在浏览器本地生成并立即下载，不经过服务器。JSON 包含镜头、Brief、声明与证据快照。
                </div>
              )}
            </div>
          </Panel>

          {exports.length > 0 ? (
            <Panel>
              <PanelHeader
                title="导出记录"
                description="本项目的本地导出历史。"
                actions={<Badge tone="outline" dot={false}>{exports.length}</Badge>}
              />
              <div className="divide-y divide-line border-t border-line">
                {exports.map((record) => {
                  const info = FORMAT_INFO[record.format];
                  const Icon = info.icon;
                  return (
                    <div key={record.id} className="flex items-start gap-3 px-4 py-3">
                      <span className="mt-0.5 grid size-7 shrink-0 place-items-center rounded-sm border border-line bg-overlay text-faint">
                        <Icon size={13} />
                      </span>
                      <div className="min-w-0 flex-1">
                        <div className="flex flex-wrap items-center gap-2">
                          <span className="text-[11px] font-medium text-fg">{info.label}</span>
                          <ExportStatusBadge status={record.status} />
                          {record.simulated ? (
                            <Badge tone="outline" dot={false}>无文件</Badge>
                          ) : (
                            <Badge tone="success" dot={false}>可下载</Badge>
                          )}
                        </div>
                        <div className="mt-0.5 text-[9px] text-faint">
                          {record.resolution} · {record.aspect} · {formatRelativeTime(record.createdAt)}
                        </div>
                        {record.status === 'processing' ? (
                          <div className="mt-1.5 max-w-[280px]">
                            <ProgressBar value={record.progress} size="sm" animated />
                          </div>
                        ) : null}
                        {record.note ? <div className="mt-1 text-[9px] leading-4 text-faint">{record.note}</div> : null}
                      </div>
                      {!record.simulated && record.status === 'completed' ? (
                        <Button
                          variant="ghost"
                          size="sm"
                          icon={<Download size={11} />}
                          onClick={() => {
                            const fileName = downloadRealFile(record.format === 'json' ? 'json' : 'srt');
                            pushToast({ tone: 'success', title: '已重新下载', description: fileName });
                          }}
                        >
                          重新下载
                        </Button>
                      ) : null}
                    </div>
                  );
                })}
              </div>
            </Panel>
          ) : null}
        </div>

        <div className="space-y-3">
          <Panel>
            <PanelHeader title="审核决定" description="决定绑定当前工程版本。" />
            <div className="space-y-3 p-4">
              {approved ? (
                <div className="rounded-md border border-success/25 bg-success-soft/30 px-3 py-2.5">
                  <div className="flex items-center gap-2 text-[11px] font-medium text-success">
                    <ShieldCheck size={13} /> 已批准
                  </div>
                  <div className="mt-1 text-[9.5px] leading-4 text-faint">
                    {video.review?.decidedAt ? formatRelativeTime(video.review.decidedAt) : ''}
                    {video.review?.note ? ` · ${video.review.note}` : ' · 未填写审核备注'}
                  </div>
                </div>
              ) : video.review?.status === 'changes_requested' ? (
                <div className="rounded-md border border-warn/25 bg-warn-soft/30 px-3 py-2.5">
                  <div className="flex items-center gap-2 text-[11px] font-medium text-warn">
                    <RefreshCw size={12} /> 已退回修改
                  </div>
                  <p className="mt-1 text-[9.5px] leading-4 text-faint">{video.review.note}</p>
                </div>
              ) : (
                <div className="rounded-md border border-line bg-raised/30 px-3 py-2.5 text-[10px] leading-4 text-muted">
                  审核尚未做出决定。批准不会触发导出或发布，只是解锁导出。
                </div>
              )}

              <div className="space-y-1 text-[9.5px] text-faint">
                <div className="flex justify-between"><span>脚本版本</span><span className="font-mono text-muted">v{video.scriptVersion}</span></div>
                <div className="flex justify-between"><span>生产版本</span><span className="font-mono text-muted">{video.producedAt ? formatRelativeTime(video.producedAt) : '尚未生产'}</span></div>
                <div className="flex justify-between"><span>当前阶段</span><span className="text-muted">{video.stage}</span></div>
              </div>

              <Button
                variant="primary"
                className="w-full"
                disabled={!bundle.canApprove || approved}
                onClick={() => { setApproveNote(''); setApproveOpen(true); }}
                icon={<ShieldCheck size={13} />}
              >
                {approved ? '当前版本已批准' : '批准当前版本'}
              </Button>
              <Button
                variant="secondary"
                className="w-full"
                onClick={() => { setChangesNote(''); setChangesOpen(true); }}
              >
                请求修改
              </Button>
              {!bundle.canApprove ? (
                <p className="text-[9px] leading-4 text-danger">
                  还有 {failCount} 项阻断。批准按钮保持禁用，避免绕过事实与生产校验。
                </p>
              ) : null}
            </div>
          </Panel>

          <Panel>
            <PanelHeader title="生产上下文" description="审核必须绑定一次成功运行。" />
            <div className="space-y-2 px-4 pb-4">
              {latestSuccess ? (
                <>
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-[10px] text-faint">最近成功</span>
                    <RunStatusBadge status={latestSuccess.status} />
                  </div>
                  <div className="text-[9.5px] leading-4 text-faint">
                    {latestSuccess.input.sceneCount} 镜 / {latestSuccess.input.durationSec}s ·{' '}
                    {latestSuccess.finishedAt ? formatRelativeTime(latestSuccess.finishedAt) : ''}
                  </div>
                  <div className="font-mono text-[8.5px] text-faint">{latestSuccess.id}</div>
                </>
              ) : (
                <div className="rounded-sm border border-danger/20 bg-danger-soft/25 px-2.5 py-2 text-[9.5px] leading-4 text-danger">
                  还没有成功运行。审核会阻断。
                </div>
              )}
              {latestRun && latestRun.status === 'failed' && latestSuccess ? (
                <div className="text-[9px] leading-4 text-warn">
                  最近一次尝试失败，仍沿用更早的成功版本。建议先去生产监控重试。
                </div>
              ) : null}
              <Link
                to={`/videos/${video.id}/production`}
                className={buttonStyles({ variant: 'ghost', size: 'sm', className: 'w-full' })}
              >
                查看生产日志 <ArrowRight size={10} />
              </Link>
            </div>
          </Panel>

          <Panel>
            <PanelHeader title="交付边界" />
            <div className="space-y-2 px-4 pb-4 text-[9.5px] leading-4 text-muted">
              <p className="flex gap-2"><Check size={10} className="mt-0.5 shrink-0 text-success" /> 项目 JSON 与 SRT 为真实文件。</p>
              <p className="flex gap-2"><Check size={10} className="mt-0.5 shrink-0 text-success" /> 审批、版本失效与证据阻断会落盘。</p>
              <p className="flex gap-2"><CircleAlert size={10} className="mt-0.5 shrink-0 text-warn" /> 媒体导出是模拟状态，不会产生视频文件。</p>
              <p className="flex gap-2"><CircleAlert size={10} className="mt-0.5 shrink-0 text-warn" /> 没有真实发布、上传或 CDN 分发。</p>
            </div>
          </Panel>

          <Panel>
            <PanelHeader title="工程数据" />
            <div className="space-y-1.5 px-4 pb-4 text-[9.5px] text-faint">
              <div className="flex justify-between"><span>视频 ID</span><span className="font-mono">{video.id}</span></div>
              <div className="flex justify-between"><span>项目</span><span className="truncate text-muted">{project.name}</span></div>
              <div className="flex justify-between"><span>镜头</span><span className="font-mono text-muted">{scenes.length}</span></div>
              <div className="flex justify-between"><span>审核检查</span><span className="font-mono text-muted">{bundle.checks.length}</span></div>
            </div>
          </Panel>
        </div>
      </div>

      <Dialog open={approveOpen} onOpenChange={setApproveOpen}>
        <DialogContent
          title="批准当前视频版本？"
          description="批准会锁定当前脚本版本与生产记录，并解锁导出。"
          size="sm"
          footer={
            <>
              <Button variant="ghost" onClick={() => setApproveOpen(false)}>取消</Button>
              <Button
                variant="primary"
                onClick={() => {
                  const result = approveVideo(video.id, approveNote.trim() || undefined);
                  setApproveOpen(false);
                  pushToast({
                    tone: result.ok ? 'success' : 'danger',
                    title: result.ok ? '审核已通过' : '无法批准',
                    description: result.message,
                  });
                }}
              >
                确认批准
              </Button>
            </>
          }
        >
          <div className="space-y-3">
            <div className="grid grid-cols-3 gap-2">
              <MiniCount label="通过" value={passCount} tone="success" />
              <MiniCount label="提醒" value={warnCount} tone="warn" />
              <MiniCount label="阻断" value={failCount} tone="danger" />
            </div>
            {warnCount > 0 ? (
              <Callout tone="warning" size="sm" title={`${warnCount} 条提醒会被记录`}>
                提醒不会阻止批准，但会作为审核上下文保留。
              </Callout>
            ) : null}
            <Field label="审核备注" optional>
              <Textarea
                value={approveNote}
                placeholder="例如：对外可用，已确认没有客户数据。"
                className="min-h-[64px]"
                onChange={(event) => setApproveNote(event.target.value)}
              />
            </Field>
            <p className="text-[9px] leading-4 text-faint">
              批准后修改工程、品牌或知识都会使审核失效，需要重新生产并审核。
            </p>
          </div>
        </DialogContent>
      </Dialog>

      <Dialog open={changesOpen} onOpenChange={setChangesOpen}>
        <DialogContent
          title="请求修改"
          description="说明需要改什么；视频会回到待修改，修改后需重新生产。"
          size="sm"
          footer={
            <>
              <Button variant="ghost" onClick={() => setChangesOpen(false)}>取消</Button>
              <Button
                variant="primary"
                disabled={!changesNote.trim()}
                onClick={() => {
                  const result = requestVideoChanges(video.id, changesNote.trim());
                  setChangesOpen(false);
                  pushToast({
                    tone: result.ok ? 'info' : 'danger',
                    title: result.ok ? '已退回修改' : '无法提交',
                    description: result.message,
                  });
                }}
              >
                提交修改意见
              </Button>
            </>
          }
        >
          <Field label="需要修改的内容" required>
            <Textarea
              value={changesNote}
              placeholder="例如：第 3 镜的转化率说法缺少限定词，需核对证据后重写字幕。"
              className="min-h-[90px]"
              onChange={(event) => setChangesNote(event.target.value)}
            />
          </Field>
          <p className="mt-2 text-[9px] leading-4 text-faint">
            修改意见会写入工程并显示在这里；不会发送通知或创建外部任务。
          </p>
        </DialogContent>
      </Dialog>
    </Page>
  );
}

function Count({ label, value, tone }: { label: string; value: number; tone: 'success' | 'warn' | 'danger' }) {
  const color = tone === 'success' ? 'text-success' : tone === 'warn' ? 'text-warn' : 'text-danger';
  return (
    <div className="w-12">
      <div className={cn('font-display text-[17px] leading-5', color)}>{value}</div>
      <div className="text-[8.5px] text-faint">{label}</div>
    </div>
  );
}

function MiniCount({ label, value, tone }: { label: string; value: number; tone: 'success' | 'warn' | 'danger' }) {
  return (
    <div className="rounded-sm border border-line bg-raised/30 px-2 py-2 text-center">
      <div
        className={cn(
          'font-display text-[16px]',
          tone === 'success' ? 'text-success' : tone === 'warn' ? 'text-warn' : 'text-danger',
        )}
      >
        {value}
      </div>
      <div className="text-[8.5px] text-faint">{label}</div>
    </div>
  );
}
