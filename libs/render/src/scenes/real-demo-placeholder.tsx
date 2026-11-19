import { AbsoluteFill, interpolate, useCurrentFrame } from 'remotion';
import { withAlpha } from '@asvs/domain';
import { FooterStrip } from '../chrome';
import { FONT_DISPLAY, FONT_MONO, FONT_SANS } from '../theme';
import { px } from '../units';
import type { SceneProps } from './scene-props';

const SKELETON_ROWS = [
  { width: '34%', height: '7%' },
  { width: '68%', height: '4%' },
  { width: '58%', height: '4%' },
  { width: '76%', height: '4%' },
];

/**
 * Step 1 has no real capture yet. This scene is intentionally impossible to
 * mistake for a product recording: wireframe blocks, hazard stripes and an
 * explicit "未接入真实录屏" panel. docs/01 §5 (真实优先) forbids anything else.
 */
export function RealDemoPlaceholder({ scene, input, theme, u }: SceneProps) {
  const frame = useCurrentFrame();
  const asset = scene.assetIds
    .map((id) => input.assets.find((item) => item.id === id))
    .find(Boolean);
  const pulse = interpolate(frame, [0, 60, 120], [0.45, 0.9, 0.45], {
    extrapolateRight: 'extend',
  });

  return (
    <AbsoluteFill
      style={{
        background: '#0E1116',
        padding: `${px(u, 9.8)} ${px(u, 4.4)} ${px(u, 4.2)}`,
        fontFamily: FONT_SANS,
        overflow: 'hidden',
      }}
    >
      <div
        style={{
          position: 'absolute',
          inset: 0,
          backgroundImage: `repeating-linear-gradient(135deg, ${withAlpha('#F0B860', 0.07)} 0 10px, transparent 10px 26px)`,
        }}
      />
      <div
        style={{
          position: 'absolute',
          inset: 0,
          display: 'grid',
          placeItems: 'center',
          fontFamily: FONT_DISPLAY,
          fontSize: u(26),
          fontWeight: 700,
          letterSpacing: '0.18em',
          color: 'rgba(255,255,255,.035)',
          transform: 'rotate(-18deg)',
          pointerEvents: 'none',
        }}
      >
        MOCK
      </div>

      <div
        style={{
          position: 'relative',
          flex: 1,
          borderRadius: u(0.6),
          border: `1px solid rgba(255,255,255,.14)`,
          background: 'rgba(9,11,15,.72)',
          overflow: 'hidden',
          display: 'flex',
          flexDirection: 'column',
        }}
      >
        <div
          style={{
            height: u(3.4),
            display: 'flex',
            alignItems: 'center',
            gap: u(0.8),
            paddingInline: u(1.2),
            borderBottom: '1px solid rgba(255,255,255,.1)',
            background: 'rgba(15,17,22,.9)',
          }}
        >
          <span style={{ display: 'flex', gap: u(0.45) }}>
            {['#FF6B5E', '#F5BF4F', '#62C554'].map((color) => (
              <span
                key={color}
                style={{
                  width: u(0.62),
                  height: u(0.62),
                  borderRadius: 999,
                  background: color,
                  opacity: 0.55,
                }}
              />
            ))}
          </span>
          <div
            style={{
              flex: 1,
              height: u(1.9),
              display: 'grid',
              placeItems: 'center',
              borderRadius: u(0.2),
              background: 'rgba(255,255,255,.05)',
              color: 'rgba(255,255,255,.4)',
              fontFamily: FONT_MONO,
              fontSize: u(0.68),
            }}
          >
            demo-plan-pending.invalid · 尚未录制
          </div>
          <span
            style={{
              padding: `${px(u, 0.2)} ${px(u, 0.5)}`,
              border: '1px solid rgba(240,184,96,.4)',
              borderRadius: u(0.15),
              color: '#F0B860',
              fontFamily: FONT_MONO,
              fontSize: u(0.58),
              letterSpacing: '0.08em',
            }}
          >
            PLACEHOLDER
          </span>
        </div>

        <div style={{ position: 'relative', flex: 1, padding: u(2.4) }}>
          <div style={{ display: 'flex', gap: u(1.2), opacity: 0.55 }}>
            <div
              style={{
                width: u(12),
                height: u(18),
                border: '1px solid rgba(255,255,255,.12)',
                borderRadius: u(0.3),
                background: 'rgba(255,255,255,.025)',
              }}
            />
            <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: u(1) }}>
              {SKELETON_ROWS.map((row, index) => (
                <div
                  key={index}
                  style={{
                    width: row.width,
                    height: u(0.8),
                    borderRadius: u(0.15),
                    background: 'rgba(255,255,255,.09)',
                  }}
                />
              ))}
              <div
                style={{
                  marginTop: u(0.8),
                  height: u(9),
                  border: '1px dashed rgba(255,255,255,.14)',
                  borderRadius: u(0.25),
                }}
              />
            </div>
          </div>

          <div
            style={{
              position: 'absolute',
              left: '50%',
              top: '50%',
              transform: 'translate(-50%, -50%)',
              width: '64%',
              padding: `${px(u, 2.2)} ${px(u, 2.6)}`,
              border: `2px dashed rgba(240,184,96,${pulse})`,
              borderRadius: u(0.45),
              background: 'rgba(9,11,15,.92)',
              boxShadow: '0 24px 70px rgba(0,0,0,.55)',
              textAlign: 'center',
            }}
          >
            <div
              style={{
                fontFamily: FONT_MONO,
                fontSize: u(0.72),
                letterSpacing: '0.18em',
                color: '#F0B860',
                marginBottom: u(0.9),
              }}
            >
              REAL_DEMO / PLACEHOLDER
            </div>
            <div
              style={{
                fontFamily: FONT_DISPLAY,
                fontSize: u(2.6),
                fontWeight: 600,
                color: '#F4F2EC',
                lineHeight: 1.2,
              }}
            >
              未接入真实录屏
            </div>
            <div
              style={{
                marginTop: u(1),
                fontSize: u(0.9),
                lineHeight: 1.65,
                color: 'rgba(244,242,236,.62)',
              }}
            >
              {asset?.name ?? '等待 Step 2 录制'} · {asset?.description ?? '真实录屏将在 Step 2 接入'}
            </div>
            <div
              style={{
                marginTop: u(1.2),
                fontFamily: FONT_MONO,
                fontSize: u(0.68),
                color: 'rgba(244,242,236,.38)',
                letterSpacing: '0.06em',
              }}
            >
              此画面为明确标注的占位，不会冒充真实产品录屏
            </div>
          </div>
        </div>
      </div>

      <FooterStrip
        left={`ASSET ${asset?.id ?? 'none'} · ${asset?.mock ? 'MOCK' : 'MISSING'}`}
        right="STEP 2 · PLAYWRIGHT CAPTURE"
        theme={theme}
        u={u}
        style={{ color: 'rgba(244,242,236,.42)', borderColor: 'rgba(255,255,255,.12)' }}
      />
    </AbsoluteFill>
  );
}
