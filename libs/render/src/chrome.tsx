import type { CSSProperties } from 'react';
import type { BrandKit, LogoMark, StoryboardSceneV1 } from '@asvs/domain';
import { withAlpha } from '@asvs/domain';
import type { SceneTheme } from './theme';
import { FONT_MONO, FONT_SANS } from './theme';
import { px } from './units';

export type Unit = (value: number) => number;

export function BrandMark({
  mark,
  size,
  color,
}: {
  mark: LogoMark;
  size: number;
  color: string;
}) {
  const common = { width: size, height: size, viewBox: '0 0 24 24', fill: 'none' } as const;
  switch (mark) {
    case 'orbit':
      return (
        <svg {...common} aria-hidden>
          <circle cx="12" cy="12" r="3.1" fill={color} />
          <ellipse
            cx="12"
            cy="12"
            rx="10"
            ry="4.4"
            stroke={color}
            strokeWidth="1.5"
            transform="rotate(-28 12 12)"
          />
        </svg>
      );
    case 'grid':
      return (
        <svg {...common} aria-hidden>
          {[2, 13].map((x) =>
            [2, 13].map((y) => (
              <rect key={`${x}-${y}`} x={x} y={y} width="9" height="9" rx="1.4" fill={color} />
            )),
          )}
        </svg>
      );
    case 'wave':
      return (
        <svg {...common} aria-hidden>
          <path
            d="M2 15.5c3.2 0 3.2-7 6.4-7s3.2 7 6.4 7 3.2-7 6.4-7"
            stroke={color}
            strokeWidth="2"
            strokeLinecap="round"
          />
        </svg>
      );
    default:
      return (
        <svg {...common} aria-hidden>
          <path
            d="M12 1.6 14.7 9.3 22.4 12l-7.7 2.7L12 22.4l-2.7-7.7L1.6 12l7.7-2.7L12 1.6Z"
            fill={color}
          />
        </svg>
      );
  }
}

export function BrandRow({
  brand,
  u,
  color,
  compact = false,
}: {
  brand: BrandKit;
  u: Unit;
  color?: string;
  compact?: boolean;
}) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: u(0.9), color }}>
      <BrandMark
        mark={brand.logoMark}
        size={u(compact ? 2.2 : 2.8)}
        color={color ?? brand.primary}
      />
      <span
        style={{
          fontFamily: FONT_SANS,
          fontWeight: 650,
          fontSize: u(compact ? 1.1 : 1.4),
          letterSpacing: '0.16em',
          textTransform: 'uppercase',
          lineHeight: 1,
        }}
      >
        {brand.logoText}
      </span>
    </div>
  );
}

export function TopBar({
  brand,
  scene,
  index,
  total,
  theme,
  u,
}: {
  brand: BrandKit;
  scene: StoryboardSceneV1;
  index: number;
  total: number;
  theme: SceneTheme;
  u: Unit;
}) {
  return (
    <div
      style={{
        position: 'absolute',
        top: 0,
        left: 0,
        right: 0,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        padding: `${px(u, 3)} ${px(u, 4.4)}`,
        zIndex: 20,
      }}
    >
      <BrandRow
        brand={brand}
        u={u}
        color={theme.surface === 'paper' || theme.surface === 'brand' ? theme.fg : undefined}
      />
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: u(1.4),
          fontFamily: FONT_MONO,
          fontSize: u(0.78),
          letterSpacing: '0.16em',
          color: theme.muted,
          textTransform: 'uppercase',
        }}
      >
        <span>{scene.templateId.replace('tpl_', '')}</span>
        <span style={{ width: u(2.2), height: 1, background: theme.line }} />
        <span>
          {String(index + 1).padStart(2, '0')} / {String(total).padStart(2, '0')}
        </span>
      </div>
    </div>
  );
}

export function Caption({
  caption,
  u,
  bottomInset = 0,
}: {
  caption: string;
  u: Unit;
  bottomInset?: number;
}) {
  if (!caption.trim()) return null;
  return (
    <div
      style={{
        position: 'absolute',
        left: 0,
        right: 0,
        bottom: bottomInset,
        display: 'flex',
        justifyContent: 'center',
        padding: `${px(u, 4)} ${px(u, 8)} ${px(u, 2.6)}`,
        background: 'linear-gradient(to top, rgba(6,7,9,.78), rgba(6,7,9,0))',
        zIndex: 15,
      }}
    >
      <p
        style={{
          margin: 0,
          maxWidth: '84%',
          textAlign: 'center',
          fontFamily: FONT_SANS,
          fontWeight: 500,
          fontSize: u(1.55),
          lineHeight: 1.5,
          color: '#FFFDF7',
          textShadow: '0 1px 12px rgba(0,0,0,.65)',
        }}
      >
        {caption}
      </p>
    </div>
  );
}

export function Vignette() {
  return (
    <div
      style={{
        position: 'absolute',
        inset: 0,
        pointerEvents: 'none',
        background: 'radial-gradient(120% 90% at 50% 48%, transparent 52%, rgba(0,0,0,.38) 100%)',
        zIndex: 12,
      }}
    />
  );
}

export function MockBadge({
  label,
  detail,
  u,
  tone = 'amber',
}: {
  label: string;
  detail?: string;
  u: Unit;
  tone?: 'amber' | 'red' | 'green';
}) {
  const color = tone === 'red' ? '#FF8A7A' : tone === 'green' ? '#6FD3A0' : '#F0B860';
  return (
    <div
      style={{
        position: 'absolute',
        top: u(8.6),
        left: '50%',
        transform: 'translateX(-50%)',
        zIndex: 25,
        display: 'flex',
        alignItems: 'center',
        gap: u(0.8),
        padding: `${px(u, 0.65)} ${px(u, 1.2)}`,
        border: `1px solid ${withAlpha(color, 0.5)}`,
        background: withAlpha('#0B0D11', 0.82),
        borderRadius: u(0.3),
        color,
        fontFamily: FONT_SANS,
        fontSize: u(0.82),
        fontWeight: 600,
        letterSpacing: '0.04em',
        whiteSpace: 'nowrap',
      }}
    >
      <span
        style={{
          width: u(0.6),
          height: u(0.6),
          borderRadius: 999,
          background: color,
          display: 'inline-block',
        }}
      />
      <span>{label}</span>
      {detail ? (
        <span style={{ color: 'rgba(255,255,255,.5)', fontWeight: 400 }}>· {detail}</span>
      ) : null}
    </div>
  );
}

export function FooterStrip({
  left,
  right,
  theme,
  u,
  style,
}: {
  left: string;
  right: string;
  theme: SceneTheme;
  u: Unit;
  style?: CSSProperties;
}) {
  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        borderTop: `1px solid ${theme.line}`,
        paddingTop: u(1.2),
        fontFamily: FONT_MONO,
        fontSize: u(0.82),
        letterSpacing: '0.08em',
        color: theme.muted,
        textTransform: 'uppercase',
        ...style,
      }}
    >
      <span>{left}</span>
      <span>{right}</span>
    </div>
  );
}
