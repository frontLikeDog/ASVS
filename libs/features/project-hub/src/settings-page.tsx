import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import type {
  AspectRatio,
  BrandKit,
  FontPair,
  GitHubConnectionStatus,
  GitHubWriteProbeResult,
  KnowledgeSnapshotSummaryV1,
  Language,
  LogoMark,
  Project,
  Scene,
  StudioSnapshot,
  VisualStyle,
} from '@asvs/domain';
import {
  FONT_PAIRS,
  LANGUAGES,
  LOGO_MARKS,
  VISUAL_STYLES,
  buildWorkspaceExport,
  formatDate,
  formatGitHubRepoRef,
  formatRelativeTime,
  parseGitHubRepoRef,
  parseWorkspaceExport,
  workspaceExportFileName,
} from '@asvs/domain';
import {
  AlertTriangle,
  Check,
  Cloud,
  CloudOff,
  Database,
  Download,
  ExternalLink,
  Globe2,
  GitPullRequest,
  Link2,
  Palette,
  RefreshCw,
  RotateCcw,
  Save,
  ShieldCheck,
  Sparkles,
  Trash2,
  Type,
  Upload,
  UserRound,
} from 'lucide-react';
import {
  Badge,
  BrandMark,
  Button,
  Callout,
  DemoBadge,
  Dialog,
  DialogContent,
  Field,
  Input,
  Page,
  PageHeader,
  Panel,
  PanelHeader,
  ScenePreview,
  Select,
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
  Textarea,
  buttonStyles,
  cn,
} from '@asvs/ui';
import {
  attachRealGitHubSource,
  getGitHubKnowledgeClient,
  parseProjectGitHubSource,
  reconcileDiscoveryCandidates,
  selectStudioSnapshot,
  useStudioStore,
  useUiStore,
  useWorkspaceSyncStore,
} from '@asvs/state';
import type { WorkspaceSyncPhase } from '@asvs/state';
import { useShallow } from 'zustand/react/shallow';
import { NotFoundInline } from './not-found-inline';

type SettingsTab = 'brand' | 'project' | 'sources' | 'data';

const FONT_INFO: Record<FontPair, { label: string; sample: string; detail: string }> = {
  grotesk: { label: 'Grotesk 编辑', sample: 'Aa 产品影像', detail: 'Space Grotesk + Inter，偏编辑设计' },
  clean: { label: 'Clean 无衬线', sample: 'Aa 产品影像', detail: 'Inter，清晰中性，适合 B2B' },
  serif: { label: 'Serif 叙事', sample: 'Aa 产品影像', detail: '衬线标题，适合品牌叙事' },
  mono: { label: 'Mono 技术', sample: 'Aa 产品影像', detail: '等宽标题，偏技术工具' },
};

const STYLE_INFO: Record<VisualStyle, { label: string; detail: string }> = {
  editorial: { label: 'Editorial', detail: '纸感与网格，信息密度高' },
  product: { label: 'Product', detail: '深色产品界面，克制' },
  bold: { label: 'Bold', detail: '品牌色块，社交感强' },
  minimal: { label: 'Minimal', detail: '少装饰，突出文字' },
};

const MARK_INFO: Record<LogoMark, string> = {
  spark: '星芒',
  orbit: '轨道',
  grid: '网格',
  wave: '波形',
};

const PRESETS: { name: string; brand: Pick<BrandKit, 'primary' | 'secondary'> }[] = [
  { name: 'Lumen Lime', brand: { primary: '#D7F36A', secondary: '#9B8CFF' } },
  { name: 'Signal Blue', brand: { primary: '#A9C7FF', secondary: '#F1B56B' } },
  { name: 'Soft Clay', brand: { primary: '#F3B4A0', secondary: '#B8D8C0' } },
  { name: 'Mono Paper', brand: { primary: '#EFE9DA', secondary: '#9CA3AF' } },
];

export function SettingsPage() {
  const { projectId = '' } = useParams();
  const [searchParams, setSearchParams] = useSearchParams();
  const project = useStudioStore((state) => state.projects.find((item) => item.id === projectId));
  const tabParam = searchParams.get('tab');
  const [tab, setTab] = useState<SettingsTab>(() =>
    tabParam === 'project' || tabParam === 'sources' || tabParam === 'data' || tabParam === 'brand'
      ? tabParam
      : 'brand',
  );

  useEffect(() => {
    if (
      tabParam === 'project' ||
      tabParam === 'sources' ||
      tabParam === 'data' ||
      tabParam === 'brand'
    ) {
      setTab(tabParam);
    }
  }, [tabParam]);

  if (!project) return <NotFoundInline label="项目不存在或已被删除。" />;

  return (
    <Page wide>
      <PageHeader
        eyebrow={
          <>
            <span className="size-1.5 rounded-full bg-accent" />
            {project.name} · Settings
          </>
        }
        title="设置与品牌"
        description="品牌与项目信息会影响所有模拟预览。已通过审核的视频在品牌变更后需要重新审核。"
        actions={
          <>
            <Link to={`/projects/${project.id}`} className={buttonStyles({ variant: 'ghost' })}>
              返回项目
            </Link>
            <DemoBadge />
          </>
        }
      />

      <Tabs
        value={tab}
        onValueChange={(value) => {
          const nextTab = value as SettingsTab;
          setTab(nextTab);
          const next = new URLSearchParams(searchParams);
          if (nextTab === 'brand') next.delete('tab');
          else next.set('tab', nextTab);
          setSearchParams(next, { replace: true });
        }}
        className="mt-5"
      >
        <TabsList>
          <TabsTrigger value="brand">
            <Palette size={13} /> 品牌套件
          </TabsTrigger>
          <TabsTrigger value="project">
            <UserRound size={13} /> 项目信息
          </TabsTrigger>
          <TabsTrigger value="sources">
            <Link2 size={13} /> 来源与同步
          </TabsTrigger>
          <TabsTrigger value="data">
            <Database size={13} /> 演示数据
          </TabsTrigger>
        </TabsList>
        <TabsContent value="brand">
          <BrandSettings key={project.id} project={project} />
        </TabsContent>
        <TabsContent value="project">
          <ProjectSettings key={project.id} project={project} />
        </TabsContent>
        <TabsContent value="sources">
          <SourceSettings project={project} />
        </TabsContent>
        <TabsContent value="data">
          <DataSettings project={project} />
        </TabsContent>
      </Tabs>
    </Page>
  );
}

function BrandSettings({ project }: { project: Project }) {
  const updateBrand = useStudioStore((state) => state.updateBrand);
  const videos = useStudioStore(
    useShallow((state) => state.videos.filter((video) => video.projectId === project.id)),
  );
  const firstFeature = useStudioStore((state) =>
    state.features.find((feature) => feature.projectId === project.id),
  );
  const pushToast = useUiStore((state) => state.pushToast);
  const [draft, setDraft] = useState<BrandKit>({ ...project.brand });
  const [previewKind, setPreviewKind] = useState<'intro' | 'selling' | 'outro'>('intro');
  const [previewAspect, setPreviewAspect] = useState<AspectRatio>(project.defaultAspect);
  const [confirming, setConfirming] = useState(false);

  const dirty = JSON.stringify(draft) !== JSON.stringify(project.brand);
  const approvedVideos = videos.filter(
    (video) => video.stage === 'approved' || video.stage === 'exported' || video.review?.status === 'approved',
  );
  const valid =
    draft.logoText.trim().length > 0 &&
    /^#[0-9a-fA-F]{6}$/.test(draft.primary) &&
    /^#[0-9a-fA-F]{6}$/.test(draft.secondary);

  const previewProject = useMemo(() => ({ ...project, brand: draft }), [project, draft]);
  const previewScene = useMemo<Scene>(() => {
    if (previewKind === 'outro') {
      return {
        id: 'brand-preview',
        order: 8,
        revision: 1,
        title: draft.outro || '现在开始使用',
        intent: '',
        narration: '',
        caption: 'lumen.app',
        durationSec: 6,
        visualType: 'cta',
        templateId: project.templateId,
        featureId: firstFeature?.id,
        claimIds: [],
        status: 'draft',
        look: 'clean',
        brightness: 1,
        vignette: false,
      };
    }
    if (previewKind === 'selling') {
      return {
        id: 'brand-preview',
        order: 3,
        revision: 1,
        title: firstFeature?.name ?? '把反馈变成产品决策',
        intent: firstFeature?.summary ?? '从证据到成片，保持每句话都可追溯。',
        narration: '',
        caption: firstFeature?.summary ?? '',
        durationSec: 8,
        visualType: 'title',
        templateId: project.templateId,
        featureId: firstFeature?.id,
        claimIds: [],
        status: 'draft',
        look: 'clean',
        brightness: 1,
        vignette: false,
      };
    }
    return {
      id: 'brand-preview',
      order: 0,
      revision: 1,
      title: draft.intro || project.productName,
      intent: project.description || '产品价值，从事实开始。',
      narration: '',
      caption: '',
      durationSec: 5,
      visualType: 'title',
      templateId: project.templateId,
      featureId: undefined,
      claimIds: [],
      status: 'draft',
      look: 'clean',
      brightness: 1,
      vignette: false,
    };
  }, [previewKind, draft.intro, draft.outro, project, firstFeature]);

  const save = () => {
    if (!valid) return;
    updateBrand(project.id, {
      ...draft,
      logoText: draft.logoText.trim(),
      intro: draft.intro.trim(),
      outro: draft.outro.trim(),
    });
    setConfirming(false);
    pushToast({
      tone: 'success',
      title: '品牌套件已保存',
      description: approvedVideos.length
        ? `${approvedVideos.length} 条已通过视频已回到待修改，需要重新生产并审核。`
        : '所有模拟预览已立即更新。',
    });
  };

  return (
    <div className="grid grid-cols-[minmax(0,1fr)] gap-4 xl:grid-cols-[minmax(0,1fr)_420px]">
      <div className="space-y-4">
        <Panel>
          <PanelHeader
            title="品牌字标"
            description="出现在片头、字幕角标与片尾。"
            actions={dirty ? <Badge tone="warn">未保存</Badge> : <Badge tone="success">已保存</Badge>}
          />
          <div className="space-y-4 p-4">
            <div className="grid grid-cols-[minmax(0,1fr)] gap-4 sm:grid-cols-[1fr_220px]">
              <Field label="品牌字标" required hint="最多 24 个字符">
                <Input
                  value={draft.logoText}
                  maxLength={24}
                  onChange={(event) => setDraft({ ...draft, logoText: event.target.value })}
                />
              </Field>
              <div>
                <div className="mb-1.5 text-[11px] font-medium text-muted">标识形状</div>
                <div className="grid grid-cols-4 gap-1">
                  {LOGO_MARKS.map((mark) => (
                    <button
                      key={mark}
                      type="button"
                      onClick={() => setDraft({ ...draft, logoMark: mark })}
                      aria-pressed={draft.logoMark === mark}
                      title={MARK_INFO[mark]}
                      className={cn(
                        'flex flex-col items-center gap-1 rounded-sm border py-2 text-[9px] transition-colors',
                        draft.logoMark === mark
                          ? 'border-accent/50 bg-accent-soft text-accent'
                          : 'border-line text-faint hover:border-line-strong hover:text-fg',
                      )}
                    >
                      <BrandMark mark={mark} size={17} />
                      {MARK_INFO[mark]}
                    </button>
                  ))}
                </div>
              </div>
            </div>

            <div className="grid gap-4 sm:grid-cols-2">
              <ColorField
                label="主色"
                value={draft.primary}
                onChange={(primary) => setDraft({ ...draft, primary })}
              />
              <ColorField
                label="辅色"
                value={draft.secondary}
                onChange={(secondary) => setDraft({ ...draft, secondary })}
              />
            </div>

            <div>
              <div className="mb-1.5 text-[11px] font-medium text-muted">快捷配色</div>
              <div className="flex flex-wrap gap-2">
                {PRESETS.map((preset) => {
                  const active =
                    preset.brand.primary.toLowerCase() === draft.primary.toLowerCase() &&
                    preset.brand.secondary.toLowerCase() === draft.secondary.toLowerCase();
                  return (
                    <button
                      key={preset.name}
                      type="button"
                      onClick={() => setDraft({ ...draft, ...preset.brand })}
                      className={cn(
                        'flex items-center gap-2 rounded-sm border px-2 py-1.5 text-[10px] transition-colors',
                        active ? 'border-accent/50 text-fg' : 'border-line text-muted hover:text-fg',
                      )}
                    >
                      <span className="flex">
                        <span
                          className="size-3 rounded-l-full border border-black/20"
                          style={{ background: preset.brand.primary }}
                        />
                        <span
                          className="size-3 rounded-r-full border border-black/20"
                          style={{ background: preset.brand.secondary }}
                        />
                      </span>
                      {preset.name}
                      {active ? <Check size={10} className="text-accent" /> : null}
                    </button>
                  );
                })}
              </div>
            </div>
          </div>
        </Panel>

        <Panel>
          <PanelHeader title="排版与视觉风格" description="影响预览、字幕与生成的镜头版式。" />
          <div className="space-y-4 p-4">
            <div>
              <div className="mb-1.5 flex items-center gap-1.5 text-[11px] font-medium text-muted">
                <Type size={12} /> 字体组合
              </div>
              <div className="grid gap-2 sm:grid-cols-2">
                {FONT_PAIRS.map((pair) => (
                  <button
                    key={pair}
                    type="button"
                    onClick={() => setDraft({ ...draft, fontPair: pair })}
                    className={cn(
                      'rounded-md border p-3 text-left transition-colors',
                      draft.fontPair === pair
                        ? 'border-accent/45 bg-accent-soft/40'
                        : 'border-line hover:border-line-strong',
                    )}
                  >
                    <div
                      className="font-display text-[16px] text-fg"
                      style={{
                        fontFamily:
                          pair === 'serif'
                            ? "'Iowan Old Style', 'Songti SC', Georgia, serif"
                            : pair === 'mono'
                              ? 'var(--font-mono)'
                              : pair === 'clean'
                                ? 'var(--font-sans)'
                                : 'var(--font-display)',
                      }}
                    >
                      {FONT_INFO[pair].sample}
                    </div>
                    <div className="mt-1 text-[10.5px] text-fg">{FONT_INFO[pair].label}</div>
                    <div className="text-[9.5px] text-faint">{FONT_INFO[pair].detail}</div>
                  </button>
                ))}
              </div>
            </div>
            <div>
              <div className="mb-1.5 flex items-center gap-1.5 text-[11px] font-medium text-muted">
                <Sparkles size={12} /> 视觉风格
              </div>
              <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
                {VISUAL_STYLES.map((style) => (
                  <button
                    key={style}
                    type="button"
                    onClick={() => setDraft({ ...draft, style })}
                    className={cn(
                      'rounded-sm border px-2 py-2 text-left transition-colors',
                      draft.style === style
                        ? 'border-accent/45 bg-accent-soft/40'
                        : 'border-line hover:border-line-strong',
                    )}
                  >
                    <div className="text-[11px] font-medium text-fg">{STYLE_INFO[style].label}</div>
                    <div className="mt-0.5 text-[9px] leading-4 text-faint">{STYLE_INFO[style].detail}</div>
                  </button>
                ))}
              </div>
            </div>
          </div>
        </Panel>

        <Panel>
          <PanelHeader title="片头与片尾" description="会作为默认文案写入新视频的首尾镜头。" />
          <div className="grid gap-4 p-4 sm:grid-cols-2">
            <Field label="片头文案" hint="最多 140 字符">
              <Textarea
                value={draft.intro}
                maxLength={140}
                className="min-h-[76px]"
                onChange={(event) => setDraft({ ...draft, intro: event.target.value })}
              />
            </Field>
            <Field label="片尾行动号召" hint="最多 140 字符">
              <Textarea
                value={draft.outro}
                maxLength={140}
                className="min-h-[76px]"
                onChange={(event) => setDraft({ ...draft, outro: event.target.value })}
              />
            </Field>
          </div>
        </Panel>
      </div>

      <div className="space-y-4 xl:sticky xl:top-4 xl:h-fit">
        <Panel className="overflow-hidden">
          <div className="flex items-center justify-between border-b border-line px-4 py-3">
            <div>
              <div className="text-[12px] font-medium text-fg">实时品牌预览</div>
              <div className="mt-0.5 text-[10px] text-faint">保存前即可检查，非成片</div>
            </div>
            <div className="flex gap-1">
              {(['16:9', '9:16'] as AspectRatio[]).map((aspect) => (
                <button
                  key={aspect}
                  type="button"
                  onClick={() => setPreviewAspect(aspect)}
                  className={cn(
                    'rounded-sm border px-1.5 py-1 font-mono text-[9px] transition-colors',
                    previewAspect === aspect
                      ? 'border-accent/40 bg-accent-soft text-accent'
                      : 'border-line text-faint',
                  )}
                >
                  {aspect}
                </button>
              ))}
            </div>
          </div>
          <div className="bg-ink p-3">
            <div className={cn('mx-auto overflow-hidden rounded-sm border border-line', previewAspect === '9:16' ? 'w-[190px]' : 'w-full')}>
              <div className={previewAspect === '9:16' ? 'aspect-[9/16]' : 'aspect-video'}>
                <ScenePreview
                  scene={previewScene}
                  project={previewProject}
                  feature={previewKind === 'selling' ? firstFeature : undefined}
                  aspect={previewAspect}
                  showCaption={false}
                  showChrome
                />
              </div>
            </div>
          </div>
          <div className="flex items-center gap-1 border-t border-line p-2">
            {[
              { value: 'intro' as const, label: '片头' },
              { value: 'selling' as const, label: '卖点' },
              { value: 'outro' as const, label: '片尾' },
            ].map((item) => (
              <button
                key={item.value}
                type="button"
                onClick={() => setPreviewKind(item.value)}
                className={cn(
                  'flex-1 rounded-sm px-2 py-1.5 text-[10.5px] transition-colors',
                  previewKind === item.value ? 'bg-overlay text-fg' : 'text-faint hover:text-fg',
                )}
              >
                {item.label}
              </button>
            ))}
          </div>
        </Panel>

        {!valid ? (
          <Callout tone="danger" size="sm" title="还有字段需要修正">
            品牌字标不能为空；主色与辅色必须是完整的 #RRGGBB。
          </Callout>
        ) : null}

        {dirty && approvedVideos.length > 0 ? (
          <Callout tone="warning" size="sm" title={`保存会影响 ${approvedVideos.length} 条已通过视频`}>
            这些视频会回到待修改，生产记录仍会保留。这是为了防止成片与最新品牌资产不一致。
          </Callout>
        ) : null}

        <div className="flex items-center gap-2">
          <Button
            variant="primary"
            className="flex-1"
            icon={<Save size={14} />}
            disabled={!dirty || !valid}
            onClick={() => (approvedVideos.length > 0 ? setConfirming(true) : save())}
          >
        保存品牌套件
          </Button>
          <Button
            variant="ghost"
            icon={<RotateCcw size={13} />}
            disabled={!dirty}
            onClick={() => setDraft({ ...project.brand })}
          >
            撤销
          </Button>
        </div>
        <p className="text-[10px] leading-4 text-faint">
          品牌修改立即写入本地工程数据。当前没有真实上传、字体加载或 CDN，预览使用本机字体回退。
        </p>
      </div>

      <Dialog open={confirming} onOpenChange={setConfirming}>
        <DialogContent
          title="品牌变更会使已通过视频失效"
          description="数据不会被删除，但审核会失效，视频回到待修改。"
          size="sm"
          footer={
            <>
              <Button variant="ghost" onClick={() => setConfirming(false)}>取消</Button>
              <Button variant="primary" onClick={save}>保存并标记待修改</Button>
            </>
          }
        >
          <div className="space-y-2">
            {approvedVideos.map((video) => (
              <div key={video.id} className="flex items-center gap-2 rounded-sm border border-line bg-raised/40 px-2.5 py-2 text-[11px]">
                <AlertTriangle size={12} className="shrink-0 text-warn" />
                <span className="min-w-0 flex-1 truncate text-fg">{video.title}</span>
                <span className="shrink-0 text-[9.5px] text-faint">审核 → 待修改</span>
              </div>
            ))}
          </div>
          <p className="mt-3 text-[10.5px] leading-4 text-faint">
            生产记录、导出记录与镜头编辑都会保留；重新审核前不能再次导出。
          </p>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function ColorField({
  label,
  value,
  onChange,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
}) {
  const valid = /^#[0-9a-fA-F]{6}$/.test(value);
  return (
    <Field label={label} hint={valid ? undefined : '需要 #RRGGBB'}>
      <div className="flex items-center gap-2">
        <label
          className="relative size-9 shrink-0 cursor-pointer overflow-hidden rounded-sm border border-line"
          style={{ background: valid ? value : '#000' }}
        >
          <input
            type="color"
            value={valid ? value : '#000000'}
            onChange={(event) => onChange(event.target.value.toUpperCase())}
            className="absolute inset-0 cursor-pointer opacity-0"
            aria-label={`${label}取色器`}
          />
        </label>
        <Input
          value={value}
          onChange={(event) => onChange(event.target.value.toUpperCase())}
          className="font-mono uppercase"
          maxLength={7}
          aria-label={`${label}十六进制值`}
        />
      </div>
    </Field>
  );
}

function ProjectSettings({ project }: { project: Project }) {
  const updateProject = useStudioStore((state) => state.updateProject);
  const templates = useStudioStore((state) => state.templates);
  const pushToast = useUiStore((state) => state.pushToast);
  const [draft, setDraft] = useState({
    name: project.name,
    productName: project.productName,
    description: project.description,
    website: project.website,
    defaultAspect: project.defaultAspect,
    defaultLanguage: project.defaultLanguage,
    templateId: project.templateId,
  });

  const dirty = JSON.stringify(draft) !== JSON.stringify({
    name: project.name,
    productName: project.productName,
    description: project.description,
    website: project.website,
    defaultAspect: project.defaultAspect,
    defaultLanguage: project.defaultLanguage,
    templateId: project.templateId,
  });
  const valid = draft.name.trim().length > 0 && draft.productName.trim().length > 0;

  return (
    <div className="grid grid-cols-[minmax(0,1fr)] gap-4 xl:grid-cols-[minmax(0,1fr)_320px]">
      <Panel>
        <PanelHeader
          title="项目信息"
          description="用于工作区导航、报告与视频默认设置。"
          actions={dirty ? <Badge tone="warn">未保存</Badge> : null}
        />
        <div className="space-y-4 p-4">
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="项目名称" required>
              <Input value={draft.name} onChange={(event) => setDraft({ ...draft, name: event.target.value })} />
            </Field>
            <Field label="产品名称" required>
              <Input
                value={draft.productName}
                onChange={(event) => setDraft({ ...draft, productName: event.target.value })}
              />
            </Field>
          </div>
          <Field label="项目描述">
            <Textarea
              value={draft.description}
              className="min-h-[78px]"
              onChange={(event) => setDraft({ ...draft, description: event.target.value })}
            />
          </Field>
          <Field label="官网" hint="仅用于展示，不会发起真实抓取">
            <Input
              value={draft.website}
              placeholder="https://"
              onChange={(event) => setDraft({ ...draft, website: event.target.value })}
            />
          </Field>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="默认画幅">
              <Select
                value={draft.defaultAspect}
                onChange={(event) => setDraft({ ...draft, defaultAspect: event.target.value as AspectRatio })}
              >
                <option value="16:9">16:9 · 横屏</option>
                <option value="9:16">9:16 · 竖屏</option>
                <option value="1:1">1:1 · 方形</option>
              </Select>
            </Field>
            <Field label="默认语言">
              <Select
                value={draft.defaultLanguage}
                onChange={(event) => setDraft({ ...draft, defaultLanguage: event.target.value as Language })}
              >
                {LANGUAGES.map((language) => (
                  <option key={language} value={language}>
                    {language === 'zh-CN' ? '简体中文' : 'English (US)'}
                  </option>
                ))}
              </Select>
            </Field>
          </div>
          <Field label="默认模板" hint="只影响之后新建的视频；已有镜头保持自己的模板。">
            <Select
              value={draft.templateId}
              onChange={(event) => setDraft({ ...draft, templateId: event.target.value })}
            >
              {templates.map((template) => (
                <option key={template.id} value={template.id}>
                  {template.name} · {template.layout}
                </option>
              ))}
            </Select>
          </Field>
          <div className="flex justify-end gap-2 border-t border-line pt-3">
            <Button
              variant="ghost"
              disabled={!dirty}
              onClick={() =>
                setDraft({
                  name: project.name,
                  productName: project.productName,
                  description: project.description,
                  website: project.website,
                  defaultAspect: project.defaultAspect,
                  defaultLanguage: project.defaultLanguage,
                  templateId: project.templateId,
                })
              }
            >
              撤销
            </Button>
            <Button
              variant="primary"
              disabled={!dirty || !valid}
              onClick={() => {
                updateProject(project.id, {
                  ...draft,
                  name: draft.name.trim(),
                  productName: draft.productName.trim(),
                  description: draft.description.trim(),
                  website: draft.website.trim(),
                });
                pushToast({
                  tone: 'success',
                  title: '项目信息已更新',
                  description: '导航、项目概览与设置已同步。',
                });
              }}
            >
              保存项目信息
            </Button>
          </div>
        </div>
      </Panel>

      <div className="space-y-4">
        <Panel>
          <PanelHeader title="当前模板" />
          <div className="p-4">
            {(() => {
              const template = templates.find((item) => item.id === draft.templateId);
              return template ? (
                <>
                  <div className="font-display text-[16px] text-fg">{template.name}</div>
                  <p className="mt-1 text-[11px] leading-4 text-muted">{template.description}</p>
                  <div className="mt-3 flex gap-1.5">
                    <Badge tone="outline">{template.surface}</Badge>
                    <Badge tone="outline">{template.layout}</Badge>
                  </div>
                </>
              ) : (
                <span className="text-[11px] text-faint">未选择模板</span>
              );
            })()}
          </div>
        </Panel>
        <Callout tone="info" size="sm" title="项目 ID 保持不变">
          <span className="font-mono text-[10px]">{project.id}</span>
          <br />
          改名不会改变已有链接、知识或视频归属。
        </Callout>
      </div>
    </div>
  );
}

function SourceSettings({ project }: { project: Project }) {
  const syncProjectKnowledge = useStudioStore((state) => state.syncProjectKnowledge);
  const pushToast = useUiStore((state) => state.pushToast);
  const realGitHub = useMemo(() => parseProjectGitHubSource(project), [project]);

  const [syncing, setSyncing] = useState(false);
  const [githubStatus, setGithubStatus] = useState<GitHubConnectionStatus | null>(null);
  const [statusError, setStatusError] = useState<string | null>(null);
  const [loadingStatus, setLoadingStatus] = useState(false);
  const [repoInput, setRepoInput] = useState(() => realGitHub?.source.name ?? '');
  const [branchInput, setBranchInput] = useState(() => realGitHub?.branch ?? 'main');
  const [binding, setBinding] = useState(false);
  const [probing, setProbing] = useState(false);
  const [probeResult, setProbeResult] = useState<GitHubWriteProbeResult | null>(null);
  const [bindError, setBindError] = useState<string | null>(null);
  const [snapshots, setSnapshots] = useState<KnowledgeSnapshotSummaryV1[]>([]);
  const [repoAction, setRepoAction] = useState<'inc' | 'cold' | 'discover' | 'stale' | null>(null);

  const sources = project.sources;

  const refreshApiStatus = useCallback(async () => {
    setLoadingStatus(true);
    setStatusError(null);
    try {
      const client = await getGitHubKnowledgeClient();
      const status = await client.getStatus();
      setGithubStatus(status);
      const suggestedRepo = status.repo || status.accessibleRepositories[0];
      if (suggestedRepo) {
        setRepoInput((current) => (current ? current : suggestedRepo));
      }
    } catch (error) {
      setGithubStatus(null);
      setStatusError(error instanceof Error ? error.message : '无法读取本机 GitHub 连接状态。');
    } finally {
      setLoadingStatus(false);
    }
  }, []);

  useEffect(() => {
    void refreshApiStatus();
  }, [refreshApiStatus]);

  useEffect(() => {
    if (!realGitHub) {
      setSnapshots([]);
      return;
    }
    let cancelled = false;
    void getGitHubKnowledgeClient()
      .then((client) => client.listSnapshots(realGitHub.repo, { branch: realGitHub.branch, limit: 10 }))
      .then((list) => {
        if (!cancelled) setSnapshots(list);
      })
      .catch(() => {
        if (!cancelled) setSnapshots([]);
      });
    return () => {
      cancelled = true;
    };
  }, [realGitHub]);

  const sync = async () => {
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
        setSnapshots(
          await client.listSnapshots(realGitHub.repo, { branch: realGitHub.branch, limit: 10 }),
        );
        pushToast({
          tone:
            staleness.claimsMarkedStale.length > 0 || summary.invalidatedVideoIds.length > 0
              ? 'warning'
              : 'success',
          title: '真实同步完成',
          description: `${snapshot.stats.mode} · 分析 ${report.summary.analyzed} 个 PR · 复用 ${snapshot.stats.reusedFiles} 个文件${
            summary.invalidatedVideoIds.length > 0
              ? ` · ${summary.invalidatedVideoIds.length} 条已批准视频因过期失效`
              : ''
          }`,
        });
      } catch (error) {
        pushToast({
          tone: 'danger',
          title: '真实同步失败',
          description: error instanceof Error ? error.message : '同步请求失败。',
        });
      } finally {
        setSyncing(false);
      }
      return;
    }

    setSyncing(true);
    const result = await syncProjectKnowledge(project.id);
    setSyncing(false);
    pushToast({ tone: 'success', title: '模拟同步完成', description: result?.message });
  };

  const bindRealRepo = async () => {
    setBindError(null);
    let parsedRepo;
    try {
      parsedRepo = parseGitHubRepoRef(repoInput);
    } catch (error) {
      setBindError(error instanceof Error ? error.message : '仓库格式无效，请使用 owner/repo。');
      return;
    }

    setBinding(true);
    try {
      const client = await getGitHubKnowledgeClient();
      const status = await client.getStatus(parsedRepo);
      if (!status.configured) {
        setBindError(
          '本机 API 尚未配置 GitHub App 只读凭证（apps/api/.env.local），无法建立真实连接。',
        );
        return;
      }
      if (!status.readOnly) {
        setBindError(
          `安全拦截：检测到写权限 [${status.writePermissions.join(', ')}]，系统拒绝接入非只读安装。`,
        );
        return;
      }
      if (!status.connected) {
        setBindError(status.error ?? '无法连接该仓库，请检查 GitHub App 安装权限。');
        return;
      }
      const meta = await client.getRepository(parsedRepo);
      const nextBranch = branchInput.trim() || meta.defaultBranch || 'main';
      setBranchInput(nextBranch);
      const fullRepo = formatGitHubRepoRef(parsedRepo);
      attachRealGitHubSource(project.id, {
        repo: fullRepo,
        branch: nextBranch,
        detail: `只读 GitHub App · 分支 ${nextBranch}（默认分支 ${meta.defaultBranch}）`,
        readOnlyVerifiedAt: status.checkedAt,
      });
      setGithubStatus(status);
      pushToast({
        tone: 'success',
        title: `已绑定真实仓库 ${fullRepo}`,
        description: `只读权限已验证，目标分支 ${nextBranch}。可在下方运行增量索引或前往知识中心发现 PR。`,
      });
    } catch (error) {
      setBindError(error instanceof Error ? error.message : '绑定真实仓库失败。');
    } finally {
      setBinding(false);
    }
  };

  const runReadOnlyProbe = async () => {
    setBindError(null);
    let parsedRepo;
    try {
      parsedRepo = realGitHub?.repo ?? parseGitHubRepoRef(repoInput);
    } catch (error) {
      setBindError(error instanceof Error ? error.message : '请先填写合法的 owner/repo。');
      return;
    }
    setProbing(true);
    try {
      const client = await getGitHubKnowledgeClient();
      const result = await client.verifyReadOnly(parsedRepo);
      setProbeResult(result);
      pushToast({
        tone: result.writeBlocked && result.readOnlyToken ? 'success' : 'danger',
        title:
          result.writeBlocked && result.readOnlyToken
            ? 'AC-01 只读边界验证通过'
            : '写操作阻断探针未通过',
        description: result.detail,
      });
    } catch (error) {
      setBindError(error instanceof Error ? error.message : '只读边界探针失败。');
    } finally {
      setProbing(false);
    }
  };

  const runRepoOperation = async (kind: 'inc' | 'cold' | 'discover' | 'stale') => {
    if (!realGitHub) return;
    setRepoAction(kind);
    try {
      const client = await getGitHubKnowledgeClient();
      if (kind === 'inc' || kind === 'cold') {
        const snapshot = await client.indexRepository(realGitHub.repo, {
          branch: realGitHub.branch,
          forceCold: kind === 'cold',
        });
        const list = await client.listSnapshots(realGitHub.repo, {
          branch: realGitHub.branch,
          limit: 10,
        });
        setSnapshots(list);
        const candidates = await client.listCandidates(realGitHub.repo, { limit: 100 });
        if (candidates.length > 0) {
          await client.refreshStaleness(realGitHub.repo, { snapshotId: snapshot.id });
          const nextCandidates = await client.listCandidates(realGitHub.repo, { limit: 100 });
          reconcileDiscoveryCandidates(project.id, nextCandidates, {
            snapshotId: snapshot.id,
            commitSha: snapshot.gitCommitSha,
            branch: snapshot.branch,
            syncedAt: snapshot.indexedAt,
          });
        } else {
          reconcileDiscoveryCandidates(project.id, [], {
            snapshotId: snapshot.id,
            commitSha: snapshot.gitCommitSha,
            branch: snapshot.branch,
            syncedAt: snapshot.indexedAt,
          });
        }
        pushToast({
          tone: 'success',
          title: `${snapshot.stats.mode === 'cold' ? '冷扫描' : '增量索引'}完成`,
          description: `文件 ${snapshot.stats.totalFiles} · 复用 ${snapshot.stats.reusedFiles} · 下载 ${snapshot.stats.fetchedFiles}（${Math.round(snapshot.stats.durationMs)} ms）`,
        });
      } else if (kind === 'discover') {
        const report = await client.discoverPullRequests(realGitHub.repo, {
          branch: realGitHub.branch,
          state: 'closed',
          limit: 20,
        });
        const candidates = await client.listCandidates(realGitHub.repo, { limit: 100 });
        reconcileDiscoveryCandidates(project.id, candidates, {
          snapshotId: report.snapshotId,
          branch: report.branch,
          syncedAt: report.analyzedAt,
        });
        pushToast({
          tone: 'success',
          title: `PR 发现完成（${report.summary.analyzed} 个）`,
          description: `用户功能 ${report.summary.userFacingFeature} · 改进 ${report.summary.userFacingImprovement} · 内部过滤 ${report.summary.internal}`,
        });
      } else {
        const result = await client.refreshStaleness(realGitHub.repo, {
          branch: realGitHub.branch,
        });
        const candidates = await client.listCandidates(realGitHub.repo, { limit: 100 });
        const summary = reconcileDiscoveryCandidates(project.id, candidates, {
          snapshotId: result.snapshotId,
          commitSha: result.gitCommitSha,
          branch: result.branch,
          syncedAt: result.refreshedAt,
        });
        pushToast({
          tone: result.claimsMarkedStale.length > 0 ? 'warning' : 'success',
          title: '过期传播完成（AC-09）',
          description: `${result.claimsMarkedStale.length} 条 Claim 标为过期，${summary.invalidatedVideoIds.length} 条视频回到待修改。`,
        });
      }
    } catch (error) {
      pushToast({
        tone: 'danger',
        title: '操作失败',
        description: error instanceof Error ? error.message : '请求本机 API 失败。',
      });
    } finally {
      setRepoAction(null);
    }
  };

  return (
    <div className="grid grid-cols-[minmax(0,1fr)] gap-4 xl:grid-cols-[minmax(0,1fr)_320px]">
      <div className="space-y-4">
        <Panel>
          <PanelHeader
            title="已连接来源"
            description={realGitHub ? '已启用真实只读 GitHub 仓库来源。' : '来源只读；连接与抓取全部为模拟。'}
            actions={
              <Button variant="secondary" size="sm" icon={<RefreshCw size={12} />} loading={syncing} onClick={sync}>
                同步全部
              </Button>
            }
          />
          <div className="divide-y divide-line border-t border-line">
            {sources.map((source) => (
              <div key={source.id} className="flex items-start gap-3 px-4 py-3.5">
                <span className="mt-0.5 grid size-8 shrink-0 place-items-center rounded-md border border-line bg-overlay text-faint">
                  {source.kind === 'github' ? (
                    <GitPullRequest size={14} />
                  ) : source.kind === 'website' ? (
                    <Globe2 size={14} />
                  ) : (
                    <Link2 size={14} />
                  )}
                </span>
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-[12px] font-medium text-fg">{source.name}</span>
                    <Badge tone={source.status === 'connected' ? 'success' : source.status === 'error' ? 'danger' : 'warn'}>
                      {source.status === 'connected'
                        ? source.demo
                          ? '已连接（模拟）'
                          : '已连接（真实只读）'
                        : source.status === 'error'
                          ? '连接异常'
                          : '待处理'}
                    </Badge>
                    {source.demo ? <span className="text-[9px] text-faint">Demo</span> : null}
                  </div>
                  <div className="mt-1 text-[10.5px] text-muted">{source.detail}</div>
                  <div className="mt-1 flex flex-wrap gap-x-3 gap-y-1 text-[9.5px] text-faint">
                    <span>范围：{source.scope ?? '默认'}</span>
                    <span>
                      最近同步：{source.lastSyncedAt ? formatRelativeTime(source.lastSyncedAt) : '尚未同步'}
                    </span>
                    {source.lastSnapshotId ? (
                      <span className="font-mono">快照：{source.lastSnapshotId.slice(0, 14)}</span>
                    ) : null}
                    {source.lastCommitSha ? (
                      <span className="font-mono">commit：{source.lastCommitSha.slice(0, 8)}</span>
                    ) : null}
                  </div>
                  {source.error ? <div className="mt-1 text-[10px] text-danger">{source.error}</div> : null}
                </div>
              </div>
            ))}
          </div>
          <div className="border-t border-line px-4 py-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <span className="text-[10.5px] text-faint">想要从零创建真实仓库或无源码项目？</span>
              <Link to="/onboarding" className={buttonStyles({ variant: 'ghost', size: 'sm' })}>
                新建接入流程 <ExternalLink size={11} />
              </Link>
            </div>
          </div>
        </Panel>

        <Panel>
          <PanelHeader
            title="本机 GitHub App 只读连接（Step 4A/4B/4C）"
            description="通过本机 Fastify API（/api/v1/github/*）连接真实只读 GitHub 仓库；未配置凭证时不会伪造成功。"
            actions={
              <Button
                variant="ghost"
                size="sm"
                icon={<RefreshCw size={12} />}
                loading={loadingStatus}
                onClick={() => void refreshApiStatus()}
              >
                刷新状态
              </Button>
            }
          />
          <div className="space-y-4 border-t border-line p-4">
            {statusError ? (
              <Callout tone="warning" size="sm" title="本机 API 未连接">
                {statusError}
              </Callout>
            ) : githubStatus && !githubStatus.configured ? (
              <Callout tone="warning" size="sm" title="GitHub App 只读凭证尚未配置">
                将 <code className="font-mono">apps/api/.env.example</code> 复制为{' '}
                <code className="font-mono">apps/api/.env.local</code> 并填入只读 GitHub App 凭证后重启 API。
              </Callout>
            ) : githubStatus ? (
              <div className="rounded-md border border-line bg-raised/30 p-3 text-[11px]">
                <div className="flex flex-wrap items-center gap-2">
                  <Badge tone={githubStatus.connected ? 'success' : 'danger'} dot={false}>
                    {githubStatus.connected ? 'GitHub App 已连接' : '连接异常'}
                  </Badge>
                  <Badge tone={githubStatus.readOnly ? 'success' : 'danger'} dot={false}>
                    {githubStatus.readOnly ? '只读权限已核验' : '存在写权限（已禁止）'}
                  </Badge>
                  {githubStatus.appId ? (
                    <span className="font-mono text-[10px] text-faint">
                      app:{githubStatus.appId}
                    </span>
                  ) : null}
                </div>
                {githubStatus.accessibleRepositories.length > 0 ? (
                  <div className="mt-2 flex flex-wrap items-center gap-1.5">
                    <span className="text-[10px] text-faint">已授权仓库：</span>
                    {githubStatus.accessibleRepositories.map((repoName) => (
                      <button
                        key={repoName}
                        type="button"
                        onClick={() => setRepoInput(repoName)}
                        className={cn(
                          'rounded-sm border px-2 py-0.5 font-mono text-[10px] transition-colors',
                          repoInput.trim() === repoName
                            ? 'border-accent/45 bg-accent-soft text-accent'
                            : 'border-line text-muted hover:text-fg',
                        )}
                      >
                        {repoName}
                      </button>
                    ))}
                  </div>
                ) : null}
              </div>
            ) : null}

            <div className="grid gap-3 sm:grid-cols-[1fr_160px]">
              <Field label="GitHub 仓库（owner/repo）">
                <Input
                  value={repoInput}
                  onChange={(event) => setRepoInput(event.target.value)}
                  placeholder="例如 frontLikeDog/livenotes"
                />
              </Field>
              <Field label="目标分支">
                <Input
                  value={branchInput}
                  onChange={(event) => setBranchInput(event.target.value)}
                  placeholder="main"
                />
              </Field>
            </div>

            <div className="flex flex-wrap items-center gap-2">
              <Button
                variant="primary"
                size="sm"
                loading={binding}
                onClick={() => void bindRealRepo()}
                icon={<GitPullRequest size={13} />}
              >
                绑定为真实只读来源
              </Button>
              <Button
                variant="secondary"
                size="sm"
                loading={probing}
                onClick={() => void runReadOnlyProbe()}
                icon={<ShieldCheck size={13} />}
              >
                验证只读边界（AC-01）
              </Button>
              {realGitHub ? (
                <Link
                  to={`/projects/${project.id}/knowledge?tab=discovery`}
                  className={buttonStyles({ variant: 'ghost', size: 'sm' })}
                >
                  前往 PR 变更发现 →
                </Link>
              ) : null}
            </div>

            {bindError ? (
              <Callout tone="danger" size="sm" title="操作未成功">
                {bindError}
              </Callout>
            ) : null}

            {probeResult ? (
              <Callout
                tone={probeResult.writeBlocked && probeResult.readOnlyToken ? 'success' : 'danger'}
                size="sm"
                title={`AC-01 只读探针：${probeResult.repo}（HTTP ${probeResult.statusCode}）`}
              >
                {probeResult.detail}
              </Callout>
            ) : null}
          </div>
        </Panel>

        {realGitHub ? (
          <Panel>
            <PanelHeader
              title="真实仓库索引与不可变快照（Step 4B）"
              description={`${realGitHub.source.name} · ${realGitHub.branch}`}
              actions={
                <div className="flex flex-wrap gap-1.5">
                  <Button
                    variant="secondary"
                    size="sm"
                    loading={repoAction === 'inc'}
                    disabled={repoAction !== null}
                    onClick={() => void runRepoOperation('inc')}
                  >
                    增量索引
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    loading={repoAction === 'cold'}
                    disabled={repoAction !== null}
                    onClick={() => void runRepoOperation('cold')}
                  >
                    冷扫描对照
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    loading={repoAction === 'discover'}
                    disabled={repoAction !== null}
                    onClick={() => void runRepoOperation('discover')}
                  >
                    发现 PR
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    loading={repoAction === 'stale'}
                    disabled={repoAction !== null}
                    onClick={() => void runRepoOperation('stale')}
                  >
                    刷新过期
                  </Button>
                </div>
              }
            />
            <div className="divide-y divide-line border-t border-line">
              {snapshots.length === 0 ? (
                <div className="px-4 py-6 text-center text-[11px] text-faint">
                  尚未生成快照；点击「增量索引」建立只追加不可变快照。
                </div>
              ) : (
                snapshots.map((snap) => (
                  <div key={snap.id} className="flex flex-wrap items-center gap-3 px-4 py-2.5 text-[11px]">
                    <span className="font-mono text-[10.5px] text-fg">{snap.id}</span>
                    <Badge tone={snap.stats.mode === 'incremental' ? 'success' : 'outline'} dot={false}>
                      {snap.stats.mode}
                    </Badge>
                    <span className="font-mono text-[10px] text-faint">
                      {snap.branch} @ {snap.gitCommitSha.slice(0, 8)}
                    </span>
                    <span className="text-muted">
                      共 {snap.stats.totalFiles} · 复用 {snap.stats.reusedFiles} · 下载 {snap.stats.fetchedFiles}
                    </span>
                    <span className="ml-auto font-mono text-[10px] text-faint">
                      {Math.round(snap.stats.durationMs)}ms · {formatDate(snap.indexedAt)}
                    </span>
                  </div>
                ))
              )}
            </div>
          </Panel>
        ) : null}
      </div>

      <div className="space-y-3">
        <Callout tone={realGitHub ? 'success' : 'warning'} title={realGitHub ? '真实只读连接器' : '模拟连接器'}>
          {realGitHub
            ? 'GitHub App 仅持有只读权限；索引快照只追加持久化在 SQLite，不会向仓库写入任何内容。'
            : '这里展示的 GitHub、网站与文档连接不会发起真实网络请求。同步只会推进本地快照、时间戳与候选建议。'}
        </Callout>
        <Panel>
          <PanelHeader title="同步会做什么" />
          <div className="space-y-2 px-4 pb-4 text-[10.5px] leading-4 text-muted">
            {realGitHub ? (
              <>
                <p>· 按 blob sha 增量复用未变更文件的提取结果。</p>
                <p>· 确定性分类 PR（用户功能 / 改进 / 内部重构）。</p>
                <p>· 按 AC-09 比对文件 SHA256，自动标出过期证据并失效受影响视频。</p>
                <p>· 不会自动批准或发布任何 Claim。</p>
              </>
            ) : (
              <>
                <p>· 更新所有来源的最后同步时间。</p>
                <p>· 将项目分析次数 +1。</p>
                <p>· 可能生成一条新的待确认知识建议。</p>
                <p>· 不会自动修改声明状态，也不会调用真实模型。</p>
              </>
            )}
          </div>
        </Panel>
        <Panel>
          <PanelHeader title="来源完整性" />
          <div className="space-y-2 px-4 pb-4">
            <SourceCheck label="至少一个来源" ok={sources.length > 0} />
            <SourceCheck label="GitHub 仓库已连接" ok={sources.some((source) => source.kind === 'github' && source.status === 'connected')} optional />
            <SourceCheck label="来源范围已指定" ok={sources.every((source) => Boolean(source.scope))} optional />
            <SourceCheck label="存在同步时间" ok={sources.some((source) => Boolean(source.lastSyncedAt))} />
          </div>
        </Panel>
      </div>
    </div>
  );
}

function SourceCheck({ label, ok, optional }: { label: string; ok: boolean; optional?: boolean }) {
  return (
    <div className="flex items-center gap-2 text-[10.5px]">
      <span className={cn('grid size-4 place-items-center rounded-full', ok ? 'bg-success-soft text-success' : 'bg-overlay text-faint')}>
        {ok ? <Check size={9} /> : <span className="size-1 rounded-full bg-current" />}
      </span>
      <span className={ok ? 'text-muted' : 'text-faint'}>{label}</span>
      {optional && !ok ? <span className="ml-auto text-[9px] text-faint">可选</span> : null}
    </div>
  );
}

const SYNC_PHASE_INFO: Record<
  WorkspaceSyncPhase,
  { label: string; tone: 'outline' | 'neutral' | 'success' | 'warn' | 'danger' }
> = {
  disabled: { label: '未启用', tone: 'outline' },
  connecting: { label: '连接中', tone: 'warn' },
  synced: { label: '已同步', tone: 'success' },
  dirty: { label: '待上传', tone: 'warn' },
  saving: { label: '上传中', tone: 'warn' },
  conflict: { label: '版本冲突', tone: 'danger' },
  error: { label: '同步错误', tone: 'danger' },
};

function WorkspaceSyncPanel() {
  const config = useWorkspaceSyncStore((state) => state.config);
  const phase = useWorkspaceSyncStore((state) => state.phase);
  const lastSyncedAt = useWorkspaceSyncStore((state) => state.lastSyncedAt);
  const remoteRevision = useWorkspaceSyncStore((state) => state.remoteRevision);
  const lastError = useWorkspaceSyncStore((state) => state.lastError);
  const updateConfig = useWorkspaceSyncStore((state) => state.updateConfig);
  const requestCommand = useWorkspaceSyncStore((state) => state.requestCommand);
  const [baseUrl, setBaseUrl] = useState(config.baseUrl);
  const [workspaceId, setWorkspaceId] = useState(config.workspaceId);

  const info = SYNC_PHASE_INFO[phase];
  const enabled = config.enabled;

  const enable = (kind: 'connect' | 'push') => {
    updateConfig({
      enabled: true,
      baseUrl: baseUrl.trim() || '/api',
      workspaceId: workspaceId.trim() || 'default',
    });
    requestCommand(kind);
  };

  return (
    <Panel>
      <PanelHeader
        title="工作区同步（SQLite API）"
        description="可选：把完整工作区写入本机 Fastify + SQLite 服务，供另一台设备或另一个浏览器恢复。"
        actions={<Badge tone={info.tone}>{info.label}</Badge>}
      />
      <div className="space-y-4 border-t border-line p-4">
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="API 地址" hint="开发环境默认经 Vite 代理到 127.0.0.1:4300">
            <Input
              value={baseUrl}
              onChange={(event) => setBaseUrl(event.target.value)}
              disabled={enabled}
              placeholder="/api"
            />
          </Field>
          <Field label="工作区 ID" hint="字母、数字、下划线与短横线">
            <Input
              value={workspaceId}
              onChange={(event) => setWorkspaceId(event.target.value)}
              disabled={enabled}
              placeholder="default"
            />
          </Field>
        </div>

        {enabled ? (
          <div className="flex flex-wrap items-center gap-2">
            <Button
              variant="secondary"
              size="sm"
              icon={<RefreshCw size={12} />}
              onClick={() => requestCommand('connect')}
            >
              重新连接
            </Button>
            <Button
              variant="secondary"
              size="sm"
              icon={<Download size={12} />}
              onClick={() => requestCommand('pull')}
            >
              拉取服务器
            </Button>
            <Button
              variant="secondary"
              size="sm"
              icon={<Upload size={12} />}
              onClick={() => requestCommand('push')}
            >
              上传本机
            </Button>
            <Button
              variant="ghost"
              size="sm"
              icon={<CloudOff size={12} />}
              onClick={() => updateConfig({ enabled: false })}
            >
              断开
            </Button>
          </div>
        ) : (
          <div className="flex flex-wrap items-center gap-2">
            <Button
              variant="primary"
              size="sm"
              icon={<Cloud size={13} />}
              onClick={() => enable('connect')}
            >
              启用并同步
            </Button>
            <Button
              variant="secondary"
              size="sm"
              icon={<Upload size={12} />}
              onClick={() => enable('push')}
            >
              上传本机并启用
            </Button>
          </div>
        )}

        {enabled ? (
          <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-[10px] text-faint">
            <span>目标 <code className="font-mono text-muted">{config.baseUrl}</code></span>
            <span>工作区 <code className="font-mono text-muted">{config.workspaceId}</code></span>
            {remoteRevision ? <span>服务器版本 r{remoteRevision}</span> : null}
            {lastSyncedAt ? <span>最近同步 {formatRelativeTime(lastSyncedAt)}</span> : null}
          </div>
        ) : null}

        {lastError ? (
          <Callout tone={phase === 'conflict' ? 'warning' : 'danger'} size="sm" title="同步状态">
            {lastError}
          </Callout>
        ) : null}

        {phase === 'conflict' ? (
          <div className="flex flex-wrap items-center gap-2 rounded-sm border border-warn/25 bg-warn-soft/30 px-3 py-2">
            <AlertTriangle size={13} className="text-warn" />
            <span className="min-w-0 flex-1 text-[10.5px] leading-4 text-muted">
              服务器上已有更新版本。选择拉取服务器内容，或以本机覆盖。
            </span>
            <Button variant="secondary" size="sm" onClick={() => requestCommand('pull')}>
              拉取服务器
            </Button>
            <Button variant="primary" size="sm" onClick={() => requestCommand('push')}>
              以本机覆盖
            </Button>
          </div>
        ) : null}

        <p className="text-[10px] leading-4 text-faint">
          同步写入的是本机 Fastify 服务的 SQLite 文件，不经过第三方云。生产运行动画仍由当前页面推进；服务器保存运行状态，供其他设备查看。
        </p>
      </div>
    </Panel>
  );
}

function WorkspaceTransferPanel() {
  const replaceWorkspace = useStudioStore((state) => state.replaceWorkspace);
  const syncEnabled = useWorkspaceSyncStore((state) => state.config.enabled);
  const pushToast = useUiStore((state) => state.pushToast);
  const inputRef = useRef<HTMLInputElement>(null);
  const [preview, setPreview] = useState<StudioSnapshot | null>(null);
  const [error, setError] = useState<string | null>(null);

  const exportWorkspace = () => {
    const json = buildWorkspaceExport(selectStudioSnapshot(useStudioStore.getState()));
    const url = URL.createObjectURL(new Blob([json], { type: 'application/json' }));
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = workspaceExportFileName();
    anchor.click();
    URL.revokeObjectURL(url);
    pushToast({
      tone: 'success',
      title: '工作区已导出',
      description: '文件包含全部项目、知识、视频工程与生产记录。',
    });
  };

  const readFile = async (file: File | undefined) => {
    if (!file) return;
    try {
      const parsed = parseWorkspaceExport(await file.text());
      setError(null);
      setPreview(parsed.workspace);
    } catch (readError) {
      setPreview(null);
      setError(readError instanceof Error ? readError.message : '无法读取该文件。');
    }
  };

  const confirmImport = () => {
    if (!preview) return;
    replaceWorkspace(preview, '从备份文件导入');
    setPreview(null);
    pushToast({
      tone: 'success',
      title: '工作区已导入',
      description: syncEnabled
        ? '已替换本机数据；同步开启时会自动上传到服务器。'
        : '已替换本机数据；如需跨设备恢复，请开启上方同步。',
    });
  };

  return (
    <Panel>
      <PanelHeader
        title="工作区备份（导入 / 导出）"
        description="导出完整工作区 JSON；在全新浏览器中导入即可恢复，不依赖服务器。"
      />
      <div className="space-y-3 border-t border-line p-4">
        <div className="flex flex-wrap items-center gap-2">
          <Button
            variant="secondary"
            size="sm"
            icon={<Download size={12} />}
            onClick={exportWorkspace}
          >
            导出工作区 JSON
          </Button>
          <Button
            variant="secondary"
            size="sm"
            icon={<Upload size={12} />}
            onClick={() => inputRef.current?.click()}
          >
            导入工作区 JSON
          </Button>
          <input
            ref={inputRef}
            type="file"
            accept="application/json,.json"
            className="hidden"
            onChange={(event) => {
              const file = event.target.files?.[0];
              void readFile(file);
              event.target.value = '';
            }}
          />
        </div>
        {error ? (
          <Callout tone="danger" size="sm" title="导入失败">
            {error}
          </Callout>
        ) : null}
        <p className="text-[10px] leading-4 text-faint">
          备份不包含 MP4 媒体文件与主题等浏览器偏好；导入会替换当前工作区并清空撤销历史。
        </p>
      </div>

      <Dialog open={Boolean(preview)} onOpenChange={(open) => !open && setPreview(null)}>
        <DialogContent
          title="导入并替换当前工作区？"
          description="当前未导出的修改会被覆盖。"
          size="sm"
          footer={
            <>
              <Button variant="ghost" onClick={() => setPreview(null)}>
                取消
              </Button>
              <Button variant="primary" onClick={confirmImport}>
                确认导入
              </Button>
            </>
          }
        >
          {preview ? (
            <div className="grid grid-cols-2 gap-px overflow-hidden rounded-sm border border-line bg-line sm:grid-cols-4">
              {[
                ['项目', preview.projects.length],
                ['功能', preview.features.length],
                ['视频', preview.videos.length],
                ['运行', preview.runs.length],
              ].map(([label, value]) => (
                <div key={String(label)} className="bg-surface px-3 py-2.5 text-center">
                  <div className="font-display text-[16px] text-fg">{value}</div>
                  <div className="text-[9px] text-faint">{label}</div>
                </div>
              ))}
            </div>
          ) : null}
          <p className="mt-3 text-[10.5px] leading-4 text-faint">
            数据会先经过版本迁移与 Schema 校验；结构不完整时不会写入。
          </p>
        </DialogContent>
      </Dialog>
    </Panel>
  );
}

function DataSettings({ project }: { project: Project }) {
  const resetDemoData = useStudioStore((state) => state.resetDemoData);
  const featureCount = useStudioStore(
    (state) => state.features.filter((feature) => feature.projectId === project.id).length,
  );
  const claimCount = useStudioStore(
    (state) => state.claims.filter((claim) => claim.projectId === project.id).length,
  );
  const videoCount = useStudioStore(
    (state) => state.videos.filter((video) => video.projectId === project.id).length,
  );
  const runCount = useStudioStore(
    (state) => state.runs.filter((run) => run.projectId === project.id).length,
  );
  const pushToast = useUiStore((state) => state.pushToast);
  const navigate = useNavigate();
  const [confirmOpen, setConfirmOpen] = useState(false);

  const localKeys = [
    'asvs.studio.v1',
    'asvs.ui.v1',
    'asvs.onboarding.v1',
    'asvs.workspace-sync.v1',
  ];

  return (
    <div className="grid grid-cols-[minmax(0,1fr)] gap-4 xl:grid-cols-[minmax(0,1fr)_340px]">
      <div className="space-y-4">
        <WorkspaceSyncPanel />
        <WorkspaceTransferPanel />

        <Panel>
          <PanelHeader
            title="本地演示数据"
            description="默认保存在浏览器 localStorage；启用工作区同步后，完整快照会写入本机 SQLite API。"
          />
          <div className="space-y-3 border-t border-line p-4">
            {localKeys.map((key) => (
              <div key={key} className="flex items-center justify-between gap-3 rounded-sm border border-line bg-raised/30 px-3 py-2">
                <code className="font-mono text-[10.5px] text-muted">{key}</code>
                <Badge tone="outline" dot={false}>本机</Badge>
              </div>
            ))}
            <div className="flex items-start gap-2 text-[10.5px] leading-4 text-faint">
              <ShieldCheck size={13} className="mt-0.5 shrink-0 text-success" />
              刷新页面不会丢失数据。同步只写入本机 Fastify 服务的 SQLite 文件，不经过第三方云。导出 MP4/WebM 只会产生模拟状态，不会写媒体文件；项目 JSON、SRT 与工作区备份会真实下载。
            </div>
          </div>
        </Panel>

        <Panel>
          <PanelHeader title="当前项目规模" />
          <div className="grid grid-cols-2 gap-px bg-line sm:grid-cols-4">
            {[
              ['功能', featureCount],
              ['声明', claimCount],
              ['视频', videoCount],
              ['运行', runCount],
            ].map(([label, value]) => (
              <div key={String(label)} className="bg-surface px-3 py-3 text-center">
                <div className="font-display text-[18px] text-fg">{value}</div>
                <div className="text-[9.5px] text-faint">{label}</div>
              </div>
            ))}
          </div>
        </Panel>
      </div>

      <div className="space-y-3">
        <Callout tone="danger" title="危险区域">
          重置会删除你在本次演示中新建的项目、视频、编辑、审核与导出记录，恢复固定的 Lumen / Pulse 示例数据。
        </Callout>
        <Panel className="border-danger/20 p-4">
          <div className="flex items-start gap-2">
            <Trash2 size={15} className="mt-0.5 text-danger" />
            <div className="min-w-0 flex-1">
              <div className="text-[12px] font-medium text-fg">重置所有演示数据</div>
              <p className="mt-1 text-[10.5px] leading-4 text-faint">
                此操作不可撤销，但不会影响本机其他网站。
              </p>
              <Button variant="danger" size="sm" className="mt-3" onClick={() => setConfirmOpen(true)}>
                重置演示数据
              </Button>
            </div>
          </div>
        </Panel>
      </div>

      <Dialog open={confirmOpen} onOpenChange={setConfirmOpen}>
        <DialogContent
          title="确认重置所有演示数据？"
          description="当前项目也会回到初始示例状态。"
          size="sm"
          footer={
            <>
              <Button variant="ghost" onClick={() => setConfirmOpen(false)}>取消</Button>
              <Button
                variant="danger"
                onClick={() => {
                  resetDemoData();
                  setConfirmOpen(false);
                  pushToast({ tone: 'info', title: '演示数据已重置', description: '已恢复初始示例项目。' });
                  navigate('/');
                }}
              >
                确认重置
              </Button>
            </>
          }
        >
          <div className="rounded-md border border-danger/20 bg-danger-soft/30 px-3 py-2.5 text-[11px] leading-5 text-muted">
            将删除本地保存的项目、功能、声明、视频、运行与导出记录，并恢复种子快照。刷新页面后仍然保持重置后的状态。
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
