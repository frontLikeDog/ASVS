import { blendHex, readableOn, withAlpha } from '@asvs/domain';
import type { BrandKit, StoryboardSceneV1 } from '@asvs/domain';

export type Surface = 'paper' | 'ink' | 'tint' | 'brand';

const SURFACE_BY_TEMPLATE: Record<string, Surface> = {
  tpl_signal: 'paper',
  tpl_grid: 'ink',
  tpl_bloom: 'tint',
  tpl_type: 'brand',
};

export interface SceneTheme {
  surface: Surface;
  bg: string;
  fg: string;
  muted: string;
  line: string;
  accent: string;
  accentText: string;
  onAccent: string;
}

export const FONT_DISPLAY =
  '"Space Grotesk", "Inter", "Noto Sans CJK SC", "Microsoft YaHei", "PingFang SC", "Segoe UI", system-ui, sans-serif';
export const FONT_SANS =
  '"Inter", "Noto Sans CJK SC", "Microsoft YaHei", "PingFang SC", "Segoe UI", system-ui, sans-serif';
export const FONT_MONO =
  '"JetBrains Mono", "Cascadia Mono", "Consolas", "Noto Sans Mono CJK SC", "Courier New", monospace';

export function surfaceFor(scene: StoryboardSceneV1, brand: BrandKit): Surface {
  const direct = SURFACE_BY_TEMPLATE[scene.templateId];
  if (direct) return direct;
  if (brand.style === 'editorial') return 'paper';
  if (brand.style === 'minimal') return 'ink';
  if (brand.style === 'bold') return 'brand';
  return 'tint';
}

export function sceneTheme(brand: BrandKit, scene: StoryboardSceneV1): SceneTheme {
  const surface = surfaceFor(scene, brand);
  const onAccent = readableOn(brand.primary);
  const bg =
    surface === 'paper'
      ? '#F2EEE3'
      : surface === 'brand'
        ? brand.primary
        : surface === 'tint'
          ? '#101217'
          : '#0B0D11';
  const fg =
    surface === 'paper'
      ? '#1A1915'
      : surface === 'brand'
        ? onAccent
        : '#F4F2EC';
  const muted =
    surface === 'paper'
      ? 'rgba(26,25,21,.65)'
      : surface === 'brand'
        ? withAlpha(onAccent, 0.64)
        : 'rgba(244,242,236,.56)';
  const line =
    surface === 'paper'
      ? 'rgba(26,25,21,.14)'
      : surface === 'brand'
        ? withAlpha(fg, 0.22)
        : 'rgba(255,255,255,.12)';
  const accent = surface === 'brand' ? fg : brand.primary;
  const accentText =
    surface === 'paper'
      ? blendHex(brand.primary, '#1A1915', 0.18)
      : surface === 'brand'
        ? fg
        : brand.primary;

  return { surface, bg, fg, muted, line, accent, accentText, onAccent };
}

export function fontForPair(pair: BrandKit['fontPair']): string {
  switch (pair) {
    case 'serif':
      return '"Iowan Old Style", "Songti SC", "Noto Serif CJK SC", Georgia, serif';
    case 'mono':
      return FONT_MONO;
    case 'clean':
      return FONT_SANS;
    default:
      return FONT_DISPLAY;
  }
}
