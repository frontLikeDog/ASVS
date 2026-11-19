import { useEffect, useMemo, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import type {
  Claim,
  Feature,
  Project,
  Scene,
  SceneLook,
  SceneStatus,
  SceneVisualType,
  VideoProject,
} from '@asvs/domain';
import {
  SCENE_VISUAL_TYPES,
  formatDuration,
  orderedScenes,
  totalDuration,
  truncate,
} from '@asvs/domain';
import {
  ArrowDown,
  ArrowRight,
  ArrowUp,
  Check,
  ChevronLeft,
  ChevronRight,
  Clapperboard,
  CopyPlus,
  GripVertical,
  Layers,
  MessageSquareText,
  MonitorPlay,
  Plus,
  Save,
  ShieldAlert,
  Trash2,
} from 'lucide-react';
import {
  Badge,
  Button,
  Callout,
  ClaimStatusBadge,
  Dialog,
  DialogContent,
  FeatureStatusBadge,
  Field,
  Input,
  Page,
  Panel,
  PanelHeader,
  ScenePreview,
  SCENE_STATUS_META,
  Select,
  Slider,
  StatusBadge,
  Switch,
  Textarea,
  buttonStyles,
  cn,
} from '@asvs/ui';
import { useStudioStore, useUiStore } from '@asvs/state';
import { useShallow } from 'zustand/react/shallow';
import { NotFoundInline } from './not-found-inline';
import { VideoWorkspaceHeader } from './video-workspace-header';

const VISUAL_LABELS: Record<SceneVisualType, string> = {
  real_demo: '产品演示',
  motion: '动态图形',
  generated: '生成画面',
  title: '标题卡',
  cta: '行动号召',
};

const LOOK_LABELS: Record<SceneLook, string> = {
  clean: '清晰',
  warm: '温暖',
  cinematic: '电影感',
};

export function StoryboardPage() {
  const { videoId = '' } = useParams();
  const video = useStudioStore((state) => state.videos.find((item) => item.id === videoId));
  const project = useStudioStore((state) =>
    state.projects.find((item) => item.id === video?.projectId),
  );
  const features = useStudioStore(
    useShallow((state) => state.features.filter((item) => item.projectId === video?.projectId)),
  );
  const claims = useStudioStore(
    useShallow((state) => state.claims.filter((item) => item.projectId === video?.projectId)),
  );
  const templates = useStudioStore((state) => state.templates);
  const addScene = useStudioStore((state) => state.addScene);
  const deleteScene = useStudioStore((state) => state.deleteScene);
  const reorderScenes = useStudioStore((state) => state.reorderScenes);
  const setVideoStage = useStudioStore((state) => state.setVideoStage);
  const pushToast = useUiStore((state) => state.pushToast);

  const scenes = useMemo(() => (video ? orderedScenes(video.scenes) : []), [video]);
  const [selectedId, setSelectedId] = useState<string | undefined>();
  const [dragId, setDragId] = useState<string | null>(null);
  const [overId, setOverId] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<Scene | null>(null);

  const selected = scenes.find((scene) => scene.id === selectedId) ?? scenes[0];

  if (!video || !project) return <NotFoundInline label="视频工程不存在或已被删除。" />;

  const claimIds = Array.from(new Set(scenes.flatMap((scene) => scene.claimIds)));
  const sceneClaims = claimIds
    .map((id) => claims.find((claim) => claim.id === id))
    .filter((claim): claim is NonNullable<typeof claim> => Boolean(claim));
  const riskyClaims = sceneClaims.filter(
    (claim) => claim.status === 'stale' || claim.status === 'rejected' || claim.status === 'proposed',
  );
  const locked = video.stage === 'producing';

  const move = (sceneId: string, direction: -1 | 1) => {
    const index = scenes.findIndex((scene) => scene.id === sceneId);
    const target = index + direction;
    if (index < 0 || target < 0 || target >= scenes.length) return;
    const ids = scenes.map((scene) => scene.id);
    const [moved] = ids.splice(index, 1);
    if (!moved) return;
    ids.splice(target, 0, moved);
    reorderScenes(video.id, ids);
  };

  const dropOn = (targetId: string) => {
    if (!dragId || dragId === targetId) return;
    const ids = scenes.map((scene) => scene.id);
    const from = ids.indexOf(dragId);
    const to = ids.indexOf(targetId);
    if (from < 0 || to < 0) return;
    const [moved] = ids.splice(from, 1);
    if (!moved) return;
    ids.splice(to, 0, moved);
    reorderScenes(video.id, ids);
    setDragId(null);
    setOverId(null);
  };

  return (
    <Page wide>
      <VideoWorkspaceHeader
        video={video}
        project={project}
        active="storyboard"
        actions={
          <>
            <Button
              variant="secondary"
              size="sm"
              disabled={locked || video.stage === 'storyboard_ready' || video.stage === 'producing' || video.stage === 'review' || video.stage === 'approved' || video.stage === 'exported'}
              onClick={() => {
                setVideoStage(video.id, 'storyboard_ready');
                pushToast({ tone: 'success', title: '分镜已确认', description: '可以进入编辑器或启动模拟生产。' });
              }}
              icon={<Check size={12} />}
            >
              确认分镜
            </Button>
            <Link to={`/videos/${video.id}/editor`} className={buttonStyles({ variant: 'primary', size: 'sm' })}>
              <MonitorPlay size={13} /> 在编辑器中预览
            </Link>
          </>
        }
      />

      {locked ? (
        <Callout tone="warning" className="mt-4" title="模拟生产进行中，分镜已锁定">
          暂停或取消生产后才能调整镜头。
          <Link to={`/videos/${video.id}/production`} className="ml-1 underline-offset-2 hover:underline">
            打开生产监控
          </Link>
        </Callout>
      ) : null}

      <div className="mt-4 flex flex-wrap items-center gap-x-4 gap-y-2 rounded-lg border border-line bg-surface/50 px-4 py-2.5 text-[10.5px] text-muted">
        <span className="flex items-center gap-1.5"><Clapperboard size={11} /> {scenes.length} 个镜头</span>
        <span>{formatDuration(totalDuration(scenes))}</span>
        <span>{video.brief.aspect}</span>
        <span className="font-mono text-[9.5px] text-faint">v{video.scriptVersion}</span>
        <span className="text-line-strong">·</span>
        <span>{claimIds.length} 条声明引用</span>
        {riskyClaims.length > 0 ? (
          <span className="flex items-center gap-1 text-warn">
            <ShieldAlert size={11} /> {riskyClaims.length} 条有风险
          </span>
        ) : (
          <span className="flex items-center gap-1 text-success"><Check size={11} /> 声明状态可用</span>
        )}
        <span className="ml-auto text-[9.5px] text-faint">拖拽左侧卡片调整顺序 · 改动即时保存</span>
      </div>

      <div className="mt-4 grid grid-cols-[minmax(0,1fr)] gap-4 xl:grid-cols-[320px_minmax(0,1fr)] 2xl:grid-cols-[320px_minmax(0,1fr)_300px]">
        <Panel className="h-fit overflow-hidden">
          <PanelHeader
            title="镜头序列"
            description="Drag to reorder"
            actions={<Badge tone="outline" dot={false}>{scenes.length}</Badge>}
          />
          <div className="max-h-[640px] overflow-y-auto border-t border-line p-2">
            {scenes.map((scene, index) => {
              const active = selected?.id === scene.id;
              const feature = features.find((item) => item.id === scene.featureId);
              return (
                <div
                  key={scene.id}
                  draggable={!locked}
                  onDragStart={(event) => {
                    setDragId(scene.id);
                    event.dataTransfer.effectAllowed = 'move';
                    event.dataTransfer.setData('text/plain', scene.id);
                  }}
                  onDragOver={(event) => {
                    event.preventDefault();
                    if (dragId && dragId !== scene.id) setOverId(scene.id);
                  }}
                  onDragLeave={() => setOverId((current) => (current === scene.id ? null : current))}
                  onDrop={(event) => { event.preventDefault(); dropOn(scene.id); }}
                  onDragEnd={() => { setDragId(null); setOverId(null); }}
                  onClick={() => setSelectedId(scene.id)}
                  role="button"
                  tabIndex={0}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter' || event.key === ' ') {
                      event.preventDefault();
                      setSelectedId(scene.id);
                    }
                  }}
                  aria-current={active ? 'true' : undefined}
                  className={cn(
                    'group mb-1 flex cursor-pointer items-center gap-2 rounded-md border px-2 py-2 transition-colors',
                    active
                      ? 'border-accent/40 bg-accent-soft/20'
                      : 'border-transparent hover:border-line hover:bg-overlay/40',
                    dragId === scene.id && 'opacity-40',
                    overId === scene.id && 'border-accent bg-accent-soft/30',
                  )}
                >
                  <span className="flex w-4 shrink-0 cursor-grab flex-col items-center text-faint active:cursor-grabbing">
                    <GripVertical size={12} />
                  </span>
                  <div className="w-[78px] shrink-0 overflow-hidden rounded-sm border border-line">
                    <div className="aspect-video">
                      <ScenePreview
                        scene={scene}
                        project={project}
                        feature={feature}
                        aspect="16:9"
                        showCaption={false}
                        showChrome={false}
                      />
                    </div>
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-1">
                      <span className="font-mono text-[8.5px] text-faint">{String(index + 1).padStart(2, '0')}</span>
                      <span className="truncate text-[10.5px] font-medium text-fg">{scene.title}</span>
                    </div>
                    <div className="mt-0.5 flex items-center gap-1.5 text-[8.5px] text-faint">
                      <span>{scene.durationSec}s</span>
                      <span>·</span>
                      <span>{VISUAL_LABELS[scene.visualType]}</span>
                      {feature ? (
                        <>
                          <span>·</span>
                          <span className="truncate">{feature.name}</span>
                        </>
                      ) : null}
                    </div>
                    <div className="mt-1">
                      <StatusBadge meta={SCENE_STATUS_META[scene.status]} />
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
          <div className="border-t border-line p-2">
            <Button
              variant="ghost"
              size="sm"
              className="w-full"
              disabled={locked}
              icon={<Plus size={13} />}
              onClick={() => {
                const id = addScene(video.id, selected?.id);
                if (id) {
                  setSelectedId(id);
                  pushToast({ tone: 'info', title: '已添加镜头', description: '新镜头默认 4 秒，内容需要你补充。' });
                }
              }}
            >
              添加镜头
            </Button>
          </div>
        </Panel>

        {selected ? (
          <SceneEditor
            key={selected.id}
            video={video}
            project={project}
            scene={selected}
            features={features}
            claims={claims}
            templates={templates.map((template) => ({ id: template.id, name: template.name, layout: template.layout }))}
            locked={locked}
            index={scenes.findIndex((scene) => scene.id === selected.id)}
            total={scenes.length}
            onSelect={setSelectedId}
            onMove={move}
            onDelete={() => setDeleting(selected)}
            onAdd={() => {
              const id = addScene(video.id, selected.id);
              if (id) setSelectedId(id);
            }}
          />
        ) : null}

        <div className="space-y-3 xl:col-span-2 2xl:col-span-1">
          <Panel>
            <PanelHeader title="脚本健康度" description="来自当前所有镜头的声明引用。" />
            <div className="space-y-2 px-4 pb-4">
              {riskyClaims.length > 0 ? (
                riskyClaims.map((claim) => {
                  const feature = features.find((item) => item.id === claim.featureId);
                  return (
                    <div key={claim.id} className="rounded-sm border border-warn/25 bg-warn-soft/30 px-2.5 py-2">
                      <div className="flex items-center gap-1.5">
                        <ClaimStatusBadge status={claim.status} />
                        <span className="truncate text-[10px] text-fg">{feature?.name ?? claim.featureId}</span>
                      </div>
                      <p className="mt-1 text-[9px] leading-4 text-faint">{truncate(claim.statement, 60)}</p>
                      <Link
                        to={`/projects/${project.id}/knowledge?feature=${claim.featureId}`}
                        className="mt-1 inline-flex text-[9px] text-warn hover:underline"
                      >
                        去知识中心处理 →
                      </Link>
                    </div>
                  );
                })
              ) : (
                <div className="flex items-center gap-2 rounded-sm border border-success/20 bg-success-soft/30 px-2.5 py-2 text-[10px] text-success">
                  <Check size={12} /> 所有引用声明当前都可发布。
                </div>
              )}
              <Link
                to={`/projects/${project.id}/knowledge`}
                className="flex items-center justify-between rounded-sm border border-line px-2.5 py-2 text-[10px] text-muted hover:border-line-strong hover:text-fg"
              >
                管理知识快照
                <ArrowRight size={10} />
              </Link>
            </div>
          </Panel>

          <Panel>
            <PanelHeader title="分镜检查" />
            <div className="space-y-2 px-4 pb-4">
              <CheckRow ok={scenes.length >= 2} label={`至少 2 个镜头（${scenes.length}）`} />
              <CheckRow ok={totalDuration(scenes) >= 10} label={`总时长 ≥ 10 秒（${totalDuration(scenes)}s）`} />
              <CheckRow ok={scenes.every((scene) => scene.durationSec >= 2.5)} label="单镜不短于 2.5 秒" />
              <CheckRow
                ok={scenes.filter((scene) => scene.caption.trim()).length === scenes.length}
                label="每个镜头都有字幕"
              />
              <CheckRow
                ok={scenes.filter((scene) => scene.narration.trim()).length === scenes.length}
                label="每个镜头都有旁白"
              />
            </div>
          </Panel>

          <Panel>
            <PanelHeader title="下一步" />
            <div className="px-4 pb-4">
              <p className="text-[10px] leading-4 text-faint">
                分镜确认后，时间线、字幕与生产输入都会使用这一版顺序。编辑器支持撤销和重做。
              </p>
              <Link
                to={`/videos/${video.id}/editor`}
                className={buttonStyles({ variant: 'secondary', size: 'sm', className: 'mt-3 w-full' })}
              >
                <MonitorPlay size={12} /> 打开时间线
              </Link>
              <Link
                to={`/videos/${video.id}/production`}
                className={buttonStyles({ variant: 'ghost', size: 'sm', className: 'mt-1.5 w-full' })}
              >
                去生产 <ArrowRight size={11} />
              </Link>
            </div>
          </Panel>
        </div>
      </div>

      <Dialog open={Boolean(deleting)} onOpenChange={(open) => { if (!open) setDeleting(null); }}>
        <DialogContent
          title="删除这个镜头？"
          description="视频至少需要保留一个镜头。删除后总时长会重新计算。"
          size="sm"
          footer={
            <>
              <Button variant="ghost" onClick={() => setDeleting(null)}>保留</Button>
              <Button
                variant="danger"
                onClick={() => {
                  if (!deleting) return;
                  const ok = deleteScene(video.id, deleting.id);
                  if (ok) {
                    pushToast({ tone: 'info', title: '镜头已删除', description: deleting.title });
                    const remaining = scenes.filter((scene) => scene.id !== deleting.id);
                    setSelectedId(remaining[0]?.id);
                  }
                  setDeleting(null);
                }}
              >
                确认删除
              </Button>
            </>
          }
        >
          <div className="rounded-md border border-line bg-raised/40 px-3 py-2.5">
            <div className="text-[12px] font-medium text-fg">{deleting?.title}</div>
            <div className="mt-1 text-[10px] text-faint">
              {deleting?.durationSec}s · {deleting ? VISUAL_LABELS[deleting.visualType] : ''}
            </div>
          </div>
        </DialogContent>
      </Dialog>
    </Page>
  );
}

function SceneEditor({
  video,
  project,
  scene,
  features,
  claims,
  templates,
  locked,
  index,
  total,
  onSelect,
  onMove,
  onDelete,
  onAdd,
}: {
  video: VideoProject;
  project: Project;
  scene: Scene;
  features: Feature[];
  claims: Claim[];
  templates: { id: string; name: string; layout: string }[];
  locked: boolean;
  index: number;
  total: number;
  onSelect: (id: string) => void;
  onMove: (sceneId: string, direction: -1 | 1) => void;
  onDelete: () => void;
  onAdd: () => void;
}) {
  const updateScene = useStudioStore((state) => state.updateScene);
  const pushToast = useUiStore((state) => state.pushToast);
  const [showCaption, setShowCaption] = useState(true);
  const [draft, setDraft] = useState(() => toDraft(scene));

  useEffect(() => {
    setDraft(toDraft(scene));
  }, [scene]);

  const selectedFeature = features.find((feature) => feature.id === draft.featureId);
  const offerClaims = selectedFeature
    ? claims.filter((claim) => selectedFeature.claimIds.includes(claim.id))
    : [];
  const dirty = JSON.stringify(draft) !== JSON.stringify(toDraft(scene));
  const totalAfter = Math.max(
    10,
    Math.round((totalDuration(video.scenes) - scene.durationSec + draft.durationSec) * 10) / 10,
  );

  const save = () => {
    updateScene(video.id, scene.id, {
      ...draft,
      title: draft.title.trim() || scene.title,
      featureId: draft.featureId || undefined,
      notes: draft.notes.trim() || undefined,
    });
    pushToast({
      tone: 'success',
      title: `镜头 ${index + 1} 已保存`,
      description: '分镜、时间线与审核检查已同步。',
    });
  };

  const previewScene: Scene = {
    ...scene,
    ...draft,
    featureId: draft.featureId || undefined,
    title: draft.title || scene.title,
  };

  return (
    <div className="space-y-3">
      <Panel className="overflow-hidden">
        <div className="flex flex-wrap items-center justify-between gap-2 border-b border-line px-4 py-2.5">
          <div className="flex items-center gap-2">
            <span className="font-mono text-[9.5px] text-faint">
              Scene {String(index + 1).padStart(2, '0')} / {String(total).padStart(2, '0')}
            </span>
            <StatusBadge meta={SCENE_STATUS_META[scene.status]} />
            {dirty ? <Badge tone="warn" dot={false}>未保存</Badge> : null}
          </div>
          <div className="flex items-center gap-1">
            <Button variant="ghost" size="icon-sm" aria-label="上一个镜头" disabled={index <= 0} onClick={() => { const prev = orderedScenes(video.scenes)[index - 1]; if (prev) onSelect(prev.id); }}>
              <ChevronLeft size={13} />
            </Button>
            <Button variant="ghost" size="icon-sm" aria-label="下一个镜头" disabled={index >= total - 1} onClick={() => { const next = orderedScenes(video.scenes)[index + 1]; if (next) onSelect(next.id); }}>
              <ChevronRight size={13} />
            </Button>
            <span className="mx-1 h-3 w-px bg-line" />
            <Button variant="ghost" size="icon-sm" aria-label="上移镜头" disabled={locked || index <= 0} onClick={() => onMove(scene.id, -1)}>
              <ArrowUp size={12} />
            </Button>
            <Button variant="ghost" size="icon-sm" aria-label="下移镜头" disabled={locked || index >= total - 1} onClick={() => onMove(scene.id, 1)}>
              <ArrowDown size={12} />
            </Button>
            <Button variant="ghost" size="icon-sm" aria-label="在后面添加镜头" disabled={locked} onClick={onAdd}>
              <CopyPlus size={12} />
            </Button>
            <Button variant="ghost" size="icon-sm" aria-label="删除镜头" disabled={locked || total <= 1} onClick={onDelete}>
              <Trash2 size={12} />
            </Button>
          </div>
        </div>
        <div className="bg-ink p-3">
          <div className="mx-auto max-w-[720px] overflow-hidden rounded-sm border border-line">
            <div className={video.brief.aspect === '9:16' ? 'mx-auto w-[210px]' : video.brief.aspect === '1:1' ? 'mx-auto w-[420px]' : ''}>
              <div className={video.brief.aspect === '9:16' ? 'aspect-[9/16]' : video.brief.aspect === '1:1' ? 'aspect-square' : 'aspect-video'}>
                <ScenePreview
                  scene={previewScene}
                  project={project}
                  feature={selectedFeature}
                  aspect={video.brief.aspect}
                  showCaption={showCaption}
                  showChrome
                />
              </div>
            </div>
          </div>
          <div className="mx-auto mt-2 flex max-w-[720px] items-center justify-between text-[9px] text-white/35">
            <span className="flex items-center gap-1"><Layers size={9} /> 模拟预览 · 非成片</span>
            <label className="flex cursor-pointer items-center gap-1.5">
              <input
                type="checkbox"
                checked={showCaption}
                onChange={(event) => setShowCaption(event.target.checked)}
                className="accent-[var(--accent)]"
              />
              显示字幕
            </label>
          </div>
        </div>
      </Panel>

      <div className="grid gap-3 lg:grid-cols-2">
        <Panel>
          <PanelHeader title="文案" description="旁白与字幕是审核依据，也是生产输入。" />
          <div className="space-y-3 p-4">
            <Field label="镜头标题" required>
              <Input
                value={draft.title}
                disabled={locked}
                onChange={(event) => setDraft({ ...draft, title: event.target.value })}
              />
            </Field>
            <Field label="旁白" hint="Enter 换行；建议 1–2 句。">
              <Textarea
                value={draft.narration}
                disabled={locked}
                className="min-h-[84px]"
                onChange={(event) => setDraft({ ...draft, narration: event.target.value })}
              />
            </Field>
            <Field label="字幕" hint="会出现在模拟预览与导出 SRT 中。">
              <Textarea
                value={draft.caption}
                disabled={locked}
                className="min-h-[64px]"
                onChange={(event) => setDraft({ ...draft, caption: event.target.value })}
              />
            </Field>
            <Field label="导演备注" optional>
              <Input
                value={draft.notes}
                disabled={locked}
                placeholder="例如：强调这是预发布能力"
                onChange={(event) => setDraft({ ...draft, notes: event.target.value })}
              />
            </Field>
          </div>
        </Panel>

        <Panel>
          <PanelHeader title="镜头设置" description="时长与画面会立即反映在预览中。" />
          <div className="space-y-4 p-4">
            <div>
              <Slider
                label="时长"
                value={draft.durationSec}
                min={2}
                max={30}
                step={0.5}
                disabled={locked}
                onValueChange={(value) => setDraft({ ...draft, durationSec: value })}
                formatValue={(value) => `${value}s`}
              />
              <div className="mt-1 text-[9px] text-faint">
                保存后视频总时长约为 {totalAfter}s（其余镜头不变）
              </div>
            </div>

            <Field label="画面类型">
              <Select
                value={draft.visualType}
                disabled={locked}
                onChange={(event) => setDraft({ ...draft, visualType: event.target.value as SceneVisualType })}
              >
                {SCENE_VISUAL_TYPES.map((type) => (
                  <option key={type} value={type}>
                    {VISUAL_LABELS[type]}
                  </option>
                ))}
              </Select>
            </Field>

            <div className="grid grid-cols-2 gap-3">
              <Field label="模板">
                <Select
                  value={draft.templateId}
                  disabled={locked}
                  onChange={(event) => setDraft({ ...draft, templateId: event.target.value })}
                >
                  {templates.map((template) => (
                    <option key={template.id} value={template.id}>
                      {template.name}
                    </option>
                  ))}
                </Select>
              </Field>
              <Field label="影调">
                <Select
                  value={draft.look}
                  disabled={locked}
                  onChange={(event) => setDraft({ ...draft, look: event.target.value as SceneLook })}
                >
                  {(['clean', 'warm', 'cinematic'] as SceneLook[]).map((look) => (
                    <option key={look} value={look}>
                      {LOOK_LABELS[look]}
                    </option>
                  ))}
                </Select>
              </Field>
            </div>

            <div>
              <Slider
                label="亮度"
                value={draft.brightness}
                min={0.6}
                max={1.4}
                step={0.05}
                disabled={locked}
                onValueChange={(value) => setDraft({ ...draft, brightness: value })}
                formatValue={(value) => `${Math.round(value * 100)}%`}
              />
            </div>

            <div className="flex items-center justify-between gap-3 rounded-sm border border-line px-3 py-2">
              <div>
                <div className="text-[11px] text-fg">暗角</div>
                <div className="text-[9px] text-faint">让视觉焦点更集中</div>
              </div>
              <Switch
                checked={draft.vignette}
                disabled={locked}
                onCheckedChange={(checked) => setDraft({ ...draft, vignette: checked })}
                label="暗角"
              />
            </div>

            <Field label="镜头状态">
              <Select
                value={draft.status}
                disabled={locked}
                onChange={(event) => setDraft({ ...draft, status: event.target.value as SceneStatus })}
              >
                {(['draft', 'review', 'approved'] as SceneStatus[]).map((status) => (
                  <option key={status} value={status}>
                    {SCENE_STATUS_META[status].label}
                  </option>
                ))}
              </Select>
            </Field>
          </div>
        </Panel>
      </div>

      <Panel>
        <PanelHeader title="事实与引用" description="镜头必须知道自己展示的是哪个功能、哪条声明。" />
        <div className="grid gap-4 p-4 lg:grid-cols-2">
          <div>
            <Field label="关联功能">
              <Select
                value={draft.featureId ?? ''}
                disabled={locked}
                onChange={(event) => {
                  const featureId = event.target.value || undefined;
                  const feature = features.find((item) => item.id === featureId);
                  setDraft({
                    ...draft,
                    featureId: featureId ?? '',
                    claimIds: feature ? [...feature.claimIds] : [],
                  });
                }}
              >
                <option value="">不绑定功能</option>
                {features.map((feature) => (
                  <option key={feature.id} value={feature.id}>
                    {feature.name}
                  </option>
                ))}
              </Select>
            </Field>
            {selectedFeature ? (
              <div className="mt-2 flex flex-wrap items-center gap-1.5">
                <FeatureStatusBadge status={selectedFeature.status} />
                <span className="text-[9px] text-faint">{selectedFeature.category}</span>
              </div>
            ) : (
              <p className="mt-2 text-[9.5px] text-warn">没有关联功能的镜头不会引用任何产品声明。</p>
            )}
          </div>
          <div>
            <div className="mb-1.5 text-[12.5px] font-medium text-fg">引用的声明</div>
            {offerClaims.length === 0 ? (
              <p className="text-[10px] text-faint">选择功能后可引用其声明。</p>
            ) : (
              <div className="space-y-1.5">
                {offerClaims.map((claim) => {
                  const checked = draft.claimIds.includes(claim.id);
                  return (
                    <button
                      key={claim.id}
                      type="button"
                      disabled={locked}
                      onClick={() =>
                        setDraft({
                          ...draft,
                          claimIds: checked
                            ? draft.claimIds.filter((id) => id !== claim.id)
                            : [...draft.claimIds, claim.id],
                        })
                      }
                      className={cn(
                        'flex w-full items-start gap-2 rounded-sm border px-2.5 py-2 text-left transition-colors',
                        checked ? 'border-accent/35 bg-accent-soft/20' : 'border-line hover:border-line-strong',
                      )}
                    >
                      <span
                        className={cn(
                          'mt-0.5 grid size-3.5 shrink-0 place-items-center rounded-[3px] border',
                          checked ? 'border-accent bg-accent text-on-accent' : 'border-line-strong',
                        )}
                      >
                        {checked ? <Check size={8} strokeWidth={3} /> : null}
                      </span>
                      <span className="min-w-0">
                        <span className="block text-[10px] leading-4 text-fg">{claim.statement}</span>
                        <span className="mt-0.5 block"><ClaimStatusBadge status={claim.status} /></span>
                      </span>
                    </button>
                  );
                })}
              </div>
            )}
          </div>
        </div>
        {draft.visualType === 'real_demo' && !draft.featureId ? (
          <div className="mx-4 mb-4 rounded-sm border border-warn/25 bg-warn-soft/30 px-3 py-2 text-[10px] text-warn">
            产品演示镜头没有关联功能，审核会提示无法核对画面与卖点一致。
          </div>
        ) : null}
      </Panel>

      <div className="flex items-center justify-between gap-3 rounded-lg border border-line bg-surface/60 px-3 py-2.5">
        <div className="flex items-center gap-1.5 text-[9.5px] text-faint">
          <MessageSquareText size={11} />
          {dirty ? '有未保存的镜头修改' : '所有修改已保存'}
        </div>
        <div className="flex items-center gap-2">
          <Button variant="ghost" size="sm" disabled={!dirty} onClick={() => setDraft(toDraft(scene))}>
            撤销更改
          </Button>
          <Button variant="primary" size="sm" icon={<Save size={12} />} disabled={!dirty || locked} onClick={save}>
            保存镜头
          </Button>
        </div>
      </div>
    </div>
  );
}

function CheckRow({ ok, label }: { ok: boolean; label: string }) {
  return (
    <div className="flex items-center gap-2 text-[10px]">
      <span className={cn('grid size-4 shrink-0 place-items-center rounded-full', ok ? 'bg-success-soft text-success' : 'bg-overlay text-faint')}>
        {ok ? <Check size={9} /> : <span className="size-1 rounded-full bg-current" />}
      </span>
      <span className={ok ? 'text-muted' : 'text-faint'}>{label}</span>
    </div>
  );
}

function toDraft(scene: Scene) {
  return {
    title: scene.title,
    narration: scene.narration,
    caption: scene.caption,
    durationSec: scene.durationSec,
    visualType: scene.visualType,
    templateId: scene.templateId,
    featureId: scene.featureId ?? '',
    claimIds: [...scene.claimIds],
    status: scene.status,
    look: scene.look,
    brightness: scene.brightness,
    vignette: scene.vignette,
    notes: scene.notes ?? '',
  };
}
