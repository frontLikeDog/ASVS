import { useEffect, useState } from 'react';
import type {
  ClaimCandidateV1,
  ClaimPublishEligibility,
  ClaimVerificationDecision,
  ClaimVerificationInputV1,
  ClaimVerificationKind,
  ClaimVerificationRecordV1,
  GitHubRepoRef,
} from '@asvs/domain';
import { formatDate } from '@asvs/domain';
import { getGitHubKnowledgeClient } from '@asvs/state';
import {
  Badge,
  Button,
  Callout,
  ClaimEligibilityBadge,
  Dialog,
  DialogContent,
  Field,
  Input,
  Select,
  Textarea,
  cn,
} from '@asvs/ui';
import { History, ShieldCheck } from 'lucide-react';

const ENV_PRESETS = ['staging', 'beta', 'preview', 'production'] as const;

export function ClaimVerificationDialog({
  open,
  onOpenChange,
  repo,
  claimId,
  claimStatement,
  currentEligibility,
  onVerified,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  repo: GitHubRepoRef;
  claimId: string;
  claimStatement: string;
  currentEligibility?: ClaimPublishEligibility;
  onVerified: (updatedClaim: ClaimCandidateV1) => Promise<void> | void;
}) {
  const [kind, setKind] = useState<ClaimVerificationKind>('runtime');
  const [environmentId, setEnvironmentId] = useState('staging');
  const [releaseTag, setReleaseTag] = useState('');
  const [testRunId, setTestRunId] = useState('');
  const [decision, setDecision] = useState<ClaimVerificationDecision>('approve');
  const [actor, setActor] = useState('');
  const [note, setNote] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setError(null);
    setNote('');
  }, [open, claimId]);

  const handleSubmit = async () => {
    const trimmedNote = note.trim();
    if (!trimmedNote) {
      setError('请填写核验说明（note）。');
      return;
    }
    if (kind === 'runtime' && !environmentId.trim()) {
      setError('运行态证据必须填写 environmentId（例如 staging 或 production）。');
      return;
    }
    if (kind === 'release' && !releaseTag.trim()) {
      setError('发布证据必须填写 releaseTag（例如 v1.2.0）。');
      return;
    }

    const payload: ClaimVerificationInputV1 = {
      kind,
      note: trimmedNote,
      ...(actor.trim() ? { actor: actor.trim() } : {}),
      ...(kind === 'runtime'
        ? {
            environmentId: environmentId.trim().toLowerCase(),
            ...(testRunId.trim() ? { testRunId: testRunId.trim() } : {}),
          }
        : {}),
      ...(kind === 'release' ? { releaseTag: releaseTag.trim() } : {}),
      ...(kind === 'test'
        ? {
            ...(testRunId.trim() ? { testRunId: testRunId.trim() } : {}),
            ...(environmentId.trim()
              ? { environmentId: environmentId.trim().toLowerCase() }
              : {}),
          }
        : {}),
      ...(kind === 'human' ? { decision } : {}),
    };

    setSubmitting(true);
    setError(null);
    try {
      const client = await getGitHubKnowledgeClient();
      const updated = await client.recordVerification(repo, claimId, payload);
      await onVerified(updated);
      onOpenChange(false);
    } catch (submitError) {
      setError(
        submitError instanceof Error ? submitError.message : '提交核验记录失败，请检查后端状态。',
      );
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        title="提交 Claim 核验记录"
        description="核验记录追加写入 SQLite 审计表，并由服务端重新计算发布资格（AC-03）。"
        size="md"
        footer={
          <>
            <Button variant="ghost" onClick={() => onOpenChange(false)} disabled={submitting}>
              取消
            </Button>
            <Button
              variant="primary"
              onClick={() => void handleSubmit()}
              loading={submitting}
              icon={<ShieldCheck size={13} />}
            >
              写入核验记录
            </Button>
          </>
        }
      >
        <div className="space-y-4">
          <div className="rounded-md border border-line bg-raised/30 p-3">
            <div className="flex flex-wrap items-center gap-2">
              <span className="font-mono text-[10px] text-faint">{claimId}</span>
              {currentEligibility ? (
                <ClaimEligibilityBadge eligibility={currentEligibility} />
              ) : null}
            </div>
            <p className="mt-1.5 text-[12px] text-fg">{claimStatement}</p>
          </div>

          <Field label="证据类型" required>
            <Select
              value={kind}
              onChange={(event) => {
                setKind(event.target.value as ClaimVerificationKind);
                setError(null);
              }}
            >
              <option value="runtime">运行态验证（runtime）</option>
              <option value="release">发布记录（release）</option>
              <option value="test">自动化测试（test）</option>
              <option value="human">人工批准 / 驳回（human）</option>
            </Select>
          </Field>

          {kind === 'runtime' ? (
            <div className="space-y-3">
              <Field
                label="运行环境标识（environmentId）"
                required
                hint="只有 production 运行态 + 人工批准才可变为「可发布」；staging / beta 仅限限定表述。"
              >
                <Input
                  value={environmentId}
                  onChange={(event) => setEnvironmentId(event.target.value)}
                  placeholder="staging 或 production"
                />
              </Field>
              <div className="flex flex-wrap gap-1.5">
                {ENV_PRESETS.map((env) => (
                  <button
                    key={env}
                    type="button"
                    onClick={() => setEnvironmentId(env)}
                    className={cn(
                      'rounded-full border px-2.5 py-0.5 font-mono text-[10px] transition-colors',
                      environmentId.trim().toLowerCase() === env
                        ? 'border-accent/45 bg-accent-soft text-accent'
                        : 'border-line text-muted hover:text-fg',
                    )}
                  >
                    {env}
                  </button>
                ))}
              </div>
              <Field label="关联测试运行 ID（testRunId）" optional>
                <Input
                  value={testRunId}
                  onChange={(event) => setTestRunId(event.target.value)}
                  placeholder="例如 ci_run_20261127"
                />
              </Field>
            </div>
          ) : null}

          {kind === 'release' ? (
            <Field
              label="Release 标签（releaseTag）"
              required
              hint="仅有发布证据只能表述「随 Release 发布」，不能声称「已上线」。"
            >
              <Input
                value={releaseTag}
                onChange={(event) => setReleaseTag(event.target.value)}
                placeholder="例如 v1.2.0"
              />
            </Field>
          ) : null}

          {kind === 'test' ? (
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label="测试运行 ID（testRunId）" optional>
                <Input
                  value={testRunId}
                  onChange={(event) => setTestRunId(event.target.value)}
                  placeholder="例如 e2e_run_42"
                />
              </Field>
              <Field label="环境标识" optional>
                <Input
                  value={environmentId}
                  onChange={(event) => setEnvironmentId(event.target.value)}
                  placeholder="staging"
                />
              </Field>
            </div>
          ) : null}

          {kind === 'human' ? (
            <div className="space-y-3">
              <Field label="人工审核决定" required>
                <Select
                  value={decision}
                  onChange={(event) => setDecision(event.target.value as ClaimVerificationDecision)}
                >
                  <option value="approve">批准发布（approve）</option>
                  <option value="reject">驳回声明（reject）</option>
                </Select>
              </Field>
              <Callout tone={decision === 'approve' ? 'info' : 'warning'} size="sm">
                {decision === 'approve'
                  ? '批准会写入人工核验记录；若尚缺少 production 运行态证据，资格仍会保持阻断或需限定，不会越级放行。'
                  : '驳回后该 Claim 将变为 blocked_rejected，禁止进入对外发布。'}
              </Callout>
            </div>
          ) : null}

          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="核验人 / 执行主体（actor）" optional>
              <Input
                value={actor}
                onChange={(event) => setActor(event.target.value)}
                placeholder="例如 qa-lead"
              />
            </Field>
            <Field label="核验说明（note）" required>
              <Textarea
                value={note}
                onChange={(event) => setNote(event.target.value)}
                placeholder="例如：在 staging 验证 CSV 导出按钮正常下载"
                className="min-h-[72px]"
              />
            </Field>
          </div>

          {error ? (
            <Callout tone="danger" size="sm" title="提交未成功">
              {error}
            </Callout>
          ) : null}
        </div>
      </DialogContent>
    </Dialog>
  );
}

export function ClaimVerificationAuditDialog({
  open,
  onOpenChange,
  repo,
  claimId,
  claimStatement,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  repo: GitHubRepoRef;
  claimId: string;
  claimStatement: string;
}) {
  const [records, setRecords] = useState<ClaimVerificationRecordV1[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open || !claimId) return;
    let cancelled = false;
    setLoading(true);
    setError(null);
    void getGitHubKnowledgeClient()
      .then((client) => client.listVerifications(repo, claimId))
      .then((list) => {
        if (!cancelled) setRecords(list);
      })
      .catch((loadError) => {
        if (!cancelled) {
          setError(
            loadError instanceof Error ? loadError.message : '无法读取核验审计历史。',
          );
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [open, repo.owner, repo.repo, claimId]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        title="核验审计历史（追加只读）"
        description="每一条核验均按时间顺序追加留档，用于追溯发布资格的变化过程。"
        size="lg"
        footer={
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            关闭
          </Button>
        }
      >
        <div className="space-y-3">
          <div className="rounded-md border border-line bg-raised/30 p-3">
            <div className="font-mono text-[10px] text-faint">{claimId}</div>
            <div className="mt-1 text-[12px] text-fg">{claimStatement}</div>
          </div>

          {loading ? (
            <div className="py-6 text-center text-[12px] text-muted">正在加载审计记录…</div>
          ) : error ? (
            <Callout tone="danger" size="sm" title="读取失败">
              {error}
            </Callout>
          ) : records.length === 0 ? (
            <div className="rounded-md border border-dashed border-line py-8 text-center text-[12px] text-muted">
              <History size={18} className="mx-auto mb-2 text-faint" />
              尚无追加的人工/运行态/发布核验记录（当前仅有初始源码证据）。
            </div>
          ) : (
            <div className="divide-y divide-line rounded-md border border-line">
              {records.map((record) => (
                <div key={record.id} className="px-3.5 py-3 text-[11px]">
                  <div className="flex flex-wrap items-center gap-2">
                    <Badge tone="outline" dot={false}>
                      {record.evidence.kind}
                    </Badge>
                    {record.evidence.decision ? (
                      <Badge
                        tone={record.evidence.decision === 'approve' ? 'success' : 'danger'}
                        dot={false}
                      >
                        {record.evidence.decision}
                      </Badge>
                    ) : null}
                    {record.evidence.environmentId ? (
                      <Badge tone="accent" dot={false}>
                        env: {record.evidence.environmentId}
                      </Badge>
                    ) : null}
                    {record.evidence.releaseTag ? (
                      <Badge tone="outline" dot={false}>
                        {record.evidence.releaseTag}
                      </Badge>
                    ) : null}
                    {record.evidence.testRunId ? (
                      <span className="font-mono text-[10px] text-faint">
                        run: {record.evidence.testRunId}
                      </span>
                    ) : null}
                    <span className="ml-auto font-mono text-[10px] text-faint">
                      {formatDate(record.recordedAt)}
                    </span>
                  </div>
                  <p className="mt-1.5 text-[11.5px] text-fg">{record.input.note}</p>
                  <div className="mt-1 flex flex-wrap items-center gap-2 text-[9.5px] text-faint">
                    <span className="font-mono">{record.id}</span>
                    {record.evidence.actor ? <span>· actor: {record.evidence.actor}</span> : null}
                    {record.evidence.commitSha ? (
                      <span className="font-mono">
                        · commit {record.evidence.commitSha.slice(0, 10)}
                      </span>
                    ) : null}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
