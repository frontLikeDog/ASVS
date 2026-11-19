import { AbsoluteFill, interpolate, spring, useCurrentFrame, useVideoConfig } from 'remotion';
import { withAlpha } from '@asvs/domain';
import type { StoryboardSceneV1 } from '@asvs/domain';
import { FooterStrip } from '../chrome';
import { FONT_DISPLAY, FONT_MONO, fontForPair } from '../theme';
import { px } from '../units';
import { featureForScene, type SceneProps } from './scene-props';

interface MotionCard {
  label: string;
  value: string;
}

const DEFAULT_CARDS: MotionCard[] = [
  { label: '数据卡', value: '48,210' },
  { label: '断开的连接', value: '— —' },
  { label: '待确认', value: '3 项' },
];

function cardsForScene(scene: StoryboardSceneV1): MotionCard[] {
  if (scene.visual.type !== 'motion_graphics') return DEFAULT_CARDS;
  const raw = scene.visual.props.cards;
  if (!Array.isArray(raw)) return DEFAULT_CARDS;
  const cards = raw.flatMap((item): MotionCard[] => {
    if (!item || typeof item !== 'object') return [];
    const record = item as Record<string, unknown>;
    if (typeof record.label !== 'string' || typeof record.value !== 'string') return [];
    return [{ label: record.label, value: record.value }];
  });
  return cards.length > 0 ? cards : DEFAULT_CARDS;
}

const CARD_POSITIONS = [
  { top: '2%', left: '2%', rotate: '-6deg' },
  { top: '34%', left: '28%', rotate: '3deg' },
  { top: '66%', left: '6%', rotate: '-2deg' },
];

export function MotionScene({ scene, input, theme, u }: SceneProps) {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const feature = featureForScene(input, scene);
  const cards = cardsForScene(scene);
  const fade = interpolate(frame, [0, 14], [0, 1], { extrapolateRight: 'clamp' });
  const titleY = interpolate(frame, [0, 24], [u(2.2), 0], { extrapolateRight: 'clamp' });
  const glow = interpolate(frame, [0, 90], [0, 1], { extrapolateRight: 'clamp' });

  return (
    <AbsoluteFill
      style={{
        padding: `${px(u, 10.5)} ${px(u, 4.4)} ${px(u, 4.4)}`,
        fontFamily: fontForPair(input.project.brand.fontPair),
        overflow: 'hidden',
      }}
    >
      <div
        style={{
          position: 'absolute',
          inset: 0,
          backgroundImage: `radial-gradient(${withAlpha(theme.fg, 0.2)} 1px, transparent 1px)`,
          backgroundSize: `${px(u, 2.2)} ${px(u, 2.2)}`,
          opacity: 0.22,
        }}
      />
      <div
        style={{
          position: 'absolute',
          width: u(46),
          height: u(46),
          right: u(-14),
          top: u(-16),
          borderRadius: '50%',
          background: `radial-gradient(circle at 40% 40%, ${withAlpha(input.project.brand.primary, 0.55)}, transparent 66%)`,
          filter: `blur(${px(u, 0.5)})`,
          opacity: 0.45 + glow * 0.25,
        }}
      />

      <div
        style={{
          position: 'relative',
          display: 'grid',
          gridTemplateColumns: '1.15fr .85fr',
          alignItems: 'center',
          flex: 1,
          gap: u(2),
        }}
      >
        <div style={{ transform: `translateY(${titleY}px)`, opacity: fade }}>
          <div
            style={{
              color: theme.accentText,
              fontSize: u(0.9),
              letterSpacing: '0.2em',
              textTransform: 'uppercase',
              fontWeight: 600,
              marginBottom: u(1.6),
            }}
          >
            {feature?.name ?? scene.intent}
          </div>
          <h1
            style={{
              margin: 0,
              fontFamily: FONT_DISPLAY,
              fontSize: u(4.5),
              lineHeight: 1.12,
              letterSpacing: '-0.03em',
              fontWeight: 500,
              color: theme.fg,
              textWrap: 'balance',
            }}
          >
            {scene.title}
          </h1>
          <p
            style={{
              margin: `${px(u, 1.6)} 0 0`,
              maxWidth: '90%',
              fontSize: u(1.15),
              lineHeight: 1.65,
              color: theme.muted,
            }}
          >
            {scene.narration || scene.intent}
          </p>
        </div>

        <div style={{ position: 'relative', height: u(32) }}>
          {cards.map((card, cardIndex) => {
            const position = CARD_POSITIONS[cardIndex % CARD_POSITIONS.length]!;
            const enter = spring({
              frame: frame - 10 - cardIndex * 7,
              fps,
              config: { damping: 18, stiffness: 120, mass: 0.8 },
            });
            const drift = Math.sin((frame + cardIndex * 20) / 34) * u(0.35);
            const offsetY = (1 - enter) * u(2.4) + drift;
            return (
              <div
                key={`${card.label}-${cardIndex}`}
                style={{
                  position: 'absolute',
                  top: position.top,
                  left: position.left,
                  width: '72%',
                  transform: `translateY(${offsetY}px) rotate(${position.rotate})`,
                  opacity: enter,
                  background:
                    theme.surface === 'paper'
                      ? 'rgba(255,255,255,.66)'
                      : 'rgba(255,255,255,.055)',
                  border: `1px solid ${theme.line}`,
                  borderRadius: u(0.35),
                  padding: u(0.9),
                  backdropFilter: 'blur(6px)',
                  boxShadow:
                    theme.surface === 'paper'
                      ? '0 10px 30px rgba(26,25,21,.10)'
                      : '0 12px 34px rgba(0,0,0,.28)',
                }}
              >
                <div style={{ fontSize: u(0.58), color: theme.muted }}>{card.label}</div>
                <div
                  style={{
                    marginTop: u(0.25),
                    fontFamily: FONT_MONO,
                    fontSize: u(1.05),
                    color: theme.fg,
                  }}
                >
                  {card.value}
                </div>
              </div>
            );
          })}
        </div>
      </div>

      <FooterStrip
        left={input.project.productName}
        right="示意数据 · 不代表产品实际指标"
        theme={theme}
        u={u}
      />
    </AbsoluteFill>
  );
}
