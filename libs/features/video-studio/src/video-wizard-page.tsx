import { useMemo, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import type {
  AspectRatio,
  Feature,
  Language,
  Tone,
  VideoBrief,
  VideoMode,
  VisualStyle,
} from '@asvs/domain';
import {
  DEFAULT_BANNED_PHRASES,
  DURATION_OPTIONS,
  TONE_INFO,
  VIDEO_MODE_INFO,
  VIDEO_MODE_ORDER,
  formatDate,
  formatDuration,
} from '@asvs/domain';
import {
  ArrowLeft,
  ArrowRight,
  Check,
  ChevronRight,
  Clock3,
  Film,
  GitPullRequest,
  GraduationCap,
  Layers,
  Plus,
  Sparkles,
  Wand2,
  X,
} from 'lucide-react';
import {
  Badge,
  Button,
  Callout,
  ClaimStatusBadge,
  FeatureStatusBadge,
  Field,
  Input,
  Page,
  PageHeader,
  Panel,
  PanelHeader,
  ScenePreview,
  SegmentedControl,
  Select,
  Slider,
  Switch,
  Textarea,
  buttonStyles,
  cn,
} from '@asvs/ui';
import { useStudioStore, useUiStore } from '@asvs/state';
import { useShallow } from 'zustand/react/shallow';
import { NotFoundInline } from './not-found-inline';

const MODE_ICONS: Record<VideoMode, typeof Film> = {
  product_film: Film,
  release_video: GitPullRequest,
  tutorial: GraduationCap,
  content_factory: Layers,
};

const STEP_LABELS = ['类型与目标', '创作简报', '生成预览'];

export function VideoWizardPage() {
  const { projectId = '' } = useParams();
  const navigate = useNavigate();
  const project = useStudioStore((state) => state.projects.find((item) => item.id === projectId));
  const features = useStudioStore(
    useShallow((state) => state.features.filter((item) => item.projectId === projectId)),
  );
  const claims = useStudioStore(
    useShallow((state) => state.claims.filter((item) => item.projectId === projectId)),
  );
  const releases = useStudioStore(
    useShallow((state) =>
      state.releases
        .filter((item) => item.projectId === projectId)
        .sort((a, b) => new Date(b.releasedAt).getTime() - new Date(a.releasedAt).getTime()),
    ),
  );
  const templates = useStudioStore((state) => state.templates);
  const createVideo = useStudioStore((state) => state.createVideo);
  const pushToast = useUiStore((state) => state.pushToast);

  const sortedFeatures = useMemo(() => {
    const rank = (feature: Feature) => {
      const claim = claims.find((item) => item.id === feature.claimIds[0]);
      if (feature.status === 'verified' || feature.status === 'deployed') {
        return claim?.status === 'verified' ? 0 : 1;
      }
      if (feature.status === 'stale') return 4;
      if (feature.status === 'proposed') return 3;
      return 2;
    };
    return [...features].sort((a, b) => rank(a) - rank(b));
  }, [features, claims]);

  const [step, setStep] = useState(1);
  const [mode, setMode] = useState<VideoMode>('release_video');
  const [title, setTitle] = useState(
    `${project?.productName ?? ''} · ${releases[0]?.name ?? '产品亮点'}`.trim(),
  );
  const [objective, setObjective] = useState('让现有用户和潜在客户在 30 秒内理解本次更新最重要的价值。');
  const [audience, setAudience] = useState('现有客户、产品评估者与团队决策者');
  const [featureIds, setFeatureIds] = useState<string[]>(() => initialFeatures('release_video', features, claims));
  const [releaseId, setReleaseId] = useState<string | undefined>(releases[0]?.id);
  const [durationSec, setDurationSec] = useState(30);
  const [aspect, setAspect] = useState<AspectRatio>(project?.defaultAspect ?? '16:9');
  const [language, setLanguage] = useState<Language>(project?.defaultLanguage ?? 'zh-CN');
  const [tone, setTone] = useState<Tone>('confident');
  const [style, setStyle] = useState<VisualStyle>(project?.brand.style ?? 'editorial');
  const [templateId, setTemplateId] = useState(templates[0]?.id ?? 'tpl_signal');
  const [useRealCapture, setUseRealCapture] = useState(true);
  const [useGeneratedVisuals, setUseGeneratedVisuals] = useState(false);
  const [cta, setCta] = useState(project?.brand.outro ?? '现在开始试用');
  const [bannedPhrases, setBannedPhrases] = useState<string[]>([...DEFAULT_BANNED_PHRASES]);
  const [newPhrase, setNewPhrase] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);

  if (!project) return <NotFoundInline label="项目不存在或已被删除。" />;

  const selectedFeatures = featureIds
    .map((id) => features.find((item) => item.id === id))
    .filter((item): item is Feature => Boolean(item));
  const selectedRelease = releases.find((release) => release.id === releaseId);
  const selectedTemplate = templates.find((template) => template.id === templateId);

  const claimStates = selectedFeatures.map((feature) => {
    const claim = claims.find((item) => item.id === feature.claimIds[0]);
    return { feature, claim };
  });
  const blocking = claimStates.filter(
    ({ feature, claim }) =>
      !claim || claim.status === 'stale' || claim.status === 'rejected' || feature.status === 'stale',
  );
  const limited = claimStates.filter(
    ({ claim }) => claim?.status === 'supported' || claim?.status === 'proposed',
  );

  const applyMode = (next: VideoMode) => {
    setMode(next);
    const info = VIDEO_MODE_INFO[next];
    setDurationSec(info.durationSec);
    setAspect(info.aspect);
    setUseRealCapture(info.useRealCapture);
    setUseGeneratedVisuals(info.useGeneratedVisuals);
    setFeatureIds(initialFeatures(next, features, claims));
    if (next === 'release_video' && releases[0]) {
      setReleaseId(releases[0].id);
      setTitle(`${project.productName} · ${releases[0].name}`);
    } else {
      setReleaseId(undefined);
      setTitle(`${project.productName} · ${info.label}`);
    }
    setObjective(modeObjective(next));
    setAudience(modeAudience(next));
    setError(null);
  };

  const toggleFeature = (featureId: string) => {
    if (mode === 'tutorial') {
      setFeatureIds([featureId]);
      return;
    }
    setFeatureIds((current) =>
      current.includes(featureId)
        ? current.filter((id) => id !== featureId)
        : [...current, featureId],
    );
  };

  const validateStep = (target: number): boolean => {
    if (target === 1 && !title.trim()) {
      setError('请先给视频起一个标题。');
      return false;
    }
    if (target === 2) {
      if (!objective.trim()) {
        setError('请填写创作目标。');
        return false;
      }
      if (!audience.trim()) {
        setError('请填写目标受众。');
        return false;
      }
      if (featureIds.length === 0) {
        setError('至少选择一个功能作为视频卖点。');
        return false;
      }
    }
    setError(null);
    return true;
  };

  const next = () => {
    if (!validateStep(step)) return;
    setStep((current) => Math.min(3, current + 1));
  };

  const create = () => {
    if (!validateStep(2)) {
      setStep(2);
      return;
    }
    setCreating(true);
    try {
      const brief: VideoBrief = {
        objective: objective.trim(),
        audience: audience.trim(),
        featureIds,
        releaseId,
        durationSec,
        aspect,
        language,
        tone,
        style,
        templateId,
        useRealCapture,
        useGeneratedVisuals,
        cta: cta.trim(),
        bannedPhrases,
      };
      const videoId = createVideo({
        projectId: project.id,
        title: title.trim(),
        mode,
        brief,
      });
      pushToast({
        tone: 'success',
        title: '脚本与分镜已生成',
        description: '现在处于脚本待确认阶段，还没有开始生产。',
      });
      navigate(`/videos/${videoId}/director`, { replace: true });
    } catch (createError) {
      setCreating(false);
      setError(createError instanceof Error ? createError.message : '无法生成视频策划。');
    }
  };

  const outline = buildOutline(mode, selectedFeatures, durationSec, cta, project.productName);

  return (
    <Page wide>
      <PageHeader
        eyebrow={
          <>
            <span className="size-1.5 rounded-full bg-accent" />
            {project.name} · New video
          </>
        }
        title="创建视频"
        description="从可追溯的产品事实开始。生成的是可编辑脚本与分镜，不是不可修改的黑盒成片。"
        actions={
          <Link to={`/projects/${project.id}/videos`} className={buttonStyles({ variant: 'ghost' })}>
            <ArrowLeft size={14} /> 取消
          </Link>
        }
      />

      <div className="mt-6 grid gap-5 xl:grid-cols-[220px_minmax(0,1fr)]">
        <aside className="h-fit xl:sticky xl:top-4">
          <ol className="space-y-1">
            {STEP_LABELS.map((label, index) => {
              const number = index + 1;
              const active = step === number;
              const done = step > number;
              return (
                <li key={label}>
                  <button
                    type="button"
                    disabled={number > step}
                    onClick={() => {
                      if (number < step) { setStep(number); setError(null); }
                    }}
                    className={cn(
                      'flex w-full items-center gap-2.5 rounded-md px-2.5 py-2 text-left transition-colors',
                      active ? 'bg-overlay text-fg' : done ? 'text-muted hover:bg-overlay/40' : 'text-faint',
                    )}
                  >
                    <span
                      className={cn(
                        'grid size-5 shrink-0 place-items-center rounded-full border font-mono text-[9px]',
                        active
                          ? 'border-accent bg-accent text-on-accent'
                          : done
                            ? 'border-success/40 bg-success-soft text-success'
                            : 'border-line-strong text-faint',
                      )}
                    >
                      {done ? <Check size={10} strokeWidth={3} /> : number}
                    </span>
                    <span className="text-[11.5px]">{label}</span>
                    {active ? <ChevronRight size={11} className="ml-auto text-accent" /> : null}
                  </button>
                </li>
              );
            })}
          </ol>

          <div className="mt-5 rounded-md border border-line bg-surface/50 p-3">
            <div className="text-[9px] uppercase tracking-[0.12em] text-faint">当前配置</div>
            <div className="mt-2 space-y-1.5 text-[10.5px]">
              <SummaryRow label="类型" value={VIDEO_MODE_INFO[mode].shortLabel} />
              <SummaryRow label="时长" value={formatDuration(durationSec)} />
              <SummaryRow label="画幅" value={aspect} />
              <SummaryRow label="卖点" value={`${featureIds.length} 个`} />
              <SummaryRow label="模板" value={selectedTemplate?.name ?? '默认'} />
            </div>
          </div>

          <Callout tone="ai" size="sm" className="mt-4" title="这里不会调用真实 AI">
            向导根据你的输入和本地知识确定性生成脚本结构；所有功能、声明与证据均来自当前项目的模拟快照。
          </Callout>
        </aside>

        <div>
          {step === 1 ? (
            <div className="space-y-4">
              <Panel>
                <PanelHeader
                  title="这条视频要做什么？"
                  description="类型会决定默认时长、画幅与叙事结构，之后都可以改。"
                />
                <div className="grid gap-3 p-4 sm:grid-cols-2">
                  {VIDEO_MODE_ORDER.map((value) => {
                    const info = VIDEO_MODE_INFO[value];
                    const Icon = MODE_ICONS[value];
                    const active = mode === value;
                    return (
                      <button
                        key={value}
                        type="button"
                        onClick={() => applyMode(value)}
                        aria-pressed={active}
                        className={cn(
                          'group relative overflow-hidden rounded-md border p-4 text-left transition-all duration-150',
                          active
                            ? 'border-accent/50 bg-accent-soft/30 shadow-[0_0_0_1px_rgba(215,243,106,.12)]'
                            : 'border-line bg-raised/20 hover:border-line-strong hover:bg-raised/40',
                        )}
                      >
                        <div className="flex items-start justify-between">
                          <span
                            className={cn(
                              'grid size-8 place-items-center rounded-md border',
                              active ? 'border-accent/40 bg-accent/10 text-accent' : 'border-line bg-overlay text-muted',
                            )}
                          >
                            <Icon size={15} />
                          </span>
                          <span
                            className={cn(
                              'grid size-4 place-items-center rounded-full border',
                              active ? 'border-accent bg-accent text-on-accent' : 'border-line-strong',
                            )}
                          >
                            {active ? <Check size={9} strokeWidth={3} /> : null}
                          </span>
                        </div>
                        <div className="mt-3 font-display text-[15px] font-medium text-fg">{info.label}</div>
                        <p className="mt-1 text-[11px] leading-[17px] text-muted">{info.description}</p>
                        <div className="mt-3 flex flex-wrap gap-1">
                          <Badge tone="outline" dot={false}>{info.durationSec}s</Badge>
                          <Badge tone="outline" dot={false}>{info.aspect}</Badge>
                          {info.useGeneratedVisuals ? <Badge tone="ai" dot={false}>含生成画面</Badge> : null}
                        </div>
                        <div className="mt-2 text-[9.5px] text-faint">适合：{info.bestFor}</div>
                      </button>
                    );
                  })}
                </div>
              </Panel>

              <Panel>
                <PanelHeader title="视频标题" description="先工作标题即可，之后仍可修改。" />
                <div className="p-4">
                  <Field label="标题" required error={error ?? undefined}>
                    <Input
                      value={title}
                      maxLength={80}
                      onChange={(event) => { setTitle(event.target.value); setError(null); }}
                      placeholder="例如：Lumen 0.9 · 让反馈进入同一条工作流"
                    />
                  </Field>
                </div>
              </Panel>
            </div>
          ) : null}

          {step === 2 ? (
            <div className="space-y-4">
              <Panel>
                <PanelHeader title="创作简报" description="目标、受众与所选事实会直接约束脚本措辞。" />
                <div className="space-y-4 p-4">
                  <div className="grid gap-4 sm:grid-cols-2">
                    <Field label="创作目标" required>
                      <Textarea
                        value={objective}
                        className="min-h-[82px]"
                        onChange={(event) => setObjective(event.target.value)}
                      />
                    </Field>
                    <Field label="目标受众" required>
                      <Textarea
                        value={audience}
                        className="min-h-[82px]"
                        onChange={(event) => setAudience(event.target.value)}
                      />
                    </Field>
                  </div>

                  <div>
                    <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
                      <div className="flex items-center gap-1.5 text-[12px] font-medium text-fg">
                        <Sparkles size={13} className="text-accent" />
                        选择卖点功能
                        <span className="text-[10px] font-normal text-faint">
                          {mode === 'tutorial' ? '教程只围绕一个功能' : '可多选'}
                        </span>
                      </div>
                      <span className="text-[10px] text-faint">
                        已选 {featureIds.length} / {sortedFeatures.length}
                      </span>
                    </div>
                    <div className="grid max-h-[310px] gap-2 overflow-y-auto pr-1 sm:grid-cols-2">
                      {sortedFeatures.map((feature) => {
                        const claim = claims.find((item) => item.id === feature.claimIds[0]);
                        const active = featureIds.includes(feature.id);
                        const risk = !claim || claim.status === 'stale' || claim.status === 'rejected' || feature.status === 'stale';
                        return (
                          <button
                            key={feature.id}
                            type="button"
                            role="checkbox"
                            aria-checked={active}
                            onClick={() => toggleFeature(feature.id)}
                            className={cn(
                              'rounded-md border p-2.5 text-left transition-colors',
                              active
                                ? 'border-accent/40 bg-accent-soft/20'
                                : 'border-line bg-raised/20 hover:border-line-strong',
                            )}
                          >
                            <div className="flex items-start gap-2">
                              <span
                                className={cn(
                                  'mt-0.5 grid size-4 shrink-0 place-items-center rounded-[4px] border',
                                  active
                                    ? 'border-accent bg-accent text-on-accent'
                                    : 'border-line-strong bg-raised',
                                )}
                              >
                                {active ? <Check size={9} strokeWidth={3} /> : null}
                              </span>
                              <div className="min-w-0 flex-1">
                                <div className="flex flex-wrap items-center gap-1.5">
                                  <span className="truncate text-[11.5px] font-medium text-fg">{feature.name}</span>
                                  <FeatureStatusBadge status={feature.status} />
                                </div>
                                <p className="mt-0.5 line-clamp-2 text-[10px] leading-4 text-faint">
                                  {feature.summary}
                                </p>
                                <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
                                  {claim ? <ClaimStatusBadge status={claim.status} /> : <Badge tone="danger">无声明</Badge>}
                                  <span className={cn('text-[9px]', risk ? 'text-danger' : 'text-faint')}>
                                    {risk
                                      ? '使用后可能阻断审核'
                                      : claim?.status === 'supported' || claim?.status === 'proposed'
                                        ? '字幕会保留限定表述'
                                        : '可用于公开视频'}
                                  </span>
                                </div>
                              </div>
                            </div>
                          </button>
                        );
                      })}
                      {sortedFeatures.length === 0 ? (
                        <div className="col-span-full rounded-md border border-dashed border-line p-6 text-center text-[11px] text-faint">
                          这个项目还没有功能，请先在知识中心完成分析。
                        </div>
                      ) : null}
                    </div>
                  </div>

                  {mode === 'release_video' ? (
                    <Field label="关联 Release" hint="会决定片头措辞；不会伪造 Release 内容。">
                      <Select
                        value={releaseId ?? ''}
                        onChange={(event) => setReleaseId(event.target.value || undefined)}
                      >
                        <option value="">不绑定 Release</option>
                        {releases.map((release) => (
                          <option key={release.id} value={release.id}>
                            {release.version} · {release.name}（{formatDate(release.releasedAt)}）
                          </option>
                        ))}
                      </Select>
                    </Field>
                  ) : null}

                  {selectedRelease ? (
                    <div className="rounded-md border border-line bg-raised/30 px-3 py-2.5">
                      <div className="flex items-center gap-2">
                        <GitPullRequest size={12} className="text-accent" />
                        <span className="text-[11px] font-medium text-fg">
                          {selectedRelease.version} · {selectedRelease.name}
                        </span>
                        <span className="ml-auto text-[9.5px] text-faint">
                          {formatDate(selectedRelease.releasedAt)}
                        </span>
                      </div>
                      <p className="mt-1 text-[10.5px] leading-4 text-muted">{selectedRelease.highlight}</p>
                    </div>
                  ) : null}
                </div>
              </Panel>

              <Panel>
                <PanelHeader title="格式与节奏" description="时长改变会重新分配各镜头秒数。" />
                <div className="grid gap-5 p-4 sm:grid-cols-2">
                  <div>
                    <Slider
                      label="目标时长"
                      value={durationSec}
                      min={15}
                      max={90}
                      step={5}
                      onValueChange={setDurationSec}
                      formatValue={(value) => `${value} 秒`}
                    />
                    <div className="mt-2 flex flex-wrap gap-1">
                      {DURATION_OPTIONS.map((value) => (
                        <button
                          key={value}
                          type="button"
                          onClick={() => setDurationSec(value)}
                          className={cn(
                            'rounded-full border px-2 py-0.5 text-[9.5px]',
                            durationSec === value
                              ? 'border-accent/40 bg-accent-soft text-accent'
                              : 'border-line text-faint hover:text-fg',
                          )}
                        >
                          {value}s
                        </button>
                      ))}
                    </div>
                  </div>
                  <Field label="画幅">
                    <SegmentedControl
                      value={aspect}
                      onChange={setAspect}
                      ariaLabel="画幅比例"
                      options={[
                        { value: '16:9', label: '16:9 横屏' },
                        { value: '9:16', label: '9:16 竖屏' },
                        { value: '1:1', label: '1:1 方形' },
                      ]}
                    />
                  </Field>
                  <Field label="语言">
                    <SegmentedControl
                      value={language}
                      onChange={setLanguage}
                      ariaLabel="视频语言"
                      options={[
                        { value: 'zh-CN', label: '简体中文' },
                        { value: 'en-US', label: 'English' },
                      ]}
                    />
                  </Field>
                  <Field label="视觉模板">
                    <Select value={templateId} onChange={(event) => setTemplateId(event.target.value)}>
                      {templates.map((template) => (
                        <option key={template.id} value={template.id}>
                          {template.name} · {template.layout}
                        </option>
                      ))}
                    </Select>
                  </Field>
                </div>
              </Panel>

              <Panel>
                <PanelHeader title="语气与画面策略" description="不会生成未经授权的真实录屏或客户数据。" />
                <div className="space-y-4 p-4">
                  <div className="grid gap-2 sm:grid-cols-4">
                    {(['confident', 'warm', 'technical', 'bold'] as Tone[]).map((value) => (
                      <button
                        key={value}
                        type="button"
                        onClick={() => setTone(value)}
                        className={cn(
                          'rounded-md border px-3 py-2.5 text-left transition-colors',
                          tone === value ? 'border-accent/45 bg-accent-soft/30' : 'border-line hover:border-line-strong',
                        )}
                      >
                        <div className="text-[11.5px] font-medium text-fg">{TONE_INFO[value].label}</div>
                        <div className="mt-0.5 text-[9.5px] leading-4 text-faint">{TONE_INFO[value].description}</div>
                      </button>
                    ))}
                  </div>

                  <div className="grid gap-3 sm:grid-cols-2">
                    <div className="flex items-center justify-between gap-3 rounded-md border border-line px-3 py-2.5">
                      <div>
                        <div className="text-[11.5px] text-fg">使用模拟产品录屏</div>
                        <div className="text-[9.5px] text-faint">DOM 渲染的演示界面，不调用真实产品</div>
                      </div>
                      <Switch checked={useRealCapture} onCheckedChange={setUseRealCapture} label="使用模拟产品录屏" />
                    </div>
                    <div className="flex items-center justify-between gap-3 rounded-md border border-line px-3 py-2.5">
                      <div>
                        <div className="text-[11.5px] text-fg">使用生成式画面</div>
                        <div className="text-[9.5px] text-faint">抽象动效占位，不调用图像模型</div>
                      </div>
                      <Switch checked={useGeneratedVisuals} onCheckedChange={setUseGeneratedVisuals} label="使用生成式画面" />
                    </div>
                  </div>

                  <Field label="片尾行动号召">
                    <Input value={cta} maxLength={80} onChange={(event) => setCta(event.target.value)} />
                  </Field>

                  <div>
                    <div className="mb-1.5 text-[12px] font-medium text-fg">禁用表述</div>
                    <div className="flex flex-wrap gap-1.5">
                      {bannedPhrases.map((phrase) => (
                        <span
                          key={phrase}
                          className="flex items-center gap-1 rounded-full border border-line bg-raised px-2 py-0.5 text-[10px] text-muted"
                        >
                          {phrase}
                          <button
                            type="button"
                            aria-label={`移除禁用表述 ${phrase}`}
                            onClick={() => setBannedPhrases((current) => current.filter((item) => item !== phrase))}
                            className="text-faint hover:text-danger"
                          >
                            <X size={10} />
                          </button>
                        </span>
                      ))}
                    </div>
                    <div className="mt-2 flex gap-2">
                      <Input
                        value={newPhrase}
                        onChange={(event) => setNewPhrase(event.target.value)}
                        placeholder="添加不应出现的表述…"
                        className="h-8 max-w-[260px] text-[11.5px]"
                        onKeyDown={(event) => {
                          if (event.key === 'Enter') {
                            event.preventDefault();
                            const value = newPhrase.trim();
                            if (value && !bannedPhrases.includes(value)) {
                              setBannedPhrases((current) => [...current, value]);
                            }
                            setNewPhrase('');
                          }
                        }}
                      />
                      <Button
                        variant="ghost"
                        size="sm"
                        icon={<Plus size={12} />}
                        disabled={!newPhrase.trim()}
                        onClick={() => {
                          const value = newPhrase.trim();
                          if (value && !bannedPhrases.includes(value)) {
                            setBannedPhrases((current) => [...current, value]);
                          }
                          setNewPhrase('');
                        }}
                      >
                        添加
                      </Button>
                    </div>
                  </div>
                </div>
              </Panel>

              {blocking.length > 0 ? (
                <Callout tone="danger" title={`${blocking.length} 个所选功能可能无法通过审核`}>
                  {blocking.map(({ feature }) => `「${feature.name}」`).join('、')}
                  缺少有效证据或状态已过期。你可以继续生成策划，但审核会阻断；建议先去知识中心重新验证。
                </Callout>
              ) : limited.length > 0 ? (
                <Callout tone="warning" title="部分声明仍处于待验证状态">
                  生成的分镜会保留限定表述，审核通过后仍需人工复核。不会把待验证能力写成确定事实。
                </Callout>
              ) : (
                <Callout tone="success" title="所选事实都有已核验证据">
                  生成脚本后仍会逐条保留 Claim 引用，方便审核追溯。
                </Callout>
              )}
            </div>
          ) : null}

          {step === 3 ? (
            <div className="space-y-4">
              <div className="grid grid-cols-[minmax(0,1fr)] gap-4 xl:grid-cols-[minmax(0,1fr)_320px]">
                <Panel>
                  <PanelHeader
                    title="即将生成的脚本结构"
                    description="这是确定性提案预览；生成后每个镜头都可以编辑和重新排序。"
                    actions={<Badge tone="accent" dot={false}>{outline.length} 个镜头 · 约 {durationSec}s</Badge>}
                  />
                  <div className="divide-y divide-line border-t border-line">
                    {outline.map((item, index) => (
                      <div key={`${item.title}-${index}`} className="flex items-start gap-3 px-4 py-3">
                        <span className="mt-0.5 grid size-6 shrink-0 place-items-center rounded-sm border border-line bg-overlay font-mono text-[9px] text-faint">
                          {String(index + 1).padStart(2, '0')}
                        </span>
                        <div className="min-w-0 flex-1">
                          <div className="flex flex-wrap items-center gap-2">
                            <span className="text-[12px] font-medium text-fg">{item.title}</span>
                            <Badge tone={item.type === 'demo' ? 'accent' : 'outline'} dot={false}>
                              {item.type === 'title' ? '片头' : item.type === 'cta' ? '片尾' : item.type === 'demo' ? '产品演示' : '卖点'}
                            </Badge>
                          </div>
                          <p className="mt-0.5 text-[10.5px] leading-4 text-muted">{item.caption}</p>
                        </div>
                        <span className="shrink-0 font-mono text-[9.5px] text-faint">~{item.duration}s</span>
                      </div>
                    ))}
                  </div>
                </Panel>

                <div className="space-y-3">
                  <Panel className="overflow-hidden">
                    <div className="border-b border-line px-3 py-2.5">
                      <div className="text-[11px] font-medium text-fg">开场画面预览</div>
                      <div className="text-[9.5px] text-faint">使用了当前品牌与模板</div>
                    </div>
                    <div className="bg-ink p-2.5">
                      <div className="overflow-hidden rounded-sm border border-line">
                        <div className={aspect === '9:16' ? 'mx-auto w-[160px]' : ''}>
                          <div className={aspect === '9:16' ? 'aspect-[9/16]' : aspect === '1:1' ? 'aspect-square' : 'aspect-video'}>
                            <ScenePreview
                              scene={previewScene(templateId, title, objective, selectedFeatures[0])}
                              project={project}
                              feature={selectedFeatures[0]}
                              aspect={aspect}
                              showCaption={false}
                              showChrome
                            />
                          </div>
                        </div>
                      </div>
                    </div>
                  </Panel>

                  <Panel>
                    <PanelHeader title="生成后会怎样" />
                    <div className="space-y-2 px-4 pb-4 text-[10.5px] leading-4 text-muted">
                      <p className="flex gap-2"><Check size={11} className="mt-0.5 shrink-0 text-success" /> 进入 AI 导演，可继续调整时长、语气、顺序。</p>
                      <p className="flex gap-2"><Check size={11} className="mt-0.5 shrink-0 text-success" /> 每个镜头保留功能与声明引用。</p>
                      <p className="flex gap-2"><Check size={11} className="mt-0.5 shrink-0 text-success" /> 分镜确认后才能开始模拟生产。</p>
                      <p className="flex gap-2"><Clock3 size={11} className="mt-0.5 shrink-0 text-faint" /> 生成只发生在本机，耗时通常不到一秒。</p>
                    </div>
                  </Panel>
                </div>
              </div>

              <Callout tone="info" title="生产不是这一步">
                这里只建立脚本和分镜。生产会在视频工程里单独启动，审核前不能导出。
              </Callout>
            </div>
          ) : null}

          {error ? (
            <div className="mt-3 rounded-sm border border-danger/25 bg-danger-soft/40 px-3 py-2 text-[11px] text-danger">
              {error}
            </div>
          ) : null}

          <div className="mt-4 flex items-center justify-between gap-3 border-t border-line pt-4">
            <div className="flex items-center gap-2 text-[10px] text-faint">
              <Sparkles size={11} />
              确定性模拟生成 · 不会产生真实媒体文件
            </div>
            <div className="flex items-center gap-2">
              {step > 1 ? (
                <Button variant="ghost" onClick={() => { setStep((current) => current - 1); setError(null); }}>
                  上一步
                </Button>
              ) : null}
              {step < 3 ? (
                <Button variant="primary" onClick={next} icon={<ArrowRight size={14} />}>
                  继续
                </Button>
              ) : (
                <Button variant="primary" loading={creating} onClick={create} icon={<Wand2 size={14} />}>
                  生成脚本与分镜
                </Button>
              )}
            </div>
          </div>
        </div>
      </div>
    </Page>
  );
}

function SummaryRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between gap-2">
      <span className="text-faint">{label}</span>
      <span className="truncate text-fg">{value}</span>
    </div>
  );
}

function initialFeatures(
  mode: VideoMode,
  features: Feature[],
  claims: { id: string; status: string }[],
): string[] {
  const verified = features.filter((feature) => {
    const claim = claims.find((item) => item.id === feature.claimIds[0]);
    return (
      claim?.status === 'verified' &&
      (feature.status === 'verified' || feature.status === 'deployed')
    );
  });
  const fallback = features.filter((feature) => feature.status !== 'deprecated');
  const pool = verified.length > 0 ? verified : fallback;
  if (mode === 'tutorial') return pool[0] ? [pool[0].id] : features[0] ? [features[0].id] : [];
  const limit = mode === 'content_factory' ? 1 : 2;
  return pool.slice(0, limit).map((feature) => feature.id);
}

function modeObjective(mode: VideoMode): string {
  switch (mode) {
    case 'release_video':
      return '让现有用户和潜在客户在 30 秒内理解本次更新最重要的价值。';
    case 'tutorial':
      return '帮助新用户在一次观看后完成一个关键任务。';
    case 'content_factory':
      return '把一个产品事实改造成适合社交渠道、可快速消费的短内容。';
    default:
      return '用一条有叙事的短片讲清产品解决的问题与关键能力。';
  }
}

function modeAudience(mode: VideoMode): string {
  switch (mode) {
    case 'release_video':
      return '现有客户、产品评估者与团队决策者';
    case 'tutorial':
      return '刚注册的新用户与客户成功团队';
    case 'content_factory':
      return '社交渠道上的开发者与产品团队';
    default:
      return '官网访客、销售会议与发布会观众';
  }
}

function buildOutline(
  mode: VideoMode,
  features: Feature[],
  durationSec: number,
  cta: string,
  productName: string,
): { title: string; caption: string; type: 'title' | 'demo' | 'cta'; duration: number }[] {
  const bodyCount = mode === 'tutorial' ? 3 : Math.max(1, features.length);
  const fixedIntro = 6;
  const fixedOutro = 4;
  const remaining = Math.max(bodyCount * 3, durationSec - fixedIntro - fixedOutro);
  const perBody = Math.round((remaining / bodyCount) * 10) / 10;
  const outline: { title: string; caption: string; type: 'title' | 'demo' | 'cta'; duration: number }[] = [
    {
      title: `${productName} · 本期主题`,
      caption: '建立注意力，提出观众正在面对的问题。',
      type: 'title',
      duration: fixedIntro,
    },
  ];
  if (mode === 'tutorial' && features[0]) {
    const steps = ['进入功能入口', '完成关键操作', '检查结果与下一步'];
    steps.forEach((step) => {
      outline.push({
        title: step,
        caption: features[0]!.summary,
        type: 'demo',
        duration: perBody,
      });
    });
  } else {
    features.forEach((feature) => {
      outline.push({
        title: feature.name,
        caption: feature.summary,
        type: 'demo',
        duration: perBody,
      });
    });
  }
  outline.push({
    title: cta || '现在开始',
    caption: '收束叙事并给出行动号召。',
    type: 'cta',
    duration: fixedOutro,
  });
  return outline;
}

function previewScene(
  templateId: string,
  title: string,
  objective: string,
  feature: Feature | undefined,
) {
  return {
    id: 'wizard-preview',
    order: 0,
    revision: 1,
    title: title || '产品影像',
    intent: objective,
    narration: '',
    caption: '',
    durationSec: 6,
    visualType: 'title' as const,
    templateId,
    featureId: feature?.id,
    claimIds: [],
    status: 'draft' as const,
    look: 'clean' as const,
    brightness: 1,
    vignette: true,
  };
}
