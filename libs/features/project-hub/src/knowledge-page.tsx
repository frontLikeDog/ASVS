import { useEffect, useMemo, useState } from 'react';
import { Link, useParams, useSearchParams } from 'react-router-dom';
import type {
  Claim,
  Evidence,
  Feature,
  FeatureStatus,
  GitHubRepoRef,
  KnowledgeSuggestion,
} from '@asvs/domain';
import {
  FEATURE_STATUSES,
  formatDate,
  formatRelativeTime,
} from '@asvs/domain';
import {
  AlertTriangle,
  ArrowRight,
  BookOpen,
  Check,
  CheckCircle2,
  ChevronRight,
  CircleSlash,
  Clock3,
  FileCode2,
  FlaskConical,
  GitPullRequest,
  History,
  Link2,
  MonitorSmartphone,
  Pencil,
  RefreshCw,
  Search,
  ShieldCheck,
  Sparkles,
  Tag,
  UserCheck,
  X,
} from 'lucide-react';
import {
  Badge,
  Button,
  Callout,
  Checkbox,
  ClaimEligibilityBadge,
  ClaimStatusBadge,
  Dialog,
  DialogContent,
  EmptyState,
  EVIDENCE_STATUS_META as EVIDENCE_META,
  FEATURE_STATUS_META,
  FeatureStatusBadge,
  Field,
  Input,
  Page,
  PageHeader,
  Panel,
  PanelHeader,
  Select,
  StatusBadge,
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
  Textarea,
  buttonStyles,
  cn,
} from '@asvs/ui';
import {
  getGitHubKnowledgeClient,
  parseProjectGitHubSource,
  reconcileDiscoveryCandidates,
  useStudioStore,
  useUiStore,
} from '@asvs/state';
import { useShallow } from 'zustand/react/shallow';
import {
  ClaimVerificationAuditDialog,
  ClaimVerificationDialog,
} from './claim-verification-dialog';
import { KnowledgeDiscoveryPanel } from './knowledge-discovery-panel';
import { NotFoundInline } from './not-found-inline';

type CatalogFilter = 'all' | 'verified' | 'attention' | 'proposed';
type KnowledgeTab = 'catalog' | 'discovery' | 'timeline' | 'pending';

const EVIDENCE_KIND_META = {
  source: { label: '源码 / PR', icon: FileCode2 },
  test: { label: '自动化测试', icon: FlaskConical },
  runtime: { label: '运行时验证', icon: MonitorSmartphone },
  release: { label: '发布记录', icon: Tag },
  human: { label: '人工确认', icon: UserCheck },
} as const;

export function KnowledgePage() {
  const { projectId = '' } = useParams();
  const [searchParams, setSearchParams] = useSearchParams();
  const project = useStudioStore((state) => state.projects.find((item) => item.id === projectId));
  const features = useStudioStore(
    useShallow((state) => state.features.filter((item) => item.projectId === projectId)),
  );
  const claims = useStudioStore(
    useShallow((state) => state.claims.filter((item) => item.projectId === projectId)),
  );
  const evidence = useStudioStore(
    useShallow((state) => state.evidence.filter((item) => item.projectId === projectId)),
  );
  const suggestions = useStudioStore(
    useShallow((state) => state.suggestions.filter((item) => item.projectId === projectId)),
  );
  const pullRequests = useStudioStore(
    useShallow((state) => state.pullRequests.filter((item) => item.projectId === projectId)),
  );
  const releases = useStudioStore(
    useShallow((state) => state.releases.filter((item) => item.projectId === projectId)),
  );
  const videos = useStudioStore(
    useShallow((state) => state.videos.filter((item) => item.projectId === projectId)),
  );
  const syncProjectKnowledge = useStudioStore((state) => state.syncProjectKnowledge);
  const pushToast = useUiStore((state) => state.pushToast);

  const tabParam = searchParams.get('tab');
  const [tab, setTab] = useState<KnowledgeTab>(() =>
    tabParam === 'discovery' ||
    tabParam === 'timeline' ||
    tabParam === 'pending' ||
    tabParam === 'catalog'
      ? tabParam
      : 'catalog',
  );
  useEffect(() => {
    if (
      tabParam === 'discovery' ||
      tabParam === 'timeline' ||
      tabParam === 'pending' ||
      tabParam === 'catalog'
    ) {
      setTab(tabParam);
    }
  }, [tabParam]);
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState<CatalogFilter>('all');
  const [syncing, setSyncing] = useState(false);
  const [welcomeDismissed, setWelcomeDismissed] = useState(false);
  const [pendingDecision, setPendingDecision] = useState<KnowledgeSuggestion | null>(null);
  const realGitHub = useMemo(() => parseProjectGitHubSource(project), [project]);

  const featuredId = searchParams.get('feature');
  const selectedFeature =
    features.find((feature) => feature.id === featuredId) ??
    features.find((feature) => filterFeature(feature, filter)) ??
    features[0];

  const filteredFeatures = useMemo(() => {
    const term = query.trim().toLowerCase();
    return features.filter((feature) => {
      if (!filterFeature(feature, filter)) return false;
      if (!term) return true;
      return `${feature.name} ${feature.summary} ${feature.category} ${feature.tags.join(' ')}`
        .toLowerCase()
        .includes(term);
    });
  }, [features, filter, query]);

  const pendingSuggestions = suggestions.filter((suggestion) => suggestion.status === 'pending');
  const handledSuggestions = suggestions.filter((suggestion) => suggestion.status !== 'pending');
  const verifiedClaims = claims.filter((claim) => claim.status === 'verified').length;
  const attentionClaims = claims.filter((claim) => claim.status !== 'verified');
  const welcome = searchParams.get('welcome') === '1' && !welcomeDismissed;

  if (!project) return <NotFoundInline label="项目不存在或已被删除。" />;

  const selectFeature = (featureId: string) => {
    setSearchParams(
      (prev) => {
        const next = new URLSearchParams(prev);
        next.set('feature', featureId);
        next.delete('welcome');
        return next;
      },
      { replace: true },
    );
  };

  const handleTabChange = (nextTab: KnowledgeTab) => {
    setTab(nextTab);
    setSearchParams(
      (prev) => {
        const next = new URLSearchParams(prev);
        if (nextTab === 'catalog') next.delete('tab');
        else next.set('tab', nextTab);
        return next;
      },
      { replace: true },
    );
  };

  const handleSync = async () => {
    if (realGitHub) {
      setSyncing(true);
      try {
        const client = await getGitHubKnowledgeClient();
        const snapshot = await client.indexRepository(realGitHub.repo, {
          branch: realGitHub.branch,
        });
        const staleness = await client.refreshStaleness(realGitHub.repo, {
          snapshotId: snapshot.id,
        });
        const report = await client.discoverPullRequests(realGitHub.repo, {
          branch: realGitHub.branch,
          snapshotId: snapshot.id,
          state: 'closed',
          limit: 20,
        });
        const candidates = await client.listCandidates(realGitHub.repo, { limit: 100 });
        const summary = reconcileDiscoveryCandidates(project.id, candidates, {
          snapshotId: snapshot.id,
          commitSha: snapshot.gitCommitSha,
          branch: snapshot.branch,
          syncedAt: snapshot.indexedAt,
        });
        handleTabChange('discovery');
        pushToast({
          tone:
            staleness.claimsMarkedStale.length > 0 || summary.invalidatedVideoIds.length > 0
              ? 'warning'
              : 'success',
          title: `真实同步完成（${snapshot.stats.mode}）`,
          description: `分析 ${report.summary.analyzed} 个 PR；复用 ${snapshot.stats.reusedFiles} / 下载 ${snapshot.stats.fetchedFiles}${
            summary.invalidatedVideoIds.length > 0
              ? `；${summary.invalidatedVideoIds.length} 条已批准视频因过期失效`
              : ''
          }。`,
        });
      } catch (syncError) {
        pushToast({
          tone: 'danger',
          title: '真实 GitHub 同步失败',
          description:
            syncError instanceof Error ? syncError.message : '无法连接本机 ASVS API。',
        });
      } finally {
        setSyncing(false);
      }
      return;
    }

    setSyncing(true);
    const result = await syncProjectKnowledge(project.id);
    setSyncing(false);
    pushToast({
      tone: 'success',
      title: '知识同步完成',
      description: result?.message ?? '来源时间戳与模拟快照已更新。',
    });
  };

  return (
    <Page wide>
      <PageHeader
        eyebrow={
          <>
            <span className="size-1.5 rounded-full bg-accent" />
            {project.name} · Knowledge center
          </>
        }
        title="知识中心"
        description="功能、声明与证据是视频卖点的唯一来源。AI 的推断不会自动变成事实。"
        actions={
          <>
            <Button variant="secondary" onClick={handleSync} loading={syncing} icon={<RefreshCw size={14} />}>
              {syncing ? '同步中…' : realGitHub ? '增量索引并发现 PR' : '模拟重新分析'}
            </Button>
            <Link to={`/projects/${project.id}/videos/new`} className={buttonStyles({ variant: 'primary' })}>
              <Sparkles size={14} />
              创建视频
            </Link>
          </>
        }
      />

      {welcome ? (
        <Callout
          tone="success"
          className="mt-4"
          title={
            realGitHub
              ? `真实仓库初始化完成：已连接 ${realGitHub.source.name}（${realGitHub.branch}）`
              : `初始化完成：模拟分析发现了 ${features.length} 个候选功能`
          }
          action={
            <button
              type="button"
              onClick={() => setWelcomeDismissed(true)}
              aria-label="关闭欢迎提示"
              className="text-success/70 hover:text-success"
            >
              <X size={14} />
            </button>
          }
        >
          {realGitHub
            ? '请在「PR 变更发现」中选择用户可感知的 PR 写入功能目录，并补齐运行态与人工核验（AC-03）。'
            : '这些功能默认是候选状态，需要人工确认后才适合用于对外视频。先检查声明与证据，再创建视频。'}
        </Callout>
      ) : null}

      <div className="mt-4 flex flex-wrap items-center gap-x-5 gap-y-2 rounded-lg border border-line bg-surface/60 px-4 py-3 text-[11px] text-muted">
        <span className="flex items-center gap-1.5">
          <span className="size-1.5 rounded-full bg-success" />
          {project.sources.filter((source) => source.status === 'connected').length} 个来源已连接
        </span>
        <span className="text-line-strong">·</span>
        <span>{features.length} 个功能</span>
        <span>{claims.length} 条声明</span>
        <span>
          <span className="text-success">{verifiedClaims}</span> 已核验
        </span>
        <span>
          <span className="text-warn">{attentionClaims.length}</span> 待处理
        </span>
        <span className="text-line-strong">·</span>
        <span className="font-mono text-[10px]">
          {realGitHub
            ? `${realGitHub.source.name} · ${realGitHub.branch}${
                realGitHub.source.lastSnapshotId
                  ? ` · ${realGitHub.source.lastSnapshotId.slice(0, 13)}`
                  : ''
              }`
            : `${project.sources[0]?.scope ?? 'main'} · analysis #${project.analysisCount}`}
        </span>
        <span className="ml-auto flex items-center gap-1.5 text-[10px] text-faint">
          <Clock3 size={11} />
          {project.sources[0]?.lastSyncedAt
            ? `同步于 ${formatRelativeTime(project.sources[0].lastSyncedAt)}`
            : '尚未同步'}
        </span>
        {realGitHub ? (
          <Badge tone="success" dot={false}>真实只读 GitHub</Badge>
        ) : (
          <Badge tone="outline" dot={false}>Demo 快照</Badge>
        )}
      </div>

      <Tabs value={tab} onValueChange={(value) => handleTabChange(value as KnowledgeTab)} className="mt-5">
        <TabsList>
          <TabsTrigger value="catalog">
            <BookOpen size={13} /> 功能目录
            <span className="rounded-full bg-overlay px-1.5 py-0.5 font-mono text-[9px] text-faint">
              {features.length}
            </span>
          </TabsTrigger>
          <TabsTrigger value="discovery">
            <GitPullRequest size={13} /> PR 变更发现
            {realGitHub ? (
              <span className="rounded-full bg-success-soft px-1.5 py-0.5 font-mono text-[9px] text-success">
                真实
              </span>
            ) : null}
          </TabsTrigger>
          <TabsTrigger value="timeline">
            <GitPullRequest size={13} /> 时间线
            <span className="rounded-full bg-overlay px-1.5 py-0.5 font-mono text-[9px] text-faint">
              {pullRequests.length + releases.length}
            </span>
          </TabsTrigger>
          <TabsTrigger value="pending">
            <Sparkles size={13} /> 待确认
            {pendingSuggestions.length > 0 ? (
              <span className="rounded-full bg-ai-soft px-1.5 py-0.5 font-mono text-[9px] text-ai">
                {pendingSuggestions.length}
              </span>
            ) : null}
          </TabsTrigger>
        </TabsList>

        <TabsContent value="catalog">
          <div className="grid grid-cols-[minmax(0,1fr)] gap-4 xl:grid-cols-[280px_minmax(0,1fr)_300px]">
            <Panel className="h-fit overflow-hidden">
              <div className="border-b border-line p-3">
                <div className="relative">
                  <Search size={13} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-faint" />
                  <Input
                    value={query}
                    onChange={(event) => setQuery(event.target.value)}
                    placeholder="搜索功能…"
                    className="h-8 pl-8 text-[12px]"
                    aria-label="搜索功能"
                  />
                </div>
                <div className="mt-2 flex flex-wrap gap-1">
                  {[
                    { value: 'all' as const, label: '全部' },
                    { value: 'verified' as const, label: '已核验' },
                    { value: 'attention' as const, label: '待处理' },
                    { value: 'proposed' as const, label: '候选' },
                  ].map((item) => (
                    <button
                      key={item.value}
                      type="button"
                      onClick={() => setFilter(item.value)}
                      className={cn(
                        'rounded-full border px-2 py-0.5 text-[10px] transition-colors',
                        filter === item.value
                          ? 'border-accent/40 bg-accent-soft text-accent'
                          : 'border-line text-faint hover:text-fg',
                      )}
                    >
                      {item.label}
                    </button>
                  ))}
                </div>
              </div>
              <div className="max-h-[620px] overflow-y-auto p-1.5">
                {filteredFeatures.length === 0 ? (
                  <div className="px-3 py-8 text-center text-[11px] text-faint">没有匹配的功能。</div>
                ) : (
                  filteredFeatures.map((feature) => {
                    const featureClaims = claims.filter((claim) => claim.featureId === feature.id);
                    const attention = featureClaims.some((claim) => claim.status !== 'verified') || feature.status === 'stale';
                    const selected = selectedFeature?.id === feature.id;
                    return (
                      <button
                        key={feature.id}
                        type="button"
                        onClick={() => selectFeature(feature.id)}
                        className={cn(
                          'mb-0.5 flex w-full items-start gap-2 rounded-sm px-2.5 py-2 text-left transition-colors',
                          selected ? 'bg-overlay text-fg' : 'text-muted hover:bg-overlay/50',
                        )}
                      >
                        <span
                          className={cn(
                            'mt-1.5 size-1.5 shrink-0 rounded-full',
                            feature.status === 'verified' || feature.status === 'deployed'
                              ? 'bg-success'
                              : feature.status === 'stale'
                                ? 'bg-danger'
                                : attention
                                  ? 'bg-warn'
                                  : 'bg-faint',
                          )}
                        />
                        <span className="min-w-0 flex-1">
                          <span className="flex items-center gap-1.5">
                            <span className="truncate text-[11.5px] font-medium">{feature.name}</span>
                          </span>
                          <span className="mt-0.5 flex items-center gap-1.5 text-[9.5px] text-faint">
                            <span>{feature.category}</span>
                            <span>·</span>
                            <span>{featureClaims.length} 条声明</span>
                            {feature.status === 'stale' ? <span className="text-danger">· 过期</span> : null}
                          </span>
                        </span>
                        {selected ? <ChevronRight size={12} className="mt-1 shrink-0 text-accent" /> : null}
                      </button>
                    );
                  })
                )}
              </div>
              <div className="border-t border-line p-3">
                <div className="flex items-center justify-between text-[10px] text-faint">
                  <span>置信度</span>
                  <span>中位 {medianConfidence(features)}%</span>
                </div>
                <p className="mt-1 text-[9.5px] leading-4 text-faint">
                  置信度只是模拟分析信号，不等于证据。审核只看 Claim 状态。
                </p>
              </div>
            </Panel>

            {selectedFeature ? (
              <FeatureDetail
                key={selectedFeature.id}
                projectId={project.id}
                realRepo={realGitHub?.repo}
                feature={selectedFeature}
                claims={claims.filter((claim) => claim.featureId === selectedFeature.id)}
                evidence={evidence}
                pullRequests={pullRequests.filter((pr) => selectedFeature.prIds.includes(pr.id))}
                releases={releases}
                videos={videos}
                onToast={pushToast}
              />
            ) : (
              <EmptyState
                icon={<BookOpen size={20} />}
                title="还没有功能"
                description="同步知识后，模拟分析会提出候选功能，等待人工确认。"
              />
            )}

            <div className="space-y-4">
              <Panel>
                <PanelHeader
                  title="证据原则"
                  description="每个对外说法都必须能回溯到证据。"
                />
                <div className="space-y-2 px-4 pb-4">
                  {[
                    { label: '已核验', detail: '可用于视频与发布', tone: 'success' as const },
                    { label: '待验证', detail: '字幕必须保留限定表述', tone: 'warn' as const },
                    { label: '已过期', detail: '阻断审核，需重新验证', tone: 'danger' as const },
                    { label: '缺失', detail: '不能作为卖点', tone: 'neutral' as const },
                  ].map((item) => (
                    <div key={item.label} className="flex items-center justify-between gap-2 text-[10.5px]">
                      <Badge tone={item.tone}>{item.label}</Badge>
                      <span className="text-faint">{item.detail}</span>
                    </div>
                  ))}
                </div>
              </Panel>

              <Panel>
                <PanelHeader title="关联合并记录" description="只展示与该功能相关的 PR。" />
                <div className="divide-y divide-line border-t border-line">
                  {selectedFeature?.prIds.length ? (
                    pullRequests
                      .filter((pr) => selectedFeature.prIds.includes(pr.id))
                      .map((pr) => (
                        <div key={pr.id} className="px-4 py-2.5">
                          <div className="flex items-center gap-2">
                            <span className="font-mono text-[9.5px] text-faint">#{pr.number}</span>
                            <span className="truncate text-[10.5px] text-fg">{pr.title}</span>
                          </div>
                          <div className="mt-1 flex items-center gap-1.5 text-[9px] text-faint">
                            <GitPullRequest size={10} />
                            {pr.author} · {formatDate(pr.mergedAt)}
                            {pr.kind === 'internal' ? <span className="text-warn">· 内部改动</span> : null}
                          </div>
                        </div>
                      ))
                  ) : (
                    <div className="px-4 py-5 text-center text-[10.5px] text-faint">没有关联 PR。</div>
                  )}
                </div>
              </Panel>

              {attentionClaims.length > 0 ? (
                <Callout tone="warning" size="sm" title={`${attentionClaims.length} 条声明需要关注`}>
                  使用待验证或过期声明的视频，会在审核时被阻断或要求补充限定表述。
                </Callout>
              ) : (
                <Callout tone="success" size="sm" title="所有声明已核验">
                  当前知识可以安全用于对外视频。
                </Callout>
              )}
            </div>
          </div>
        </TabsContent>

        <TabsContent value="discovery">
          <KnowledgeDiscoveryPanel
            project={project}
            features={features}
            claims={claims}
            onOpenFeature={(featureId) => {
              handleTabChange('catalog');
              selectFeature(featureId);
            }}
            onToast={pushToast}
          />
        </TabsContent>

        <TabsContent value="timeline">
          <Panel className="overflow-hidden">
            <PanelHeader
              title="合并记录与 Release"
              description="模拟 GitHub 快照；内部改动不会进入视频卖点。"
              actions={<Badge tone="outline" dot={false}>{pullRequests.length} PR · {releases.length} Release</Badge>}
            />
            <div className="border-t border-line">
              {[...pullRequests.map((pr) => ({
                id: pr.id,
                at: pr.mergedAt,
                kind: 'pr' as const,
                data: pr,
              })), ...releases.map((release) => ({
                id: release.id,
                at: release.releasedAt,
                kind: 'release' as const,
                data: release,
              }))]
                .sort((a, b) => new Date(b.at).getTime() - new Date(a.at).getTime())
                .map((entry) => (
                  <div key={entry.id} className="flex gap-3 border-b border-line px-5 py-3 last:border-b-0">
                    <span className="mt-0.5 grid size-7 shrink-0 place-items-center rounded-sm border border-line bg-raised text-faint">
                      {entry.kind === 'release' ? <Tag size={13} /> : <GitPullRequest size={13} />}
                    </span>
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-2">
                        {entry.kind === 'pr' ? (
                          <span className="font-mono text-[10px] text-faint">#{entry.data.number}</span>
                        ) : (
                          <Badge tone="accent" dot={false}>{entry.data.version}</Badge>
                        )}
                        <span className="text-[12px] font-medium text-fg">
                          {entry.kind === 'pr' ? entry.data.title : entry.data.name}
                        </span>
                        {entry.kind === 'pr' && entry.data.kind === 'internal' ? (
                          <Badge tone="warn" dot={false}>内部 · 不建议宣传</Badge>
                        ) : null}
                        {entry.kind === 'pr' && entry.data.kind === 'feature' ? (
                          <Badge tone="success" dot={false}>功能</Badge>
                        ) : null}
                      </div>
                      <p className="mt-1 text-[10.5px] leading-[17px] text-muted">
                        {entry.kind === 'pr' ? entry.data.summary : entry.data.highlight}
                      </p>
                      <div className="mt-1 flex items-center gap-2 text-[9.5px] text-faint">
                        <span>{entry.kind === 'pr' ? entry.data.author : 'Release'}</span>
                        <span>·</span>
                        <span>{formatDate(entry.at)}</span>
                        {entry.kind === 'pr' && entry.data.featureIds.length > 0 ? (
                          <>
                            <span>·</span>
                            <span>{entry.data.featureIds.length} 个关联功能</span>
                          </>
                        ) : null}
                      </div>
                    </div>
                  </div>
                ))}
              {pullRequests.length === 0 && releases.length === 0 ? (
                <div className="px-5 py-14 text-center text-[12px] text-muted">
                  该项目没有 GitHub 快照。使用文档或网址接入时，这里会为空。
                </div>
              ) : null}
            </div>
          </Panel>
        </TabsContent>

        <TabsContent value="pending">
          <div className="grid grid-cols-[minmax(0,1fr)] gap-4 xl:grid-cols-[minmax(0,1fr)_300px]">
            <div className="space-y-3">
              {pendingSuggestions.length === 0 ? (
                <EmptyState
                  icon={<CheckCircle2 size={20} />}
                  title="没有待确认建议"
                  description="模拟 AI 没有提出新的功能、证据或状态变化。你可以继续创建视频。"
                />
              ) : (
                pendingSuggestions.map((suggestion) => (
                  <SuggestionCard
                    key={suggestion.id}
                    suggestion={suggestion}
                    features={features}
                    onDecision={() => setPendingDecision(suggestion)}
                  />
                ))
              )}
              {handledSuggestions.length > 0 ? (
                <Panel>
                  <PanelHeader title="已处理建议" description="保留记录，方便追溯人工决定。" />
                  <div className="divide-y divide-line border-t border-line">
                    {handledSuggestions.map((suggestion) => (
                      <div key={suggestion.id} className="flex items-center gap-2 px-4 py-2.5">
                        {suggestion.status === 'accepted' ? (
                          <Check size={12} className="text-success" />
                        ) : (
                          <CircleSlash size={12} className="text-faint" />
                        )}
                        <span className="min-w-0 flex-1 truncate text-[11px] text-muted">{suggestion.title}</span>
                        <Badge tone={suggestion.status === 'accepted' ? 'success' : 'neutral'} dot={false}>
                          {suggestion.status === 'accepted' ? '已接受' : '已拒绝'}
                        </Badge>
                      </div>
                    ))}
                  </div>
                </Panel>
              ) : null}
            </div>
            <div className="space-y-3">
              <Callout tone="ai" title="AI 建议不会直接成为事实">
                接受建议会新增模拟证据或候选功能，并写入活动记录；它不会调用真实模型，也不能跳过人工审核。
              </Callout>
              <Panel>
                <PanelHeader title="对你视频的影响" />
                <div className="space-y-2 px-4 pb-4 text-[10.5px] leading-4 text-muted">
                  <p>· 接受「关联证据」会把声明升级为已验证，可能解除审核阻断。</p>
                  <p>· 接受「新功能」只创建候选功能，仍需要补证据后才适合用于视频。</p>
                  <p>· 拒绝建议不会删除已有知识，只会记录决定。</p>
                </div>
              </Panel>
            </div>
          </div>
        </TabsContent>
      </Tabs>

      <SuggestionDecisionDialog
        suggestion={pendingDecision}
        onClose={() => setPendingDecision(null)}
        onAccepted={(suggestion) => {
          setPendingDecision(null);
          setTab('catalog');
          if (suggestion.targetId && features.some((feature) => feature.id === suggestion.targetId)) {
            selectFeature(suggestion.targetId);
          }
          pushToast({
            tone: 'success',
            title: '建议已接受',
            description: '知识已更新；受影响的声明与审核检查会立即重新计算。',
          });
        }}
        onRejected={() => {
          setPendingDecision(null);
          pushToast({ tone: 'info', title: '建议已拒绝', description: '决定已记录，不会修改现有知识。' });
        }}
      />
    </Page>
  );
}

function filterFeature(feature: Feature, filter: CatalogFilter): boolean {
  if (filter === 'all') return true;
  if (filter === 'verified') return feature.status === 'verified' || feature.status === 'deployed';
  if (filter === 'proposed') return feature.status === 'proposed';
  return feature.status === 'stale' || ['proposed', 'implemented', 'stale'].includes(feature.status);
}

function medianConfidence(features: Feature[]): number {
  if (features.length === 0) return 0;
  const values = features.map((feature) => feature.confidence).sort((a, b) => a - b);
  return values[Math.floor(values.length / 2)] ?? 0;
}

function FeatureDetail({
  projectId,
  realRepo,
  feature,
  claims,
  evidence,
  pullRequests,
  releases,
  videos,
  onToast,
}: {
  projectId: string;
  realRepo?: GitHubRepoRef;
  feature: Feature;
  claims: Claim[];
  evidence: Evidence[];
  pullRequests: { id: string; number: number; title: string; kind: string; mergedAt: string; author: string }[];
  releases: { id: string; version: string; name: string; highlight: string; releasedAt: string }[];
  videos: { id: string; title: string; scenes: { id: string; featureId?: string }[] }[];
  onToast: (toast: { tone: 'success' | 'info' | 'warning' | 'danger'; title: string; description?: string }) => void;
}) {
  const updateFeature = useStudioStore((state) => state.updateFeature);
  const reverifyClaim = useStudioStore((state) => state.reverifyClaim);
  const [editing, setEditing] = useState(false);
  const [verifyClaim, setVerifyClaim] = useState<Claim | null>(null);
  const [auditClaim, setAuditClaim] = useState<Claim | null>(null);
  const [draft, setDraft] = useState({
    name: feature.name,
    summary: feature.summary,
    category: feature.category,
    status: feature.status,
  });

  const relatedVideos = videos.filter((video) => video.scenes.some((scene) => scene.featureId === feature.id));

  const save = () => {
    if (!draft.name.trim()) return;
    updateFeature(feature.id, {
      name: draft.name.trim(),
      summary: draft.summary.trim(),
      category: draft.category.trim() || feature.category,
      status: draft.status,
      userConfirmed: true,
    });
    setEditing(false);
    onToast({
      tone: 'success',
      title: '功能已更新',
      description: '修改会同步到关联镜头、审核检查与项目概览。',
    });
  };

  return (
    <Panel className="overflow-hidden">
      <div className="border-b border-line p-5">
        <div className="flex items-start justify-between gap-4">
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-[10px] uppercase tracking-[0.12em] text-faint">{feature.category}</span>
              <FeatureStatusBadge status={feature.status} />
              {feature.userConfirmed ? (
                <Badge tone="outline" dot={false}>
                  已人工确认
                </Badge>
              ) : (
                <Badge tone="warn" dot={false}>
                  待人工确认
                </Badge>
              )}
              <Badge tone="outline" dot={false}>{feature.confidence}% 置信度</Badge>
            </div>
            {editing ? (
              <div className="mt-3 space-y-3">
                <Field label="功能名称" required>
                  <Input value={draft.name} onChange={(event) => setDraft({ ...draft, name: event.target.value })} />
                </Field>
                <Field label="摘要">
                  <Textarea
                    value={draft.summary}
                    onChange={(event) => setDraft({ ...draft, summary: event.target.value })}
                    className="min-h-[70px]"
                  />
                </Field>
                <div className="grid gap-3 sm:grid-cols-2">
                  <Field label="分类">
                    <Input
                      value={draft.category}
                      onChange={(event) => setDraft({ ...draft, category: event.target.value })}
                    />
                  </Field>
                  <Field label="状态">
                    <Select
                      value={draft.status}
                      onChange={(event) => setDraft({ ...draft, status: event.target.value as FeatureStatus })}
                    >
                      {FEATURE_STATUSES.map((status) => (
                        <option key={status} value={status}>
                          {FEATURE_STATUS_META[status].label}
                        </option>
                      ))}
                    </Select>
                  </Field>
                </div>
              </div>
            ) : (
              <>
                <h2 className="mt-2 font-display text-[22px] font-medium leading-7 tracking-[-0.02em] text-fg">
                  {feature.name}
                </h2>
                <p className="mt-1.5 max-w-2xl text-[12.5px] leading-5 text-muted">{feature.summary}</p>
              </>
            )}
            <div className="mt-3 flex flex-wrap items-center gap-1.5">
              {feature.tags.map((tag) => (
                <span key={tag} className="rounded-sm bg-overlay px-1.5 py-0.5 text-[9.5px] text-muted">
                  {tag}
                </span>
              ))}
              <span className="ml-1 font-mono text-[9.5px] text-faint">{feature.demoRoute}</span>
            </div>
          </div>
          <div className="flex shrink-0 gap-1">
            {editing ? (
              <>
                <Button variant="ghost" size="sm" onClick={() => { setEditing(false); setDraft({ name: feature.name, summary: feature.summary, category: feature.category, status: feature.status }); }}>
                  取消
                </Button>
                <Button variant="primary" size="sm" onClick={save}>
                  保存
                </Button>
              </>
            ) : (
              <>
                <Link
                  to={`/projects/${projectId}/videos/new?feature=${feature.id}`}
                  className={buttonStyles({ variant: 'secondary', size: 'sm' })}
                >
                  <Sparkles size={12} /> 创建视频
                </Link>
                <Button
                  variant="ghost"
                  size="sm"
                  icon={<Pencil size={12} />}
                  onClick={() => setEditing(true)}
                >
                  编辑
                </Button>
              </>
            )}
          </div>
        </div>

        <div className="mt-4 grid grid-cols-2 gap-2 sm:grid-cols-4">
          <MiniStat label="声明" value={`${claims.length}`} hint={`${claims.filter((claim) => claim.status === 'verified').length} 已核验`} />
          <MiniStat
            label="证据"
            value={`${evidence.filter((item) => claims.some((claim) => claim.id === item.claimId)).length}`}
            hint={feature.demo ? '含模拟来源' : '源码 / 核验追踪'}
          />
          <MiniStat label="关联视频" value={`${relatedVideos.length}`} hint="使用该功能" />
          <MiniStat label="更新" value={formatRelativeTime(feature.updatedAt)} hint="人工或分析" small />
        </div>
      </div>

      <div className="p-5">
        <div className="mb-3 flex items-center justify-between">
          <h3 className="font-display text-[14px] font-medium text-fg">声明与证据</h3>
          <span className="text-[10px] text-faint">必须能逐条回溯</span>
        </div>
        {claims.length === 0 ? (
          <Callout tone="warning" size="sm">
            这个功能还没有声明，不能作为视频卖点。接受“新功能”建议后需要补充证据。
          </Callout>
        ) : (
          <div className="space-y-3">
            {claims.map((claim) => {
              const claimEvidence = evidence.filter((item) => item.claimId === claim.id);
              return (
                <div key={claim.id} className="rounded-md border border-line bg-raised/20">
                  <div className="flex flex-wrap items-start justify-between gap-2 border-b border-line px-3.5 py-3">
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-2">
                        {claim.eligibility ? (
                          <ClaimEligibilityBadge eligibility={claim.eligibility} />
                        ) : null}
                        <ClaimStatusBadge status={claim.status} />
                        <span className="text-[11.5px] leading-5 text-fg">{claim.statement}</span>
                      </div>
                      <div className="mt-1 flex flex-wrap items-center gap-2 text-[9.5px] text-faint">
                        <span>面向：{claim.audience}</span>
                        {claim.verification ? (
                          <span>
                            · {claim.verification.environment} · {claim.verification.appVersion} ·{' '}
                            {formatDate(claim.verification.verifiedAt)}
                            {claim.verification.commitSha
                              ? ` · commit ${claim.verification.commitSha.slice(0, 8)}`
                              : ''}
                          </span>
                        ) : (
                          <span>· 还没有核验记录</span>
                        )}
                      </div>
                      {claim.blockers && claim.blockers.length > 0 ? (
                        <div className="mt-1.5 flex items-start gap-1.5 text-[10px] text-danger">
                          <AlertTriangle size={11} className="mt-0.5 shrink-0" />
                          <span>{claim.blockers.join(' ')}</span>
                        </div>
                      ) : claim.guidance ? (
                        <div className="mt-1 text-[10px] text-muted">{claim.guidance}</div>
                      ) : null}
                    </div>
                    {!claim.demo && realRepo && claim.sourceClaimId ? (
                      <div className="flex shrink-0 items-center gap-1">
                        <Button
                          variant="secondary"
                          size="sm"
                          icon={<ShieldCheck size={11} />}
                          onClick={() => setVerifyClaim(claim)}
                        >
                          提交核验记录
                        </Button>
                        <Button
                          variant="ghost"
                          size="sm"
                          icon={<History size={11} />}
                          onClick={() => setAuditClaim(claim)}
                        >
                          核验审计
                        </Button>
                      </div>
                    ) : claim.status !== 'verified' ? (
                      <Button
                        variant="ghost"
                        size="sm"
                        icon={<RefreshCw size={11} />}
                        onClick={() => {
                          reverifyClaim(claim.id);
                          onToast({
                            tone: 'success',
                            title: `「${feature.name}」已重新验证`,
                            description: '新增了一条模拟运行时证据，声明状态更新为已核验。',
                          });
                        }}
                      >
                        重新验证
                      </Button>
                    ) : (
                      <span className="flex items-center gap-1 text-[10px] text-success">
                        <ShieldCheck size={12} /> 可发布
                      </span>
                    )}
                  </div>
                  <div className="divide-y divide-line/60">
                    {claimEvidence.map((item) => {
                      const meta = EVIDENCE_KIND_META[item.kind];
                      const Icon = meta.icon;
                      const statusMeta = EVIDENCE_META[item.status];
                      return (
                        <div key={item.id} className="flex items-start gap-2.5 px-3.5 py-2.5">
                          <span className="mt-0.5 grid size-6 shrink-0 place-items-center rounded-sm border border-line bg-overlay text-faint">
                            <Icon size={12} />
                          </span>
                          <div className="min-w-0 flex-1">
                            <div className="flex flex-wrap items-center gap-1.5">
                              <span className="text-[10.5px] text-fg">{item.title}</span>
                              <span className="rounded-sm bg-overlay px-1 py-0.5 text-[8.5px] text-faint">
                                {meta.label}
                              </span>
                              <StatusBadge meta={statusMeta} />
                              {item.decision ? (
                                <Badge
                                  tone={item.decision === 'approve' ? 'success' : 'danger'}
                                  dot={false}
                                >
                                  {item.decision}
                                </Badge>
                              ) : null}
                            </div>
                            <div className="mt-0.5 text-[9.5px] leading-4 text-faint">
                              {item.detail} · <span className="font-mono">{item.ref}</span>
                              {item.sourceDigest ? (
                                <span className="font-mono"> · sha256:{item.sourceDigest.slice(0, 12)}</span>
                              ) : null}
                              {item.actor ? <span> · {item.actor}</span> : null}
                            </div>
                          </div>
                          {item.demo ? <span className="shrink-0 text-[8.5px] text-faint">Demo</span> : null}
                        </div>
                      );
                    })}
                    {claimEvidence.length === 0 ? (
                      <div className="px-3.5 py-2.5 text-[10px] text-warn">没有证据。此声明不能用于公开视频。</div>
                    ) : null}
                  </div>
                </div>
              );
            })}
          </div>
        )}

        <div className="mt-5 grid gap-4 sm:grid-cols-2">
          <div>
            <h3 className="mb-2 font-display text-[13px] font-medium text-fg">来源引用</h3>
            <div className="space-y-1.5">
              {feature.sourceRefs.map((source, index) => (
                <div key={`${source.label}-${index}`} className="flex items-start gap-2 text-[10.5px]">
                  <Link2 size={11} className="mt-0.5 shrink-0 text-faint" />
                  <div>
                    <span className="text-fg">{source.label}</span>
                    <span className="text-faint"> · {source.detail}</span>
                  </div>
                </div>
              ))}
            </div>
          </div>
          <div>
            <h3 className="mb-2 font-display text-[13px] font-medium text-fg">关联视频</h3>
            {relatedVideos.length === 0 ? (
              <p className="text-[10.5px] text-faint">还没有视频使用这个功能。</p>
            ) : (
              <div className="space-y-1.5">
                {relatedVideos.slice(0, 4).map((video) => (
                  <Link
                    key={video.id}
                    to={`/videos/${video.id}/storyboard`}
                    className="flex items-center gap-2 rounded-sm border border-line bg-raised/30 px-2 py-1.5 text-[10.5px] text-muted transition-colors hover:border-line-strong hover:text-fg"
                  >
                    <span className="truncate">{video.title}</span>
                    <ArrowRight size={10} className="ml-auto shrink-0" />
                  </Link>
                ))}
              </div>
            )}
          </div>
        </div>

        {pullRequests.length > 0 || releases.length > 0 ? (
          <div className="mt-5 border-t border-line pt-4">
            <h3 className="mb-2 font-display text-[13px] font-medium text-fg">可追溯来源</h3>
            <div className="flex flex-wrap gap-1.5">
              {pullRequests.map((pr) => (
                <span key={pr.id} className="rounded-sm border border-line px-2 py-1 text-[9.5px] text-muted">
                  PR #{pr.number} · {pr.title}
                </span>
              ))}
              {releases.map((release) => (
                <span key={release.id} className="rounded-sm border border-line px-2 py-1 text-[9.5px] text-muted">
                  {release.version} · {release.name}
                </span>
              ))}
            </div>
          </div>
        ) : null}
      </div>

      {verifyClaim && realRepo && verifyClaim.sourceClaimId ? (
        <ClaimVerificationDialog
          open={Boolean(verifyClaim)}
          onOpenChange={(open) => {
            if (!open) setVerifyClaim(null);
          }}
          repo={realRepo}
          claimId={verifyClaim.sourceClaimId}
          claimStatement={verifyClaim.statement}
          currentEligibility={verifyClaim.eligibility}
          onVerified={async (updatedClaim) => {
            const client = await getGitHubKnowledgeClient();
            const candidate = verifyClaim.sourceCandidateId
              ? await client.getCandidate(realRepo, verifyClaim.sourceCandidateId)
              : null;
            const list = candidate
              ? [candidate]
              : await client.listCandidates(realRepo, { limit: 100 });
            reconcileDiscoveryCandidates(projectId, list);
            onToast({
              tone: updatedClaim.eligibility === 'publishable' ? 'success' : 'info',
              title: '核验记录已写入',
              description: `最新资格：${updatedClaim.eligibility}（${updatedClaim.guidance}）`,
            });
          }}
        />
      ) : null}

      {auditClaim && realRepo && auditClaim.sourceClaimId ? (
        <ClaimVerificationAuditDialog
          open={Boolean(auditClaim)}
          onOpenChange={(open) => {
            if (!open) setAuditClaim(null);
          }}
          repo={realRepo}
          claimId={auditClaim.sourceClaimId}
          claimStatement={auditClaim.statement}
        />
      ) : null}
    </Panel>
  );
}

function MiniStat({
  label,
  value,
  hint,
  small,
}: {
  label: string;
  value: string;
  hint: string;
  small?: boolean;
}) {
  return (
    <div className="rounded-sm border border-line bg-raised/30 px-2.5 py-2">
      <div className="text-[9px] uppercase tracking-wide text-faint">{label}</div>
      <div className={cn('font-display text-fg', small ? 'mt-0.5 text-[11px]' : 'text-[17px]')}>{value}</div>
      <div className="text-[9px] text-faint">{hint}</div>
    </div>
  );
}

function SuggestionCard({
  suggestion,
  features,
  onDecision,
}: {
  suggestion: KnowledgeSuggestion;
  features: Feature[];
  onDecision: () => void;
}) {
  const target = suggestion.targetId ? features.find((feature) => feature.id === suggestion.targetId) : undefined;
  return (
    <Panel className="p-4">
      <div className="flex items-start gap-3">
        <span className="mt-0.5 grid size-8 shrink-0 place-items-center rounded-md border border-ai/25 bg-ai-soft text-ai">
          <Sparkles size={15} />
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-[12.5px] font-medium text-fg">{suggestion.title}</span>
            <Badge tone="ai" dot={false}>
              {suggestion.kind === 'new_feature'
                ? '新功能'
                : suggestion.kind === 'link_evidence'
                  ? '补充证据'
                  : '状态变化'}
            </Badge>
            <Badge tone="outline" dot={false}>{suggestion.confidence}% 置信度</Badge>
          </div>
          <p className="mt-1.5 text-[11px] leading-[18px] text-muted">{suggestion.rationale}</p>
          {target ? (
            <div className="mt-2 text-[10px] text-faint">
              影响功能：<span className="text-fg">{target.name}</span>
              {suggestion.proposedStatus ? ` · 建议状态：${FEATURE_STATUS_META[suggestion.proposedStatus].label}` : ''}
            </div>
          ) : null}
          {suggestion.proposedFeature ? (
            <div className="mt-2 rounded-sm border border-line bg-raised/30 px-2.5 py-2 text-[10px] text-muted">
              候选功能：<span className="text-fg">{suggestion.proposedFeature.name}</span> ·{' '}
              {suggestion.proposedFeature.category} · {suggestion.proposedFeature.confidence}% 置信度
            </div>
          ) : null}
          <div className="mt-3 flex items-center gap-2">
            <Button variant="primary" size="sm" onClick={onDecision}>
              查看并决定
            </Button>
            <span className="text-[9.5px] text-faint">接受后会立即写入本地知识</span>
          </div>
        </div>
      </div>
    </Panel>
  );
}

function SuggestionDecisionDialog({
  suggestion,
  onClose,
  onAccepted,
  onRejected,
}: {
  suggestion: KnowledgeSuggestion | null;
  onClose: () => void;
  onAccepted: (suggestion: KnowledgeSuggestion) => void;
  onRejected: (suggestion: KnowledgeSuggestion) => void;
}) {
  const acceptSuggestion = useStudioStore((state) => state.acceptKnowledgeSuggestion);
  const rejectSuggestion = useStudioStore((state) => state.rejectKnowledgeSuggestion);
  const [rememberChoice, setRememberChoice] = useState(true);

  if (!suggestion) return null;

  return (
    <Dialog open={Boolean(suggestion)} onOpenChange={(open) => { if (!open) onClose(); }}>
      <DialogContent
        title="决定这条知识建议"
        description="建议来自模拟分析。接受或拒绝都会立即记录，但不会调用真实模型。"
        footer={
          <>
            <Button variant="ghost" onClick={onClose}>取消</Button>
            <Button
              variant="danger"
              onClick={() => {
                rejectSuggestion(suggestion.id);
                onRejected(suggestion);
              }}
            >
              拒绝建议
            </Button>
            <Button
              variant="primary"
              onClick={() => {
                const ok = acceptSuggestion(suggestion.id);
                if (ok) onAccepted(suggestion);
                else onClose();
              }}
            >
              接受并写入知识
            </Button>
          </>
        }
      >
        <div className="rounded-md border border-ai/20 bg-ai-soft/40 p-3">
          <div className="flex items-center gap-2">
            <Sparkles size={14} className="text-ai" />
            <span className="text-[12px] font-medium text-fg">{suggestion.title}</span>
          </div>
          <p className="mt-1.5 text-[11px] leading-[18px] text-muted">{suggestion.rationale}</p>
        </div>
        <div className="mt-3 space-y-2 text-[11px] text-muted">
          <div className="flex justify-between gap-3 border-b border-line py-1.5">
            <span className="text-faint">建议类型</span>
            <span className="text-fg">
              {suggestion.kind === 'new_feature'
                ? '新增候选功能'
                : suggestion.kind === 'link_evidence'
                  ? '补充运行时证据'
                  : '更新功能状态'}
            </span>
          </div>
          <div className="flex justify-between gap-3 border-b border-line py-1.5">
            <span className="text-faint">置信度</span>
            <span className="text-fg">{suggestion.confidence}%（仅作参考）</span>
          </div>
          <div className="flex justify-between gap-3 border-b border-line py-1.5">
            <span className="text-faint">副作用</span>
            <span className="text-right text-fg">
              {suggestion.kind === 'link_evidence'
                ? '新增模拟证据并提升声明状态；视频审核会重新计算。'
                : suggestion.kind === 'new_feature'
                  ? '创建候选功能，仍需补充证据；不会自动用于视频。'
                  : '更新功能状态并标记人工确认。'}
            </span>
          </div>
        </div>
        <div className="mt-3 flex items-start gap-2">
          <Checkbox
            checked={rememberChoice}
            onCheckedChange={setRememberChoice}
            label="记录这次人工决定"
          />
          <div>
            <div className="text-[11px] text-fg">记录这次人工决定</div>
            <div className="text-[10px] text-faint">活动记录会保留建议标题与结果，方便追溯。</div>
          </div>
        </div>
        {!rememberChoice ? (
          <p className="mt-2 text-[10px] text-warn">如果不记录，决定只会在本次页面会话中生效。</p>
        ) : null}
      </DialogContent>
    </Dialog>
  );
}
