import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useParams, useSearchParams } from 'react-router-dom';
import type { Claim, Scene } from '@asvs/domain';
import {
  formatTimecode,
  orderedScenes,
  sceneAtTime,
  sceneStartTimes,
  totalDuration,
} from '@asvs/domain';
import {
  ArrowLeft,
  ArrowRight,
  Captions,
  Check,
  ChevronLeft,
  ChevronRight,
  Clock3,
  Keyboard,
  Pause,
  Play,
  Redo2,
  Repeat2,
  RotateCcw,
  Save,
  ShieldAlert,
  Undo2,
} from 'lucide-react';
import {
  Badge,
  Button,
  Callout,
  ClaimStatusBadge,
  Field,
  Input,
  Page,
  Panel,
  PanelHeader,
  PreviewFrame,
  SCENE_STATUS_META,
  SegmentedControl,
  Slider,
  StatusBadge,
  Switch,
  Textarea,
  Timeline,
  buttonStyles,
  cn,
} from '@asvs/ui';
import {
  canRedoVideo,
  canUndoVideo,
  useStudioStore,
  useUiStore,
} from '@asvs/state';
import { useShallow } from 'zustand/react/shallow';
import { NotFoundInline } from './not-found-inline';
import { VideoWorkspaceHeader } from './video-workspace-header';

export function EditorPage() {
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
  const undoVideo = useStudioStore((state) => state.undoVideo);
  const redoVideo = useStudioStore((state) => state.redoVideo);
  const canUndo = useStudioStore((state) => (video ? canUndoVideo(state, video.id) : false));
  const canRedo = useStudioStore((state) => (video ? canRedoVideo(state, video.id) : false));
  const pushToast = useUiStore((state) => state.pushToast);

  const scenes = useMemo(() => (video ? orderedScenes(video.scenes) : []), [video]);
  const total = totalDuration(scenes);
  const starts = sceneStartTimes(scenes);

  const [currentTime, setCurrentTime] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [loop, setLoop] = useState(false);
  const [speed, setSpeed] = useState(1);
  const [showCaption, setShowCaption] = useState(true);
  const [selectedSceneId, setSelectedSceneId] = useState<string | undefined>(scenes[0]?.id);
  // 5D · Gate 3 deep link: `/videos/:id/editor?scene=<sceneId>` preselects the
  // scene a QA finding points at, so "定位到第 N 镜" lands on the right shot.
  const [searchParams, setSearchParams] = useSearchParams();
  const deepLinkedSceneId = searchParams.get('scene') ?? undefined;
  const frameRef = useRef<number | undefined>(undefined);
  const lastTsRef = useRef<number | undefined>(undefined);

  const activeInfo = sceneAtTime(scenes, currentTime);
  const activeScene = activeInfo?.scene ?? scenes[0];
  const selected = scenes.find((scene) => scene.id === selectedSceneId) ?? scenes[0];
  const selectedIndex = selected ? scenes.findIndex((scene) => scene.id === selected.id) : -1;

  useEffect(() => {
    if (!playing) {
      if (frameRef.current) cancelAnimationFrame(frameRef.current);
      lastTsRef.current = undefined;
      return;
    }
    const tick = (timestamp: number) => {
      if (lastTsRef.current === undefined) lastTsRef.current = timestamp;
      const delta = ((timestamp - lastTsRef.current) / 1000) * speed;
      lastTsRef.current = timestamp;
      setCurrentTime((time) => Math.min(total, time + delta));
      frameRef.current = requestAnimationFrame(tick);
    };
    frameRef.current = requestAnimationFrame(tick);
    return () => {
      if (frameRef.current) cancelAnimationFrame(frameRef.current);
    };
  }, [playing, speed, total]);

  useEffect(() => {
    if (!playing) return;
    if (currentTime < total - 0.01) return;
    if (loop) {
      setCurrentTime(0);
    } else {
      setPlaying(false);
    }
  }, [currentTime, playing, total, loop]);

  useEffect(() => {
    setCurrentTime((time) => Math.min(time, total));
  }, [total]);

  useEffect(() => {
    if (selectedSceneId && scenes.some((scene) => scene.id === selectedSceneId)) return;
    setSelectedSceneId(scenes[0]?.id);
  }, [scenes, selectedSceneId]);

  // Consume `?scene=` once per value: select the scene, seek to its start and
  // drop the param so a later manual selection is not fought by the URL. An
  // unknown id (e.g. a scene deleted since the QA run) falls back to the first
  // scene and still clears the param.
  useEffect(() => {
    if (!deepLinkedSceneId) return;
    const index = scenes.findIndex((scene) => scene.id === deepLinkedSceneId);
    if (index >= 0) {
      setSelectedSceneId(deepLinkedSceneId);
      const start = sceneStartTimes(scenes)[index] ?? 0;
      setCurrentTime(Math.min(totalDuration(scenes), Math.max(0, Number(start.toFixed(2)))));
      setPlaying(false);
    }
    setSearchParams(
      (params) => {
        const next = new URLSearchParams(params);
        next.delete('scene');
        return next;
      },
      { replace: true },
    );
  }, [deepLinkedSceneId, scenes, setSearchParams]);

  const playbackRef = useRef({ currentTime: 0, total: 0, playing: false });
  playbackRef.current = { currentTime, total, playing };

  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (
        target &&
        (target.tagName === 'INPUT' ||
          target.tagName === 'TEXTAREA' ||
          target.tagName === 'SELECT' ||
          target.tagName === 'BUTTON' ||
          target.tagName === 'A' ||
          target.isContentEditable ||
          target.closest?.('[role="slider"]'))
      ) {
        return;
      }
      const playback = playbackRef.current;
      if (event.key === ' ' || event.code === 'Space') {
        event.preventDefault();
        setPlaying((value) => {
          if (!value && playback.currentTime >= playback.total - 0.01) setCurrentTime(0);
          return !value;
        });
      } else if (event.key === 'ArrowLeft') {
        event.preventDefault();
        setCurrentTime((time) => Math.max(0, time - 1));
      } else if (event.key === 'ArrowRight') {
        event.preventDefault();
        setCurrentTime((time) => Math.min(playback.total, time + 1));
      } else if (event.key === 'Home') {
        event.preventDefault();
        setCurrentTime(0);
      } else if (event.key === 'End') {
        event.preventDefault();
        setCurrentTime(playback.total);
      } else if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'z') {
        event.preventDefault();
        if (event.shiftKey) redoVideo(video?.id ?? '');
        else undoVideo(video?.id ?? '');
      } else if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'y') {
        event.preventDefault();
        redoVideo(video?.id ?? '');
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [video?.id, undoVideo, redoVideo]);

  if (!video || !project) return <NotFoundInline label="视频工程不存在或已被删除。" />;

  const seek = (time: number) => {
    setCurrentTime(Math.min(total, Math.max(0, Number(time.toFixed(2)))));
  };

  const togglePlay = () => {
    if (playing) {
      setPlaying(false);
      return;
    }
    if (currentTime >= total - 0.01) setCurrentTime(0);
    setPlaying(true);
  };

  const selectScene = (sceneId: string) => {
    setSelectedSceneId(sceneId);
    const index = scenes.findIndex((scene) => scene.id === sceneId);
    if (index >= 0) seek(starts[index] ?? 0);
  };

  const undo = () => {
    undoVideo(video.id);
    pushToast({ tone: 'info', title: '已撤销一步工程修改' });
  };
  const redo = () => {
    redoVideo(video.id);
    pushToast({ tone: 'info', title: '已重做工程修改' });
  };

  return (
    <Page wide>
      <VideoWorkspaceHeader
        video={video}
        project={project}
        active="editor"
        actions={
          <>
            <div className="flex items-center rounded-md border border-line bg-ink/40 p-0.5">
              <Button
                variant="ghost"
                size="icon-sm"
                aria-label="撤销"
                disabled={!canUndo}
                onClick={undo}
                title="撤销 (Ctrl/Cmd + Z)"
              >
                <Undo2 size={13} />
              </Button>
              <Button
                variant="ghost"
                size="icon-sm"
                aria-label="重做"
                disabled={!canRedo}
                onClick={redo}
                title="重做 (Ctrl/Cmd + Shift + Z)"
              >
                <Redo2 size={13} />
              </Button>
            </div>
            <Link to={`/videos/${video.id}/production`} className={buttonStyles({ variant: 'secondary', size: 'sm' })}>
              去生产 <ArrowRight size={12} />
            </Link>
          </>
        }
      />

      <div className="mt-4 grid grid-cols-[minmax(0,1fr)] gap-4 xl:grid-cols-[minmax(0,1fr)_320px]">
        <div className="space-y-3">
          <Panel className="overflow-hidden">
            <div className="flex flex-wrap items-center justify-between gap-2 border-b border-line px-4 py-2.5">
              <div className="flex items-center gap-2">
                <span className="flex items-center gap-1.5 rounded-sm border border-line bg-raised/50 px-2 py-1 text-[9px] text-muted">
                  <span className={cn('size-1.5 rounded-full', playing ? 'animate-pulse bg-accent' : 'bg-faint')} />
                  {playing ? '播放中' : '已暂停'}
                </span>
                <span className="font-mono text-[10px] text-faint">模拟预览 · 无真实音轨</span>
              </div>
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => setShowCaption((value) => !value)}
                  className={cn(
                    'flex items-center gap-1 rounded-sm border px-2 py-1 text-[9.5px] transition-colors',
                    showCaption
                      ? 'border-accent/35 bg-accent-soft text-accent'
                      : 'border-line text-faint hover:text-fg',
                  )}
                  aria-pressed={showCaption}
                >
                  <Captions size={12} /> 字幕
                </button>
                <div className="flex items-center gap-1 text-[9.5px] text-faint">
                  <Repeat2 size={11} />
                  循环
                  <Switch checked={loop} onCheckedChange={setLoop} label="循环播放" />
                </div>
              </div>
            </div>

            <div className="bg-ink/70 p-4">
              <div className={cn('mx-auto', video.brief.aspect === '9:16' ? 'max-w-[300px]' : video.brief.aspect === '1:1' ? 'max-w-[520px]' : 'max-w-[760px]')}>
                <PreviewFrame
                  video={video}
                  project={project}
                  features={features}
                  currentTime={currentTime}
                  isPlaying={playing}
                  onTogglePlay={togglePlay}
                  onSeek={seek}
                  showCaption={showCaption}
                  showControls
                />
              </div>
            </div>

            <div className="border-t border-line px-4 py-3">
              <div className="flex flex-wrap items-center gap-3">
                <button
                  type="button"
                  onClick={() => seek(currentTime - 1)}
                  aria-label="后退一秒"
                  className="text-faint transition-colors hover:text-fg"
                >
                  <ChevronLeft size={16} />
                </button>
                <button
                  type="button"
                  onClick={togglePlay}
                  aria-label={playing ? '暂停' : '播放'}
                  className="grid size-8 place-items-center rounded-full bg-accent text-on-accent transition-transform hover:scale-105"
                >
                  {playing ? <Pause size={14} /> : <Play size={14} className="ml-0.5" />}
                </button>
                <button
                  type="button"
                  onClick={() => seek(currentTime + 1)}
                  aria-label="前进一秒"
                  className="text-faint transition-colors hover:text-fg"
                >
                  <ChevronRight size={16} />
                </button>
                <span className="font-mono text-[11px] tabular text-fg">
                  {formatTimecode(currentTime, true)}
                  <span className="text-faint"> / {formatTimecode(total, true)}</span>
                </span>
                <div className="ml-auto flex items-center gap-2">
                  <span className="text-[9px] text-faint">速度</span>
                  <SegmentedControl
                    value={String(speed)}
                    onChange={(value) => setSpeed(Number(value))}
                    size="sm"
                    ariaLabel="播放速度"
                    options={[
                      { value: '0.5', label: '0.5×' },
                      { value: '1', label: '1×' },
                      { value: '1.5', label: '1.5×' },
                    ]}
                  />
                </div>
              </div>
            </div>
          </Panel>

          <Panel className="overflow-hidden">
            <div className="flex flex-wrap items-center justify-between gap-2 border-b border-line px-4 py-2.5">
              <div className="flex items-center gap-2">
                <Clock3 size={12} className="text-faint" />
                <span className="text-[11px] font-medium text-fg">时间线</span>
                <span className="text-[9.5px] text-faint">点击或拖拽定位；拖动时预览同步</span>
              </div>
              <Badge tone="outline" dot={false}>{scenes.length} 镜 · {total}s</Badge>
            </div>
            <div className="p-4">
              <Timeline
                scenes={scenes}
                currentTime={currentTime}
                onSeek={seek}
                onSelectScene={selectScene}
                selectedSceneId={selected?.id}
                accent={project.brand.primary}
              />
            </div>

            <div className="border-t border-line">
              <div className="flex items-center justify-between px-4 py-2 text-[9.5px] text-faint">
                <span>字幕轨 · 与镜头时长同步</span>
                <span>导出 SRT 在审核与导出页</span>
              </div>
              <div className="max-h-[220px] overflow-y-auto">
                {scenes.map((scene, index) => {
                  const start = starts[index] ?? 0;
                  const active = activeScene?.id === scene.id;
                  const isSelected = selected?.id === scene.id;
                  return (
                    <button
                      key={scene.id}
                      type="button"
                      onClick={() => selectScene(scene.id)}
                      className={cn(
                        'flex w-full items-start gap-3 border-t border-line/70 px-4 py-2 text-left transition-colors',
                        active ? 'bg-accent-soft/20' : 'hover:bg-overlay/40',
                        isSelected && 'ring-1 ring-inset ring-accent/25',
                      )}
                    >
                      <span className="mt-0.5 w-[92px] shrink-0 font-mono text-[9px] text-faint">
                        {formatTimecode(start, true)} → {formatTimecode(start + scene.durationSec, true)}
                      </span>
                      <span className="mt-0.5 w-4 shrink-0 font-mono text-[8.5px] text-faint">
                        {String(index + 1).padStart(2, '0')}
                      </span>
                      <span
                        className={cn(
                          'min-w-0 flex-1 text-[10.5px] leading-4',
                          active ? 'text-fg' : 'text-muted',
                        )}
                      >
                        {scene.caption || <span className="text-faint">（无字幕）</span>}
                      </span>
                      {active ? <span className="mt-1 size-1.5 shrink-0 rounded-full bg-accent" /> : null}
                    </button>
                  );
                })}
              </div>
            </div>
          </Panel>
        </div>

        <div className="space-y-3">
          {selected ? (
            <SceneInspector
              key={selected.id}
              scene={selected}
              index={selectedIndex}
              total={scenes.length}
              videoId={video.id}
              claims={claims}
              onPrev={() => {
                const prev = scenes[selectedIndex - 1];
                if (prev) selectScene(prev.id);
              }}
              onNext={() => {
                const next = scenes[selectedIndex + 1];
                if (next) selectScene(next.id);
              }}
            />
          ) : null}

          <Panel>
            <PanelHeader title="工程历史" description="撤销记录只存在于当前页面会话。" />
            <div className="px-4 pb-4">
              <div className="flex items-center gap-2">
                <Button variant="secondary" size="sm" className="flex-1" disabled={!canUndo} onClick={undo} icon={<Undo2 size={12} />}>
                  撤销
                </Button>
                <Button variant="secondary" size="sm" className="flex-1" disabled={!canRedo} onClick={redo} icon={<Redo2 size={12} />}>
                  重做
                </Button>
              </div>
              <div className="mt-2 flex items-center gap-1.5 text-[9px] text-faint">
                <RotateCcw size={9} />
                刷新后工程数据保留，但撤销栈会清空。
              </div>
            </div>
          </Panel>

          <Panel>
            <PanelHeader title="快捷键" />
            <div className="space-y-1.5 px-4 pb-4">
              {[
                ['Space', '播放 / 暂停'],
                ['← / →', '前后 1 秒'],
                ['Home / End', '跳到首尾'],
                ['Ctrl/Cmd + Z', '撤销'],
                ['Ctrl/Cmd + Shift + Z', '重做'],
              ].map(([key, action]) => (
                <div key={key} className="flex items-center justify-between gap-2 text-[9.5px]">
                  <span className="text-faint">{action}</span>
                  <kbd className="rounded-sm border border-line bg-raised px-1.5 py-0.5 font-mono text-[8.5px] text-muted">
                    {key}
                  </kbd>
                </div>
              ))}
              <div className="mt-2 flex items-start gap-1.5 text-[8.5px] leading-4 text-faint">
                <Keyboard size={10} className="mt-0.5 shrink-0" />
                输入框聚焦时快捷键不会触发，避免误操作。
              </div>
            </div>
          </Panel>

          <Callout tone="info" size="sm" title="没有真实音轨与渲染">
            预览由 DOM 实时绘制，旁白只作为文本。生产会模拟配音轨道，但不会生成可播放音频文件。
          </Callout>
        </div>
      </div>

      <p className="mt-4 flex items-center gap-1.5 text-[10px] text-faint">
        <Save size={10} />
        工程修改即时写入本机存储 · 审核通过后修改会使审核失效并要求重新生产
      </p>
    </Page>
  );
}

function SceneInspector({
  scene,
  index,
  total,
  videoId,
  claims,
  onPrev,
  onNext,
}: {
  scene: Scene;
  index: number;
  total: number;
  videoId: string;
  claims: Claim[];
  onPrev: () => void;
  onNext: () => void;
}) {
  const video = useStudioStore((state) => state.videos.find((item) => item.id === videoId));
  const updateScene = useStudioStore((state) => state.updateScene);
  const pushToast = useUiStore((state) => state.pushToast);
  const [draft, setDraft] = useState(() => ({
    title: scene.title,
    caption: scene.caption,
    narration: scene.narration,
    durationSec: scene.durationSec,
    status: scene.status,
  }));

  useEffect(() => {
    setDraft({
      title: scene.title,
      caption: scene.caption,
      narration: scene.narration,
      durationSec: scene.durationSec,
      status: scene.status,
    });
  }, [scene]);

  const sceneClaims = scene.claimIds
    .map((id) => claims.find((claim) => claim.id === id))
    .filter((claim): claim is Claim => Boolean(claim));
  const risky = sceneClaims.filter((claim) => claim.status !== 'verified');
  const dirty =
    draft.title !== scene.title ||
    draft.caption !== scene.caption ||
    draft.narration !== scene.narration ||
    draft.durationSec !== scene.durationSec ||
    draft.status !== scene.status;

  const save = () => {
    const beforeStage = video?.stage;
    updateScene(videoId, scene.id, {
      title: draft.title.trim() || scene.title,
      caption: draft.caption,
      narration: draft.narration,
      durationSec: draft.durationSec,
      status: draft.status,
    });
    pushToast({
      tone: 'success',
      title: `镜头 ${index + 1} 已更新`,
      description:
        beforeStage === 'approved' || beforeStage === 'exported'
          ? '已审核视频回到待审核，需要重新生产后才能导出。'
          : '时间线、字幕轨与模拟预览已同步。',
    });
  };

  return (
    <Panel>
      <PanelHeader
        title={`镜头 ${index + 1}`}
        description={`共 ${total} 个镜头`}
        actions={
          <div className="flex gap-0.5">
            <Button variant="ghost" size="icon-sm" aria-label="上一个镜头" disabled={index <= 0} onClick={onPrev}>
              <ChevronLeft size={13} />
            </Button>
            <Button variant="ghost" size="icon-sm" aria-label="下一个镜头" disabled={index >= total - 1} onClick={onNext}>
              <ChevronRight size={13} />
            </Button>
          </div>
        }
      />
      <div className="space-y-3 p-4">
        <div className="flex flex-wrap items-center gap-1.5">
          <StatusBadge meta={SCENE_STATUS_META[scene.status]} />
          <Badge tone="outline" dot={false}>{scene.durationSec}s</Badge>
          {dirty ? <Badge tone="warn" dot={false}>未保存</Badge> : <Badge tone="success" dot={false}>已同步</Badge>}
        </div>
        <Field label="镜头标题">
          <Input value={draft.title} onChange={(event) => setDraft({ ...draft, title: event.target.value })} />
        </Field>
        <Field label="字幕" hint="显示在预览与 SRT 中">
          <Textarea
            value={draft.caption}
            className="min-h-[64px]"
            onChange={(event) => setDraft({ ...draft, caption: event.target.value })}
          />
        </Field>
        <Field label="旁白" hint="不会生成真实音频">
          <Textarea
            value={draft.narration}
            className="min-h-[58px]"
            onChange={(event) => setDraft({ ...draft, narration: event.target.value })}
          />
        </Field>
        <Slider
          label="镜头时长"
          value={draft.durationSec}
          min={2}
          max={40}
          step={0.5}
          onValueChange={(value) => setDraft({ ...draft, durationSec: value })}
          formatValue={(value) => `${value}s`}
        />
        <Field label="镜头状态">
          <SegmentedControl
            value={draft.status}
            onChange={(status) => setDraft({ ...draft, status })}
            size="sm"
            ariaLabel="镜头状态"
            options={[
              { value: 'draft', label: '草稿' },
              { value: 'review', label: '待确认' },
              { value: 'approved', label: '已确认' },
            ]}
          />
        </Field>

        {sceneClaims.length > 0 ? (
          <div className="rounded-sm border border-line px-2.5 py-2">
            <div className="text-[9px] uppercase tracking-wide text-faint">声明引用</div>
            <div className="mt-1.5 space-y-1.5">
              {sceneClaims.map((claim) => (
                <div key={claim.id} className="flex items-start gap-1.5">
                  <ClaimStatusBadge status={claim.status} />
                  <span className="min-w-0 text-[9px] leading-4 text-muted">{claim.statement}</span>
                </div>
              ))}
            </div>
          </div>
        ) : (
          <div className="flex items-start gap-1.5 rounded-sm border border-warn/25 bg-warn-soft/30 px-2.5 py-2 text-[9px] leading-4 text-warn">
            <ShieldAlert size={11} className="mt-0.5 shrink-0" />
            这个镜头没有声明引用，审核会提示无法核对事实。
          </div>
        )}

        {risky.length > 0 ? (
          <div className="text-[9px] leading-4 text-warn">
            有 {risky.length} 条声明不是已核验状态，审核可能阻断或要求限定表述。
          </div>
        ) : null}

        <div className="flex items-center gap-2 border-t border-line pt-3">
          <Button variant="primary" size="sm" className="flex-1" disabled={!dirty} onClick={save} icon={<Save size={12} />}>
            保存镜头
          </Button>
          <Button
            variant="ghost"
            size="sm"
            disabled={!dirty}
            onClick={() =>
              setDraft({
                title: scene.title,
                caption: scene.caption,
                narration: scene.narration,
                durationSec: scene.durationSec,
                status: scene.status,
              })
            }
          >
            还原
          </Button>
        </div>
        <div className="flex items-center justify-between text-[8.5px] text-faint">
          <span className="flex items-center gap-1"><Check size={9} /> 保存后立即持久化</span>
          <span className="flex items-center gap-1"><ArrowLeft size={9} /> 快捷键可撤销</span>
        </div>
      </div>
    </Panel>
  );
}
