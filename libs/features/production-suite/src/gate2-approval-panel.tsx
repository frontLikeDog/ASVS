import { useEffect, useMemo, useState } from 'react';
import type {
  DemoPlanDraftV1,
  DemoPlanRiskLevel,
  DemoPlanTemplateId,
  OrchestrationArtifactV1,
  OrchestrationRunV1,
} from '@asvs/domain';
import {
  AlertTriangle,
  CheckCircle2,
  Download,
  FileJson,
  FileText,
  Film,
  Image as ImageIcon,
  Loader2,
  ShieldAlert,
  ShieldCheck,
  XCircle,
} from 'lucide-react';
import {
  Badge,
  Button,
  Field,
  Input,
  Panel,
  PanelHeader,
  Select,
  Textarea,
  cn,
} from '@asvs/ui';
import { getOrchestrationClient } from '@asvs/state';
import {
  downloadVerifiedArtifact,
  formatArtifactSize,
  formatDurationMs,
  shortSha,
} from './orchestration-format';
import type { ServerOrchestrationApi } from './server-orchestration';

/**
 * Gate 2 approval card (Step 5C).
 *
 * Loaded lazily from `server-orchestration-panel.tsx` on purpose: the plan
 * table, risk checklist and evidence viewer are the largest UI in the
 * production route, and the route budget (24 kB gzip) only holds if this file
 * is its own chunk. It renders nothing while the API object is undefined, so
 * a slow chunk never shifts the layout below it.
 *
 * The card reads only from `run`/`detail`, both persisted server-side: a page
 * refresh restores the same `approvalId` + `planDigest`, and the approve call
 * sends exactly the digest displayed here. The server refuses anything else
 * (409 `approval_subject_mismatch`), so what the reviewer saw is what runs.
 */

const TEMPLATE_OPTIONS: Array<{ value: DemoPlanTemplateId; label: string; hint: string }> = [
  {
    value: 'web_studio_knowledge_claim',
    label: '4D 知识与声明验证',
    hint: '从已核验 Feature / Claim 生成：知识库 → 声明详情 → 过滤与搜索',
  },
  {
    value: 'web_studio_tour',
    label: 'web-studio 巡览',
    hint: '按项目路由巡览：工作台 → 视频库 → 分镜 → 生产监控',
  },
  {
    value: 'web_studio_route_focus',
    label: '按路由聚焦',
    hint: '只聚焦单条演示路由，最短路径、最快出片',
  },
  { value: 'custom', label: '自定义计划', hint: '审查者逐条编辑声明式步骤（仍禁止脚本/CSS）' },
];

const RISK_TONE: Record<DemoPlanRiskLevel, 'success' | 'warn' | 'danger'> = {
  low: 'success',
  medium: 'warn',
  high: 'danger',
};

const RISK_LABEL: Record<DemoPlanRiskLevel, string> = {
  low: '低风险',
  medium: '需关注',
  high: '高风险',
};

const ACTION_LABEL: Record<string, string> = {
  navigate: '打开',
  click: '点击',
  fill: '填写',
  press: '按键',
  wait_for: '等待',
  assert: '断言',
  capture: '录屏',
};

const RUN_STATUS_TONE: Record<
  OrchestrationRunV1['status'],
  'neutral' | 'accent' | 'success' | 'warn' | 'danger'
> = {
  queued: 'neutral',
  running: 'accent',
  awaiting_approval: 'warn',
  succeeded: 'success',
  failed: 'danger',
  cancelled: 'neutral',
};

const RUN_STATUS_LABEL: Record<OrchestrationRunV1['status'], string> = {
  queued: '已入队',
  running: '录制/渲染中',
  awaiting_approval: '等待审批',
  succeeded: '已完成',
  failed: '失败',
  cancelled: '已取消',
};

function templateLabel(id: string): string {
  return TEMPLATE_OPTIONS.find((option) => option.value === id)?.label ?? id;
}

/** One-line human summary of a declarative step; never renders raw CSS. */
function stepSummary(step: DemoPlanDraftV1['steps'][number]): string {
  switch (step.action) {
    case 'navigate':
      return step.target ?? '—';
    case 'assert': {
      const assertion = step.assertion;
      if (!assertion) return '—';
      if (assertion.kind === 'url') return `URL ${assertion.match} ${String(assertion.expected ?? '')}`;
      const target = step.target ?? assertion.attribute ?? '';
      return `${target} · ${assertion.kind} ${assertion.match} ${String(assertion.expected ?? '')}`;
    }
    case 'capture':
      return '录制片段';
    case 'press':
      return `${step.target ?? ''} · ${step.key ?? step.value ?? ''}`;
    case 'fill':
      return `${step.target ?? ''} · ${step.valueRef ? `fixture:${step.valueRef}` : '字面值'}`;
    default:
      return step.target ?? '—';
  }
}

export interface Gate2ApprovalPanelProps {
  api: ServerOrchestrationApi;
}

/**
 * Rendered through `React.lazy`, so the parent passes a ref-like object and
 * this component is only mounted once the chunk is present.
 */
export function Gate2ApprovalPanel({ api }: Gate2ApprovalPanelProps) {
  const { run, detail, busy, captureHealth } = api;
  const [note, setNote] = useState('');
  const [rejectReason, setRejectReason] = useState('');
  const [rejecting, setRejecting] = useState(false);
  const [editing, setEditing] = useState(false);
  const [editTemplate, setEditTemplate] = useState<DemoPlanTemplateId>('web_studio_knowledge_claim');
  const [editBaseUrl, setEditBaseUrl] = useState('');
  const [editReset, setEditReset] = useState<'fixture' | 'none'>('fixture');
  const [downloading, setDownloading] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [previewId, setPreviewId] = useState<string | null>(null);

  const plan = run?.demoPlan ?? null;
  const approval = run?.approval ?? null;
  const awaiting = run?.status === 'awaiting_approval' && approval?.status === 'pending';
  const planDigest = plan?.planDigest ?? null;

  // Reset the edit form whenever a new plan arrives (a supersede changes the
  // digest, so the old form values would silently describe a different plan).
  useEffect(() => {
    if (!plan) return;
    setEditTemplate(plan.template as DemoPlanTemplateId);
    setEditBaseUrl(plan.baseUrl);
    setEditReset(plan.draft.resetStrategy);
    setEditing(false);
  }, [plan]);

  const steps = useMemo(() => plan?.draft.steps ?? [], [plan]);
  const findings = plan?.risk.findings ?? [];
  const captureFailure = run?.captureFailure ?? null;
  const captureArtifacts = useMemo(
    () => detail?.artifacts.filter((artifact) => artifact.kind.startsWith('capture_')) ?? [],
    [detail],
  );
  const successClip = captureArtifacts.find((artifact) => artifact.kind === 'capture_clip') ?? null;
  const successReceipt = captureArtifacts.find((artifact) => artifact.kind === 'capture_receipt') ?? null;
  const failureReport =
    captureArtifacts.find((artifact) => artifact.kind === 'capture_failure_report') ?? null;
  const failureTrace =
    captureArtifacts.find((artifact) => artifact.kind === 'capture_trace') ?? null;
  const failureShots = captureArtifacts.filter((artifact) => artifact.kind === 'capture_screenshot');
  const previewShot = failureShots.find((artifact) => artifact.id === previewId) ?? failureShots[0] ?? null;

  const download = async (artifact: OrchestrationArtifactV1) => {
    setDownloading(artifact.id);
    setError(null);
    try {
      const client = await getOrchestrationClient();
      await downloadVerifiedArtifact(client.artifactDownloadUrl(api.workspaceId, artifact.id), artifact);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setDownloading(null);
    }
  };

  const approve = async () => {
    await api.approve(note.trim() || undefined);
  };

  const submitEdit = async () => {
    setError(null);
    await api.editDemoPlan({
      template: editTemplate,
      ...(editBaseUrl ? { baseUrl: editBaseUrl } : {}),
      resetStrategy: editReset,
    });
    setEditing(false);
  };

  const submitReject = async () => {
    if (!rejectReason.trim()) {
      setError('驳回需要填写理由：审批记录会永久保存这条理由。');
      return;
    }
    setRejecting(true);
    setError(null);
    try {
      await api.reject(rejectReason.trim());
      setRejectReason('');
    } finally {
      setRejecting(false);
    }
  };

  if (!run) return null;
  const succeeded = run.status === 'succeeded' && successClip !== null;
  const failedCapture = captureFailure !== null;

  return (
    <Panel className="overflow-hidden">
      <PanelHeader
        title="Gate 2 · 演示计划审批与真实录屏"
        description="计划是数据不是脚本；审批绑定 planDigest，任何修改都会让旧审批失效。"
        actions={
          <div className="flex items-center gap-1.5">
            {plan ? (
              <Badge tone={RISK_TONE[plan.risk.level]} dot={false}>
                <ShieldAlert size={9} className="mr-1" />
                {RISK_LABEL[plan.risk.level]}
              </Badge>
            ) : null}
            <Badge tone={RUN_STATUS_TONE[run.status]} dot={false}>
              {run.status === 'awaiting_approval'
                ? '等待审批'
                : run.status === 'succeeded'
                  ? '已出片'
                  : RUN_STATUS_LABEL[run.status]}
            </Badge>
          </div>
        }
      />
      <div className="space-y-3 border-t border-line p-4">
        {!plan && !failedCapture ? (
          <p className="text-[10px] leading-5 text-faint">
            {run.input.capture && run.input.capture.enabled === false
              ? '本运行未启用真实录屏：plan_demo / capture_demo / qa_capture 已在创建时标记为 skipped，不会启动浏览器。'
              : captureHealth && !captureHealth.enabled
                ? '服务端未启用真实录屏（ASVS_CAPTURE_ENABLED=false）。'
                : '等待服务端生成演示计划…'}
          </p>
        ) : null}

        {plan ? (
          <>
            {/* Binding card: ids the approver is actually signing. */}
            <div className="rounded-sm border border-line bg-raised/20 p-3">
              <div className="flex flex-wrap items-center gap-1.5">
                <Badge tone="accent" dot={false}>{templateLabel(plan.template)}</Badge>
                <span className="font-mono text-[9px] text-faint">{plan.planId}</span>
                <span className="ml-auto text-[9px] text-faint">
                  策略 {plan.policyVersion}
                  {approval?.policyVersion && approval.policyVersion !== plan.policyVersion
                    ? `（审批记录为 ${approval.policyVersion}）`
                    : ''}
                </span>
              </div>
              <div className="mt-2 grid gap-x-4 gap-y-1 text-[9.5px] sm:grid-cols-2">
                <Fact label="运行" value={run.id} mono />
                <Fact label="审批 ID" value={approval?.approvalId ?? '—'} mono />
                <Fact label="计划摘要" value={planDigest ? shortSha(planDigest, 20) : '—'} mono title={planDigest ?? ''} />
                <Fact label="目标 origin" value={plan.allowedOrigins.join(' · ')} mono />
                <Fact
                  label="断言"
                  value={`${plan.risk.assertionCount} 条 · ${plan.risk.stepCount} 步 · ${plan.risk.originCount} 个 origin`}
                />
                <Fact
                  label="写操作范围"
                  value={
                    plan.risk.writeScope === 'none'
                      ? '无写操作'
                      : plan.risk.writeScope === 'local_ui_state'
                        ? '仅本地 UI 状态'
                        : '网络写入（高风险）'
                  }
                />
              </div>
            </div>

            {/* Risk checklist */}
            <div>
              <div className="mb-1 flex items-center justify-between text-[9px] uppercase tracking-wide text-faint">
                <span>风险清单</span>
                <span>{findings.length} 项</span>
              </div>
              {findings.length === 0 ? (
                <div className="flex items-center gap-1.5 rounded-sm border border-success/20 bg-success-soft/20 px-2.5 py-2 text-[9.5px] text-success">
                  <ShieldCheck size={11} /> 未发现风险项：单一 origin、无写操作、断言覆盖完整。
                </div>
              ) : (
                <ul className="space-y-1">
                  {findings.map((finding) => (
                    <li
                      key={`${finding.code}-${finding.stepId ?? ''}`}
                      className={cn(
                        'flex items-start gap-1.5 rounded-sm border px-2.5 py-1.5 text-[9.5px] leading-4',
                        finding.level === 'high'
                          ? 'border-danger/25 bg-danger-soft/20 text-danger'
                          : 'border-warn/25 bg-warn-soft/20 text-warn',
                      )}
                    >
                      <AlertTriangle size={10} className="mt-0.5 shrink-0" />
                      <span>
                        <span className="font-mono text-[8.5px] opacity-70">{finding.code}</span>
                        {' · '}
                        {finding.message}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </div>

            {/* Declarative step table */}
            <div>
              <div className="mb-1 flex items-center justify-between text-[9px] uppercase tracking-wide text-faint">
                <span>声明式步骤</span>
                <span>
                  {steps.filter((step) => step.action === 'assert').length} 条断言 / {steps.length} 步
                </span>
              </div>
              <div className="max-h-[220px] overflow-y-auto rounded-sm border border-line">
                <table className="w-full border-collapse text-left text-[9.5px]">
                  <thead className="sticky top-0 bg-surface text-[8.5px] uppercase tracking-wide text-faint">
                    <tr>
                      <th className="px-2 py-1 font-medium">#</th>
                      <th className="px-2 py-1 font-medium">动作</th>
                      <th className="px-2 py-1 font-medium">目标 / 断言</th>
                    </tr>
                  </thead>
                  <tbody>
                    {steps.map((step, index) => (
                      <tr key={step.id} className="border-t border-line align-top">
                        <td className="px-2 py-1 font-mono text-faint">{index + 1}</td>
                        <td className="whitespace-nowrap px-2 py-1">
                          <span
                            className={cn(
                              'font-medium',
                              step.action === 'assert' ? 'text-success' : 'text-fg',
                            )}
                          >
                            {ACTION_LABEL[step.action] ?? step.action}
                          </span>
                        </td>
                        <td className="px-2 py-1 break-all font-mono text-[9px] text-muted">
                          {stepSummary(step)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <p className="mt-1 text-[8.5px] leading-4 text-faint">
                selector 仅允许 role / heading / label / placeholder / testid / text / alt 语义前缀；CSS、XPath
                与任意脚本在打开浏览器前即被拒绝。
              </p>
            </div>

            {/* Edit / approve / reject — only while the gate is pending. */}
            {awaiting ? (
              <div className="space-y-2 rounded-sm border border-accent/25 bg-accent-soft/10 p-3">
                {editing ? (
                  <div className="grid gap-2 sm:grid-cols-3">
                    <Field label="模板">
                      <Select
                        value={editTemplate}
                        disabled={busy}
                        onChange={(event) => setEditTemplate(event.target.value as DemoPlanTemplateId)}
                      >
                        {TEMPLATE_OPTIONS.map((option) => (
                          <option key={option.value} value={option.value}>
                            {option.label}
                          </option>
                        ))}
                      </Select>
                    </Field>
                    <Field label="目标 baseUrl" hint="必须是白名单内的 origin">
                      <Input
                        value={editBaseUrl}
                        disabled={busy}
                        onChange={(event) => setEditBaseUrl(event.target.value)}
                      />
                    </Field>
                    <Field label="重置策略">
                      <Select
                        value={editReset}
                        disabled={busy}
                        onChange={(event) => setEditReset(event.target.value as 'fixture' | 'none')}
                      >
                        <option value="fixture">fixture（清空存储并重载种子）</option>
                        <option value="none">none（不重置）</option>
                      </Select>
                    </Field>
                  </div>
                ) : null}
                <Field label="审批备注" optional hint="写入审批台账，随回执长期保留">
                  <Input
                    value={note}
                    placeholder="例如：计划只读，已逐条审阅"
                    disabled={busy}
                    onChange={(event) => setNote(event.target.value)}
                  />
                </Field>
                <div className="flex flex-wrap items-center gap-2">
                  <Button
                    variant="primary"
                    size="sm"
                    icon={<ShieldCheck size={12} />}
                    disabled={busy || !planDigest}
                    onClick={() => void approve()}
                  >
                    {busy ? '正在提交…' : '批准 Gate 2 并启动录屏'}
                  </Button>
                  {editing ? (
                    <>
                      <Button variant="secondary" size="sm" disabled={busy} onClick={() => void submitEdit()}>
                        保存修改并重新审批
                      </Button>
                      <Button variant="ghost" size="sm" disabled={busy} onClick={() => setEditing(false)}>
                        取消修改
                      </Button>
                    </>
                  ) : (
                    <Button variant="secondary" size="sm" disabled={busy} onClick={() => setEditing(true)}>
                      修改计划
                    </Button>
                  )}
                  <Button
                    variant="ghost"
                    size="sm"
                    icon={<XCircle size={12} />}
                    disabled={busy || rejecting || !rejectReason.trim()}
                    onClick={() => void submitReject()}
                  >
                    驳回计划
                  </Button>
                </div>
                <Field label="驳回理由" hint="驳回是终态：运行进入 failed(approval_rejected)，需重新创建运行">
                  <Textarea
                    value={rejectReason}
                    rows={2}
                    disabled={busy || rejecting}
                    onChange={(event) => setRejectReason(event.target.value)}
                  />
                </Field>
                {editing ? (
                  <p className="flex items-start gap-1.5 text-[9px] leading-4 text-warn">
                    <AlertTriangle size={10} className="mt-0.5 shrink-0" />
                    保存后服务端会重新计算 planDigest 并作废当前审批 ID（superseded）；旧摘要不能再用于批准。
                  </p>
                ) : null}
              </div>
            ) : null}

            {approval && approval.status !== 'pending' ? (
              <div className="flex flex-wrap items-center gap-2 text-[9.5px] text-faint">
                <Badge
                  tone={approval.status === 'approved' ? 'success' : approval.status === 'rejected' ? 'danger' : 'neutral'}
                  dot={false}
                >
                  {approval.status === 'approved'
                    ? '已批准'
                    : approval.status === 'rejected'
                      ? '已驳回'
                      : '已被新审批取代'}
                </Badge>
                {approval.decidedBy ? <span>决策人 {approval.decidedBy}</span> : null}
                {approval.decisionNote ? <span>备注：{approval.decisionNote}</span> : null}
                {approval.approvedAt ? <span>{new Date(approval.approvedAt).toLocaleString('zh-CN', { hour12: false })}</span> : null}
              </div>
            ) : null}
          </>
        ) : null}

        {/* Success evidence */}
        {succeeded && successClip ? (
          <div className="rounded-sm border border-success/25 bg-success-soft/20 p-3">
            <div className="flex flex-wrap items-center gap-1.5 text-[10.5px] font-medium text-success">
              <CheckCircle2 size={12} /> 真实录屏已回填到渲染输入
            </div>
            <div className="mt-1.5 grid gap-x-4 gap-y-1 text-[9.5px] sm:grid-cols-2">
              <Fact
                label="断言"
                value={
                  run.input.capture?.assertions
                    ? `${run.input.capture.assertions.passed}/${run.input.capture.assertions.total} 通过`
                    : typeof successReceipt?.metadata.assertions === 'object'
                      ? '全部通过'
                      : '—'
                }
              />
              <Fact
                label="片段 SHA256"
                value={shortSha(String(successClip.metadata.sha256 ?? successClip.sha256), 20)}
                mono
                title={String(successClip.metadata.sha256 ?? successClip.sha256)}
              />
              <Fact
                label="时长"
                value={
                  typeof successClip.metadata.durationMs === 'number'
                    ? formatDurationMs(successClip.metadata.durationMs)
                    : typeof run.input.capture?.clipDurationMs === 'number'
                      ? formatDurationMs(run.input.capture.clipDurationMs)
                      : '—'
                }
                mono
              />
              <Fact label="素材" value={`${successClip.fileName} · ${formatArtifactSize(successClip.byteSize)}`} mono />
            </div>
            <div className="mt-2 flex flex-wrap gap-1.5">
              <Button
                variant="secondary"
                size="sm"
                icon={<Film size={11} />}
                disabled={downloading !== null}
                onClick={() => void download(successClip)}
              >
                {downloading === successClip.id ? '校验中…' : '下载录屏片段'}
              </Button>
              {successReceipt ? (
                <Button
                  variant="ghost"
                  size="sm"
                  icon={<FileJson size={11} />}
                  disabled={downloading !== null}
                  onClick={() => void download(successReceipt)}
                >
                  下载 capture-receipt.json
                </Button>
              ) : null}
            </div>
          </div>
        ) : null}

        {/* Failure evidence */}
        {failedCapture ? (
          <div className="space-y-2 rounded-sm border border-danger/25 bg-danger-soft/15 p-3">
            <div className="flex flex-wrap items-center gap-1.5 text-[10.5px] font-medium text-danger">
              <XCircle size={12} /> 真实录屏失败 · {captureFailure.code}
              {captureFailure.retryable ? <Badge tone="warn" dot={false}>可重试</Badge> : null}
            </div>
            <p className="text-[9.5px] leading-4 text-muted">{captureFailure.message}</p>
            <div className="grid gap-x-4 gap-y-1 text-[9.5px] sm:grid-cols-2">
              {captureFailure.failedStepId ? (
                <Fact label="失败步骤" value={captureFailure.failedStepId} mono />
              ) : null}
              <Fact label="断言失败" value={`${captureFailure.assertionFailures} 条`} />
              <Fact label="发生时间" value={new Date(captureFailure.failedAt).toLocaleString('zh-CN', { hour12: false })} />
              {captureFailure.blockedRequests.length > 0 ? (
                <Fact label="越界请求" value={captureFailure.blockedRequests.join(' · ')} mono />
              ) : null}
            </div>
            {previewShot ? (
              <div className="overflow-hidden rounded-sm border border-line bg-black/40">
                <div className="flex items-center gap-1.5 border-b border-line px-2 py-1 text-[8.5px] text-faint">
                  <ImageIcon size={10} /> 失败现场 · {previewShot.fileName}
                  {failureShots.length > 1 ? (
                    <div className="ml-auto flex flex-wrap gap-1">
                      {failureShots.map((shot, index) => (
                        <button
                          key={shot.id}
                          type="button"
                          onClick={() => setPreviewId(shot.id)}
                          className={cn(
                            'rounded-sm border px-1 py-px font-mono',
                            previewShot.id === shot.id
                              ? 'border-accent/50 text-accent'
                              : 'border-line text-faint hover:text-fg',
                          )}
                        >
                          {index + 1}
                        </button>
                      ))}
                    </div>
                  ) : null}
                </div>
                <InlinePng artifact={previewShot} workspaceId={api.workspaceId} onError={setError} />
              </div>
            ) : null}
            <div className="flex flex-wrap gap-1.5">
              {failureReport ? (
                <Button
                  variant="secondary"
                  size="sm"
                  icon={<FileText size={11} />}
                  disabled={downloading !== null}
                  onClick={() => void download(failureReport)}
                >
                  {downloading === failureReport.id ? '校验中…' : '下载 failure-report.json'}
                </Button>
              ) : null}
              {failureTrace ? (
                <Button
                  variant="ghost"
                  size="sm"
                  icon={<Download size={11} />}
                  disabled={downloading !== null}
                  onClick={() => void download(failureTrace)}
                >
                  {downloading === failureTrace.id ? '校验中…' : '下载 trace.zip'}
                </Button>
              ) : null}
              {failureShots.map((shot, index) => (
                <Button
                  key={shot.id}
                  variant="ghost"
                  size="sm"
                  icon={<ImageIcon size={11} />}
                  disabled={downloading !== null}
                  onClick={() => void download(shot)}
                >
                  下载截图 {index + 1}
                </Button>
              ))}
            </div>
            <p className="text-[8.5px] leading-4 text-faint">
              失败路径不会生成回执或回填素材：渲染输入保持原样，直到重新审批并录制成功。
            </p>
          </div>
        ) : null}

        {error ? (
          <div className="rounded-sm border border-danger/25 bg-danger-soft/20 px-2.5 py-2 text-[9.5px] text-danger">
            {error}
          </div>
        ) : null}
      </div>
    </Panel>
  );
}

/**
 * Inline PNG preview. The route only sends `inline` for PNG screenshots and
 * always adds `nosniff`; this component still re-checks the metadata so a
 * future artifact kind cannot become an inline HTML/SVG surface by accident.
 */
function InlinePng({
  artifact,
  workspaceId,
  onError,
}: {
  artifact: OrchestrationArtifactV1;
  workspaceId: string;
  onError: (message: string) => void;
}) {
  const [src, setSrc] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setSrc(null);
    setFailed(false);
    void (async () => {
      const client = await getOrchestrationClient();
      if (cancelled) return;
      setSrc(client.artifactInlineUrl(workspaceId, artifact.id));
    })().catch((caught: unknown) => {
      if (!cancelled) {
        setFailed(true);
        onError(caught instanceof Error ? caught.message : String(caught));
      }
    });
    return () => {
      cancelled = true;
    };
  }, [artifact.id, workspaceId, onError]);

  if (failed) {
    return (
      <div className="flex items-center gap-1.5 px-2 py-3 text-[9px] text-danger">
        <AlertTriangle size={11} /> 截图无法预览，请下载后查看。
      </div>
    );
  }
  if (!src) {
    return (
      <div className="flex items-center gap-1.5 px-2 py-3 text-[9px] text-faint">
        <Loader2 size={11} className="animate-spin" /> 载入失败截图…
      </div>
    );
  }
  return (
    <img
      src={src}
      alt={`失败现场截图 ${artifact.fileName}`}
      className="block max-h-[260px] w-full object-contain"
      onError={() => {
        setFailed(true);
        onError('截图预览失败（可能已被清理）。');
      }}
    />
  );
}

function Fact({
  label,
  value,
  mono,
  title,
}: {
  label: string;
  value: string;
  mono?: boolean;
  title?: string;
}) {
  return (
    <div className="flex items-baseline justify-between gap-2" title={title}>
      <span className="shrink-0 text-faint">{label}</span>
      <span className={cn('truncate text-fg', mono && 'font-mono text-[9px]')}>{value}</span>
    </div>
  );
}

export default Gate2ApprovalPanel;
