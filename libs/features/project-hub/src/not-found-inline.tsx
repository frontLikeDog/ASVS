import { Link } from 'react-router-dom';
import { FolderX } from 'lucide-react';
import { EmptyState, Page, buttonStyles } from '@asvs/ui';

export function NotFoundInline({ label }: { label: string }) {
  return (
    <Page>
      <EmptyState
        className="mt-12"
        icon={<FolderX size={20} />}
        title="找不到这个内容"
        description={label}
        action={
          <Link to="/projects" className={buttonStyles({ variant: 'primary' })}>
            返回项目列表
          </Link>
        }
      />
    </Page>
  );
}
