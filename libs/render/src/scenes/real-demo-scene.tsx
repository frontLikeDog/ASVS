import { AbsoluteFill, OffthreadVideo, staticFile, useVideoConfig } from 'remotion';
import { findRealCaptureAsset, withAlpha, type RenderInputV1 } from '@asvs/domain';
import { FooterStrip } from '../chrome';
import { FONT_MONO, FONT_SANS } from '../theme';
import { px } from '../units';
import { RealDemoPlaceholder } from './real-demo-placeholder';
import type { SceneProps } from './scene-props';

const CAPTURE_ASPECT = 16 / 9;
/** 1px border on each side of the browser frame. */
const SCREEN_BORDER_PX = 2;

/**
 * Vertical budget for the real-capture scene, in design units (1u = 1% of the
 * frame width). The recorded viewport is 16:9, so the video gets a strict
 * 16:9 inner frame and is never cropped: cropping the web app's own top bar
 * would silently hide the UI the plan just asserted on. The surrounding
 * chrome, badge row, caption and footer keep separate rows; the composition
 * reuses these values so nothing overlaps.
 */
export const REAL_DEMO_LAYOUT = {
  topUnits: 9,
  sideUnits: 4.4,
  bottomUnits: 4.2,
  footerUnits: 2.4,
  addressUnits: 3.2,
  /** Floating status badge sits between the top bar and the browser frame. */
  badgeTopUnits: 6.2,
  /** Caption sits above the footer strip, over the bottom of the video. */
  captionInsetUnits: 7.1,
} as const;

/** Derived from project/asset metadata, never hardcoded to one plan. */
function addressLabel(input: RenderInputV1, assetName: string): string {
  const origin = input.project.sources.find(
    (source) => source.kind === 'website' && source.status === 'connected',
  )?.name;
  return [origin, assetName, 'Playwright capture'].filter(Boolean).join(' · ');
}

/**
 * Plays the real Playwright recording produced by workers/browser-worker.
 * The recording is not decorative: the scene only takes this path when the
 * Asset is `mock: false`, carries media metadata, and the render worker has
 * verified the file hash before bundling it.
 */
export function RealDemoScene(props: SceneProps) {
  const { scene, input, theme, u } = props;
  const asset = findRealCaptureAsset(scene, input.assets);
  const { width: frameWidth, height: frameHeight } = useVideoConfig();

  if (!asset?.media) {
    return <RealDemoPlaceholder {...props} />;
  }

  const layout = REAL_DEMO_LAYOUT;
  const addressHeight = u(layout.addressUnits);
  const footerHeight = u(layout.footerUnits);
  // The chrome occupies every pixel between the top bar/badge area and the
  // footer; its width follows from the strict 16:9 video area.
  const chromeHeight = frameHeight - u(layout.topUnits) - u(layout.bottomUnits) - footerHeight;
  const videoAreaHeight = chromeHeight - addressHeight - SCREEN_BORDER_PX;
  const maxVideoWidth = frameWidth - u(layout.sideUnits) * 2 - SCREEN_BORDER_PX;
  const videoWidth = Math.max(
    0,
    Math.min(Math.round(videoAreaHeight * CAPTURE_ASPECT), maxVideoWidth),
  );
  const videoHeight = Math.round(videoWidth / CAPTURE_ASPECT);
  const chromeWidth = videoWidth + SCREEN_BORDER_PX;
  const finalChromeHeight = videoHeight + addressHeight + SCREEN_BORDER_PX;
  const address = addressLabel(input, asset.name);

  return (
    <AbsoluteFill
      style={{
        background: '#0B0D11',
        padding: `${px(u, layout.topUnits)} ${px(u, layout.sideUnits)} ${px(u, layout.bottomUnits)}`,
        fontFamily: FONT_SANS,
        overflow: 'hidden',
        display: 'flex',
        flexDirection: 'column',
      }}
    >
      <div
        style={{
          flex: 1,
          minHeight: 0,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
        }}
      >
        <div
          style={{
            width: chromeWidth,
            height: finalChromeHeight,
            boxSizing: 'border-box',
            display: 'flex',
            flexDirection: 'column',
            borderRadius: u(0.6),
            border: `1px solid ${withAlpha(theme.fg, 0.16)}`,
            background: '#07080B',
            overflow: 'hidden',
            boxShadow: `0 ${px(u, 2)} ${px(u, 5)} rgba(0,0,0,.55)`,
            flexShrink: 0,
          }}
        >
          <div
            style={{
              height: addressHeight,
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
                whiteSpace: 'nowrap',
                overflow: 'hidden',
              }}
            >
              {address}
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
                flexShrink: 0,
              }}
            >
              REAL
            </span>
          </div>

          <div
            style={{
              position: 'relative',
              flex: 1,
              minHeight: 0,
              background: '#000',
            }}
          >
            <OffthreadVideo
              src={staticFile(asset.media.src)}
              muted
              style={{
                display: 'block',
                width: '100%',
                height: '100%',
                objectFit: 'contain',
              }}
            />
          </div>
        </div>
      </div>

      <FooterStrip
        left={`ASSET ${asset.id} · REAL CAPTURE`}
        right={asset.media.capturePlanId ? `PLAN ${asset.media.capturePlanId}` : 'PLAYWRIGHT CAPTURE'}
        theme={theme}
        u={u}
        style={{
          height: footerHeight,
          flexShrink: 0,
          color: withAlpha('#F4F2EC', 0.48),
          borderColor: withAlpha('#FFFFFF', 0.12),
        }}
      />
    </AbsoluteFill>
  );
}
