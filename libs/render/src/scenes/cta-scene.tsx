import { AbsoluteFill, interpolate, spring, useCurrentFrame, useVideoConfig } from 'remotion';
import { withAlpha } from '@asvs/domain';
import { FooterStrip } from '../chrome';
import { FONT_DISPLAY, FONT_MONO, fontForPair } from '../theme';
import { px } from '../units';
import type { SceneProps } from './scene-props';

export function CtaScene({ scene, input, theme, u }: SceneProps) {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const brand = input.project.brand;
  const enter = spring({ frame, fps, config: { damping: 20, stiffness: 110, mass: 0.8 } });
  const pillScale = interpolate(enter, [0, 1], [0.86, 1]);
  const fade = interpolate(frame, [0, 14], [0, 1], { extrapolateRight: 'clamp' });
  const titleY = interpolate(frame, [0, 26], [u(2.2), 0], { extrapolateRight: 'clamp' });
  const cta = brand.outro || '访问产品官网';

  return (
    <AbsoluteFill
      style={{
        padding: `${px(u, 10.5)} ${px(u, 5)} ${px(u, 4.6)}`,
        fontFamily: fontForPair(brand.fontPair),
        overflow: 'hidden',
      }}
    >
      <div
        style={{
          position: 'absolute',
          width: u(52),
          height: u(52),
          right: u(-14),
          bottom: u(-18),
          borderRadius: '50%',
          border: `1px solid ${withAlpha(theme.fg, 0.24)}`,
          background: `radial-gradient(circle at 35% 35%, ${withAlpha(theme.fg, 0.16)}, transparent 62%)`,
          opacity: 0.9,
        }}
      />
      <div
        style={{
          position: 'absolute',
          top: u(9.6),
          right: u(4.8),
          fontFamily: FONT_MONO,
          fontSize: u(0.8),
          letterSpacing: '0.2em',
          color: withAlpha(theme.fg, 0.62),
        }}
      >
        END CARD
      </div>

      <div
        style={{
          position: 'relative',
          display: 'flex',
          flex: 1,
          flexDirection: 'column',
          justifyContent: 'center',
          maxWidth: '76%',
        }}
      >
        <div
          style={{
            marginBottom: u(1.6),
            fontFamily: FONT_MONO,
            fontSize: u(0.95),
            letterSpacing: '0.2em',
            textTransform: 'uppercase',
            color: withAlpha(theme.fg, 0.68),
            opacity: fade,
          }}
        >
          {brand.intro || input.project.productName}
        </div>
        <h1
          style={{
            margin: 0,
            fontFamily: FONT_DISPLAY,
            fontSize: u(5.3),
            lineHeight: 1.08,
            letterSpacing: '-0.03em',
            fontWeight: 500,
            color: theme.fg,
            transform: `translateY(${titleY}px)`,
            opacity: fade,
            textWrap: 'balance',
          }}
        >
          {scene.title}
        </h1>
        <div
          style={{
            marginTop: u(3),
            display: 'inline-flex',
            alignItems: 'center',
            alignSelf: 'flex-start',
            gap: u(0.8),
            padding: `${px(u, 0.9)} ${px(u, 1.8)}`,
            borderRadius: u(0.25),
            background: theme.fg,
            color: brand.primary,
            fontFamily: FONT_DISPLAY,
            fontSize: u(1.2),
            fontWeight: 650,
            transform: `scale(${pillScale})`,
            transformOrigin: 'left center',
          }}
        >
          {cta}
          <span aria-hidden>↗</span>
        </div>
      </div>

      <FooterStrip
        left={brand.outro || input.project.productName}
        right={input.project.website || 'demo'}
        theme={theme}
        u={u}
      />
    </AbsoluteFill>
  );
}
