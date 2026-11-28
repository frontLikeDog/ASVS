import {
  AbsoluteFill,
  Audio,
  Sequence,
  interpolate,
  staticFile,
  useCurrentFrame,
  useVideoConfig,
} from 'remotion';
import {
  findRealCaptureAsset,
  narrationStartOffsetFrames,
  type NarrationClipV1,
  type RenderInputV1,
  type StoryboardSceneV1,
} from '@asvs/domain';
import { Caption, MockBadge, TopBar, Vignette, type Unit } from './chrome';
import { sceneTheme } from './theme';
import { CtaScene } from './scenes/cta-scene';
import { GeneratedScene } from './scenes/generated-scene';
import { MotionScene } from './scenes/motion-scene';
import { RealDemoScene, REAL_DEMO_LAYOUT } from './scenes/real-demo-scene';
import { TitleScene } from './scenes/title-scene';
import type { SceneProps } from './scenes/scene-props';
import type { StoryboardProps } from './types';

function SceneBody(props: SceneProps) {
  switch (props.scene.visual.type) {
    case 'title':
      return <TitleScene {...props} />;
    case 'motion_graphics':
      return <MotionScene {...props} />;
    case 'cta':
      return <CtaScene {...props} />;
    case 'real_demo':
      return <RealDemoScene {...props} />;
    case 'generated_visual':
      return <GeneratedScene {...props} />;
  }
}

/**
 * Narration for one scene. Mounted inside the scene's `<Sequence>` so the clip
 * starts exactly at the scene boundary; the inner `<Sequence>` adds the
 * per-clip lead-in so speech never collides with the cut. `libs/render` never
 * fetches anything: `clip.src` points into the worker-verified public dir.
 */
function SceneNarration({
  clip,
  fps,
}: {
  clip: NarrationClipV1;
  fps: number;
}) {
  const offset = narrationStartOffsetFrames(clip, fps);
  return (
    <Sequence from={offset} durationInFrames={Math.max(1, Math.ceil((clip.durationMs / 1000) * fps))}>
      <Audio src={staticFile(clip.src)} volume={1} />
    </Sequence>
  );
}

function SceneFrame({
  scene,
  input,
  index,
  total,
}: {
  scene: StoryboardSceneV1;
  input: RenderInputV1;
  index: number;
  total: number;
}) {
  const frame = useCurrentFrame();
  const { width } = useVideoConfig();
  const u: Unit = (value) => (value * width) / 100;
  const theme = sceneTheme(input.project.brand, scene);
  const enter = interpolate(frame, [0, 8], [0, 1], { extrapolateRight: 'clamp' });
  const exit = interpolate(
    frame,
    [Math.max(0, scene.durationFrames - 8), scene.durationFrames],
    [1, 0],
    { extrapolateLeft: 'clamp' },
  );
  const opacity = Math.min(enter, exit);
  const scale = interpolate(frame, [0, 20], [0.992, 1], { extrapolateRight: 'clamp' });
  const showCaption = scene.visual.type !== 'title' && scene.visual.type !== 'cta';
  const realCapture =
    scene.visual.type === 'real_demo'
      ? findRealCaptureAsset(scene, input.assets)
      : undefined;
  // The real-capture scene has its own footer strip; keep the caption above
  // it instead of letting the two texts stack on each other.
  const captionInset = realCapture ? u(REAL_DEMO_LAYOUT.captionInsetUnits) : 0;
  const sceneProps: SceneProps = { scene, input, index, total, theme, u };

  return (
    <AbsoluteFill
      style={{
        backgroundColor: theme.bg,
        color: theme.fg,
        opacity,
        transform: `scale(${scale})`,
      }}
    >
      <div style={{ position: 'absolute', inset: 0, filter: `brightness(${scene.brightness})` }}>
        <SceneBody {...sceneProps} />
      </div>
      {scene.vignette ? <Vignette /> : null}
      {showCaption ? <Caption caption={scene.caption} u={u} bottomInset={captionInset} /> : null}
      <TopBar
        brand={input.project.brand}
        scene={scene}
        index={index}
        total={total}
        theme={theme}
        u={u}
      />
      {scene.visual.type === 'real_demo' ? (
        realCapture ? (
          <MockBadge
            label="真实录屏"
            detail={`Playwright · ${realCapture.media.capturePlanId ?? '断言通过'}`}
            tone="green"
            u={u}
            top={u(REAL_DEMO_LAYOUT.badgeTopUnits)}
          />
        ) : (
          <MockBadge label="未接入真实录屏" detail="占位画面" tone="red" u={u} />
        )
      ) : null}
      {scene.visual.type === 'generated_visual' ? (
        <MockBadge label="生成画面" detail="模拟素材" u={u} />
      ) : null}
    </AbsoluteFill>
  );
}

/**
 * The single Remotion composition. It consumes only the frozen storyboard and
 * the validated render input: no network, no clocks, no randomness.
 */
export function StoryboardComposition({ input }: StoryboardProps) {
  if (!input) {
    return <AbsoluteFill style={{ backgroundColor: '#0B0D11' }} />;
  }
  const scenes = input.storyboard.scenes;
  const clipsByScene = new Map(
    (input.narration?.clips ?? []).map((clip) => [clip.sceneId, clip]),
  );
  let offset = 0;

  return (
    <AbsoluteFill style={{ backgroundColor: '#0B0D11' }}>
      {scenes.map((scene) => {
        const from = offset;
        offset += scene.durationFrames;
        const clip = clipsByScene.get(scene.id);
        return (
          <Sequence
            key={scene.id}
            from={from}
            durationInFrames={scene.durationFrames}
            name={`${String(scene.order + 1).padStart(2, '0')} · ${scene.title}`}
          >
            <SceneFrame scene={scene} input={input} index={scene.order} total={scenes.length} />
            {clip ? <SceneNarration clip={clip} fps={input.storyboard.fps} /> : null}
          </Sequence>
        );
      })}
    </AbsoluteFill>
  );
}
