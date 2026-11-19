import type { HTMLAttributes, ReactNode } from 'react';
import { cn } from './cn';

export function Panel({ className, children, ...props }: HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={cn('rounded-lg border border-line bg-surface', className)}
      {...props}
    >
      {children}
    </div>
  );
}

export interface PanelHeaderProps {
  title: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
  className?: string;
  titleClassName?: string;
}

export function PanelHeader({ title, description, actions, className, titleClassName }: PanelHeaderProps) {
  return (
    <div className={cn('flex items-start justify-between gap-4 px-5 pt-4 pb-3', className)}>
      <div className="min-w-0">
        <h3 className={cn('font-display text-[15px] font-medium tracking-[-0.01em] text-fg', titleClassName)}>
          {title}
        </h3>
        {description ? <p className="mt-0.5 text-[12.5px] leading-5 text-muted">{description}</p> : null}
      </div>
      {actions ? <div className="flex shrink-0 items-center gap-2">{actions}</div> : null}
    </div>
  );
}

export interface PageHeaderProps {
  eyebrow?: ReactNode;
  title: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
  className?: string;
}

export function Page({
  children,
  className,
  wide,
}: {
  children: ReactNode;
  className?: string;
  wide?: boolean;
}) {
  return (
    <div
      className={cn(
        'mx-auto w-full px-5 py-6 lg:px-8 lg:py-7',
        wide ? 'max-w-[1600px]' : 'max-w-[1380px]',
        className,
      )}
    >
      {children}
    </div>
  );
}

export function PageHeader({ eyebrow, title, description, actions, className }: PageHeaderProps) {
  return (
    <header className={cn('flex flex-wrap items-end justify-between gap-x-6 gap-y-4', className)}>
      <div className="min-w-0 max-w-2xl">
        {eyebrow ? (
          <div className="mb-1.5 flex items-center gap-2 text-[11px] font-medium uppercase tracking-[0.12em] text-faint">
            {eyebrow}
          </div>
        ) : null}
        <h1 className="font-display text-[28px] font-medium leading-9 tracking-[-0.02em] text-fg">
          {title}
        </h1>
        {description ? (
          <p className="mt-1.5 text-[13.5px] leading-[22px] text-muted">{description}</p>
        ) : null}
      </div>
      {actions ? <div className="flex flex-wrap items-center gap-2">{actions}</div> : null}
    </header>
  );
}

export function SectionLabel({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <div
      className={cn(
        'text-[10.5px] font-semibold uppercase tracking-[0.14em] text-faint',
        className,
      )}
    >
      {children}
    </div>
  );
}

export function Divider({ className }: { className?: string }) {
  return <div className={cn('h-px w-full bg-line', className)} role="separator" />;
}

export function Metric({
  label,
  value,
  hint,
  tone,
  className,
}: {
  label: ReactNode;
  value: ReactNode;
  hint?: ReactNode;
  tone?: 'default' | 'accent' | 'warn' | 'danger' | 'ai';
  className?: string;
}) {
  const toneClass = {
    default: 'text-fg',
    accent: 'text-accent',
    warn: 'text-warn',
    danger: 'text-danger',
    ai: 'text-ai',
  }[tone ?? 'default'];
  return (
    <div className={cn('min-w-0', className)}>
      <div className="text-[11px] font-medium uppercase tracking-[0.1em] text-faint">{label}</div>
      <div className={cn('mt-1.5 font-display text-[26px] leading-none tracking-[-0.02em] tabular', toneClass)}>
        {value}
      </div>
      {hint ? <div className="mt-1.5 text-[12px] leading-4 text-muted">{hint}</div> : null}
    </div>
  );
}

export function KeyValue({
  label,
  children,
  className,
}: {
  label: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <div className={cn('flex items-start justify-between gap-4 py-2', className)}>
      <dt className="shrink-0 text-[12.5px] text-faint">{label}</dt>
      <dd className="min-w-0 text-right text-[12.5px] text-fg">{children}</dd>
    </div>
  );
}
