import { AbsoluteFill, interpolate, spring, useCurrentFrame, useVideoConfig } from 'remotion';
import { FooterStrip } from '../chrome';
import { FONT_DISPLAY, FONT_MONO, fontForPair } from '../theme';
import { px } from '../units';
import { featureForScene, type SceneProps } from './scene-props';

export function TitleScene({ scene, input, index, theme, u }: SceneProps) {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const feature = featureForScene(input, scene);
  const enter = spring({ frame, fps, config: { damping: 200, mass: 0.9, stiffness: 80 } });
  const titleY = interpolate(enter, [0, 1], [u(2.6), 0]);
  const fade = interpolate(frame, [0, 12], [0, 1], { extrapolateRight: 'clamp' });
  const rule = interpolate(frame, [6, 30], [0, 1], {
    extrapolateLeft: 'clamp',
    extrapolateRight: 'clamp',
  });

  return (
    <AbsoluteFill
      style={{
        padding: `${px(u, 10.5)} ${px(u, 4.6)} ${px(u, 4.4)}`,
        fontFamily: fontForPair(input.project.brand.fontPair),
      }}
    >
      <div style={{ display: 'flex', flex: 1, alignItems: 'center', gap: u(3) }}>
        <div style={{ maxWidth: '74%' }}>
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: u(1.2),
              marginBottom: u(2.2),
              color: theme.accentText,
              fontSize: u(0.95),
              letterSpacing: '0.18em',
              textTransform: 'uppercase',
              fontWeight: 600,
            }}
          >
            <span style={{ width: u(3) * rule, height: 2, background: theme.accent }} />
            <span>{feature?.category ?? '产品影像'} / 2026</span>
          </div>
          <h1
            style={{
              margin: 0,
              fontFamily: FONT_DISPLAY,
              fontWeight: 500,
              fontSize: u(5.7),
              lineHeight: 1.06,
              letterSpacing: '-0.03em',
              color: theme.fg,
              transform: `translateY(${titleY}px)`,
              opacity: fade,
              textWrap: 'balance',
            }}
          >
            {scene.title}
          </h1>
          <p
            style={{
              margin: `${px(u, 2.2)} 0 0`,
              maxWidth: u(56),
              fontSize: u(1.35),
              lineHeight: 1.65,
              color: theme.muted,
            }}
          >
            {feature?.summary ?? scene.intent}
          </p>
        </div>
        <div
          style={{
            marginLeft: 'auto',
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'flex-end',
            gap: u(0.8),
            opacity: 0.92,
          }}
        >
          <span
            style={{
              fontFamily: FONT_DISPLAY,
              fontSize: u(9),
              lineHeight: 1,
              color: theme.accentText,
              fontWeight: 500,
            }}
          >
            {String(index + 1).padStart(2, '0')}
          </span>
          <span
            style={{
              fontFamily: FONT_MONO,
              fontSize: u(0.8),
              letterSpacing: '0.2em',
              color: theme.muted,
              textTransform: 'uppercase',
            }}
          >
            Scene
          </span>
        </div>
      </div>
      <FooterStrip
        left={input.project.productName}
        right={input.project.website || 'demo'}
        theme={theme}
        u={u}
      />
    </AbsoluteFill>
  );
}
