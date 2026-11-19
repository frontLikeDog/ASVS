import type { ReactNode } from 'react';
import { cn } from './cn';

export interface SegmentedOption<T extends string> {
  value: T;
  label: ReactNode;
  icon?: ReactNode;
  disabled?: boolean;
  title?: string;
}

export function SegmentedControl<T extends string>({
  value,
  onChange,
  options,
  size = 'md',
  className,
  ariaLabel,
}: {
  value: T;
  onChange: (value: T) => void;
  options: SegmentedOption<T>[];
  size?: 'sm' | 'md';
  className?: string;
  ariaLabel?: string;
}) {
  return (
    <div
      role="radiogroup"
      aria-label={ariaLabel}
      className={cn(
        'inline-flex items-center gap-0.5 rounded-md border border-line bg-ink/40 p-0.5',
        className,
      )}
    >
      {options.map((option) => {
        const active = option.value === value;
        return (
          <button
            key={option.value}
            type="button"
            role="radio"
            aria-checked={active}
            title={option.title}
            disabled={option.disabled}
            onClick={() => onChange(option.value)}
            className={cn(
              'inline-flex items-center justify-center gap-1.5 rounded-[7px] font-medium transition-colors duration-150 disabled:cursor-not-allowed disabled:opacity-40',
              size === 'sm' ? 'h-6 px-2 text-[11.5px]' : 'h-7 px-2.5 text-[12px]',
              active
                ? 'bg-overlay text-fg shadow-[0_1px_0_rgba(255,255,255,.06)_inset]'
                : 'text-muted hover:text-fg',
            )}
          >
            {option.icon ? <span className="[&_svg]:size-3.5">{option.icon}</span> : null}
            {option.label}
          </button>
        );
      })}
    </div>
  );
}
