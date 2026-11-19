import { Link, isRouteErrorResponse, useRouteError } from 'react-router-dom';
import { AlertOctagon, ArrowLeft, RotateCcw } from 'lucide-react';
import { buttonStyles } from '@asvs/ui';

export function RouteErrorPage() {
  const error = useRouteError();
  const status = isRouteErrorResponse(error) ? `${error.status} ${error.statusText}` : 'Runtime error';
  const message = isRouteErrorResponse(error)
    ? error.data
      ? String(error.data)
      : '路由加载失败。'
    : error instanceof Error
      ? error.message
      : '发生了未知错误。';

  return (
    <div className="grid min-h-dvh place-items-center bg-ink px-6 text-fg">
      <div className="w-full max-w-lg rounded-xl border border-line bg-surface p-6 shadow-lift">
        <span className="grid size-11 place-items-center rounded-lg border border-danger/25 bg-danger-soft text-danger">
          <AlertOctagon size={20} />
        </span>
        <div className="mt-4 font-mono text-[10px] uppercase tracking-[0.16em] text-faint">{status}</div>
        <h1 className="mt-1 font-display text-[24px] font-medium tracking-[-0.02em] text-fg">
          页面没有正常渲染
        </h1>
        <p className="mt-2 text-[12px] leading-5 text-muted">
          本地演示数据可能损坏，或页面遇到了未处理的异常。刷新通常可以恢复；不会上传任何内容。
        </p>
        <pre className="mt-3 max-h-[160px] overflow-auto rounded-md border border-line bg-ink/70 p-3 font-mono text-[10px] leading-5 text-danger/90 whitespace-pre-wrap">
          {message}
        </pre>
        <div className="mt-5 flex flex-wrap gap-2">
          <button type="button" className={buttonStyles({ variant: 'primary' })} onClick={() => window.location.reload()}>
            <RotateCcw size={14} /> 刷新页面
          </button>
          <Link to="/" className={buttonStyles({ variant: 'secondary' })}>
            <ArrowLeft size={14} /> 回到概览
          </Link>
        </div>
        <p className="mt-4 text-[9.5px] leading-4 text-faint">
          如果刷新仍失败，可以在设置 → 演示数据中重置本地快照（浏览器 localStorage）。
        </p>
      </div>
    </div>
  );
}
