import { Link } from 'react-router-dom';
import { ArrowLeft, SearchX } from 'lucide-react';
import { Page, buttonStyles } from '@asvs/ui';

export function NotFoundInline({ label = '内容不存在或已被删除。' }: { label?: string }) {
  return (
    <Page>
      <div className="flex min-h-[56vh] flex-col items-center justify-center text-center">
        <span className="grid size-12 place-items-center rounded-md border border-line bg-surface text-faint">
          <SearchX size={20} />
        </span>
        <h1 className="mt-4 font-display text-[20px] font-medium text-fg">找不到这个页面</h1>
        <p className="mt-1 max-w-sm text-[12px] leading-5 text-muted">{label}</p>
        <Link to="/" className={buttonStyles({ variant: 'secondary', className: 'mt-4' })}>
          <ArrowLeft size={14} /> 返回工作区
        </Link>
      </div>
    </Page>
  );
}
