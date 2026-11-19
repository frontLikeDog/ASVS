import type { ReactNode } from 'react';
import { AlertCircle, CheckCircle2, Info, TriangleAlert, X } from 'lucide-react';
import { cn } from './cn';

export type ToastTone = 'info' | 'success' | 'warning' | 'danger';

const TONE = {
  info: { border: 'border-line-strong', icon: <Info size={15} className="text-muted" /> },
  success: { border: 'border-success/30', icon: <CheckCircle2 size={15} className="text-success" /> },
  warning: { border: 'border-warn/30', icon: <TriangleAlert size={15} className="text-warn" /> },
  danger: { border: 'border-danger/30', icon: <AlertCircle size={15} className="text-danger" /> },
};

export function ToastCard({
  tone = 'info',
  title,
  description,
  onDismiss,
  action,
}: {
  tone?: ToastTone;
  title: ReactNode;
  description?: ReactNode;
  onDismiss?: () => void;
  action?: ReactNode;
}) {
  return (
    <div
      role="status"
      className={cn(
        'animate-enter pointer-events-auto flex w-[340px] items-start gap-2.5 rounded-md border bg-surface px-3.5 py-3 shadow-float',
        TONE[tone].border,
      )}
    >
      <span className="mt-[1px] shrink-0">{TONE[tone].icon}</span>
      <div className="min-w-0 flex-1">
        <div className="text-[12.5px] font-medium leading-5 text-fg">{title}</div>
        {description ? (
          <div className="mt-0.5 text-[12px] leading-[18px] text-muted">{description}</div>
        ) : null}
        {action ? <div className="mt-2">{action}</div> : null}
      </div>
      {onDismiss ? (
        <button
          type="button"
          aria-label="关闭提示"
          onClick={onDismiss}
          className="-mr-1 -mt-1 grid size-6 place-items-center rounded-sm text-faint transition-colors hover:bg-overlay hover:text-fg"
        >
          <X size={13} />
        </button>
      ) : null}
    </div>
  );
}
