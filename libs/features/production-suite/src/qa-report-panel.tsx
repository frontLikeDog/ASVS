import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import type { QaCategory, QaFindingV1, QaReportResponse } from '@asvs/ports';
import {
  AlertTriangle,
  ArrowUpRight,
  Ban,
  CheckCircle2,
  Clock3,
  FileSearch,
  Fingerprint,
  Image as ImageIcon,
  Info,
  ScanSearch,
  ShieldAlert,
  ShieldCheck,
  XCircle,
} from 'lucide-react';
import { Badge, Callout, Panel, PanelHeader, buttonStyles, cn } from '@asvs/ui';
import { getOrchestrationClient, useWorkspaceSyncStore } from '@asvs/state';
import { formatDurationMs, shortSha } from './orchestration-format';
import type { QaGate } from './qa-gate';

/**
 * Gate 3 · independent QA report (docs/16 §7D).
 *
 * Loaded through `React.lazy(() => import('./qa-report-panel'))` from the
 * review page: this renderer, the finding taxonomy and the evidence previews
 * must not enter the `review` route's static import closure (22 kB gzip
 * budget, docs/16 red line 1). The gate *state* lives in `qa-gate.ts`, which
 * the review page uses directly so the approve buttons can be disabled even
 * if this chunk never loads.
 *
 * Output rules enforced here:
 * - only `matchRedacted` is ever rendered — the API does not send a raw match,
 *   and this component never asks for one;
 * - an unexecuted OCR is never presented as a pass: `ocrExecuted: false` gets
 *   an explicit warning badge;
 * - an evidence preview points at a registered `qa_evidence_frame`, which the
 *   server already blurred before registering, so the page cannot re-leak the
 *   raw secret.
 */

const VERDICT_META = {
  pass: { label: '通过', tone: 'success' as const, icon: CheckCircle2 },
  pass_with_warnings: { label: '通过 · 有提醒', tone: 'warn' as const, icon: AlertTriangle },
  fail: { label: '已阻断', tone: 'danger' as const, icon: XCircle },
} as const;

const CATEGORY_META: Record<QaCategory, { label: string; icon: typeof ShieldCheck }> = {
  privacy: { label: '隐私守门（AC-07）', icon: ShieldAlert },
  technical: { label: '技术质量', icon: ScanSearch },
  fact: { label: '事实一致性', icon: FileSearch },
  content: { label: '内容合规', icon: Info },
};

const SEVERITY_TONE = {
  blocker: 'danger',
  warning: 'warn',
  info: 'neutral',
} as const;

const SEVERITY_LABEL = {
  blocker: '阻断',
  warning: '提醒',
  info: '信息',
} as const;

const OCR_LABEL = {
  tesseract_cli: 'Tesseract OCR',
  deterministic_test: '测试 OCR',
  unconfigured: '未配置 OCR',
} as const;

export interface QaReportPanelProps {
  videoId: string;
  /** Current script version; a report for another version is `已过期`. */
  currentScriptVersion: number;
  gate: QaGate;
}

export default function QaReportPanel({ videoId, currentScriptVersion, gate }: QaReportPanelProps) {
  if (gate.status === 'loading') {
    return (
      <Panel>
        <div className="flex items-center gap-2 p-4 text-[10.5px] text-faint">
          <ShieldCheck size={12} className="animate-pulse" /> 正在读取服务端独立 QA 报告…
        </div>
      </Panel>
    );
  }

  if (gate.status === 'unavailable') {
    return (
      <Callout tone="info" size="sm" title="当前未连接服务端独立 QA">
        上方检查只覆盖浏览器内的文案模拟扫描，不含录屏帧 / 断言截图 / Playwright trace
        的隐私扫描。连接本机服务端并完成一次生产后，这里会显示 AC-07 隐私守门与技术 / 事实 /
        内容复核的真实结论。
      </Callout>
    );
  }

  if (gate.status === 'empty') {
    return (
      <Callout
        tone="warning"
        size="sm"
        title="该视频还没有服务端独立 QA 报告"
        action={
          <Link
            to={`/videos/${videoId}/production`}
            className={buttonStyles({ variant: 'ghost', size: 'sm' })}
          >
            去生产 <ArrowUpRight size={10} />
          </Link>
        }
      >
        交付包要求一次 <span className="font-mono">qa_final</span> 通过的运行；否则服务端会以{' '}
        <span className="font-mono">409 export_qa_missing</span> 拒绝导出。
      </Callout>
    );
  }

  if (gate.status === 'error' || !gate.envelope) {
    return (
      <Callout tone="danger" size="sm" title="无法读取 QA 报告">
        {gate.error ?? '服务端返回了无法解析的报告。'} 报告文件可能已被篡改或清理；服务端会以{' '}
        <span className="font-mono">409 qa_report_tampered</span> 拒绝导出，直到重新运行 QA。
      </Callout>
    );
  }

  return (
    <QaReportBody
      envelope={gate.envelope}
      currentScriptVersion={currentScriptVersion}
      videoId={videoId}
    />
  );
}

function QaReportBody({
  envelope,
  currentScriptVersion,
  videoId,
}: {
  envelope: QaReportResponse;
  currentScriptVersion: number;
  videoId: string;
}) {
  const { report, run, evidenceArtifacts } = envelope;
  const verdict = VERDICT_META[report.verdict];
  const VerdictIcon = verdict.icon;
  const blocked = report.verdict === 'fail';
  const stale = report.subject.scriptVersion !== currentScriptVersion;
  const evidenceByFinding = useMemo(() => {
    const map = new Map<string, { id: string; fileName: string; byteSize: number }>();
    for (const artifact of evidenceArtifacts) {
      const findingId = artifact.metadata.findingId;
      if (typeof findingId === 'string') map.set(findingId, artifact);
    }
    return map;
  }, [evidenceArtifacts]);

  return (
    <Panel
      className={cn(
        blocked && 'border-danger/40',
        !blocked && report.verdict === 'pass_with_warnings' && 'border-warn/35',
      )}
    >
      <PanelHeader
        title="独立 QA 报告"
        description={`由服务端在${report.stage === 'final' ? '成片完成' : '录屏完成'}后独立执行；AC-07 隐私命中会直接阻断运行与导出。`}
        actions={
          <Badge tone={verdict.tone} dot={false}>
            <VerdictIcon size={9} className="mr-1" />
            {verdict.label}
          </Badge>
        }
      />
      <div className="space-y-3 border-t border-line p-4">
        <div className="flex flex-wrap items-center gap-2">
          <Badge tone="outline" dot={false}>
            {report.stage === 'final' ? '成片独立 QA' : '录屏前置 QA（AC-07）'}
          </Badge>
          <Badge tone="outline" dot={false}>
            脚本 v{report.subject.scriptVersion}
          </Badge>
          {stale ? (
            <Badge tone="warn" dot={false}>
              <Clock3 size={9} className="mr-1" />
              已过期 · 当前 v{currentScriptVersion}
            </Badge>
          ) : null}
          {report.coverage.ocrSynthetic ? (
            <Badge tone="warn" dot={false}>
              测试 OCR · 非真实识别
            </Badge>
          ) : null}
          {!report.coverage.ocrExecuted ? (
            <Badge tone="warn" dot={false}>
              OCR 未执行
            </Badge>
          ) : null}
          <span className="font-mono text-[9px] text-faint">{report.reportId}</span>
          <span className="ml-auto font-mono text-[9px] text-faint">run {run.id}</span>
        </div>

        <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
          <Stat
            label="阻断"
            value={report.summary.blockerCount}
            tone={report.summary.blockerCount > 0 ? 'danger' : 'muted'}
          />
          <Stat
            label="提醒"
            value={report.summary.warningCount}
            tone={report.summary.warningCount > 0 ? 'warn' : 'muted'}
          />
          <Stat
            label="AC-07 隐私阻断"
            value={report.summary.privacyBlockerCount}
            tone={report.summary.privacyBlockerCount > 0 ? 'danger' : 'muted'}
          />
          <Stat label="检查耗时" value={`${(report.durationMs / 1000).toFixed(1)}s`} tone="muted" />
        </div>

        <div className="flex flex-wrap gap-x-4 gap-y-1 rounded-sm border border-line bg-raised/20 px-2.5 py-2 text-[9px] text-faint">
          <span>
            录屏帧 <span className="font-mono text-muted">{report.coverage.scannedCaptureFrames}</span>
          </span>
          <span>
            成片帧 <span className="font-mono text-muted">{report.coverage.scannedRenderFrames}</span>
          </span>
          <span>
            截图 <span className="font-mono text-muted">{report.coverage.scannedScreenshots}</span>
          </span>
          <span>
            Trace 条目{' '}
            <span className="font-mono text-muted">{report.coverage.scannedTraceEntries}</span>
          </span>
          <span>
            镜头 <span className="font-mono text-muted">{report.coverage.scannedScenes}</span>
          </span>
          <span>
            SRT 字幕 <span className="font-mono text-muted">{report.coverage.scannedSrtCues}</span>
          </span>
          <span>
            OCR{' '}
            <span className="font-mono text-muted">{OCR_LABEL[report.coverage.ocrProvider]}</span>
          </span>
        </div>

        <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
          {report.checks.map((check) => {
            const meta = CATEGORY_META[check.category];
            const Icon = meta.icon;
            const tone =
              check.status === 'fail'
                ? 'text-danger'
                : check.status === 'warn'
                  ? 'text-warn'
                  : 'text-success';
            return (
              <div key={check.category} className="rounded-sm border border-line px-2.5 py-2">
                <div className="flex items-center gap-1.5">
                  <Icon size={11} className={tone} />
                  <span className="text-[10px] font-medium text-fg">{meta.label}</span>
                  <span className="ml-auto font-mono text-[9px] text-faint">
                    {check.blockerCount + check.warningCount + check.infoCount} 项
                  </span>
                </div>
                <div className="mt-0.5 text-[9px] leading-4 text-faint">{check.summary}</div>
              </div>
            );
          })}
        </div>

        {blocked ? (
          <Callout tone="danger" size="sm" title="独立 QA 已阻断：修复后重新运行">
            {report.summary.privacyBlockerCount > 0
              ? `其中 ${report.summary.privacyBlockerCount} 项为 AC-07 隐私命中；`
              : ''}
            阻断项已冻结本次运行：批准与导出在 <span className="font-mono">qa_final</span>{' '}
            通过前都不可用。报告只保留脱敏片段与 SHA256，原始命中值不会出现在本页。
          </Callout>
        ) : null}

        {report.findings.length === 0 ? (
          <div className="flex items-center gap-2 rounded-sm border border-success/25 bg-success-soft/15 px-2.5 py-2 text-[9.5px] text-success">
            <ShieldCheck size={12} /> 四个维度均未发现问题；报告已写入交付包，哈希绑定本次产物。
          </div>
        ) : (
          <FindingGroups report={report} evidenceByFinding={evidenceByFinding} videoId={videoId} />
        )}

        <div className="flex flex-wrap gap-x-4 gap-y-0.5 font-mono text-[8.5px] text-faint">
          <span>policy {report.policyVersion}</span>
          {report.subject.mp4Sha256 ? (
            <span>mp4 {shortSha(report.subject.mp4Sha256, 16)}</span>
          ) : null}
          {report.subject.srtSha256 ? (
            <span>srt {shortSha(report.subject.srtSha256, 16)}</span>
          ) : null}
          {report.subject.manifestSha256 ? (
            <span>manifest {shortSha(report.subject.manifestSha256, 16)}</span>
          ) : null}
        </div>
      </div>
    </Panel>
  );
}

function Stat({
  label,
  value,
  tone,
}: {
  label: string;
  value: number | string;
  tone: 'danger' | 'warn' | 'muted';
}) {
  const color = tone === 'danger' ? 'text-danger' : tone === 'warn' ? 'text-warn' : 'text-muted';
  return (
    <div className="rounded-sm border border-line px-2 py-1.5">
      <div className="text-[8.5px] uppercase tracking-wide text-faint">{label}</div>
      <div className={cn('font-mono text-[14px]', color)}>{value}</div>
    </div>
  );
}

function FindingGroups({
  report,
  evidenceByFinding,
  videoId,
}: {
  report: QaReportResponse['report'];
  evidenceByFinding: Map<string, { id: string; fileName: string; byteSize: number }>;
  videoId: string;
}) {
  // Group by scene so the reviewer fixes a shot, not a flat list of rows.
  const groups = useMemo(() => {
    const map = new Map<
      string,
      { key: string; title: string; order: number | null; findings: QaFindingV1[] }
    >();
    for (const finding of report.findings) {
      const key = finding.location.sceneId ?? '__global__';
      const existing = map.get(key);
      if (existing) {
        existing.findings.push(finding);
        continue;
      }
      map.set(key, {
        key,
        title:
          finding.location.sceneTitle ??
          (finding.location.sceneOrder !== undefined
            ? `第 ${finding.location.sceneOrder + 1} 镜`
            : finding.location.scope === 'global'
              ? '全局 / 产物级'
              : '未映射到镜头'),
        order: finding.location.sceneOrder ?? null,
        findings: [finding],
      });
    }
    return [...map.values()].sort((a, b) => (a.order ?? 99) - (b.order ?? 99));
  }, [report.findings]);

  return (
    <div className="space-y-2">
      {groups.map((group) => (
        <div key={group.key} className="rounded-sm border border-line">
          <div className="flex flex-wrap items-center gap-2 border-b border-line bg-raised/25 px-2.5 py-1.5">
            {group.order !== null ? (
              <Badge tone="outline" dot={false}>
                第 {group.order + 1} 镜
              </Badge>
            ) : (
              <Badge tone="outline" dot={false}>
                全局
              </Badge>
            )}
            <span className="text-[10px] text-fg">{group.title}</span>
            <span className="text-[9px] text-faint">{group.findings.length} 项</span>
            {group.key !== '__global__' ? (
              <Link
                to={`/videos/${videoId}/editor?scene=${encodeURIComponent(group.key)}`}
                className={buttonStyles({ variant: 'ghost', size: 'sm', className: 'ml-auto' })}
              >
                定位到第 {(group.order ?? 0) + 1} 镜 <ArrowUpRight size={10} />
              </Link>
            ) : null}
          </div>
          <div className="divide-y divide-line">
            {group.findings.map((finding) => (
              <FindingRow
                key={finding.id}
                finding={finding}
                evidence={evidenceByFinding.get(finding.id) ?? null}
              />
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}

function FindingRow({
  finding,
  evidence,
}: {
  finding: QaFindingV1;
  evidence: { id: string; fileName: string; byteSize: number } | null;
}) {
  const tone = SEVERITY_TONE[finding.severity];
  const Icon =
    finding.severity === 'blocker' ? Ban : finding.severity === 'warning' ? AlertTriangle : Info;
  return (
    <div className="flex gap-2 px-2.5 py-2">
      <Icon
        size={12}
        className={cn(
          'mt-0.5 shrink-0',
          tone === 'danger' ? 'text-danger' : tone === 'warn' ? 'text-warn' : 'text-faint',
        )}
      />
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-1.5">
          <Badge tone={tone} dot={false}>
            {SEVERITY_LABEL[finding.severity]}
          </Badge>
          <span className="font-mono text-[9px] text-faint">{finding.ruleId}</span>
          <span className="text-[10px] font-medium text-fg">{finding.title}</span>
        </div>
        <div className="mt-0.5 text-[9px] leading-4 text-muted">{finding.message}</div>
        <div className="mt-1 flex flex-wrap gap-x-3 gap-y-0.5 text-[8.5px] text-faint">
          <span>
            来源 <span className="font-mono text-muted">{finding.sourceKind}</span>
          </span>
          {finding.location.timestampMs !== undefined ? (
            <span>
              位置{' '}
              <span className="font-mono text-muted">
                {formatDurationMs(finding.location.timestampMs)}
              </span>
            </span>
          ) : null}
          {finding.location.stepId ? (
            <span>
              步骤 <span className="font-mono text-muted">{finding.location.stepId}</span>
            </span>
          ) : null}
          {finding.location.traceEntryPath ? (
            <span className="font-mono text-muted">{finding.location.traceEntryPath}</span>
          ) : null}
          {finding.matchRedacted ? (
            <span className="inline-flex items-center gap-1">
              <Fingerprint size={9} />
              脱敏片段 <span className="font-mono text-muted">{finding.matchRedacted}</span>
            </span>
          ) : null}
          {finding.matchSha256 ? (
            <span className="font-mono">match {shortSha(finding.matchSha256, 12)}</span>
          ) : null}
        </div>
        <div className="mt-0.5 text-[8.5px] leading-4 text-faint">修复建议：{finding.remediation}</div>
        {evidence ? (
          <EvidencePreview
            artifactId={evidence.id}
            fileName={evidence.fileName}
            byteSize={evidence.byteSize}
          />
        ) : null}
      </div>
    </div>
  );
}

/**
 * Server-blurred evidence preview. The bytes come from the registered
 * `qa_evidence_frame` artifact through `?inline=1`, so what the reviewer sees
 * is exactly what the server decided was safe to expose — this component never
 * derives a frame itself.
 */
function EvidencePreview({
  artifactId,
  fileName,
  byteSize,
}: {
  artifactId: string;
  fileName: string;
  byteSize: number;
}) {
  const syncConfig = useWorkspaceSyncStore((state) => state.config);
  const [url, setUrl] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const client = await getOrchestrationClient(syncConfig.baseUrl);
        if (!cancelled) setUrl(client.artifactInlineUrl(syncConfig.workspaceId, artifactId));
      } catch {
        if (!cancelled) setFailed(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [syncConfig.baseUrl, syncConfig.workspaceId, artifactId]);

  if (failed) return null;
  return (
    <div className="mt-1.5 flex items-center gap-2">
      <div className="grid h-14 w-24 place-items-center overflow-hidden rounded-sm border border-line bg-raised/30">
        {url ? (
          <img
            src={url}
            alt={`服务端脱敏证据帧 ${fileName}`}
            className="h-full w-full object-cover"
            onError={() => setFailed(true)}
          />
        ) : (
          <ImageIcon size={16} className="text-faint" />
        )}
      </div>
      <div className="text-[8.5px] leading-4 text-faint">
        服务端已脱敏的证据帧
        <br />
        <span className="font-mono">{fileName}</span> · {(byteSize / 1024).toFixed(1)} KB
      </div>
    </div>
  );
}
