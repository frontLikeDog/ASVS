import { Link } from 'react-router-dom';
import { ArrowLeft, Compass, FolderKanban } from 'lucide-react';
import { Page, buttonStyles } from '@asvs/ui';

export function NotFoundPage() {
  return (
    <Page>
      <div className="flex min-h-[62vh] flex-col items-center justify-center text-center">
        <span className="grid size-14 place-items-center rounded-xl border border-line bg-surface text-faint">
          <Compass size={24} />
        </span>
        <div className="mt-4 font-mono text-[10px] uppercase tracking-[0.18em] text-faint">404 · Not found</div>
        <h1 className="mt-1 font-display text-[26px] font-medium tracking-[-0.03em] text-fg">
          这条路径不存在
        </h1>
        <p className="mt-2 max-w-md text-[12.5px] leading-5 text-muted">
          可能是项目或视频已被删除，也可能是链接写错了。演示数据重置后，新建的项目不会保留。
        </p>
        <div className="mt-5 flex flex-wrap items-center justify-center gap-2">
          <Link to="/" className={buttonStyles({ variant: 'primary' })}>
            <ArrowLeft size={14} /> 回到概览
          </Link>
          <Link to="/projects" className={buttonStyles({ variant: 'secondary' })}>
            <FolderKanban size={14} /> 查看项目
          </Link>
        </div>
      </div>
    </Page>
  );
}
