import {
  AbsoluteFill,
  OffthreadVideo,
  interpolate,
  staticFile,
  useCurrentFrame,
} from 'remotion';
import { findRealCaptureAsset, withAlpha } from '@asvs/domain';
import { FooterStrip } from '../chrome';
import { FONT_MONO, FONT_SANS } from '../theme';
import { px } from '../units';
import { RealDemoPlaceholder } from './real-demo-placeholder';
import type { SceneProps } from './scene-props';

/**
 * Plays the real Playwright recording produced by workers/browser-worker.
 * The recording is not decorative: the scene only takes this path when the
 * Asset is `mock: false`, carries media metadata, and the render worker has
 * verified the file hash before bundling it.
 */
export function RealDemoScene(props: SceneProps) {
  const { scene, input, theme, u } = props;
  const asset = findRealCaptureAsset(scene, input.assets);
  const frame = useCurrentFrame();

  if (!asset?.media) {
    return <RealDemoPlaceholder {...props} />;
  }

  const zoom = interpolate(frame, [0, Math.max(1, scene.durationFrames)], [1, 1.015], {
    extrapolateRight: 'clamp',
  });
  const plan = asset.media.capturePlanId;

  return (
    <AbsoluteFill
      style={{
        background: '#0B0D11',
        padding: `${px(u, 9.8)} ${px(u, 4.4)} ${px(u, 4.2)}`,
        fontFamily: FONT_SANS,
        overflow: 'hidden',
      }}
    >
      <div
        style={{
          position: 'relative',
          flex: 1,
          display: 'flex',
          flexDirection: 'column',
          borderRadius: u(0.6),
          border: `1px solid ${withAlpha(theme.fg, 0.16)}`,
          background: '#07080B',
          overflow: 'hidden',
          boxShadow: `0 ${px(u, 2)} ${px(u, 5)} rgba(0,0,0,.55)`,
        }}
      >
        <div
          style={{
            height: u(3.2),
            display: 'flex',
            alignItems: 'center',
            gap: u(0.8),
            paddingInline: u(1.2),
            borderBottom: `1px solid ${withAlpha(theme.fg, 0.1)}`,
            background: '#12151B',
            flexShrink: 0,
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
                  opacity: 0.7,
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
              background: withAlpha('#FFFFFF', 0.05),
              color: withAlpha('#F4F2EC', 0.55),
              fontFamily: FONT_MONO,
              fontSize: u(0.66),
              letterSpacing: '0.04em',
            }}
          >
            localhost:4200 · web-studio · Playwright capture
          </div>
          <span
            style={{
              padding: `${px(u, 0.18)} ${px(u, 0.5)}`,
              border: `1px solid ${withAlpha('#6FD3A0', 0.5)}`,
              borderRadius: u(0.15),
              color: '#6FD3A0',
              fontFamily: FONT_MONO,
              fontSize: u(0.56),
              letterSpacing: '0.1em',
            }}
          >
            REAL
          </span>
        </div>

        <div style={{ position: 'relative', flex: 1, overflow: 'hidden', background: '#000' }}>
          <OffthreadVideo
            src={staticFile(asset.media.src)}
            muted
            style={{
              width: '100%',
              height: '100%',
              objectFit: 'cover',
              transform: `scale(${zoom})`,
              transformOrigin: '50% 50%',
            }}
          />
        </div>
      </div>

      <FooterStrip
        left={`ASSET ${asset.id} · REAL CAPTURE`}
        right={plan ? `PLAN ${plan}` : 'PLAYWRIGHT CAPTURE'}
        theme={theme}
        u={u}
        style={{ color: withAlpha('#F4F2EC', 0.48), borderColor: withAlpha('#FFFFFF', 0.12) }}
      />
    </AbsoluteFill>
  );
}
