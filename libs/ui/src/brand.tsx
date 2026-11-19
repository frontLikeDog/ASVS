import type { LogoMark } from '@asvs/domain';
import { cn } from './cn';

export function BrandMark({
  mark,
  size = 28,
  className,
  title,
}: {
  mark: LogoMark;
  size?: number;
  className?: string;
  title?: string;
}) {
  const shared = {
    width: size,
    height: size,
    viewBox: '0 0 32 32',
    fill: 'none',
    role: 'img' as const,
    'aria-label': title ?? `${mark} 标志`,
  };
  return (
    <svg {...shared} className={cn('shrink-0', className)}>
      {mark === 'spark' ? (
        <path
          d="M16 3.5c.8 7.1 4.4 10.7 11.5 11.5-7.1.8-10.7 4.4-11.5 11.5-.8-7.1-4.4-10.7-11.5-11.5C11.6 14.2 15.2 10.6 16 3.5Z"
          fill="currentColor"
        />
      ) : null}
      {mark === 'orbit' ? (
        <>
          <circle cx="16" cy="16" r="5.2" fill="currentColor" />
          <ellipse
            cx="16"
            cy="16"
            rx="12.2"
            ry="6.4"
            stroke="currentColor"
            strokeWidth="1.6"
            transform="rotate(-28 16 16)"
            opacity=".55"
          />
        </>
      ) : null}
      {mark === 'grid' ? (
        <>
          <rect x="4" y="4" width="10.5" height="10.5" rx="2.5" fill="currentColor" />
          <rect x="17.5" y="4" width="10.5" height="10.5" rx="2.5" fill="currentColor" opacity=".45" />
          <rect x="4" y="17.5" width="10.5" height="10.5" rx="2.5" fill="currentColor" opacity=".45" />
          <rect x="17.5" y="17.5" width="10.5" height="10.5" rx="2.5" fill="currentColor" />
        </>
      ) : null}
      {mark === 'wave' ? (
        <path
          d="M2.5 18.5c3.6 0 3.6-5 7.2-5s3.6 5 7.2 5 3.6-5 7.2-5 3.6 5 5.4 5"
          stroke="currentColor"
          strokeWidth="2.2"
          strokeLinecap="round"
        />
      ) : null}
    </svg>
  );
}

export function StudioLogo({ className, compact }: { className?: string; compact?: boolean }) {
  return (
    <div className={cn('flex items-center gap-2.5', className)}>
      <span className="relative grid size-7 place-items-center rounded-[7px] bg-accent text-on-accent">
        <svg width="16" height="16" viewBox="0 0 20 20" fill="none" aria-hidden>
          <path d="M4 3.5 16 10 4 16.5V3.5Z" fill="currentColor" />
          <path d="M2 10h4" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
        </svg>
      </span>
      {compact ? null : (
        <span className="font-display text-[13px] font-semibold uppercase tracking-[0.1em] text-fg">
          ASVS
        </span>
      )}
    </div>
  );
}
