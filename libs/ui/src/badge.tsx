import type { ReactNode } from 'react';
import { cn } from './cn';

export type BadgeTone =
  | 'neutral'
  | 'accent'
  | 'ai'
  | 'success'
  | 'warn'
  | 'danger'
  | 'outline';

const TONES: Record<BadgeTone, string> = {
  neutral: 'bg-overlay text-muted border-line',
  accent: 'bg-accent-soft text-accent border-accent/25',
  ai: 'bg-ai-soft text-ai border-ai/25',
  success: 'bg-success-soft text-success border-success/25',
  warn: 'bg-warn-soft text-warn border-warn/25',
  danger: 'bg-danger-soft text-danger border-danger/25',
  outline: 'bg-transparent text-muted border-line-strong border-dashed',
};

const DOTS: Record<BadgeTone, string> = {
  neutral: 'bg-faint',
  accent: 'bg-accent',
  ai: 'bg-ai',
  success: 'bg-success',
  warn: 'bg-warn',
  danger: 'bg-danger',
  outline: 'bg-faint',
};

export interface BadgeProps {
  tone?: BadgeTone;
  children: ReactNode;
  className?: string;
  dot?: boolean;
  title?: string;
}

export function Badge({ tone = 'neutral', children, className, dot = true, title }: BadgeProps) {
  return (
    <span
      title={title}
      className={cn(
        'inline-flex h-[22px] items-center gap-1.5 rounded-full border px-2 text-[11px] font-medium leading-none whitespace-nowrap',
        TONES[tone],
        className,
      )}
    >
      {dot ? <span className={cn('size-1.5 rounded-full', DOTS[tone])} aria-hidden /> : null}
      {children}
    </span>
  );
}

export function DemoBadge({ className, label = 'Demo 数据' }: { className?: string; label?: string }) {
  return (
    <Badge tone="outline" dot={false} className={cn('italic tracking-wide', className)}>
      {label}
    </Badge>
  );
}

export function SimulatedBadge({ className, label = '模拟预览' }: { className?: string; label?: string }) {
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1 rounded-sm border border-white/20 bg-black/40 px-1.5 py-0.5 text-[10px] font-medium tracking-wide text-white/80 backdrop-blur-sm',
        className,
      )}
    >
      <span className="size-1 rounded-full bg-white/60" aria-hidden />
      {label}
    </span>
  );
}
