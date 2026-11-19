import {
  cloneElement,
  forwardRef,
  isValidElement,
  useId,
  type InputHTMLAttributes,
  type ReactElement,
  type ReactNode,
  type SelectHTMLAttributes,
  type TextareaHTMLAttributes,
} from 'react';
import * as SwitchPrimitive from '@radix-ui/react-switch';
import * as CheckboxPrimitive from '@radix-ui/react-checkbox';
import * as SliderPrimitive from '@radix-ui/react-slider';
import { Check, ChevronDown, Minus } from 'lucide-react';
import { cn } from './cn';

export interface FieldProps {
  label?: ReactNode;
  hint?: ReactNode;
  error?: ReactNode;
  htmlFor?: string;
  required?: boolean;
  optional?: boolean;
  children: ReactNode;
  className?: string;
  labelClassName?: string;
}

export function Field({
  label,
  hint,
  error,
  htmlFor,
  required,
  optional,
  children,
  className,
  labelClassName,
}: FieldProps) {
  // Associate the visible label with a direct input/textarea/select child when
  // no explicit htmlFor is given. This keeps screen readers attached without
  // every call site remembering to wire id + htmlFor by hand.
  const generatedId = useId();
  const child = isValidElement(children)
    ? (children as ReactElement<{ id?: string }>)
    : undefined;
  const labelable = child
    ? ([Input, Textarea, Select, 'input', 'textarea', 'select'] as unknown[]).includes(child.type)
    : false;
  const controlId = htmlFor ?? (labelable ? (child?.props.id ?? generatedId) : undefined);
  const control =
    labelable && !child?.props.id ? cloneElement(child!, { id: generatedId }) : children;

  return (
    <div className={cn('space-y-1.5', className)}>
      {label ? (
        <label
          htmlFor={controlId}
          className={cn('flex items-baseline gap-1.5 text-[12.5px] font-medium text-fg', labelClassName)}
        >
          {label}
          {required ? <span className="text-[11px] font-normal text-faint">必填</span> : null}
          {optional ? <span className="text-[11px] font-normal text-faint">可选</span> : null}
        </label>
      ) : null}
      {control}
      {error ? (
        <p role="alert" className="flex items-start gap-1.5 text-[12px] leading-4 text-danger">
          <span className="mt-[5px] size-1 shrink-0 rounded-full bg-danger" aria-hidden />
          {error}
        </p>
      ) : hint ? (
        <p className="text-[12px] leading-4 text-muted">{hint}</p>
      ) : null}
    </div>
  );
}

const controlBase =
  'w-full rounded-sm border bg-raised/60 text-[13px] text-fg placeholder:text-faint transition-colors duration-150 hover:border-line-strong focus:border-accent/60 focus:outline-none focus:ring-2 focus:ring-accent/25 disabled:cursor-not-allowed disabled:opacity-50';

export const Input = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement>>(
  function Input({ className, ...props }, ref) {
    return (
      <input
        ref={ref}
        className={cn(controlBase, 'h-9 border-line px-3', className)}
        {...props}
      />
    );
  },
);

export const Textarea = forwardRef<HTMLTextAreaElement, TextareaHTMLAttributes<HTMLTextAreaElement>>(
  function Textarea({ className, ...props }, ref) {
    return (
      <textarea
        ref={ref}
        className={cn(controlBase, 'min-h-[88px] resize-y border-line px-3 py-2 leading-[20px]', className)}
        {...props}
      />
    );
  },
);

export interface SelectProps extends SelectHTMLAttributes<HTMLSelectElement> {
  wrapperClassName?: string;
}

export const Select = forwardRef<HTMLSelectElement, SelectProps>(function Select(
  { className, wrapperClassName, children, ...props },
  ref,
) {
  return (
    <div className={cn('relative', wrapperClassName)}>
      <select
        ref={ref}
        className={cn(controlBase, 'h-9 appearance-none border-line pl-3 pr-8', className)}
        {...props}
      >
        {children}
      </select>
      <ChevronDown
        size={14}
        className="pointer-events-none absolute right-2.5 top-1/2 -translate-y-1/2 text-faint"
        aria-hidden
      />
    </div>
  );
});

export interface SwitchProps {
  checked: boolean;
  onCheckedChange: (checked: boolean) => void;
  id?: string;
  disabled?: boolean;
  label?: string;
}

export function Switch({ checked, onCheckedChange, id, disabled, label }: SwitchProps) {
  return (
    <SwitchPrimitive.Root
      id={id}
      checked={checked}
      onCheckedChange={onCheckedChange}
      disabled={disabled}
      aria-label={label}
      className={cn(
        'relative inline-flex h-[22px] w-[38px] shrink-0 cursor-pointer items-center rounded-full border transition-colors duration-150',
        checked ? 'border-accent/50 bg-accent' : 'border-line-strong bg-overlay',
        disabled && 'cursor-not-allowed opacity-40',
      )}
    >
      <SwitchPrimitive.Thumb
        className={cn(
          'block size-[16px] rounded-full shadow-sm transition-transform duration-150',
          checked ? 'translate-x-[18px] bg-on-accent' : 'translate-x-[3px] bg-faint',
        )}
      />
    </SwitchPrimitive.Root>
  );
}

export interface CheckboxProps {
  checked: boolean;
  onCheckedChange: (checked: boolean) => void;
  id?: string;
  disabled?: boolean;
  label?: string;
}

export function Checkbox({ checked, onCheckedChange, id, disabled, label }: CheckboxProps) {
  return (
    <CheckboxPrimitive.Root
      id={id}
      checked={checked}
      onCheckedChange={(value) => onCheckedChange(value === true)}
      disabled={disabled}
      aria-label={label}
      className={cn(
        'flex size-[18px] shrink-0 items-center justify-center rounded-[5px] border transition-colors',
        checked
          ? 'border-accent bg-accent text-on-accent'
          : 'border-line-strong bg-raised hover:border-faint',
        disabled && 'cursor-not-allowed opacity-40',
      )}
    >
      <CheckboxPrimitive.Indicator>
        <Check size={12} strokeWidth={3} aria-hidden />
      </CheckboxPrimitive.Indicator>
    </CheckboxPrimitive.Root>
  );
}

export interface SliderProps {
  value: number;
  onValueChange: (value: number) => void;
  min?: number;
  max?: number;
  step?: number;
  disabled?: boolean;
  label: string;
  className?: string;
  formatValue?: (value: number) => string;
}

export function Slider({
  value,
  onValueChange,
  min = 0,
  max = 100,
  step = 1,
  disabled,
  label,
  className,
  formatValue,
}: SliderProps) {
  return (
    <div className={cn('space-y-2', className)}>
      <div className="flex items-center justify-between text-[12px]">
        <span className="text-muted">{label}</span>
        <span className="font-mono tabular text-fg">{formatValue ? formatValue(value) : value}</span>
      </div>
      <SliderPrimitive.Root
        value={[value]}
        min={min}
        max={max}
        step={step}
        disabled={disabled}
        onValueChange={(values) => onValueChange(values[0] ?? value)}
        aria-label={label}
        className={cn('relative flex h-4 w-full touch-none select-none items-center', disabled && 'opacity-40')}
      >
        <SliderPrimitive.Track className="relative h-[3px] w-full grow overflow-hidden rounded-full bg-line-strong">
          <SliderPrimitive.Range className="absolute h-full bg-accent" />
        </SliderPrimitive.Track>
        <SliderPrimitive.Thumb
          aria-label={label}
          aria-valuetext={formatValue ? formatValue(value) : String(value)}
          className="block size-3.5 rounded-full border-2 border-ink bg-accent shadow-[0_0_0_1px_var(--accent)] transition-transform hover:scale-110 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
        />
      </SliderPrimitive.Root>
    </div>
  );
}

export function RadioCard({
  selected,
  onSelect,
  title,
  description,
  icon,
  meta,
  disabled,
  className,
}: {
  selected: boolean;
  onSelect: () => void;
  title: ReactNode;
  description?: ReactNode;
  icon?: ReactNode;
  meta?: ReactNode;
  disabled?: boolean;
  className?: string;
}) {
  return (
    <button
      type="button"
      role="radio"
      aria-checked={selected}
      disabled={disabled}
      onClick={onSelect}
      className={cn(
        'group relative w-full rounded-md border p-3.5 text-left transition-colors duration-150 disabled:cursor-not-allowed disabled:opacity-45',
        selected
          ? 'border-accent/60 bg-accent-soft'
          : 'border-line bg-raised/40 hover:border-line-strong hover:bg-raised',
        className,
      )}
    >
      <div className="flex items-start gap-3">
        {icon ? (
          <span
            className={cn(
              'mt-0.5 grid size-8 shrink-0 place-items-center rounded-sm border',
              selected ? 'border-accent/30 bg-accent-soft text-accent' : 'border-line bg-overlay text-muted',
            )}
          >
            {icon}
          </span>
        ) : null}
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="text-[13px] font-medium text-fg">{title}</span>
            {meta}
          </div>
          {description ? <p className="mt-1 text-[12px] leading-[18px] text-muted">{description}</p> : null}
        </div>
        <span
          className={cn(
            'mt-1 grid size-4 shrink-0 place-items-center rounded-full border',
            selected ? 'border-accent bg-accent text-on-accent' : 'border-line-strong',
          )}
          aria-hidden
        >
          {selected ? <Check size={10} strokeWidth={3} /> : <Minus size={8} className="opacity-0" />}
        </span>
      </div>
    </button>
  );
}
