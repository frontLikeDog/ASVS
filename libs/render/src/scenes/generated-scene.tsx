import { AbsoluteFill, interpolate, useCurrentFrame } from 'remotion';
import { withAlpha } from '@asvs/domain';
import { FooterStrip } from '../chrome';
import { FONT_DISPLAY, FONT_MONO, fontForPair } from '../theme';
import { px } from '../units';
import { featureForScene, type SceneProps } from './scene-props';

export function GeneratedScene({ scene, input, theme, u }: SceneProps) {
  const frame = useCurrentFrame();
  const brand = input.project.brand;
  const feature = featureForScene(input, scene);
  const drift = Math.sin(frame / 44) * u(2.2);
  const driftB = Math.cos(frame / 52) * u(1.8);
  const fade = interpolate(frame, [0, 16], [0, 1], { extrapolateRight: 'clamp' });

  return (
    <AbsoluteFill
      style={{
        background: `
          radial-gradient(48% 52% at ${22 + drift / 10}% 30%, ${withAlpha(brand.primary, 0.72)}, transparent 70%),
          radial-gradient(44% 60% at ${82 + driftB / 10}% 74%, ${withAlpha(brand.secondary, 0.66)}, transparent 68%),
          radial-gradient(40% 40% at 62% 18%, rgba(110,72,220,.42), transparent 72%),
          #0A0B0F
        `,
        padding: `${px(u, 10.5)} ${px(u, 4.6)} ${px(u, 4.4)}`,
        fontFamily: fontForPair(brand.fontPair),
        overflow: 'hidden',
      }}
    >
      <div
        style={{
          position: 'absolute',
          inset: 0,
          background: 'linear-gradient(180deg, rgba(0,0,0,.18), rgba(0,0,0,.58))',
        }}
      />
      <div
        style={{
          position: 'relative',
          display: 'flex',
          flex: 1,
          flexDirection: 'column',
          justifyContent: 'center',
          maxWidth: '76%',
          opacity: fade,
        }}
      >
        <div
          style={{
            fontFamily: FONT_MONO,
            fontSize: u(0.8),
            letterSpacing: '0.2em',
            textTransform: 'uppercase',
            color: 'rgba(255,255,255,.55)',
          }}
        >
          GENERATED VISUAL · 模拟素材
        </div>
        <h1
          style={{
            margin: `${px(u, 1.4)} 0 0`,
            fontFamily: FONT_DISPLAY,
            fontSize: u(5),
            lineHeight: 1.1,
            letterSpacing: '-0.03em',
            fontWeight: 500,
            color: '#FFFDF7',
            textWrap: 'balance',
          }}
        >
          {scene.title}
        </h1>
        <p
          style={{
            margin: `${px(u, 1.6)} 0 0`,
            maxWidth: '82%',
            fontSize: u(1.15),
            lineHeight: 1.65,
            color: 'rgba(255,255,255,.62)',
          }}
        >
          {feature?.summary ?? (scene.narration || scene.intent)}
        </p>
      </div>

      <FooterStrip
        left="生成画面仅作氛围，不证明任何产品能力"
        right={brand.logoText}
        theme={theme}
        u={u}
        style={{ color: 'rgba(255,255,255,.42)', borderColor: 'rgba(255,255,255,.14)' }}
      />
    </AbsoluteFill>
  );
}
