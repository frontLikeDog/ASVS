export function RouteLoading() {
  return (
    <div
      role="status"
      aria-live="polite"
      className="grid min-h-[40vh] place-items-center px-6 py-16"
    >
      <div className="flex items-center gap-2.5 text-[12px] text-muted">
        <span
          aria-hidden
          className="size-3.5 animate-spin rounded-full border-2 border-line-strong border-t-accent"
        />
        <span>正在加载页面…</span>
      </div>
    </div>
  );
}
