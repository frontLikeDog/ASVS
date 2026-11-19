import { useEffect } from 'react';
import { Link } from 'react-router-dom';
import { buttonStyles, ToastCard } from '@asvs/ui';
import { useUiStore } from '@asvs/state';
import type { Toast } from '@asvs/state';

export function Toaster() {
  const toasts = useUiStore((state) => state.toasts);
  return (
    <div className="pointer-events-none fixed bottom-4 right-4 z-[80] flex flex-col items-end gap-2">
      {toasts.map((toast) => (
        <ToastItem key={toast.id} toast={toast} />
      ))}
    </div>
  );
}

function ToastItem({ toast }: { toast: Toast }) {
  const dismiss = useUiStore((state) => state.dismissToast);

  useEffect(() => {
    const timeout = window.setTimeout(
      () => dismiss(toast.id),
      toast.tone === 'danger' ? 7000 : 4800,
    );
    return () => window.clearTimeout(timeout);
  }, [toast.id, toast.tone, dismiss]);

  return (
    <ToastCard
      tone={toast.tone}
      title={toast.title}
      description={toast.description}
      onDismiss={() => dismiss(toast.id)}
      action={
        toast.actionHref && toast.actionLabel ? (
          <Link
            to={toast.actionHref}
            onClick={() => dismiss(toast.id)}
            className={buttonStyles({ variant: 'ghost', size: 'sm', className: 'h-7 px-0 text-accent' })}
          >
            {toast.actionLabel} →
          </Link>
        ) : null
      }
    />
  );
}
