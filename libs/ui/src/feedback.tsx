import type { ReactNode } from 'react';
import { AlertCircle, CheckCircle2, Info, TriangleAlert } from 'lucide-react';
import { cn } from './cn';

export function EmptyState({
  icon,
  title,
  description,
  action,
  className,
  compact,
}: {
  icon?: ReactNode;
  title: ReactNode;
  description?: ReactNode;
  action?: ReactNode;
  className?: string;
  compact?: boolean;
}) {
  return (
    <div
      className={cn(
        'flex flex-col items-center justify-center rounded-lg border border-dashed border-line-strong text-center',
        compact ? 'px-5 py-8' : 'px-6 py-14',
        className,
      )}
    >
      {icon ? (
        <div className="mb-3 grid size-10 place-items-center rounded-md border border-line bg-raised text-muted">
          {icon}
        </div>
      ) : null}
      <h3 className="font-display text-[15px] font-medium text-fg">{title}</h3>
      {description ? (
        <p className="mt-1.5 max-w-md text-[12.5px] leading-5 text-muted">{description}</p>
      ) : null}
      {action ? <div className="mt-4">{action}</div> : null}
    </div>
  );
}

export function ProgressBar({
  value,
  tone = 'accent',
  size = 'md',
  showValue = false,
  label,
  className,
  animated = false,
}: {
  value: number;
  tone?: 'accent' | 'success' | 'warn' | 'danger' | 'ai';
  size?: 'sm' | 'md';
  showValue?: boolean;
  label?: string;
  className?: string;
  animated?: boolean;
}) {
  const clamped = Math.min(100, Math.max(0, value));
  const bar = {
    accent: 'bg-accent',
    success: 'bg-success',
    warn: 'bg-warn',
    danger: 'bg-danger',
    ai: 'bg-ai',
  }[tone];
  return (
    <div className={cn('space-y-1.5', className)}>
      {label || showValue ? (
        <div className="flex items-center justify-between gap-3 text-[11.5px]">
          {label ? <span className="text-muted">{label}</span> : <span />}
          {showValue ? <span className="font-mono tabular text-faint">{Math.round(clamped)}%</span> : null}
        </div>
      ) : null}
      <div
        role="progressbar"
        aria-valuenow={Math.round(clamped)}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-label={label}
        className={cn(
          'relative w-full overflow-hidden rounded-full bg-overlay',
          size === 'sm' ? 'h-1' : 'h-1.5',
        )}
      >
        <div
          className={cn('relative h-full rounded-full transition-[width] duration-300 ease-out', bar, animated && clamped < 100 && 'progress-sheen')}
          style={{ width: `${clamped}%` }}
        />
      </div>
    </div>
  );
}

export type CalloutTone = 'info' | 'success' | 'warning' | 'danger' | 'ai';

const CALLOUT: Record<CalloutTone, { wrap: string; icon: ReactNode }> = {
  info: { wrap: 'border-line-strong bg-raised/60 text-muted', icon: <Info size={15} /> },
  success: { wrap: 'border-success/25 bg-success-soft text-success', icon: <CheckCircle2 size={15} /> },
  warning: { wrap: 'border-warn/25 bg-warn-soft text-warn', icon: <TriangleAlert size={15} /> },
  danger: { wrap: 'border-danger/25 bg-danger-soft text-danger', icon: <AlertCircle size={15} /> },
  ai: { wrap: 'border-ai/25 bg-ai-soft text-ai', icon: <Info size={15} /> },
};

export function Callout({
  tone = 'info',
  title,
  children,
  action,
  className,
  size = 'md',
}: {
  tone?: CalloutTone;
  title?: ReactNode;
  children?: ReactNode;
  action?: ReactNode;
  className?: string;
  size?: 'sm' | 'md';
}) {
  return (
    <div
      className={cn(
        'flex items-start gap-2.5 rounded-md border leading-5',
        size === 'sm' ? 'px-3 py-2' : 'px-3.5 py-3',
        CALLOUT[tone].wrap,
        className,
      )}
    >
      <span className="mt-[1px] shrink-0">{CALLOUT[tone].icon}</span>
      <div className="min-w-0 flex-1 text-[12.5px]">
        {title ? <div className="font-medium">{title}</div> : null}
        {children ? <div className={cn('text-[12.5px]', title && 'mt-0.5 opacity-85')}>{children}</div> : null}
      </div>
      {action ? <div className="shrink-0">{action}</div> : null}
    </div>
  );
}

export function ThinkingDots({ label = '正在处理…' }: { label?: string }) {
  return (
    <div className="flex items-center gap-2 text-[12px] text-ai">
      <span className="flex items-end gap-[3px]" aria-hidden>
        <span className="ai-dot size-1.5 rounded-full bg-ai" />
        <span className="ai-dot size-1.5 rounded-full bg-ai" />
        <span className="ai-dot size-1.5 rounded-full bg-ai" />
      </span>
      {label}
    </div>
  );
}

export function Kbd({ children }: { children: ReactNode }) {
  return (
    <kbd className="inline-flex h-[19px] min-w-[19px] items-center justify-center rounded-[4px] border border-line-strong bg-raised px-1 font-mono text-[10px] text-muted">
      {children}
    </kbd>
  );
}

export function Avatar({
  name,
  size = 28,
  className,
}: {
  name: string;
  size?: number;
  className?: string;
}) {
  const initials = name
    .trim()
    .split(/\s+/)
    .slice(0, 2)
    .map((part) => part.slice(0, 1))
    .join('')
    .toUpperCase();
  return (
    <span
      className={cn(
        'grid shrink-0 place-items-center rounded-full border border-line bg-overlay font-display text-[10.5px] font-medium text-muted',
        className,
      )}
      style={{ width: size, height: size }}
      title={name}
    >
      {initials || '?'}
    </span>
  );
}
