import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import type {
  Claim,
  ClaimCandidateV1,
  Feature,
  KnowledgeSnapshotSummaryV1,
  PRChangeCandidateV1,
  PRChangeClassification,
  Project,
} from '@asvs/domain';
import { formatDate, formatGitHubRepoRef, formatRelativeTime } from '@asvs/domain';
import {
  getGitHubKnowledgeClient,
  parseProjectGitHubSource,
  promotePRCandidate,
  reconcileDiscoveryCandidates,
} from '@asvs/state';
import {
  Badge,
  Button,
  Callout,
  ClaimEligibilityBadge,
  ClaimStatusBadge,
  EmptyState,
  PRClassificationBadge,
  Panel,
  Select,
  StatusBadge,
  EVIDENCE_STATUS_META,
  buttonStyles,
  cn,
} from '@asvs/ui';
import {
  AlertTriangle,
  CheckCircle2,
  Database,
  ExternalLink,
  FileCode2,
  GitPullRequest,
  History,
  PlusCircle,
  RefreshCw,
  ShieldAlert,
  ShieldCheck,
  Sparkles,
} from 'lucide-react';
import {
  ClaimVerificationAuditDialog,
  ClaimVerificationDialog,
} from './claim-verification-dialog';

type ClassificationFilter = 'all' | PRChangeClassification;
type PullStateFilter = 'closed' | 'all' | 'open';

export function KnowledgeDiscoveryPanel({
  project,
  features,
  claims,
  onOpenFeature,
  onToast,
}: {
  project: Project;
  features: Feature[];
  claims: Claim[];
  onOpenFeature: (featureId: string) => void;
  onToast: (toast: {
    tone: 'success' | 'info' | 'warning' | 'danger';
    title: string;
    description?: string;
  }) => void;
}) {
  const realGitHub = useMemo(() => parseProjectGitHubSource(project), [project]);

  const [snapshots, setSnapshots] = useState<KnowledgeSnapshotSummaryV1[]>([]);
  const [candidates, setCandidates] = useState<PRChangeCandidateV1[]>([]);
  const [loading, setLoading] = useState(false);
  const [busyAction, setBusyAction] = useState<
    'index' | 'discover' | 'staleness' | null
  >(null);
  const [error, setError] = useState<string | null>(null);
  const [prState, setPrState] = useState<PullStateFilter>('closed');
  const [classificationFilter, setClassificationFilter] =
    useState<ClassificationFilter>('all');
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [verifyTarget, setVerifyTarget] = useState<{
    candidateId: string;
    claim: ClaimCandidateV1;
  } | null>(null);
  const [auditTarget, setAuditTarget] = useState<ClaimCandidateV1 | null>(null);

  const loadLocalCache = useCallback(async () => {
    if (!realGitHub) return;
    setLoading(true);
    setError(null);
    try {
      const client = await getGitHubKnowledgeClient();
      const [snapshotList, candidateList] = await Promise.all([
        client.listSnapshots(realGitHub.repo, { branch: realGitHub.branch, limit: 10 }),
        client.listCandidates(realGitHub.repo, { limit: 100 }),
      ]);
      setSnapshots(snapshotList);
      setCandidates(candidateList);
    } catch (loadError) {
      setError(
        loadError instanceof Error ? loadError.message : '无法读取本地知识快照与 PR 候选。',
      );
    } finally {
      setLoading(false);
    }
  }, [realGitHub]);

  useEffect(() => {
    void loadLocalCache();
  }, [loadLocalCache]);

  if (!realGitHub) {
    return (
      <div className="space-y-4">
        <Callout tone="info" title="当前项目尚未绑定真实 GitHub 仓库">
          该工作区项目当前使用本地 Demo 或无源码模式（AC-08）。你可以在设置中绑定只读 GitHub App 仓库，或通过入门向导创建真实仓库项目。
        </Callout>
        <div className="flex flex-wrap gap-2">
          <Link
            to={`/projects/${project.id}/settings?tab=sources`}
            className={buttonStyles({ variant: 'primary', size: 'sm' })}
          >
            前往「来源与同步」绑定真实仓库
          </Link>
          <Link
            to="/onboarding"
            className={buttonStyles({ variant: 'secondary', size: 'sm' })}
          >
            新建真实 GitHub 项目
          </Link>
        </div>
      </div>
    );
  }

  const fullRepo = formatGitHubRepoRef(realGitHub.repo);
  const latestSnapshot = snapshots[0];

  const handleIndex = async () => {
    setBusyAction('index');
    setError(null);
    try {
      const client = await getGitHubKnowledgeClient();
      const snapshot = await client.indexRepository(realGitHub.repo, {
        branch: realGitHub.branch,
      });
      let refreshedMessage = '';
      if (candidates.length > 0) {
        const staleness = await client.refreshStaleness(realGitHub.repo, {
          snapshotId: snapshot.id,
        });
        const updatedCandidates = await client.listCandidates(realGitHub.repo, { limit: 100 });
        setCandidates(updatedCandidates);
        const summary = reconcileDiscoveryCandidates(project.id, updatedCandidates, {
          snapshotId: snapshot.id,
          commitSha: snapshot.gitCommitSha,
          branch: snapshot.branch,
          syncedAt: snapshot.indexedAt,
        });
        if (staleness.claimsMarkedStale.length > 0 || summary.invalidatedVideoIds.length > 0) {
          refreshedMessage = `；检测到 ${staleness.staleFiles.length} 个变更文件，${staleness.claimsMarkedStale.length} 条 Claim 过期`;
        }
      } else {
        reconcileDiscoveryCandidates(project.id, candidates, {
          snapshotId: snapshot.id,
          commitSha: snapshot.gitCommitSha,
          branch: snapshot.branch,
          syncedAt: snapshot.indexedAt,
        });
      }
      const nextSnapshots = await client.listSnapshots(realGitHub.repo, {
        branch: realGitHub.branch,
        limit: 10,
      });
      setSnapshots(nextSnapshots);
      onToast({
        tone: refreshedMessage ? 'warning' : 'success',
        title: `增量索引完成（${snapshot.stats.mode}）`,
        description: `共 ${snapshot.stats.totalFiles} 文件，复用 ${snapshot.stats.reusedFiles}，新下载 ${snapshot.stats.fetchedFiles}${refreshedMessage}。`,
      });
    } catch (actionError) {
      const msg = actionError instanceof Error ? actionError.message : '增量索引失败。';
      setError(msg);
      onToast({ tone: 'danger', title: '索引失败', description: msg });
    } finally {
      setBusyAction(null);
    }
  };

  const handleDiscover = async () => {
    setBusyAction('discover');
    setError(null);
    try {
      const client = await getGitHubKnowledgeClient();
      const report = await client.discoverPullRequests(realGitHub.repo, {
        state: prState,
        branch: realGitHub.branch,
        limit: 20,
      });
      const updatedCandidates = await client.listCandidates(realGitHub.repo, { limit: 100 });
      setCandidates(updatedCandidates);
      const summary = reconcileDiscoveryCandidates(project.id, updatedCandidates, {
        snapshotId: report.snapshotId,
        branch: report.branch,
        syncedAt: report.analyzedAt,
      });
      onToast({
        tone: 'success',
        title: `PR 变更发现完成（分析 ${report.summary.analyzed} 个）`,
        description: `用户功能 ${report.summary.userFacingFeature}、改进 ${report.summary.userFacingImprovement}、内部过滤 ${report.summary.internal}、待复核 ${report.summary.ambiguous}${
          summary.invalidatedVideoIds.length > 0
            ? `；${summary.invalidatedVideoIds.length} 条已批准视频已失效`
            : ''
        }。`,
      });
    } catch (actionError) {
      const msg = actionError instanceof Error ? actionError.message : 'PR 变更发现失败。';
      setError(msg);
      onToast({ tone: 'danger', title: 'PR 发现失败', description: msg });
    } finally {
      setBusyAction(null);
    }
  };

  const handleRefreshStaleness = async () => {
    setBusyAction('staleness');
    setError(null);
    try {
      const client = await getGitHubKnowledgeClient();
      const result = await client.refreshStaleness(realGitHub.repo, {
        branch: realGitHub.branch,
      });
      const updatedCandidates = await client.listCandidates(realGitHub.repo, { limit: 100 });
      setCandidates(updatedCandidates);
      const summary = reconcileDiscoveryCandidates(project.id, updatedCandidates, {
        snapshotId: result.snapshotId,
        commitSha: result.gitCommitSha,
        branch: result.branch,
        syncedAt: result.refreshedAt,
      });
      onToast({
        tone: result.claimsMarkedStale.length > 0 ? 'warning' : 'success',
        title: '过期状态刷新完成（AC-09）',
        description:
          result.claimsMarkedStale.length > 0
            ? `${result.claimsMarkedStale.length} 条 Claim 标为过期（涉及 ${result.staleFiles.length} 个文件），${summary.invalidatedVideoIds.length} 条已批准视频回到待修改。`
            : `扫描 ${result.candidatesScanned} 个候选，未发现过期证据。`,
      });
    } catch (actionError) {
      const msg = actionError instanceof Error ? actionError.message : '过期刷新失败。';
      setError(msg);
      onToast({ tone: 'danger', title: '刷新过期状态失败', description: msg });
    } finally {
      setBusyAction(null);
    }
  };

  const handlePromoteOne = (candidate: PRChangeCandidateV1) => {
    const res = promotePRCandidate(project.id, candidate);
    if (!res.ok) {
      onToast({ tone: 'danger', title: '无法写入功能目录', description: res.message });
      return;
    }
    onToast({
      tone: 'success',
      title: `已写入功能目录：PR #${candidate.pullNumber}`,
      description: '已保留源码证据指纹；未完成核验前仍无法在审核页批准发布。',
    });
  };

  const promotableUnadded = candidates.filter(
    (candidate) =>
      candidate.promotable &&
      candidate.claims.length > 0 &&
      !features.some((feature) => feature.sourceCandidateId === candidate.id),
  );

  const handlePromoteAll = () => {
    let added = 0;
    for (const candidate of promotableUnadded) {
      const res = promotePRCandidate(project.id, candidate);
      if (res.ok) added += 1;
    }
    onToast({
      tone: added > 0 ? 'success' : 'info',
      title: added > 0 ? `已批量写入 ${added} 个可推广功能` : '没有待写入的新候选',
      description: added > 0 ? '请在功能目录逐条核验或创建视频。' : undefined,
    });
  };

  const filteredCandidates = candidates.filter(
    (candidate) =>
      classificationFilter === 'all' || candidate.classification === classificationFilter,
  );

  return (
    <div className="space-y-4">
      <Panel>
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-line px-4 py-3.5">
          <div>
            <div className="flex flex-wrap items-center gap-2">
              <span className="font-mono text-[12px] font-medium text-fg">{fullRepo}</span>
              <Badge tone="outline" dot={false}>
                分支 {realGitHub.branch}
              </Badge>
              <Badge tone="success" dot={false}>
                只读 GitHub App
              </Badge>
            </div>
            <p className="mt-1 text-[11px] text-muted">
              首次冷扫描视仓库规模约 10–60s，后续同提交热扫描会复用未变更文件（fetchedFiles = 0）。
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Button
              variant="secondary"
              size="sm"
              loading={busyAction === 'index'}
              disabled={busyAction !== null}
              onClick={() => void handleIndex()}
              icon={<Database size={13} />}
            >
              运行增量索引
            </Button>
            <Select
              value={prState}
              onChange={(event) => setPrState(event.target.value as PullStateFilter)}
              aria-label="PR 状态筛选"
              wrapperClassName="w-[116px]"
              className="h-8 text-[11.5px]"
            >
              <option value="closed">已关闭/合并</option>
              <option value="all">全部 PR</option>
              <option value="open">进行中</option>
            </Select>
            <Button
              variant="primary"
              size="sm"
              loading={busyAction === 'discover'}
              disabled={busyAction !== null}
              onClick={() => void handleDiscover()}
              icon={<GitPullRequest size={13} />}
            >
              发现 PR 变更
            </Button>
            <Button
              variant="ghost"
              size="sm"
              loading={busyAction === 'staleness'}
              disabled={busyAction !== null || snapshots.length === 0}
              onClick={() => void handleRefreshStaleness()}
              icon={<RefreshCw size={13} />}
            >
              刷新过期状态
            </Button>
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-x-4 gap-y-2 bg-raised/20 px-4 py-2.5 text-[11px] text-muted">
          {latestSnapshot ? (
            <>
              <span className="font-mono text-[10.5px] text-fg">{latestSnapshot.id}</span>
              <span>
                模式 <strong className="text-fg">{latestSnapshot.stats.mode}</strong>
              </span>
              <span className="font-mono text-[10.5px]">
                commit {latestSnapshot.gitCommitSha.slice(0, 10)}
              </span>
              <span>
                文件 {latestSnapshot.stats.totalFiles} · 复用 {latestSnapshot.stats.reusedFiles} ·
                新下载 {latestSnapshot.stats.fetchedFiles}
              </span>
              <span className="ml-auto text-[10px] text-faint">
                索引于 {formatRelativeTime(latestSnapshot.indexedAt)}
              </span>
            </>
          ) : (
            <span className="text-faint">
              尚未生成 4B 知识快照；点击「运行增量索引」建立文件 SHA256 指纹基线。
            </span>
          )}
        </div>
      </Panel>

      {error ? (
        <Callout tone="danger" size="sm" title="与本机 API 通信异常">
          {error}
        </Callout>
      ) : null}

      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-wrap gap-1.5">
          {[
            { value: 'all' as const, label: `全部 (${candidates.length})` },
            {
              value: 'user_facing_feature' as const,
              label: `用户新功能 (${
                candidates.filter((c) => c.classification === 'user_facing_feature').length
              })`,
            },
            {
              value: 'user_facing_improvement' as const,
              label: `用户改进 (${
                candidates.filter((c) => c.classification === 'user_facing_improvement').length
              })`,
            },
            {
              value: 'internal_non_promotable' as const,
              label: `内部变更 (${
                candidates.filter((c) => c.classification === 'internal_non_promotable').length
              })`,
            },
            {
              value: 'ambiguous_needs_review' as const,
              label: `待复核 (${
                candidates.filter((c) => c.classification === 'ambiguous_needs_review').length
              })`,
            },
          ].map((item) => (
            <button
              key={item.value}
              type="button"
              onClick={() => setClassificationFilter(item.value)}
              className={cn(
                'rounded-full border px-2.5 py-1 text-[11px] transition-colors',
                classificationFilter === item.value
                  ? 'border-accent/45 bg-accent-soft text-accent'
                  : 'border-line text-muted hover:text-fg',
              )}
            >
              {item.label}
            </button>
          ))}
        </div>
        {promotableUnadded.length > 0 ? (
          <Button
            variant="secondary"
            size="sm"
            icon={<PlusCircle size={13} />}
            onClick={handlePromoteAll}
          >
            同步全部可推广候选（{promotableUnadded.length}）
          </Button>
        ) : null}
      </div>

      {loading ? (
        <Panel className="p-8 text-center text-[12px] text-muted">正在读取 PR 变更候选…</Panel>
      ) : filteredCandidates.length === 0 ? (
        <EmptyState
          icon={<GitPullRequest size={20} />}
          title="暂无 PR 变更候选"
          description="点击上方「发现 PR 变更」拉取并确定性分类仓库的 PR；内部重构不会产出可推广 Claim。"
        />
      ) : (
        <div className="space-y-3">
          {filteredCandidates.map((candidate) => {
            const promotedFeature = features.find(
              (feature) => feature.sourceCandidateId === candidate.id,
            );
            const expanded = expandedId === candidate.id;
            return (
              <Panel key={candidate.id} className="overflow-hidden">
                <div className="border-b border-line px-4 py-3.5">
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="font-mono text-[11px] text-faint">
                          #{candidate.pullNumber}
                        </span>
                        <PRClassificationBadge classification={candidate.classification} />
                        <Badge tone="outline" dot={false}>
                          {candidate.confidence}% 规则置信度
                        </Badge>
                        {candidate.merged ? (
                          <Badge tone="outline" dot={false}>
                            已合并
                          </Badge>
                        ) : (
                          <Badge tone="warn" dot={false}>
                            {candidate.state}
                          </Badge>
                        )}
                        {candidate.release ? (
                          <Badge tone="accent" dot={false}>
                            Release {candidate.release.tagName}
                          </Badge>
                        ) : null}
                      </div>
                      <h3 className="mt-2 font-display text-[15px] font-medium text-fg">
                        {candidate.title}
                      </h3>
                      <div className="mt-1 flex flex-wrap items-center gap-2 text-[10.5px] text-faint">
                        <span>{candidate.author}</span>
                        <span>·</span>
                        <span>{formatDate(candidate.mergedAt ?? candidate.analyzedAt)}</span>
                        <span>·</span>
                        <span>
                          {candidate.diffStats.filesChanged} 文件（+{candidate.diffStats.additions}/-
                          {candidate.diffStats.deletions}）
                        </span>
                        <a
                          href={candidate.htmlUrl}
                          target="_blank"
                          rel="noreferrer"
                          className="inline-flex items-center gap-1 text-muted hover:text-accent"
                        >
                          GitHub <ExternalLink size={10} />
                        </a>
                      </div>
                    </div>

                    <div className="flex shrink-0 flex-wrap items-center gap-2">
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => setExpandedId(expanded ? null : candidate.id)}
                      >
                        {expanded ? '收起依据' : '判定依据与文件'}
                      </Button>
                      {candidate.promotable && candidate.claims.length > 0 ? (
                        promotedFeature ? (
                          <>
                            <Button
                              variant="secondary"
                              size="sm"
                              onClick={() => onOpenFeature(promotedFeature.id)}
                            >
                              已在目录 · 查看
                            </Button>
                            <Link
                              to={`/projects/${project.id}/videos/new?feature=${promotedFeature.id}`}
                              className={buttonStyles({ variant: 'primary', size: 'sm' })}
                            >
                              <Sparkles size={12} /> 创建视频
                            </Link>
                          </>
                        ) : (
                          <Button
                            variant="primary"
                            size="sm"
                            icon={<PlusCircle size={13} />}
                            onClick={() => handlePromoteOne(candidate)}
                          >
                            写入功能目录
                          </Button>
                        )
                      ) : null}
                    </div>
                  </div>

                  {expanded ? (
                    <div className="mt-3 grid gap-3 rounded-md border border-line bg-raised/30 p-3 text-[11px] sm:grid-cols-2">
                      <div>
                        <div className="mb-1 font-medium text-fg">确定性分类理由</div>
                        <ul className="space-y-1 pl-4 text-muted">
                          {candidate.rationale.map((reason) => (
                            <li key={reason} className="list-disc">
                              {reason}
                            </li>
                          ))}
                        </ul>
                      </div>
                      <div>
                        <div className="mb-1 font-medium text-fg">
                          变更文件（{candidate.changedFiles.length}）
                        </div>
                        <div className="max-h-28 space-y-1 overflow-y-auto font-mono text-[10px] text-muted">
                          {candidate.changedFiles.map((file) => (
                            <div key={file.path} className="flex items-center gap-2">
                              <span className="rounded bg-overlay px-1 text-[9px] text-faint">
                                {file.category}
                              </span>
                              <span className="truncate">{file.path}</span>
                            </div>
                          ))}
                        </div>
                      </div>
                    </div>
                  ) : null}
                </div>

                <div className="p-4">
                  {!candidate.promotable || candidate.claims.length === 0 ? (
                    <div className="flex items-center gap-2 rounded-sm border border-warn/25 bg-warn-soft/20 px-3 py-2 text-[11px] text-warn">
                      <ShieldAlert size={14} className="shrink-0" />
                      <span>
                        AC-02 过滤：该 PR 判定为「
                        {candidate.classification === 'internal_non_promotable'
                          ? '内部非推广变更'
                          : '需人工复核'}
                        」，系统不产出 Claim，也不允许写入功能目录作为视频卖点。
                      </span>
                    </div>
                  ) : (
                    <div className="space-y-3">
                      {candidate.claims.map((claim) => {
                        const claimEvidence = candidate.evidence.filter((ev) =>
                          claim.evidenceIds.includes(ev.id),
                        );
                        const workspaceClaim = claims.find(
                          (item) => item.sourceClaimId === claim.id,
                        );
                        return (
                          <div
                            key={claim.id}
                            className="rounded-md border border-line bg-raised/20 p-3.5"
                          >
                            <div className="flex flex-wrap items-start justify-between gap-2">
                              <div className="min-w-0 flex-1">
                                <div className="flex flex-wrap items-center gap-2">
                                  <ClaimEligibilityBadge eligibility={claim.eligibility} />
                                  <ClaimStatusBadge status={claim.status} />
                                  <span className="text-[12.5px] font-medium text-fg">
                                    {claim.statement}
                                  </span>
                                </div>
                                <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-[10px] text-faint">
                                  <span>受众：{claim.audience}</span>
                                  <span className="font-mono">
                                    commit {claim.verification.commitSha.slice(0, 10)}
                                  </span>
                                  <span>env: {claim.verification.environmentId}</span>
                                  {claim.verification.releaseTag ? (
                                    <span>release: {claim.verification.releaseTag}</span>
                                  ) : null}
                                  {workspaceClaim ? (
                                    <span className="text-success">· 已同步至功能目录</span>
                                  ) : null}
                                </div>
                              </div>
                              <div className="flex shrink-0 items-center gap-1.5">
                                <Button
                                  variant="secondary"
                                  size="sm"
                                  icon={<ShieldCheck size={12} />}
                                  onClick={() =>
                                    setVerifyTarget({ candidateId: candidate.id, claim })
                                  }
                                >
                                  提交核验记录
                                </Button>
                                <Button
                                  variant="ghost"
                                  size="sm"
                                  icon={<History size={12} />}
                                  onClick={() => setAuditTarget(claim)}
                                >
                                  核验审计
                                </Button>
                              </div>
                            </div>

                            {claim.blockers.length > 0 ? (
                              <div className="mt-2.5 space-y-1 rounded-sm border border-danger/20 bg-danger-soft/20 px-2.5 py-2 text-[10.5px] text-danger">
                                {claim.blockers.map((blocker) => (
                                  <div key={blocker} className="flex items-start gap-1.5">
                                    <AlertTriangle size={12} className="mt-0.5 shrink-0" />
                                    <span>{blocker}</span>
                                  </div>
                                ))}
                              </div>
                            ) : (
                              <div className="mt-2.5 flex items-center gap-1.5 rounded-sm border border-success/25 bg-success-soft/20 px-2.5 py-1.5 text-[10.5px] text-success">
                                <CheckCircle2 size={12} className="shrink-0" />
                                <span>{claim.guidance}</span>
                              </div>
                            )}

                            <div className="mt-2.5 flex flex-wrap gap-1.5">
                              {claimEvidence.map((ev) => (
                                <span
                                  key={ev.id}
                                  className="inline-flex items-center gap-1.5 rounded-sm border border-line bg-surface px-2 py-1 text-[10px] text-muted"
                                >
                                  <FileCode2 size={10} className="text-faint" />
                                  <span>{ev.title}</span>
                                  {ev.filePath ? (
                                    <span className="font-mono text-[9.5px] text-faint">
                                      {ev.filePath}
                                    </span>
                                  ) : null}
                                  {ev.sourceDigest ? (
                                    <span className="font-mono text-[9px] text-faint">
                                      #{ev.sourceDigest.slice(0, 8)}
                                    </span>
                                  ) : null}
                                  <StatusBadge meta={EVIDENCE_STATUS_META[ev.status]} />
                                </span>
                              ))}
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  )}
                </div>
              </Panel>
            );
          })}
        </div>
      )}

      {verifyTarget ? (
        <ClaimVerificationDialog
          open={Boolean(verifyTarget)}
          onOpenChange={(open) => {
            if (!open) setVerifyTarget(null);
          }}
          repo={realGitHub.repo}
          claimId={verifyTarget.claim.id}
          claimStatement={verifyTarget.claim.statement}
          currentEligibility={verifyTarget.claim.eligibility}
          onVerified={async (updatedClaim) => {
            const client = await getGitHubKnowledgeClient();
            const refreshedCandidate = await client.getCandidate(
              realGitHub.repo,
              verifyTarget.candidateId,
            );
            const nextList = refreshedCandidate
              ? candidates.map((item) =>
                  item.id === refreshedCandidate.id ? refreshedCandidate : item,
                )
              : await client.listCandidates(realGitHub.repo, { limit: 100 });
            setCandidates(nextList);
            reconcileDiscoveryCandidates(project.id, nextList);
            onToast({
              tone: updatedClaim.eligibility === 'publishable' ? 'success' : 'info',
              title: '核验记录已写入',
              description: `最新资格：${updatedClaim.eligibility}（${updatedClaim.guidance}）`,
            });
          }}
        />
      ) : null}

      {auditTarget ? (
        <ClaimVerificationAuditDialog
          open={Boolean(auditTarget)}
          onOpenChange={(open) => {
            if (!open) setAuditTarget(null);
          }}
          repo={realGitHub.repo}
          claimId={auditTarget.id}
          claimStatement={auditTarget.statement}
        />
      ) : null}
    </div>
  );
}
