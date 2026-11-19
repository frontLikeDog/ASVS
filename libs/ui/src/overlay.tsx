import type { ComponentPropsWithoutRef, ReactNode } from 'react';
import * as DialogPrimitive from '@radix-ui/react-dialog';
import * as TabsPrimitive from '@radix-ui/react-tabs';
import * as TooltipPrimitive from '@radix-ui/react-tooltip';
import * as DropdownPrimitive from '@radix-ui/react-dropdown-menu';
import { X } from 'lucide-react';
import { cn } from './cn';

export const Dialog = DialogPrimitive.Root;
export const DialogTrigger = DialogPrimitive.Trigger;
export const DialogClose = DialogPrimitive.Close;

export interface DialogContentProps extends Omit<ComponentPropsWithoutRef<typeof DialogPrimitive.Content>, 'title' | 'children'> {
  title: ReactNode;
  description?: ReactNode;
  footer?: ReactNode;
  size?: 'sm' | 'md' | 'lg';
  children?: ReactNode;
}

export function DialogContent({
  title,
  description,
  footer,
  size = 'md',
  className,
  children,
  ...props
}: DialogContentProps) {
  return (
    <DialogPrimitive.Portal>
      <DialogPrimitive.Overlay className="animate-fade fixed inset-0 z-50 bg-black/60 backdrop-blur-[3px]" />
      <DialogPrimitive.Content
        className={cn(
          'animate-enter fixed left-1/2 top-1/2 z-50 max-h-[86vh] w-[calc(100vw-32px)] -translate-x-1/2 -translate-y-1/2 overflow-hidden rounded-xl border border-line-strong bg-surface shadow-float',
          size === 'sm' && 'max-w-[440px]',
          size === 'md' && 'max-w-[560px]',
          size === 'lg' && 'max-w-[760px]',
          className,
        )}
        {...props}
      >
        <div className="flex items-start justify-between gap-6 border-b border-line px-5 py-4">
          <div className="min-w-0">
            <DialogPrimitive.Title className="font-display text-[17px] font-medium leading-6 tracking-[-0.01em] text-fg">
              {title}
            </DialogPrimitive.Title>
            {description ? (
              <DialogPrimitive.Description className="mt-1 text-[12.5px] leading-5 text-muted">
                {description}
              </DialogPrimitive.Description>
            ) : null}
          </div>
          <DialogPrimitive.Close
            className="-mr-1 -mt-1 grid size-8 shrink-0 place-items-center rounded-sm text-muted transition-colors hover:bg-overlay hover:text-fg"
            aria-label="关闭对话框"
          >
            <X size={16} />
          </DialogPrimitive.Close>
        </div>
        <div className="max-h-[calc(86vh-140px)] overflow-y-auto px-5 py-4">{children}</div>
        {footer ? (
          <div className="flex items-center justify-end gap-2 border-t border-line bg-raised/40 px-5 py-3">
            {footer}
          </div>
        ) : null}
      </DialogPrimitive.Content>
    </DialogPrimitive.Portal>
  );
}

export const Tabs = TabsPrimitive.Root;

export function TabsList({
  className,
  ...props
}: ComponentPropsWithoutRef<typeof TabsPrimitive.List>) {
  return (
    <TabsPrimitive.List
      className={cn('flex items-center gap-5 border-b border-line', className)}
      {...props}
    />
  );
}

export function TabsTrigger({
  className,
  ...props
}: ComponentPropsWithoutRef<typeof TabsPrimitive.Trigger>) {
  return (
    <TabsPrimitive.Trigger
      className={cn(
        'relative -mb-px flex h-9 items-center gap-2 border-b-2 border-transparent text-[13px] font-medium text-muted transition-colors hover:text-fg data-[state=active]:border-accent data-[state=active]:text-fg',
        className,
      )}
      {...props}
    />
  );
}

export function TabsContent({
  className,
  ...props
}: ComponentPropsWithoutRef<typeof TabsPrimitive.Content>) {
  return <TabsPrimitive.Content className={cn('mt-4', className)} {...props} />;
}

export function TooltipProvider({ children }: { children: ReactNode }) {
  return (
    <TooltipPrimitive.Provider delayDuration={350} skipDelayDuration={120}>
      {children}
    </TooltipPrimitive.Provider>
  );
}

export function Tooltip({
  label,
  children,
  side = 'top',
  disabled,
}: {
  label: ReactNode;
  children: ReactNode;
  side?: 'top' | 'right' | 'bottom' | 'left';
  disabled?: boolean;
}) {
  if (disabled) return <>{children}</>;
  return (
    <TooltipPrimitive.Root>
      <TooltipPrimitive.Trigger asChild>{children}</TooltipPrimitive.Trigger>
      <TooltipPrimitive.Portal>
        <TooltipPrimitive.Content
          side={side}
          sideOffset={6}
          className="animate-fade z-[60] max-w-[260px] rounded-sm border border-line-strong bg-overlay px-2 py-1 text-[11.5px] leading-4 text-fg shadow-lift"
        >
          {label}
        </TooltipPrimitive.Content>
      </TooltipPrimitive.Portal>
    </TooltipPrimitive.Root>
  );
}

export const DropdownMenu = DropdownPrimitive.Root;
export const DropdownMenuTrigger = DropdownPrimitive.Trigger;

export interface MenuItem {
  key: string;
  label: ReactNode;
  icon?: ReactNode;
  onSelect?: () => void;
  destructive?: boolean;
  separatorBefore?: boolean;
  disabled?: boolean;
}

export function DropdownMenuContent({
  items,
  align = 'end',
  className,
  children,
}: {
  items?: MenuItem[];
  align?: 'start' | 'center' | 'end';
  className?: string;
  children?: ReactNode;
}) {
  return (
    <DropdownPrimitive.Portal>
      <DropdownPrimitive.Content
        align={align}
        sideOffset={6}
        className={cn(
          'animate-fade z-[60] min-w-[210px] overflow-hidden rounded-md border border-line-strong bg-surface p-1 shadow-float',
          className,
        )}
      >
        {children}
        {items?.map((item) => (
          <div key={item.key}>
            {item.separatorBefore ? (
              <DropdownPrimitive.Separator className="my-1 h-px bg-line" />
            ) : null}
            <DropdownPrimitive.Item
              disabled={item.disabled}
              onSelect={item.onSelect}
              className={cn(
                'flex cursor-pointer select-none items-center gap-2.5 rounded-sm px-2.5 py-2 text-[12.5px] outline-none transition-colors data-[disabled]:pointer-events-none data-[disabled]:opacity-40',
                item.destructive
                  ? 'text-danger data-[highlighted]:bg-danger-soft'
                  : 'text-fg data-[highlighted]:bg-overlay',
              )}
            >
              {item.icon ? (
                <span className={cn('text-faint', item.destructive && 'text-danger')}>{item.icon}</span>
              ) : null}
              {item.label}
            </DropdownPrimitive.Item>
          </div>
        ))}
      </DropdownPrimitive.Content>
    </DropdownPrimitive.Portal>
  );
}
