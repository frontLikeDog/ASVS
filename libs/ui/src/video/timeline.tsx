import { useRef } from 'react';
import type { Scene } from '@asvs/domain';
import { formatTimecode, orderedScenes, sceneStartTimes, totalDuration } from '@asvs/domain';
import { cn } from '../cn';

export interface TimelineProps {
  scenes: Scene[];
  currentTime: number;
  onSeek: (time: number) => void;
  onSelectScene?: (sceneId: string) => void;
  selectedSceneId?: string;
  accent?: string;
  className?: string;
  compact?: boolean;
}

export function Timeline({
  scenes: rawScenes,
  currentTime,
  onSeek,
  onSelectScene,
  selectedSceneId,
  accent = 'var(--accent)',
  className,
  compact = false,
}: TimelineProps) {
  const scenes = orderedScenes(rawScenes);
  const total = totalDuration(scenes);
  const starts = sceneStartTimes(scenes);
  const trackRef = useRef<HTMLDivElement>(null);
  const draggingRef = useRef(false);

  const seekFromClientX = (clientX: number) => {
    const rect = trackRef.current?.getBoundingClientRect();
    if (!rect || rect.width === 0) return;
    const ratio = Math.min(1, Math.max(0, (clientX - rect.left) / rect.width));
    onSeek(Number((ratio * total).toFixed(2)));
  };

  return (
    <div className={cn('select-none', className)}>
      <div
        className={cn('flex justify-between pb-1.5 font-mono text-[10px] text-faint', compact && 'text-[9.5px]')}
      >
        <span className="tabular">{formatTimecode(0, true)}</span>
        <span className="tabular">{formatTimecode(total / 2)}</span>
        <span className="tabular">{formatTimecode(total, true)}</span>
      </div>
      <div
        ref={trackRef}
        className="relative touch-none"
        onPointerDown={(event) => {
          draggingRef.current = true;
          event.currentTarget.setPointerCapture(event.pointerId);
          seekFromClientX(event.clientX);
        }}
        onPointerMove={(event) => {
          if (draggingRef.current) seekFromClientX(event.clientX);
        }}
        onPointerUp={(event) => {
          draggingRef.current = false;
          event.currentTarget.releasePointerCapture(event.pointerId);
        }}
        onPointerCancel={() => {
          draggingRef.current = false;
        }}
        style={{ ['--timeline-accent' as string]: accent }}
      >
        <div className={cn('flex gap-[3px] overflow-hidden rounded-sm border border-line bg-ink/60 p-[3px]', compact ? 'h-9' : 'h-[62px]')}>
          {scenes.map((scene, index) => {
            const active = scene.id === selectedSceneId;
            const current =
              currentTime >= (starts[index] ?? 0) &&
              currentTime < (starts[index] ?? 0) + scene.durationSec;
            const palette = visualPalette(scene);
            return (
              <button
                key={scene.id}
                type="button"
                title={`${scene.title} · ${scene.durationSec.toFixed(1)}s`}
                onPointerDown={(event) => event.stopPropagation()}
                onClick={(event) => {
                  event.stopPropagation();
                  onSelectScene?.(scene.id);
                  onSeek(starts[index] ?? 0);
                }}
                className={cn(
                  'group relative min-w-0 overflow-hidden rounded-[3px] border text-left transition-[border-color,filter] duration-150',
                  active
                    ? 'border-white/40'
                    : current
                      ? 'border-white/20'
                      : 'border-transparent hover:border-white/20',
                  compact ? 'px-1.5' : 'px-2 pt-1.5',
                )}
                style={{
                  flexGrow: Math.max(0.4, scene.durationSec),
                  flexBasis: 0,
                  background: palette.bg,
                }}
              >
                <span
                  className={cn(
                    'block truncate font-medium text-white/90',
                    compact ? 'text-[9px] leading-6' : 'text-[10.5px] leading-4',
                  )}
                >
                  {compact ? `${index + 1}` : scene.title}
                </span>
                {!compact ? (
                  <span className="mt-0.5 flex items-center justify-between font-mono text-[9px] text-white/45">
                    <span>{String(index + 1).padStart(2, '0')}</span>
                    <span>{scene.durationSec.toFixed(1)}s</span>
                  </span>
                ) : null}
                <span
                  className="absolute inset-x-0 bottom-0 h-[2px]"
                  style={{ background: palette.line }}
                  aria-hidden
                />
              </button>
            );
          })}
        </div>
        {/* Slider semantics live on an overlay without focusable descendants;
            the scene buttons stay siblings so the track is not a nested widget. */}
        <div
          role="slider"
          aria-label="视频时间轴"
          aria-valuemin={0}
          aria-valuemax={Math.round(total)}
          aria-valuenow={Math.round(currentTime)}
          aria-valuetext={`${formatTimecode(currentTime, true)} / ${formatTimecode(total, true)}`}
          tabIndex={0}
          onKeyDown={(event) => {
            if (event.key === 'ArrowLeft') {
              event.preventDefault();
              onSeek(Math.max(0, currentTime - 0.5));
            }
            if (event.key === 'ArrowRight') {
              event.preventDefault();
              onSeek(Math.min(total, currentTime + 0.5));
            }
            if (event.key === 'Home') {
              event.preventDefault();
              onSeek(0);
            }
            if (event.key === 'End') {
              event.preventDefault();
              onSeek(total);
            }
          }}
          className="pointer-events-none absolute inset-0 z-10 rounded-sm"
        />
        <div
          className="pointer-events-none absolute bottom-0 top-0 z-10 w-px"
          style={{
            left: `${total > 0 ? Math.min(100, (currentTime / total) * 100) : 0}%`,
            background: 'var(--timeline-accent)',
          }}
        >
          <span
            className="absolute -left-[5px] top-0 size-[11px] rounded-[2px]"
            style={{ background: 'var(--timeline-accent)' }}
          />
        </div>
      </div>
    </div>
  );
}

function visualPalette(scene: Scene): { bg: string; line: string } {
  switch (scene.visualType) {
    case 'real_demo':
      return { bg: '#222A38', line: 'rgba(126,170,255,.7)' };
    case 'title':
      return { bg: '#2A2A24', line: 'rgba(240,236,220,.5)' };
    case 'cta':
      return { bg: '#3A2822', line: 'rgba(255,140,100,.75)' };
    case 'generated':
      return { bg: '#2B2338', line: 'rgba(167,139,250,.7)' };
    default:
      return { bg: '#1D2622', line: 'rgba(130,210,180,.55)' };
  }
}
