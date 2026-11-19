import { forwardRef, type ButtonHTMLAttributes, type ReactNode } from 'react';
import { Loader2 } from 'lucide-react';
import { cn } from './cn';

export type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger' | 'link' | 'ai';
export type ButtonSize = 'sm' | 'md' | 'lg' | 'icon' | 'icon-sm';

const VARIANTS: Record<ButtonVariant, string> = {
  primary:
    'bg-accent text-on-accent border border-transparent hover:brightness-105 active:brightness-95 shadow-[0_1px_0_rgba(255,255,255,.18)_inset]',
  secondary:
    'bg-raised text-fg border border-line hover:border-line-strong hover:bg-overlay active:bg-raised',
  ghost:
    'bg-transparent text-muted border border-transparent hover:text-fg hover:bg-overlay active:bg-raised',
  danger:
    'bg-danger-soft text-danger border border-danger/30 hover:bg-danger/15 hover:border-danger/50',
  link: 'bg-transparent text-fg border border-transparent underline-offset-4 hover:text-accent hover:underline px-0',
  ai: 'bg-ai-soft text-ai border border-ai/30 hover:bg-ai/15 hover:border-ai/50',
};

const SIZES: Record<ButtonSize, string> = {
  sm: 'h-8 px-3 text-[13px] gap-1.5 rounded-sm',
  md: 'h-[34px] px-3.5 text-[13px] gap-2 rounded-md',
  lg: 'h-10 px-5 text-sm gap-2 rounded-md',
  icon: 'h-[34px] w-[34px] rounded-md',
  'icon-sm': 'h-8 w-8 rounded-sm',
};

export interface ButtonStyleOptions {
  variant?: ButtonVariant;
  size?: ButtonSize;
  className?: string;
}

export function buttonStyles({ variant = 'secondary', size = 'md', className }: ButtonStyleOptions = {}) {
  return cn(
    'inline-flex select-none items-center justify-center whitespace-nowrap font-medium transition-[background-color,border-color,color,filter,opacity] duration-150 disabled:pointer-events-none disabled:opacity-40',
    VARIANTS[variant],
    SIZES[size],
    className,
  );
}

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  loading?: boolean;
  icon?: ReactNode;
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { className, variant = 'secondary', size = 'md', loading = false, icon, children, disabled, type = 'button', ...props },
  ref,
) {
  return (
    <button
      ref={ref}
      type={type}
      className={buttonStyles({ variant, size, className })}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      {...props}
    >
      {loading ? <Loader2 size={15} className="animate-spin" aria-hidden /> : icon}
      {children}
    </button>
  );
});

export interface IconButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  label: string;
  variant?: ButtonVariant;
  size?: 'sm' | 'md';
  children: ReactNode;
}

export const IconButton = forwardRef<HTMLButtonElement, IconButtonProps>(function IconButton(
  { label, variant = 'ghost', size = 'md', className, children, type = 'button', ...props },
  ref,
) {
  return (
    <button
      ref={ref}
      type={type}
      aria-label={label}
      title={label}
      className={buttonStyles({
        variant,
        size: size === 'sm' ? 'icon-sm' : 'icon',
        className,
      })}
      {...props}
    >
      {children}
    </button>
  );
});
