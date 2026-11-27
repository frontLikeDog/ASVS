import { useEffect, useRef, useState, type ReactNode } from 'react';
import { useNavigate } from 'react-router-dom';
import type {
  AspectRatio,
  BrandKit,
  FontPair,
  GitHubConnectionStatus,
  GitHubWriteProbeResult,
  LogoMark,
  OnboardingDraft,
  SourceConnection,
  SourceKind,
  VisualStyle,
} from '@asvs/domain';
import { formatGitHubRepoRef, parseGitHubRepoRef } from '@asvs/domain';
import {
  BRAND_PRESETS,
  DEFAULT_BRAND,
  cloneDraft,
  defaultOnboardingDraft,
  docsFromDraft,
} from './onboarding-draft';
import {
  ArrowLeft,
  ArrowRight,
  Check,
  FileText,
  GitPullRequest,
  Globe2,
  Layers,
  Loader2,
  ShieldCheck,
  Sparkles,
  Wand2,
} from 'lucide-react';
import {
  Badge,
  BrandMark,
  Button,
  Callout,
  Checkbox,
  Field,
  Input,
  Page,
  Panel,
  RadioCard,
  Select,
  Switch,
  Textarea,
  cn,
} from '@asvs/ui';
import {
  createRealGitHubProject,
  getGitHubKnowledgeClient,
  useStudioStore,
  useUiStore,
} from '@asvs/state';

const STEPS = [
  { title: '项目信息', description: '产品、项目与一句话定位' },
  { title: '接入方式', description: '选择可信事实从哪来' },
  { title: '知识来源', description: '确认同步范围与导入内容' },
  { title: '品牌套件', description: '决定视频的视觉语气' },
  { title: '演示环境', description: '声明演示边界与重置策略' },
  { title: '初始化', description: '确定性生成知识快照' },
];

type AccessMode = 'github' | 'website' | 'docs' | 'combo';

const ACCESS_MODES: {
  mode: AccessMode;
  methods: SourceKind[];
  title: string;
  description: string;
  icon: ReactNode;
}[] = [
  {
    mode: 'github',
    methods: ['github'],
    title: 'GitHub 仓库',
    description: '读取已合并 PR、提交与 Release，适合工程驱动的产品。',
    icon: <GitPullRequest size={16} />,
  },
  {
    mode: 'website',
    methods: ['website'],
    title: '产品网址',
    description: '从公开页面理解入口、文案与演示路径，不登录后台。',
    icon: <Globe2 size={16} />,
  },
  {
    mode: 'docs',
    methods: ['docs'],
    title: '产品文档',
    description: '提取功能说明、限制条件与标准术语，适合 To B 产品。',
    icon: <FileText size={16} />,
  },
  {
    mode: 'combo',
    methods: ['github', 'docs', 'website'],
    title: '组合来源',
    description: '把仓库、文档与线上产品放在一起交叉核对，最接近真实工作流。',
    icon: <Layers size={16} />,
  },
];

const INIT_STEPS = [
  { title: '验证来源权限', detail: '只读连接 · 不接受写入权限' },
  { title: '读取模拟 PR、文档与页面', detail: '从本地模板生成可信快照' },
  { title: '提取功能与对外声明', detail: '每一条声明都保留来源' },
  { title: '建立证据与限制条件', detail: '区分源码、测试、运行与人工确认' },
  { title: '写入本地知识快照', detail: '项目与知识同时生效' },
];

const REAL_INIT_STEPS = [
  { title: '核验 GitHub App 只读权限', detail: '严格 GET 只读，拒绝任何写权限（AC-01）' },
  { title: '运行 4B 增量知识索引', detail: '生成不可变快照与文件 SHA256 指纹' },
  { title: '运行 4C PR 变更发现与分类', detail: '过滤内部重构（AC-02），绑定源码证据指纹' },
  { title: '写入本地工作区并进入知识中心', detail: '待确认的候选功能与发布守门已就绪' },
];

function inferMode(methods: SourceKind[]): AccessMode {
  if (methods.length > 1) return 'combo';
  if (methods[0] === 'website') return 'website';
  if (methods[0] === 'docs') return 'docs';
  return 'github';
}

export function OnboardingPage() {
  const navigate = useNavigate();
  const templates = useStudioStore((state) => state.templates);
  const testConnection = useStudioStore((state) => state.testConnection);
  const createProjectFromDraft = useStudioStore((state) => state.createProjectFromDraft);
  const setLastProjectId = useUiStore((state) => state.setLastProjectId);
  const pushToast = useUiStore((state) => state.pushToast);

  const [draft, setDraft] = useState<OnboardingDraft>(() => loadDraft());
  const [step, setStep] = useState(0);
  const [maxVisited, setMaxVisited] = useState(0);
  const [accessMode, setAccessMode] = useState<AccessMode>(() => inferMode(loadDraft().methods));
  const [githubMode, setGithubMode] = useState<'mock' | 'real'>(() => {
    const initial = loadDraft();
    return initial.connections.github && !initial.connections.github.demo ? 'real' : 'mock';
  });
  const [githubStatus, setGithubStatus] = useState<GitHubConnectionStatus | null>(null);
  const [githubProbe, setGithubProbe] = useState<GitHubWriteProbeResult | null>(null);
  const [probingGitHub, setProbingGitHub] = useState(false);
  const [connecting, setConnecting] = useState<Partial<Record<SourceKind, boolean>>>({});
  const [connectionErrors, setConnectionErrors] = useState<Partial<Record<SourceKind, string>>>({});
  const [attempted, setAttempted] = useState(false);
  const [initializing, setInitializing] = useState(false);
  const [initIndex, setInitIndex] = useState(-1);
  const [initError, setInitError] = useState<string | null>(null);
  const [createdProjectId, setCreatedProjectId] = useState<string | null>(null);
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    void getGitHubKnowledgeClient()
      .then((client) => client.getStatus())
      .then((status) => {
        if (mounted.current) setGithubStatus(status);
      })
      .catch(() => {
        if (mounted.current) setGithubStatus(null);
      });
    return () => {
      mounted.current = false;
    };
  }, []);

  useEffect(() => {
    try {
      localStorage.setItem('asvs.onboarding.v1', JSON.stringify({ version: 1, draft }));
    } catch {
      // Draft persistence is a convenience; the flow still works without it.
    }
  }, [draft]);

  const errors = validateStep(step, draft);
  const selectedTemplate = templates.find((template) => template.id === draft.templateId);

  const patch = (value: Partial<OnboardingDraft>) => {
    setDraft((current) => ({ ...current, ...value }));
    setAttempted(false);
  };

  const patchBrand = (value: Partial<BrandKit>) => {
    setDraft((current) => ({ ...current, brand: { ...current.brand, ...value } }));
  };

  const clearConnection = (kind: SourceKind) => {
    setDraft((current) => {
      const connections = { ...current.connections };
      delete connections[kind];
      return { ...current, connections };
    });
  };

  const connect = async (kind: SourceKind) => {
    if (kind === 'github' && githubMode === 'real') {
      setConnecting((current) => ({ ...current, github: true }));
      setConnectionErrors((current) => ({ ...current, github: undefined }));
      setGithubProbe(null);
      try {
        const parsedRepo = parseGitHubRepoRef(draft.githubRepo);
        const client = await getGitHubKnowledgeClient();
        const status = await client.getStatus(parsedRepo);
        if (!mounted.current) return;
        setGithubStatus(status);
        if (!status.configured) {
          setConnectionErrors((current) => ({
            ...current,
            github: '本机 API 尚未配置 GitHub App 只读凭证（apps/api/.env.local），不会伪造真实连接。',
          }));
          return;
        }
        if (!status.readOnly) {
          setConnectionErrors((current) => ({
            ...current,
            github: `安全阻断：检测到写权限 [${status.writePermissions.join(', ')}]，只读模式拒绝接入。`,
          }));
          return;
        }
        if (!status.connected) {
          setConnectionErrors((current) => ({
            ...current,
            github: status.error ?? '无法连接目标仓库，请确认 GitHub App 已安装且有权限访问。',
          }));
          return;
        }
        const meta = await client.getRepository(parsedRepo);
        if (!mounted.current) return;
        const resolvedBranch = draft.branch.trim() || meta.defaultBranch || 'main';
        const fullRepo = formatGitHubRepoRef(parsedRepo);
        setDraft((current) => ({
          ...current,
          githubRepo: fullRepo,
          branch: resolvedBranch,
          connections: {
            ...current.connections,
            github: {
              id: `src_${Date.now().toString(36)}`,
              kind: 'github',
              name: fullRepo,
              detail: `只读 GitHub App 连接 · 默认分支 ${meta.defaultBranch}`,
              status: 'connected',
              scope: resolvedBranch,
              lastSyncedAt: status.checkedAt,
              readOnlyVerifiedAt: status.checkedAt,
              demo: false,
            },
          },
        }));
      } catch (error) {
        if (!mounted.current) return;
        setConnectionErrors((current) => ({
          ...current,
          github: error instanceof Error ? error.message : 'GitHub 只读连接验证失败。',
        }));
      } finally {
        if (mounted.current) setConnecting((current) => ({ ...current, github: false }));
      }
      return;
    }

    setConnecting((current) => ({ ...current, [kind]: true }));
    setConnectionErrors((current) => ({ ...current, [kind]: undefined }));
    const value =
      kind === 'github'
        ? draft.githubRepo
        : kind === 'website'
          ? draft.demoUrl
          : docsFromDraft(draft).join('\n');
    const result = await testConnection({ kind, value, branch: draft.branch });
    if (!mounted.current) return;
    setConnecting((current) => ({ ...current, [kind]: false }));
    if (result.ok) {
      setDraft((current) => ({
        ...current,
        connections: { ...current.connections, [kind]: result.source },
      }));
    } else {
      setConnectionErrors((current) => ({ ...current, [kind]: result.error }));
    }
  };

  const probeGitHubWriteBlocked = async () => {
    setConnectionErrors((current) => ({ ...current, github: undefined }));
    setProbingGitHub(true);
    try {
      const parsedRepo = parseGitHubRepoRef(draft.githubRepo);
      const client = await getGitHubKnowledgeClient();
      const probe = await client.verifyReadOnly(parsedRepo);
      if (mounted.current) setGithubProbe(probe);
    } catch (error) {
      if (mounted.current) {
        setConnectionErrors((current) => ({
          ...current,
          github: error instanceof Error ? error.message : '只读边界验证失败。',
        }));
      }
    } finally {
      if (mounted.current) setProbingGitHub(false);
    }
  };

  const fillExample = async () => {
    setGithubMode('mock');
    setGithubProbe(null);
    const example = cloneDraft(defaultOnboardingDraft());
    example.name = 'Atlas 增长操作系统';
    example.productName = 'Atlas';
    example.description = '给增长团队的项目与协作工作台，让数据、讨论和决策留在同一块看板上。';
    example.website = 'https://atlas.demo.invalid';
    example.githubRepo = 'lumen-labs/atlas';
    example.demoUrl = 'https://atlas.demo.invalid/workspace';
    example.docs = [
      'https://docs.atlas.demo.invalid/guide/getting-started',
      'https://docs.atlas.demo.invalid/guide/collaboration',
      'https://docs.atlas.demo.invalid/guide/sharing',
    ];
    example.brand = { ...example.brand, logoText: 'ATLAS', primary: '#FF7A59', secondary: '#F5C9A8' };
    example.methods = ['github', 'docs', 'website'];
    example.connections = {};
    setDraft(example);
    setAccessMode('combo');
    setConnecting({ github: true, docs: true, website: true });
    const inputs: { kind: SourceKind; value: string }[] = [
      { kind: 'github', value: example.githubRepo },
      { kind: 'docs', value: example.docs.join('\n') },
      { kind: 'website', value: example.demoUrl },
    ];
    const results = await Promise.all(
      inputs.map(async (input) => ({
        kind: input.kind,
        result: await testConnection({ ...input, branch: example.branch }),
      })),
    );
    if (!mounted.current) return;
    const connections: Partial<Record<SourceKind, SourceConnection>> = {};
    results.forEach(({ kind, result }) => {
      if (result.ok) connections[kind] = result.source;
    });
    setDraft((current) => ({ ...current, connections }));
    setConnecting({});
  };

  const goNext = () => {
    setAttempted(true);
    if (errors.length > 0) return;
    const next = Math.min(5, step + 1);
    setStep(next);
    setMaxVisited((value) => Math.max(value, next));
    setAttempted(false);
  };

  const goBack = () => {
    if (initializing) return;
    setStep((value) => Math.max(0, value - 1));
    setAttempted(false);
  };

  const changeMode = (mode: AccessMode) => {
    const target = ACCESS_MODES.find((item) => item.mode === mode);
    if (!target) return;
    setAccessMode(mode);
    patch({ methods: [...target.methods] });
  };

  const isRealGitHubFlow =
    draft.methods.includes('github') &&
    Boolean(draft.connections.github) &&
    draft.connections.github?.demo === false;

  const initialize = async () => {
    if (initializing) return;
    setInitializing(true);
    setInitIndex(-1);
    setInitError(null);

    if (isRealGitHubFlow) {
      try {
        const parsedRepo = parseGitHubRepoRef(draft.githubRepo);
        const branch = draft.branch.trim() || 'main';
        const client = await getGitHubKnowledgeClient();

        const status = await client.getStatus(parsedRepo);
        if (!mounted.current) return;
        if (!status.configured || !status.connected || !status.readOnly) {
          throw new Error(status.error ?? 'GitHub App 只读连接校验未通过，无法继续初始化。');
        }
        setInitIndex(0);

        const snapshot = await client.indexRepository(parsedRepo, { branch });
        if (!mounted.current) return;
        setInitIndex(1);

        const report = await client.discoverPullRequests(parsedRepo, {
          branch,
          snapshotId: snapshot.id,
          state: 'closed',
          limit: 15,
        });
        if (!mounted.current) return;
        setInitIndex(2);

        const projectId = createRealGitHubProject(
          {
            ...draft,
            name: draft.name.trim() || `${draft.productName.trim()} 视频项目`,
            connections: draft.connections,
            docs: docsFromDraft(draft),
          },
          {
            snapshot,
            candidates: report.candidates,
            readOnlyVerifiedAt: status.checkedAt,
          },
        );
        localStorage.removeItem('asvs.onboarding.v1');
        setInitIndex(3);
        setCreatedProjectId(projectId);
        setLastProjectId(projectId);
        pushToast({
          tone: 'success',
          title: `真实项目「${draft.name || draft.productName}」已创建`,
          description: `完成 ${snapshot.stats.mode} 索引（${snapshot.stats.totalFiles} 文件）与 ${report.summary.analyzed} 个 PR 发现。`,
          actionLabel: '打开知识中心',
          actionHref: `/projects/${projectId}/knowledge?tab=discovery`,
        });
        await new Promise((resolve) => setTimeout(resolve, 450));
        if (!mounted.current) return;
        navigate(`/projects/${projectId}/knowledge?tab=discovery&welcome=1`);
      } catch (error) {
        if (!mounted.current) return;
        setInitializing(false);
        setInitError(error instanceof Error ? error.message : '真实仓库初始化失败，请重试。');
      }
      return;
    }

    for (let index = 0; index < INIT_STEPS.length; index += 1) {
      await new Promise((resolve) => setTimeout(resolve, index === 0 ? 450 : 520));
      if (!mounted.current) return;
      setInitIndex(index);
    }
    await new Promise((resolve) => setTimeout(resolve, 380));
    if (!mounted.current) return;
    const projectId = createProjectFromDraft({
      ...draft,
      name: draft.name.trim() || `${draft.productName.trim()} 视频项目`,
      connections: draft.connections,
      docs: docsFromDraft(draft),
    });
    localStorage.removeItem('asvs.onboarding.v1');
    setCreatedProjectId(projectId);
    setLastProjectId(projectId);
    const projectFeatures = useStudioStore
      .getState()
      .features.filter((feature) => feature.projectId === projectId);
    pushToast({
      tone: 'success',
      title: `项目「${draft.name || draft.productName}」已创建`,
      description: `模拟分析发现了 ${projectFeatures.length} 个候选功能，已进入知识中心等待确认。`,
      actionLabel: '打开知识中心',
      actionHref: `/projects/${projectId}/knowledge`,
    });
    await new Promise((resolve) => setTimeout(resolve, 650));
    if (!mounted.current) return;
    navigate(`/projects/${projectId}/knowledge?welcome=1`);
  };

  return (
    <Page wide>
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <div className="flex items-center gap-2 text-[10.5px] font-medium uppercase tracking-[0.14em] text-faint">
            <Sparkles size={12} className="text-accent" />
            Onboarding · 本地草稿自动保存
          </div>
          <h1 className="mt-2 font-display text-[28px] font-medium leading-9 tracking-[-0.02em] text-fg">
            新建视频项目
          </h1>
          <p className="mt-1.5 max-w-2xl text-[13px] leading-[22px] text-muted">
            六步建立可信知识。连接与扫描是模拟的；项目、功能、声明与后续视频数据都会真实写入本地工作区。
          </p>
        </div>
        {step < 5 ? (
          <Button variant="ghost" onClick={fillExample} icon={<Wand2 size={14} />}>
            使用 Lumen 示例
          </Button>
        ) : null}
      </div>

      <div className="mt-6 grid gap-5 lg:grid-cols-[230px_minmax(0,1fr)]">
        <aside>
          <ol className="space-y-1">
            {STEPS.map((item, index) => {
              const active = index === step;
              const complete = index < step;
              const reachable = index <= maxVisited && !initializing;
              return (
                <li key={item.title}>
                  <button
                    type="button"
                    disabled={!reachable}
                    onClick={() => {
                      setStep(index);
                      setAttempted(false);
                    }}
                    className={cn(
                      'flex w-full items-start gap-2.5 rounded-md px-2.5 py-2.5 text-left transition-colors',
                      active ? 'bg-overlay text-fg' : 'text-muted hover:bg-overlay/50',
                      !reachable && 'cursor-not-allowed opacity-45',
                    )}
                  >
                    <span
                      className={cn(
                        'mt-0.5 grid size-5 shrink-0 place-items-center rounded-full border font-mono text-[9.5px]',
                        active
                          ? 'border-accent bg-accent text-on-accent'
                          : complete
                            ? 'border-success/40 bg-success-soft text-success'
                            : 'border-line-strong text-faint',
                      )}
                    >
                      {complete ? <Check size={10} strokeWidth={3} /> : index + 1}
                    </span>
                    <span className="min-w-0">
                      <span className={cn('block text-[12px] font-medium', active && 'text-fg')}>
                        {item.title}
                      </span>
                      <span className="mt-0.5 block text-[10px] leading-4 text-faint">{item.description}</span>
                    </span>
                  </button>
                </li>
              );
            })}
          </ol>
          <div className="mt-4 rounded-md border border-line bg-surface/50 p-3">
            <div className="flex items-center gap-1.5 text-[10.5px] font-medium text-muted">
              <ShieldCheck size={12} className="text-success" />
              只读与本地优先
            </div>
            <p className="mt-1 text-[10.5px] leading-[17px] text-faint">
              {githubMode === 'real'
                ? '通过本机 API 以只读 GitHub App 接入，拒绝任何写权限（AC-01），绝不修改仓库。'
                : '演示模式不会连接真实 GitHub，所有连接结果为本地确定性模拟；可切换到真实只读 GitHub App。'}
            </p>
          </div>
        </aside>

        <Panel className="overflow-hidden">
          <div className="flex items-center justify-between border-b border-line px-5 py-3.5">
            <div>
              <div className="font-display text-[16px] font-medium text-fg">
                {step + 1}. {STEPS[step].title}
              </div>
              <div className="mt-0.5 text-[11px] text-faint">{STEPS[step].description}</div>
            </div>
            <span className="font-mono text-[10px] text-faint">{step + 1} / 6</span>
          </div>

          <div className="min-h-[430px] px-5 py-5">
            {step === 0 ? (
              <StepProject draft={draft} patch={patch} errors={attempted ? errors : []} />
            ) : null}
            {step === 1 ? (
              <StepAccess
                draft={draft}
                accessMode={accessMode}
                githubMode={githubMode}
                githubStatus={githubStatus}
                githubProbe={githubProbe}
                probingGitHub={probingGitHub}
                connecting={connecting}
                connectionErrors={connectionErrors}
                onModeChange={changeMode}
                onGitHubModeChange={(mode) => {
                  setGithubMode(mode);
                  setGithubProbe(null);
                  setConnectionErrors((current) => ({ ...current, github: undefined }));
                  clearConnection('github');
                  if (
                    mode === 'real' &&
                    !draft.githubRepo.trim() &&
                    githubStatus?.accessibleRepositories[0]
                  ) {
                    patch({ githubRepo: githubStatus.accessibleRepositories[0] });
                  }
                }}
                onProbeGitHub={probeGitHubWriteBlocked}
                onPatch={patch}
                onClearConnection={clearConnection}
                onConnect={connect}
                errors={attempted ? errors : []}
              />
            ) : null}
            {step === 2 ? (
              <StepSources
                draft={draft}
                githubMode={githubMode}
                onPatch={patch}
                onClearConnection={clearConnection}
                errors={attempted ? errors : []}
              />
            ) : null}
            {step === 3 ? (
              <StepBrand draft={draft} templates={templates} patchBrand={patchBrand} patch={patch} />
            ) : null}
            {step === 4 ? (
              <StepDemoEnvironment draft={draft} patch={patch} errors={attempted ? errors : []} />
            ) : null}
            {step === 5 ? (
              <StepInitialize
                draft={draft}
                brand={draft.brand}
                isRealGitHub={isRealGitHubFlow}
                initializing={initializing}
                initIndex={initIndex}
                initError={initError}
                createdProjectId={createdProjectId}
                onStart={initialize}
              />
            ) : null}
          </div>

          <div className="flex flex-wrap items-center justify-between gap-3 border-t border-line bg-raised/30 px-5 py-3">
            <div className="min-w-0 text-[11px] text-faint">
              {attempted && errors.length > 0 ? (
                <span className="text-danger">{errors[0]}</span>
              ) : step === 5 ? (
                selectedTemplate
                  ? `模板 ${selectedTemplate.name} · ${draft.defaultAspect} · ${draft.defaultLanguage}`
                  : '准备初始化'
              ) : (
                '所有步骤都可以返回修改；草稿保存在本机浏览器。'
              )}
            </div>
            <div className="flex items-center gap-2">
              <Button variant="ghost" onClick={goBack} disabled={step === 0 || initializing}>
                <ArrowLeft size={14} /> 返回
              </Button>
              {step < 5 ? (
                <Button variant="primary" onClick={goNext}>
                  继续 <ArrowRight size={14} />
                </Button>
              ) : (
                <Button
                  variant="primary"
                  onClick={initialize}
                  loading={
                    initializing &&
                    initIndex < (isRealGitHubFlow ? REAL_INIT_STEPS.length : INIT_STEPS.length) - 1
                  }
                  disabled={Boolean(createdProjectId)}
                >
                  {createdProjectId ? '正在进入知识中心…' : '开始初始化'}
                  {!initializing ? <Sparkles size={14} /> : null}
                </Button>
              )}
            </div>
          </div>
        </Panel>
      </div>
    </Page>
  );
}

function StepProject({
  draft,
  patch,
  errors,
}: {
  draft: OnboardingDraft;
  patch: (value: Partial<OnboardingDraft>) => void;
  errors: string[];
}) {
  return (
    <div className="grid gap-5 xl:grid-cols-[1.1fr_.9fr]">
      <div className="space-y-4">
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="产品名称" required htmlFor="productName" error={errors.includes('请填写产品名称。') ? '请填写产品名称。' : undefined}>
            <Input
              id="productName"
              value={draft.productName}
              onChange={(event) => patch({ productName: event.target.value })}
              placeholder="例如 Atlas"
            />
          </Field>
          <Field label="项目名称" required htmlFor="projectName" error={errors.includes('请填写项目名称。') ? '请填写项目名称。' : undefined}>
            <Input
              id="projectName"
              value={draft.name}
              onChange={(event) => patch({ name: event.target.value })}
              placeholder="例如 Atlas 增长操作系统"
            />
          </Field>
        </div>
        <Field label="一句话描述" htmlFor="description" hint="会出现在项目卡和视频 Brief 的默认目标里。">
          <Textarea
            id="description"
            value={draft.description}
            onChange={(event) => patch({ description: event.target.value })}
            placeholder="给谁解决什么问题，用什么方式。"
            className="min-h-[92px]"
          />
        </Field>
        <Field
          label="产品网站"
          optional
          htmlFor="website"
          hint="用于项目概览里的链接，不会自动抓取。"
          error={errors.includes('产品网站需要以 http:// 或 https:// 开头。') ? '产品网站需要以 http:// 或 https:// 开头。' : undefined}
        >
          <Input
            id="website"
            value={draft.website}
            onChange={(event) => patch({ website: event.target.value })}
            placeholder="https://example.com"
          />
        </Field>
        <div className="rounded-md border border-line bg-raised/30 p-3">
          <div className="text-[11px] font-medium text-muted">默认输出</div>
          <div className="mt-2 grid grid-cols-3 gap-2">
            {(['16:9', '9:16', '1:1'] as AspectRatio[]).map((aspect) => (
              <button
                key={aspect}
                type="button"
                onClick={() => patch({ defaultAspect: aspect })}
                className={cn(
                  'flex items-center gap-2 rounded-sm border px-3 py-2 text-[12px] transition-colors',
                  draft.defaultAspect === aspect
                    ? 'border-accent/50 bg-accent-soft text-fg'
                    : 'border-line text-muted hover:border-line-strong',
                )}
              >
                <span
                  className="rounded-[1px] border border-current opacity-60"
                  style={{
                    width: aspect === '9:16' ? 10 : aspect === '1:1' ? 14 : 20,
                    height: aspect === '9:16' ? 18 : aspect === '1:1' ? 14 : 12,
                  }}
                />
                {aspect}
              </button>
            ))}
          </div>
          <div className="mt-2 flex items-center justify-between text-[11px] text-faint">
            <span>语言</span>
            <Select
              value={draft.defaultLanguage}
              onChange={(event) => patch({ defaultLanguage: event.target.value as OnboardingDraft['defaultLanguage'] })}
              wrapperClassName="w-[140px]"
              className="h-7 text-[11px]"
            >
              <option value="zh-CN">简体中文</option>
              <option value="en-US">English</option>
            </Select>
          </div>
        </div>
      </div>

      <div className="rounded-md border border-line bg-ink/50 p-3">
        <div className="text-[10px] font-medium uppercase tracking-[0.12em] text-faint">项目预览</div>
        <div className="relative mt-2 aspect-[4/3] overflow-hidden rounded-md border border-line bg-surface p-4">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <span className="grid size-8 place-items-center rounded-sm border border-line" style={{ color: draft.brand.primary }}>
                <BrandMark mark={draft.brand.logoMark} size={18} />
              </span>
              <div>
                <div className="font-display text-[12px] text-fg">{draft.name || '项目名称'}</div>
                <div className="text-[9.5px] text-faint">{draft.productName || '产品名称'}</div>
              </div>
            </div>
            <Badge tone="outline" dot={false}>Demo</Badge>
          </div>
          <div className="mt-5">
            <div className="text-[9px] uppercase tracking-[0.16em] text-faint">Product workspace</div>
            <div className="mt-1.5 font-display text-[19px] leading-6 text-fg">
              {draft.description || '一句话说清产品为谁解决什么问题。'}
            </div>
          </div>
          <div className="absolute inset-x-4 bottom-4 grid grid-cols-3 gap-2">
            {['知识', '视频', '审核'].map((label) => (
              <div key={label} className="rounded-sm border border-line bg-raised/50 px-2 py-1.5">
                <div className="font-mono text-[8px] text-faint">—</div>
                <div className="mt-1 text-[9.5px] text-muted">{label}</div>
              </div>
            ))}
          </div>
        </div>
        <p className="mt-2 text-[10px] leading-4 text-faint">
          这里只展示项目壳。初始化后，知识中心会用真实生成的功能与声明替换占位数字。
        </p>
      </div>
    </div>
  );
}

function StepAccess({
  draft,
  accessMode,
  githubMode,
  githubStatus,
  githubProbe,
  probingGitHub,
  connecting,
  connectionErrors,
  onModeChange,
  onGitHubModeChange,
  onProbeGitHub,
  onPatch,
  onClearConnection,
  onConnect,
  errors,
}: {
  draft: OnboardingDraft;
  accessMode: AccessMode;
  githubMode: 'mock' | 'real';
  githubStatus: GitHubConnectionStatus | null;
  githubProbe: GitHubWriteProbeResult | null;
  probingGitHub: boolean;
  connecting: Partial<Record<SourceKind, boolean>>;
  connectionErrors: Partial<Record<SourceKind, string>>;
  onModeChange: (mode: AccessMode) => void;
  onGitHubModeChange: (mode: 'mock' | 'real') => void;
  onProbeGitHub: () => Promise<void>;
  onPatch: (value: Partial<OnboardingDraft>) => void;
  onClearConnection: (kind: SourceKind) => void;
  onConnect: (kind: SourceKind) => Promise<void>;
  errors: string[];
}) {
  return (
    <div>
      <div role="radiogroup" aria-label="接入方式" className="grid gap-2 sm:grid-cols-2">
        {ACCESS_MODES.map((item) => (
          <RadioCard
            key={item.mode}
            selected={accessMode === item.mode}
            onSelect={() => onModeChange(item.mode)}
            title={item.title}
            description={item.description}
            icon={item.icon}
            meta={item.mode === 'combo' ? <Badge tone="accent">推荐</Badge> : undefined}
          />
        ))}
      </div>

      <div className="mt-5 space-y-3">
        {draft.methods.includes('github') ? (
          <SourceConnectRow
            kind="github"
            title="GitHub 仓库"
            description={
              githubMode === 'real'
                ? '连接本机 ASVS API 提供的只读 GitHub App；不接受写权限。'
                : '模拟只读连接；不会打开真实 OAuth，也不会访问 GitHub API。'
            }
            icon={<GitPullRequest size={15} />}
            connection={draft.connections.github}
            connecting={Boolean(connecting.github)}
            connectLabel={githubMode === 'real' ? '验证只读连接' : '模拟连接'}
            connectedBadgeLabel={githubMode === 'real' ? '已连接 · 真实只读' : '已连接 · 模拟'}
            error={connectionErrors.github}
            onConnect={() => onConnect('github')}
            input={
              <div className="space-y-2.5">
                <div className="flex flex-wrap items-center gap-2">
                  <button
                    type="button"
                    onClick={() => onGitHubModeChange('mock')}
                    className={cn(
                      'rounded-full border px-2.5 py-0.5 text-[10.5px] transition-colors',
                      githubMode === 'mock'
                        ? 'border-accent/45 bg-accent-soft text-accent'
                        : 'border-line text-muted hover:text-fg',
                    )}
                  >
                    本地模拟（Demo）
                  </button>
                  <button
                    type="button"
                    onClick={() => onGitHubModeChange('real')}
                    className={cn(
                      'rounded-full border px-2.5 py-0.5 text-[10.5px] transition-colors',
                      githubMode === 'real'
                        ? 'border-accent/45 bg-accent-soft text-accent'
                        : 'border-line text-muted hover:text-fg',
                    )}
                  >
                    真实只读 GitHub App
                  </button>
                  {githubMode === 'real' ? (
                    <Badge
                      tone={githubStatus?.configured ? 'success' : 'warn'}
                      dot={false}
                    >
                      {githubStatus === null
                        ? 'API 未连接'
                        : githubStatus.configured
                          ? 'API 已配置'
                          : '未配置凭证'}
                    </Badge>
                  ) : null}
                </div>

                {githubMode === 'real' &&
                githubStatus?.accessibleRepositories &&
                githubStatus.accessibleRepositories.length > 0 ? (
                  <div className="flex flex-wrap items-center gap-1.5">
                    <span className="text-[10px] text-faint">已授权仓库：</span>
                    {githubStatus.accessibleRepositories.map((repoName) => (
                      <button
                        key={repoName}
                        type="button"
                        onClick={() => {
                          onPatch({ githubRepo: repoName });
                          onClearConnection('github');
                        }}
                        className="rounded-sm border border-line bg-overlay px-2 py-0.5 font-mono text-[10px] text-muted hover:text-fg"
                      >
                        {repoName}
                      </button>
                    ))}
                  </div>
                ) : null}

                <div className="grid gap-2 sm:grid-cols-[1fr_140px]">
                  <Input
                    value={draft.githubRepo}
                    onChange={(event) => {
                      onPatch({ githubRepo: event.target.value });
                      onClearConnection('github');
                    }}
                    placeholder="owner/repo"
                    aria-label="GitHub 仓库"
                  />
                  {githubMode === 'real' ? (
                    <Input
                      value={draft.branch}
                      onChange={(event) => {
                        onPatch({ branch: event.target.value });
                        onClearConnection('github');
                      }}
                      placeholder="main"
                      aria-label="分支"
                    />
                  ) : (
                    <Select
                      value={draft.branch}
                      onChange={(event) => {
                        onPatch({ branch: event.target.value });
                        onClearConnection('github');
                      }}
                      aria-label="分支"
                    >
                      <option value="main">main</option>
                      <option value="staging">staging</option>
                      <option value="release/2.8">release/2.8</option>
                    </Select>
                  )}
                </div>

                {githubMode === 'real' && draft.connections.github && !draft.connections.github.demo ? (
                  <div className="flex flex-wrap items-center gap-2 pt-0.5">
                    <Button
                      variant="ghost"
                      size="sm"
                      loading={probingGitHub}
                      onClick={() => void onProbeGitHub()}
                      icon={<ShieldCheck size={12} />}
                    >
                      验证只读边界（AC-01）
                    </Button>
                    {githubProbe ? (
                      <span
                        className={cn(
                          'text-[10px]',
                          githubProbe.writeBlocked ? 'text-success' : 'text-danger',
                        )}
                      >
                        {githubProbe.detail}（HTTP {githubProbe.statusCode}）
                      </span>
                    ) : null}
                  </div>
                ) : null}
              </div>
            }
          />
        ) : null}

        {draft.methods.includes('docs') ? (
          <SourceConnectRow
            kind="docs"
            title="产品文档"
            description="每行一个文档地址；实际读取由本地模板模拟。"
            icon={<FileText size={15} />}
            connection={draft.connections.docs}
            connecting={Boolean(connecting.docs)}
            error={connectionErrors.docs}
            onConnect={() => onConnect('docs')}
            input={
              <Textarea
                value={draft.docs.join('\n')}
                onChange={(event) => {
                  onPatch({ docs: event.target.value.split('\n') });
                  onClearConnection('docs');
                }}
                placeholder={'https://docs.example.com/guide\nhttps://docs.example.com/api'}
                className="min-h-[70px] font-mono text-[11.5px]"
                aria-label="文档地址"
              />
            }
          />
        ) : null}

        {draft.methods.includes('website') ? (
          <SourceConnectRow
            kind="website"
            title="线上产品"
            description="仅打开公开演示站点；不登录、不抓取后台数据。"
            icon={<Globe2 size={15} />}
            connection={draft.connections.website}
            connecting={Boolean(connecting.website)}
            error={connectionErrors.website}
            onConnect={() => onConnect('website')}
            input={
              <Input
                value={draft.demoUrl}
                onChange={(event) => {
                  onPatch({ demoUrl: event.target.value });
                  onClearConnection('website');
                }}
                placeholder="https://atlas.demo.invalid/workspace"
                aria-label="演示站点"
              />
            }
          />
        ) : null}
      </div>

      {errors.length > 0 ? (
        <Callout tone="warning" className="mt-4" size="sm">
          {errors[0]}
        </Callout>
      ) : (
        <p className="mt-4 text-[10.5px] leading-4 text-faint">
          模拟连接只在本地生成一个来源对象；它不校验真实网络可达性。输入包含 “fail” 可复现授权失败。
        </p>
      )}
    </div>
  );
}

function SourceConnectRow({
  title,
  description,
  icon,
  connection,
  connecting,
  connectLabel = '模拟连接',
  connectedBadgeLabel = '已连接 · 模拟',
  error,
  onConnect,
  input,
}: {
  kind: SourceKind;
  title: string;
  description: string;
  icon: ReactNode;
  connection?: SourceConnection;
  connecting: boolean;
  connectLabel?: string;
  connectedBadgeLabel?: string;
  error?: string;
  onConnect: () => void;
  input: ReactNode;
}) {
  return (
    <div
      className={cn(
        'rounded-md border p-3 transition-colors',
        connection ? 'border-success/25 bg-success-soft/20' : 'border-line bg-raised/30',
      )}
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <span className="grid size-6 place-items-center rounded-sm border border-line bg-overlay text-muted">
            {icon}
          </span>
          <div>
            <div className="text-[12px] font-medium text-fg">{title}</div>
            <div className="text-[10px] text-faint">{description}</div>
          </div>
        </div>
        <div className="flex items-center gap-2">
          {connection ? (
            <Badge tone="success" dot={false}>
              {connectedBadgeLabel}
            </Badge>
          ) : error ? (
            <Badge tone="danger" dot={false}>
              连接失败
            </Badge>
          ) : null}
          <Button
            size="sm"
            variant={connection ? 'ghost' : 'secondary'}
            onClick={onConnect}
            loading={connecting}
          >
            {connection ? '重新连接' : connectLabel}
          </Button>
        </div>
      </div>
      <div className="mt-2.5">{input}</div>
      {connection ? (
        <div className="mt-2 flex items-center gap-1.5 text-[10px] text-success">
          <Check size={11} />
          {connection.name} · {connection.detail}
        </div>
      ) : null}
      {error ? <div className="mt-2 text-[10.5px] text-danger">{error}</div> : null}
    </div>
  );
}

function StepSources({
  draft,
  githubMode,
  onPatch,
  onClearConnection,
  errors,
}: {
  draft: OnboardingDraft;
  githubMode: 'mock' | 'real';
  onPatch: (value: Partial<OnboardingDraft>) => void;
  onClearConnection: (kind: SourceKind) => void;
  errors: string[];
}) {
  const docPages = draft.docs.filter((doc) => doc.trim().length > 0);
  return (
    <div className="grid gap-5 xl:grid-cols-[1.05fr_.95fr]">
      <div className="space-y-4">
        {draft.methods.includes('github') ? (
          <div className="rounded-md border border-line p-3.5">
            <div className="flex items-center justify-between">
              <div className="text-[12px] font-medium text-fg">仓库分支</div>
              <Badge tone="outline" dot={false}>只读</Badge>
            </div>
            <div className="mt-2 grid gap-2 sm:grid-cols-2">
              <Input
                value={draft.githubRepo}
                onChange={(event) => {
                  onPatch({ githubRepo: event.target.value });
                  onClearConnection('github');
                }}
                placeholder="owner/repo"
                aria-label="仓库"
              />
              {githubMode === 'real' ? (
                <Input
                  value={draft.branch}
                  onChange={(event) => {
                    onPatch({ branch: event.target.value });
                    onClearConnection('github');
                  }}
                  placeholder="main"
                  aria-label="分支"
                />
              ) : (
                <Select
                  value={draft.branch}
                  onChange={(event) => {
                    onPatch({ branch: event.target.value });
                    onClearConnection('github');
                  }}
                  aria-label="分支"
                >
                  <option value="main">main</option>
                  <option value="staging">staging</option>
                  <option value="release/2.8">release/2.8</option>
                </Select>
              )}
            </div>
            <p className="mt-2 text-[10px] leading-4 text-faint">
              修改仓库或分支会让已建立的连接失效，需要回到上一步重新验证。
            </p>
          </div>
        ) : null}

        {draft.methods.includes('docs') ? (
          <div className="rounded-md border border-line p-3.5">
            <div className="flex items-center justify-between">
              <div className="text-[12px] font-medium text-fg">要导入的文档页面</div>
              <span className="text-[10px] text-faint">{docPages.length} 页</span>
            </div>
            <div className="mt-2 space-y-1.5">
              {draft.docs.map((doc, index) => {
                const enabled = doc.trim().length > 0;
                return (
                  <label
                    key={`doc-${index}`}
                    className="flex items-center gap-2 rounded-sm border border-line bg-raised/30 px-2 py-1.5 text-[11px]"
                  >
                    <Checkbox
                      checked={enabled}
                      onCheckedChange={(checked) => {
                        const next = [...draft.docs];
                        if (checked) {
                          next[index] = `https://docs.example.com/page-${index + 1}`;
                        } else {
                          next[index] = '';
                        }
                        onPatch({ docs: next });
                        onClearConnection('docs');
                      }}
                      label={`选择文档 ${index + 1}`}
                    />
                    <Input
                      value={doc}
                      onChange={(event) => {
                        const next = [...draft.docs];
                        next[index] = event.target.value;
                        onPatch({ docs: next });
                        onClearConnection('docs');
                      }}
                      placeholder="https://docs.example.com/..."
                      className="h-7 border-0 bg-transparent px-0 font-mono text-[10.5px] focus:ring-0"
                      aria-label={`文档地址 ${index + 1}`}
                    />
                  </label>
                );
              })}
            </div>
            <Button
              variant="ghost"
              size="sm"
              className="mt-2"
              onClick={() => onPatch({ docs: [...draft.docs, ''] })}
            >
              添加文档页面
            </Button>
          </div>
        ) : null}

        {draft.methods.includes('website') ? (
          <Field label="演示站点" hint="初始化后仅记录该地址，不会自动访问。">
            <Input
              value={draft.demoUrl}
              onChange={(event) => {
                onPatch({ demoUrl: event.target.value });
                onClearConnection('website');
              }}
              placeholder="https://atlas.demo.invalid/workspace"
            />
          </Field>
        ) : null}

        {draft.methods.length === 0 ? (
          <Callout tone="warning">至少选择一种接入方式。</Callout>
        ) : null}
        {errors.length > 0 ? <Callout tone="warning" size="sm">{errors[0]}</Callout> : null}
      </div>

      <div className="rounded-md border border-line bg-ink/40 p-4">
        <div className="text-[10px] font-medium uppercase tracking-[0.12em] text-faint">将导入什么</div>
        <div className="mt-3 space-y-3">
          {draft.methods.includes('github') ? (
            <ImportPreview
              icon={<GitPullRequest size={13} />}
              title="GitHub 合并记录"
              items={['已合并 PR（区分功能 / 改进 / 内部）', 'Release 说明与版本号', '源码路径与测试文件引用']}
            />
          ) : null}
          {draft.methods.includes('docs') ? (
            <ImportPreview
              icon={<FileText size={13} />}
              title={`${docPages.length} 个文档页面`}
              items={['功能说明与目标用户', '限制条件与 Beta 标记', '术语表与公开可用表述']}
            />
          ) : null}
          {draft.methods.includes('website') ? (
            <ImportPreview
              icon={<Globe2 size={13} />}
              title="公开产品页面"
              items={['入口路径与页面标题', '公开可见的交互范围', '演示环境域名（模拟）']}
            />
          ) : null}
        </div>
        <Callout tone="info" className="mt-4" size="sm">
          {githubMode === 'real'
            ? '初始化将通过本机 API 执行真实只读索引与 PR 发现；所有候选项均需在知识中心人工确认与核验。'
            : '初始化只会生成明确标注为 Demo 的候选功能。任何 AI 推断都要在知识中心人工确认。'}
        </Callout>
      </div>
    </div>
  );
}

function ImportPreview({ icon, title, items }: { icon: ReactNode; title: string; items: string[] }) {
  return (
    <div>
      <div className="flex items-center gap-1.5 text-[11px] font-medium text-fg">
        <span className="text-accent">{icon}</span>
        {title}
      </div>
      <ul className="mt-1.5 space-y-1 pl-4">
        {items.map((item) => (
          <li key={item} className="list-disc text-[10.5px] leading-4 text-muted">
            {item}
          </li>
        ))}
      </ul>
    </div>
  );
}

const STYLE_OPTIONS: { style: VisualStyle; label: string; description: string }[] = [
  { style: 'editorial', label: '编辑叙事', description: '大字标题、留白与克制' },
  { style: 'product', label: '产品清晰', description: '界面优先，信息密度高' },
  { style: 'bold', label: '大胆冲击', description: '色块与节奏更强' },
  { style: 'minimal', label: '极简克制', description: '少量元素，几乎无装饰' },
];

const FONT_OPTIONS: { pair: FontPair; label: string }[] = [
  { pair: 'grotesk', label: 'Grotesk' },
  { pair: 'clean', label: 'Inter' },
  { pair: 'serif', label: 'Serif' },
  { pair: 'mono', label: 'Mono' },
];

const MARKS: LogoMark[] = ['spark', 'orbit', 'grid', 'wave'];

function StepBrand({
  draft,
  templates,
  patchBrand,
  patch,
}: {
  draft: OnboardingDraft;
  templates: { id: string; name: string; description: string; surface: string }[];
  patchBrand: (value: Partial<BrandKit>) => void;
  patch: (value: Partial<OnboardingDraft>) => void;
}) {
  return (
    <div className="grid gap-5 xl:grid-cols-[1.05fr_.95fr]">
      <div className="space-y-4">
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="品牌字标" required htmlFor="logoText" hint="视频里显示的文字标识。">
            <div className="flex gap-2">
              <Input
                id="logoText"
                value={draft.brand.logoText}
                onChange={(event) => patchBrand({ logoText: event.target.value.toUpperCase().slice(0, 24) })}
                placeholder="ATLAS"
              />
              <Button
                variant="secondary"
                size="md"
                onClick={() => patchBrand({ logoText: (draft.productName || 'BRAND').toUpperCase().slice(0, 24) })}
              >
                用产品名
              </Button>
            </div>
          </Field>
          <Field label="品牌标记" htmlFor="logoMark">
            <div className="flex gap-1.5">
              {MARKS.map((mark) => (
                <button
                  key={mark}
                  type="button"
                  onClick={() => patchBrand({ logoMark: mark })}
                  aria-label={`标志 ${mark}`}
                  className={cn(
                    'grid size-9 place-items-center rounded-sm border transition-colors',
                    draft.brand.logoMark === mark
                      ? 'border-accent/50 bg-accent-soft text-accent'
                      : 'border-line bg-raised/40 text-muted hover:border-line-strong',
                  )}
                >
                  <BrandMark mark={mark} size={17} />
                </button>
              ))}
            </div>
            <input type="hidden" id="logoMark" value={draft.brand.logoMark} />
          </Field>
        </div>

        <Field label="配色预设" hint="品牌色只用于视频画面与项目标识，不会污染工作台按钮。">
          <div className="grid grid-cols-2 gap-2">
            {BRAND_PRESETS.map((preset) => (
              <button
                key={preset.name}
                type="button"
                onClick={() => patchBrand({ primary: preset.primary, secondary: preset.secondary })}
                className={cn(
                  'flex items-center gap-2 rounded-sm border px-2.5 py-2 text-left transition-colors',
                  draft.brand.primary === preset.primary
                    ? 'border-accent/50 bg-accent-soft'
                    : 'border-line hover:border-line-strong',
                )}
              >
                <span className="flex">
                  <span className="size-4 rounded-l-[2px]" style={{ background: preset.primary }} />
                  <span className="size-4 rounded-r-[2px]" style={{ background: preset.secondary }} />
                </span>
                <span className="text-[11px] text-fg">{preset.name}</span>
              </button>
            ))}
          </div>
        </Field>

        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="主色" htmlFor="primary">
            <div className="flex gap-2">
              <input
                id="primary"
                type="color"
                value={draft.brand.primary}
                onChange={(event) => patchBrand({ primary: event.target.value })}
                className="h-9 w-10 cursor-pointer rounded-sm border border-line bg-raised p-0.5"
              />
              <Input
                value={draft.brand.primary}
                onChange={(event) => {
                  const value = event.target.value;
                  if (/^#[0-9a-fA-F]{0,6}$/.test(value)) patchBrand({ primary: value });
                }}
                className="font-mono uppercase"
              />
            </div>
          </Field>
          <Field label="辅色" htmlFor="secondary">
            <div className="flex gap-2">
              <input
                id="secondary"
                type="color"
                value={draft.brand.secondary}
                onChange={(event) => patchBrand({ secondary: event.target.value })}
                className="h-9 w-10 cursor-pointer rounded-sm border border-line bg-raised p-0.5"
              />
              <Input
                value={draft.brand.secondary}
                onChange={(event) => {
                  const value = event.target.value;
                  if (/^#[0-9a-fA-F]{0,6}$/.test(value)) patchBrand({ secondary: value });
                }}
                className="font-mono uppercase"
              />
            </div>
          </Field>
        </div>

        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="视觉风格">
            <Select
              value={draft.brand.style}
              onChange={(event) => patchBrand({ style: event.target.value as VisualStyle })}
            >
              {STYLE_OPTIONS.map((option) => (
                <option key={option.style} value={option.style}>
                  {option.label} · {option.description}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="字体倾向">
            <Select
              value={draft.brand.fontPair}
              onChange={(event) => patchBrand({ fontPair: event.target.value as FontPair })}
            >
              {FONT_OPTIONS.map((option) => (
                <option key={option.pair} value={option.pair}>
                  {option.label}
                </option>
              ))}
            </Select>
          </Field>
        </div>

        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="片头短句" optional>
            <Input
              value={draft.brand.intro}
              onChange={(event) => patchBrand({ intro: event.target.value.slice(0, 140) })}
              placeholder="让团队看见同一个真相"
            />
          </Field>
          <Field label="片尾 CTA" optional>
            <Input
              value={draft.brand.outro}
              onChange={(event) => patchBrand({ outro: event.target.value.slice(0, 140) })}
              placeholder="开始免费试用"
            />
          </Field>
        </div>

        <Field label="默认视频模板">
          <div className="grid grid-cols-2 gap-2">
            {templates.map((template) => (
              <button
                key={template.id}
                type="button"
                onClick={() => patch({ templateId: template.id })}
                className={cn(
                  'rounded-sm border px-2.5 py-2 text-left transition-colors',
                  draft.templateId === template.id
                    ? 'border-accent/50 bg-accent-soft'
                    : 'border-line hover:border-line-strong',
                )}
              >
                <div className="text-[11px] font-medium text-fg">{template.name}</div>
                <div className="mt-0.5 line-clamp-2 text-[9.5px] leading-3.5 text-faint">{template.description}</div>
              </button>
            ))}
          </div>
        </Field>
      </div>

      <div>
        <div
          className="relative aspect-[16/10] overflow-hidden rounded-md border border-line"
          style={{ background: '#0C0E12' }}
        >
          <div
            className="absolute inset-0 opacity-70"
            style={{
              background: `radial-gradient(70% 90% at 18% 20%, ${draft.brand.primary}44, transparent 70%), radial-gradient(50% 70% at 90% 90%, ${draft.brand.secondary}33, transparent 70%)`,
            }}
          />
          <div className="relative flex h-full flex-col justify-between p-5">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2 text-white/85">
                <BrandMark mark={draft.brand.logoMark} size={20} />
                <span className="font-display text-[11px] font-semibold uppercase tracking-[0.18em]">
                  {draft.brand.logoText || 'BRAND'}
                </span>
              </div>
              <span className="font-mono text-[8px] uppercase tracking-[0.16em] text-white/35">
                Brand kit preview
              </span>
            </div>
            <div>
              <div className="text-[9px] uppercase tracking-[0.16em] text-white/45">
                {STYLE_OPTIONS.find((option) => option.style === draft.brand.style)?.label}
              </div>
              <div
                className="mt-2 max-w-[85%] text-[25px] font-medium leading-[1.12] tracking-[-0.03em] text-white"
                style={{
                  fontFamily:
                    draft.brand.fontPair === 'serif'
                      ? "'Iowan Old Style', Georgia, serif"
                      : draft.brand.fontPair === 'mono'
                        ? 'var(--font-mono)'
                        : draft.brand.fontPair === 'clean'
                          ? 'var(--font-sans)'
                          : 'var(--font-display)',
                }}
              >
                {draft.brand.intro || '让团队看见同一个真相'}
              </div>
            </div>
            <div className="flex items-center justify-between">
              <span className="text-[9px] text-white/45">{draft.productName || '产品名称'}</span>
              <span
                className="rounded-sm px-2 py-1 text-[9px] font-semibold"
                style={{ background: draft.brand.primary, color: '#15140F' }}
              >
                {draft.brand.outro || '开始试用'}
              </span>
            </div>
          </div>
        </div>
        <p className="mt-2 text-[10px] leading-4 text-faint">
          预览使用与视频镜头相同的品牌数据。保存项目后，修改品牌会同步到所有预览，并使已审核视频需要重新审核。
        </p>
      </div>
    </div>
  );
}

function StepDemoEnvironment({
  draft,
  patch,
  errors,
}: {
  draft: OnboardingDraft;
  patch: (value: Partial<OnboardingDraft>) => void;
  errors: string[];
}) {
  return (
    <div className="grid gap-5 xl:grid-cols-[1.05fr_.95fr]">
      <div className="space-y-4">
        <Field
          label="演示环境地址"
          htmlFor="demoUrl"
          required={draft.methods.includes('website')}
          hint="视频中的“真实操作”只会在模拟录屏层展示；不会启动浏览器或访问该地址。"
          error={errors.includes('请填写演示环境地址。') ? '请填写演示环境地址。' : undefined}
        >
          <Input
            id="demoUrl"
            value={draft.demoUrl}
            onChange={(event) => patch({ demoUrl: event.target.value })}
            placeholder="https://atlas.demo.invalid/workspace"
          />
        </Field>

        <Field label="演示数据重置策略">
          <div className="space-y-2">
            {[
              {
                value: 'fixture' as const,
                title: '每次初始化重建 fixture',
                detail: '推荐。演示数据固定、可重复，不会累积上一次的状态。',
              },
              {
                value: 'snapshot' as const,
                title: '复用最近一次知识快照',
                detail: '保留已确认的功能与证据，只更新来源引用。',
              },
              {
                value: 'manual' as const,
                title: '仅人工重置',
                detail: '最接近真实客户环境，但失败后需要手动恢复。',
              },
            ].map((option) => (
              <button
                key={option.value}
                type="button"
                onClick={() => patch({ resetStrategy: option.value })}
                className={cn(
                  'flex w-full items-start gap-2.5 rounded-md border p-3 text-left transition-colors',
                  draft.resetStrategy === option.value
                    ? 'border-accent/50 bg-accent-soft'
                    : 'border-line bg-raised/30 hover:border-line-strong',
                )}
              >
                <span
                  className={cn(
                    'mt-0.5 grid size-4 shrink-0 place-items-center rounded-full border',
                    draft.resetStrategy === option.value
                      ? 'border-accent bg-accent text-on-accent'
                      : 'border-line-strong',
                  )}
                >
                  {draft.resetStrategy === option.value ? <Check size={9} strokeWidth={3} /> : null}
                </span>
                <span>
                  <span className="block text-[12px] font-medium text-fg">{option.title}</span>
                  <span className="mt-0.5 block text-[10.5px] leading-4 text-faint">{option.detail}</span>
                </span>
              </button>
            ))}
          </div>
        </Field>

        <Callout tone="warning" size="sm" title="这里没有真实浏览器自动化">
          生产监控里的“录制”会显示模拟素材与断言步骤，不会启动 Playwright、FFmpeg 或真实录制。不要把演示画面当作产品证据。
        </Callout>
      </div>

      <div className="rounded-md border border-line bg-ink/40 p-4">
        <div className="text-[10px] font-medium uppercase tracking-[0.12em] text-faint">环境边界检查</div>
        <div className="mt-3 space-y-2.5">
          {[
            ['只读权限', '不会创建 issue、合并 PR 或写入仓库'],
            ['域名白名单', '仅记录 atlas.demo.invalid 一类的演示域'],
            ['凭证处理', '不要求 token，也不保存任何凭证'],
            ['录制范围', '仅生成模拟画面与断言说明'],
            ['数据归属', '全部保存在当前浏览器 localStorage'],
          ].map(([title, detail]) => (
            <div key={title} className="flex items-start gap-2">
              <ShieldCheck size={13} className="mt-0.5 shrink-0 text-success" />
              <div>
                <div className="text-[11px] text-fg">{title}</div>
                <div className="text-[10px] leading-4 text-faint">{detail}</div>
              </div>
            </div>
          ))}
        </div>
        <div className="mt-4 flex items-center justify-between rounded-sm border border-line bg-raised/30 px-2.5 py-2">
          <div>
            <div className="text-[11px] text-fg">演示模式</div>
            <div className="text-[9.5px] text-faint">始终开启，无法关闭</div>
          </div>
          <Switch checked onCheckedChange={() => undefined} disabled label="演示模式" />
        </div>
      </div>
    </div>
  );
}

function StepInitialize({
  draft,
  brand,
  isRealGitHub,
  initializing,
  initIndex,
  initError,
  createdProjectId,
  onStart,
}: {
  draft: OnboardingDraft;
  brand: BrandKit;
  isRealGitHub: boolean;
  initializing: boolean;
  initIndex: number;
  initError: string | null;
  createdProjectId: string | null;
  onStart: () => void;
}) {
  const stepsList = isRealGitHub ? REAL_INIT_STEPS : INIT_STEPS;
  return (
    <div className="grid gap-5 xl:grid-cols-[.95fr_1.05fr]">
      <div>
        <div className="rounded-md border border-line bg-ink/40 p-4">
          <div className="flex items-center gap-2.5">
            <span
              className="grid size-9 place-items-center rounded-md border border-line"
              style={{ color: brand.primary }}
            >
              <BrandMark mark={brand.logoMark} size={20} />
            </span>
            <div>
              <div className="font-display text-[15px] font-medium text-fg">{draft.name || '未命名项目'}</div>
              <div className="text-[10.5px] text-faint">{draft.productName || '产品名称'}</div>
            </div>
            <Badge tone={isRealGitHub ? 'success' : 'outline'} dot={false} className="ml-auto">
              {isRealGitHub ? '真实只读 GitHub' : '待创建'}
            </Badge>
          </div>
          <p className="mt-3 line-clamp-2 text-[11px] leading-[18px] text-muted">
            {draft.description || '还没有描述。'}
          </p>
          <dl className="mt-3 space-y-1.5 border-t border-line pt-3 text-[10.5px]">
            <div className="flex justify-between gap-3">
              <dt className="text-faint">来源</dt>
              <dd className="text-fg">
                {draft.methods
                  .map((method) =>
                    method === 'github' ? draft.githubRepo : method === 'docs' ? `${draft.docs.filter(Boolean).length} 页文档` : draft.demoUrl,
                  )
                  .join(' · ') || '无'}
              </dd>
            </div>
            <div className="flex justify-between gap-3">
              <dt className="text-faint">默认输出</dt>
              <dd className="text-fg">
                {draft.defaultAspect} · {draft.defaultLanguage === 'zh-CN' ? '简体中文' : 'English'}
              </dd>
            </div>
            <div className="flex justify-between gap-3">
              <dt className="text-faint">重置策略</dt>
              <dd className="text-fg">
                {draft.resetStrategy === 'fixture'
                  ? '重建 fixture'
                  : draft.resetStrategy === 'snapshot'
                    ? '复用快照'
                    : '人工重置'}
              </dd>
            </div>
          </dl>
        </div>
        <Callout tone="info" className="mt-3" size="sm">
          {isRealGitHub
            ? '点击“开始初始化”会通过本机 API 执行真实只读索引与 PR 变更发现（不修改远程仓库）。'
            : '点击“开始初始化”后会用确定性步骤生成本地快照。整个过程不需要网络，也不会调用真实模型。'}
        </Callout>
      </div>

      <div className="rounded-md border border-line p-4">
        <div className="flex items-center justify-between">
          <div className="text-[12px] font-medium text-fg">初始化进度</div>
          <span className="font-mono text-[10px] text-faint">
            {initializing || createdProjectId ? `${Math.max(0, initIndex + 1)}/${stepsList.length}` : `0/${stepsList.length}`}
          </span>
        </div>
        <div className="mt-3 space-y-2.5">
          {stepsList.map((item, index) => {
            const done = initIndex >= index;
            const running = initializing && initIndex === index - 1;
            return (
              <div key={item.title} className="flex items-start gap-2.5">
                <span
                  className={cn(
                    'mt-0.5 grid size-5 shrink-0 place-items-center rounded-full border',
                    done
                      ? 'border-success/40 bg-success-soft text-success'
                      : running
                        ? 'border-accent/40 bg-accent-soft text-accent'
                        : 'border-line bg-raised text-faint',
                  )}
                >
                  {done ? (
                    <Check size={10} strokeWidth={3} />
                  ) : running ? (
                    <Loader2 size={10} className="animate-spin" />
                  ) : (
                    <span className="font-mono text-[8px]">{index + 1}</span>
                  )}
                </span>
                <div className="min-w-0 flex-1 pb-1">
                  <div className={cn('text-[11.5px]', done ? 'text-fg' : 'text-muted')}>{item.title}</div>
                  <div className="text-[9.5px] leading-4 text-faint">{item.detail}</div>
                </div>
              </div>
            );
          })}
        </div>
        <div className="mt-4 h-1 overflow-hidden rounded-full bg-overlay">
          <div
            className="h-full rounded-full bg-accent transition-[width] duration-500"
            style={{
              width: `${createdProjectId ? 100 : initializing ? ((initIndex + 1) / stepsList.length) * 100 : 0}%`,
            }}
          />
        </div>
        {initError ? (
          <Callout tone="danger" size="sm" className="mt-3" title="初始化失败">
            {initError}
          </Callout>
        ) : createdProjectId ? (
          <div className="mt-3 text-[10.5px] text-success">知识快照已写入。正在进入知识中心…</div>
        ) : initializing ? (
          <div className="mt-3 text-[10.5px] text-muted">
            {isRealGitHub ? '正在运行真实仓库索引与 PR 发现，请稍候…' : '正在生成模拟知识，请稍候；不要关闭页面。'}
          </div>
        ) : (
          <div className="mt-3 flex items-center gap-1.5 text-[10.5px] text-faint">
            <Sparkles size={11} className="text-ai" />
            初始化的每一步都会写入确定性记录，刷新后仍可恢复。
          </div>
        )}
      </div>
    </div>
  );
}

function validateStep(step: number, draft: OnboardingDraft): string[] {
  const errors: string[] = [];
  if (step === 0) {
    if (!draft.productName.trim()) errors.push('请填写产品名称。');
    if (!draft.name.trim()) errors.push('请填写项目名称。');
    if (draft.website.trim() && !/^https?:\/\//i.test(draft.website.trim())) {
      errors.push('产品网站需要以 http:// 或 https:// 开头。');
    }
  }
  if (step === 1) {
    if (draft.methods.length === 0) errors.push('至少选择一种接入方式。');
    draft.methods.forEach((method) => {
      if (!draft.connections[method]) {
        errors.push(
          method === 'github'
            ? '请先完成 GitHub 仓库的连接验证。'
            : method === 'docs'
              ? '请先完成产品文档的模拟连接。'
              : '请先完成线上产品的模拟连接。',
        );
      }
    });
    if (draft.methods.includes('github') && !/^[\w.-]+\/[\w.-]+$/.test(draft.githubRepo.trim())) {
      errors.push('仓库格式应为 owner/repo。');
    }
    if (draft.methods.includes('website') && !draft.demoUrl.trim()) {
      errors.push('请填写演示站点。');
    }
    if (draft.methods.includes('docs') && docsFromDraft(draft).length === 0) {
      errors.push('请至少填写一个文档地址。');
    }
  }
  if (step === 2) {
    if (draft.methods.includes('github') && !draft.connections.github) {
      errors.push('仓库范围已变更，请返回上一步重新连接。');
    }
    if (draft.methods.includes('docs') && !draft.connections.docs) {
      errors.push('文档范围已变更，请返回上一步重新连接。');
    }
    if (draft.methods.includes('website') && !draft.connections.website) {
      errors.push('演示站点已变更，请返回上一步重新连接。');
    }
  }
  if (step === 3) {
    if (!draft.brand.logoText.trim()) errors.push('请填写品牌字标。');
    if (!/^#[0-9a-fA-F]{6}$/.test(draft.brand.primary)) errors.push('主色需要是完整的 #RRGGBB。');
    if (!/^#[0-9a-fA-F]{6}$/.test(draft.brand.secondary)) errors.push('辅色需要是完整的 #RRGGBB。');
  }
  if (step === 4) {
    if (
      draft.methods.includes('website') &&
      (!draft.demoUrl.trim() || !/^https?:\/\//i.test(draft.demoUrl.trim()))
    ) {
      errors.push('请填写演示环境地址。');
    }
  }
  return errors;
}

function loadDraft(): OnboardingDraft {
  try {
    const raw = localStorage.getItem('asvs.onboarding.v1');
    if (raw) {
      const parsed = JSON.parse(raw) as { version?: number; draft?: OnboardingDraft };
      if (parsed.version === 1 && parsed.draft && Array.isArray(parsed.draft.methods)) {
        return { ...defaultOnboardingDraft(), ...parsed.draft, brand: { ...DEFAULT_BRAND, ...parsed.draft.brand } };
      }
    }
  } catch {
    // Fall through to a clean draft.
  }
  return defaultOnboardingDraft();
}
