import { useRef } from 'react';
import type { Feature, Project, VideoProject } from '@asvs/domain';
import {
  formatTimecode,
  orderedScenes,
  sceneAtTime,
  sceneStartTimes,
  totalDuration,
} from '@asvs/domain';
import { Maximize2, Pause, Play, VolumeX } from 'lucide-react';
import { cn } from '../cn';
import { ScenePreview } from './scene-preview';

export interface PreviewFrameProps {
  video: VideoProject;
  project: Project;
  features?: Feature[];
  currentTime: number;
  isPlaying?: boolean;
  onTogglePlay?: () => void;
  onSeek?: (time: number) => void;
  showControls?: boolean;
  showCaption?: boolean;
  className?: string;
  frameClassName?: string;
  label?: string;
}

export function PreviewFrame({
  video,
  project,
  features = [],
  currentTime,
  isPlaying = false,
  onTogglePlay,
  onSeek,
  showControls = true,
  showCaption = true,
  className,
  frameClassName,
  label = '模拟预览',
}: PreviewFrameProps) {
  const scenes = orderedScenes(video.scenes);
  const total = totalDuration(scenes);
  const activeInfo = sceneAtTime(scenes, currentTime);
  const active = activeInfo?.scene ?? scenes[0];
  const feature = active?.featureId
    ? features.find((item) => item.id === active.featureId)
    : undefined;
  const containerRef = useRef<HTMLDivElement>(null);
  const starts = sceneStartTimes(scenes);
  const activeIndex = active ? scenes.findIndex((scene) => scene.id === active.id) : 0;

  const requestFullscreen = () => {
    const node = containerRef.current;
    if (!node) return;
    if (document.fullscreenElement) {
      void document.exitFullscreen();
    } else {
      void node.requestFullscreen?.();
    }
  };

  return (
    <div className={cn('group relative', className)}>
      <div
        ref={containerRef}
        className={cn(
          'relative overflow-hidden rounded-lg border border-line bg-black shadow-lift',
          frameClassName,
        )}
        style={{
          aspectRatio:
            video.brief.aspect === '9:16' ? '9 / 16' : video.brief.aspect === '1:1' ? '1 / 1' : '16 / 9',
        }}
      >
        {active ? (
          <ScenePreview
            scene={active}
            project={project}
            feature={feature}
            aspect={video.brief.aspect}
            showCaption={showCaption}
            showChrome={false}
          />
        ) : (
          <div className="grid h-full place-items-center text-[12px] text-faint">还没有镜头</div>
        )}

        <div className="pointer-events-none absolute inset-x-0 top-0 flex items-start justify-between p-3">
          <span className="inline-flex items-center gap-1.5 rounded-sm border border-white/20 bg-black/45 px-2 py-1 text-[10px] font-medium tracking-wide text-white/80 backdrop-blur-sm">
            <span className="size-1.5 rounded-full bg-white/60" aria-hidden />
            {label} · 非成片
          </span>
          <span className="rounded-sm border border-white/15 bg-black/40 px-1.5 py-1 font-mono text-[10px] text-white/65 backdrop-blur-sm">
            {String(activeIndex + 1).padStart(2, '0')} / {String(scenes.length).padStart(2, '0')}
          </span>
        </div>

        {showControls ? (
          <>
            <button
              type="button"
              aria-label={isPlaying ? '暂停预览' : '播放预览'}
              onClick={onTogglePlay}
              className={cn(
                'absolute left-1/2 top-1/2 grid size-12 -translate-x-1/2 -translate-y-1/2 place-items-center rounded-full border border-white/25 bg-black/45 text-white backdrop-blur-sm transition-all duration-200 hover:scale-105 hover:bg-black/60',
                isPlaying ? 'opacity-0 group-hover:opacity-100' : 'opacity-100',
              )}
            >
              {isPlaying ? <Pause size={19} /> : <Play size={19} className="ml-0.5" />}
            </button>

            <div className="absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/80 via-black/35 to-transparent px-3 pb-2.5 pt-8">
              <div
                className="relative mb-2 h-1 cursor-pointer rounded-full bg-white/20"
                onPointerDown={(event) => {
                  const rect = event.currentTarget.getBoundingClientRect();
                  const ratio = Math.min(1, Math.max(0, (event.clientX - rect.left) / rect.width));
                  onSeek?.(Number((ratio * total).toFixed(2)));
                }}
                role="presentation"
              >
                <div
                  className="absolute inset-y-0 left-0 rounded-full bg-white/80"
                  style={{ width: `${total > 0 ? (currentTime / total) * 100 : 0}%` }}
                />
                <div
                  className="absolute top-1/2 size-2.5 -translate-x-1/2 -translate-y-1/2 rounded-full bg-white shadow"
                  style={{ left: `${total > 0 ? (currentTime / total) * 100 : 0}%` }}
                />
              </div>
              <div className="flex items-center justify-between gap-3 text-[10.5px] text-white/75">
                <div className="flex items-center gap-2.5">
                  <button
                    type="button"
                    onClick={onTogglePlay}
                    aria-label={isPlaying ? '暂停' : '播放'}
                    className="text-white/85 transition-colors hover:text-white"
                  >
                    {isPlaying ? <Pause size={13} /> : <Play size={13} />}
                  </button>
                  <span className="font-mono tabular text-white/90">
                    {formatTimecode(currentTime, true)} / {formatTimecode(total, true)}
                  </span>
                  <span className="hidden items-center gap-1 text-white/45 sm:flex">
                    <VolumeX size={12} />
                    模拟旁白 · 无真实音轨
                  </span>
                </div>
                <div className="flex items-center gap-2">
                  <span className="hidden text-white/45 md:inline">
                    第 {active?.order !== undefined ? active.order + 1 : 0} 镜
                  </span>
                  <button
                    type="button"
                    onClick={requestFullscreen}
                    aria-label="全屏查看预览"
                    className="text-white/70 transition-colors hover:text-white"
                  >
                    <Maximize2 size={12} />
                  </button>
                </div>
              </div>
            </div>
          </>
        ) : null}
      </div>
      <div className="mt-2 flex items-center justify-between text-[11px] text-faint">
        <span className="truncate">
          {starts[activeIndex] !== undefined ? `第 ${activeIndex + 1} 镜 · ` : ''}
          {active?.title ?? '暂无镜头'}
        </span>
        <span className="shrink-0">模拟预览，不代表最终渲染质量</span>
      </div>
    </div>
  );
}
