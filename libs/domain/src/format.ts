export function formatTimecode(totalSeconds: number, withTenths = false): string {
  const safe = Math.max(0, totalSeconds);
  const minutes = Math.floor(safe / 60);
  const seconds = Math.floor(safe % 60);
  const base = `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
  if (!withTenths) return base;
  const tenths = Math.floor((safe % 1) * 10);
  return `${base}.${tenths}`;
}

export function formatSrtTime(totalSeconds: number): string {
  const safe = Math.max(0, totalSeconds);
  const hours = Math.floor(safe / 3600);
  const minutes = Math.floor((safe % 3600) / 60);
  const seconds = Math.floor(safe % 60);
  const milliseconds = Math.round((safe % 1) * 1000);
  return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')},${String(milliseconds).padStart(3, '0')}`;
}

export function formatDuration(seconds: number): string {
  const rounded = Math.round(seconds);
  if (rounded < 60) return `${rounded} 秒`;
  const minutes = Math.floor(rounded / 60);
  const rest = rounded % 60;
  return rest === 0 ? `${minutes} 分钟` : `${minutes} 分 ${rest} 秒`;
}

export function formatElapsed(ms: number): string {
  return formatTimecode(ms / 1000, true);
}

export function formatRelativeTime(iso: string, now: number = Date.now()): string {
  const time = new Date(iso).getTime();
  if (Number.isNaN(time)) return iso;
  const diff = Math.max(0, now - time);
  const minute = 60_000;
  const hour = 60 * minute;
  const day = 24 * hour;
  if (diff < minute) return '刚刚';
  if (diff < hour) return `${Math.floor(diff / minute)} 分钟前`;
  if (diff < day) return `${Math.floor(diff / hour)} 小时前`;
  if (diff < day * 2) return '昨天';
  if (diff < day * 7) return `${Math.floor(diff / day)} 天前`;
  return new Intl.DateTimeFormat('zh-CN', {
    month: 'short',
    day: 'numeric',
  }).format(new Date(time));
}

export function formatDate(iso: string): string {
  const time = new Date(iso).getTime();
  if (Number.isNaN(time)) return iso;
  return new Intl.DateTimeFormat('zh-CN', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date(time));
}

export function formatShortDate(iso: string): string {
  const time = new Date(iso).getTime();
  if (Number.isNaN(time)) return iso;
  return new Intl.DateTimeFormat('zh-CN', {
    month: '2-digit',
    day: '2-digit',
  }).format(new Date(time));
}

export function truncate(text: string, max = 80): string {
  const clean = text.trim();
  return clean.length > max ? `${clean.slice(0, max - 1)}…` : clean;
}

export function hexToRgb(hex: string): { r: number; g: number; b: number } {
  const clean = hex.replace('#', '');
  const value = clean.length === 3
    ? clean.split('').map((part) => `${part}${part}`).join('')
    : clean.padEnd(6, '0').slice(0, 6);
  return {
    r: Number.parseInt(value.slice(0, 2), 16) || 0,
    g: Number.parseInt(value.slice(2, 4), 16) || 0,
    b: Number.parseInt(value.slice(4, 6), 16) || 0,
  };
}

export function withAlpha(hex: string, alpha: number): string {
  const { r, g, b } = hexToRgb(hex);
  return `rgba(${r}, ${g}, ${b}, ${Math.min(1, Math.max(0, alpha))})`;
}

function relativeLuminance({ r, g, b }: { r: number; g: number; b: number }): number {
  const channel = (value: number) => {
    const normalized = value / 255;
    return normalized <= 0.03928
      ? normalized / 12.92
      : ((normalized + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

function toHex({ r, g, b }: { r: number; g: number; b: number }): string {
  return `#${[r, g, b]
    .map((value) => Math.round(Math.min(255, Math.max(0, value))).toString(16).padStart(2, '0'))
    .join('')
    .toUpperCase()}`;
}

/** Linear blend of two hex colors; weight 0 keeps `hex`, weight 1 returns `target`. */
export function blendHex(hex: string, target: string, weight: number): string {
  const from = hexToRgb(hex);
  const to = hexToRgb(target);
  const mix = Math.min(1, Math.max(0, weight));
  return toHex({
    r: from.r + (to.r - from.r) * mix,
    g: from.g + (to.g - from.g) * mix,
    b: from.b + (to.b - from.b) * mix,
  });
}

export function contrastRatio(a: string, b: string): number {
  const first = relativeLuminance(hexToRgb(a));
  const second = relativeLuminance(hexToRgb(b));
  return (Math.max(first, second) + 0.05) / (Math.min(first, second) + 0.05);
}

/** Picks the foreground (dark or paper) with the higher WCAG contrast ratio. */
export function readableOn(hex: string): string {
  return contrastRatio('#15140F', hex) >= contrastRatio('#FFFDF7', hex) ? '#15140F' : '#FFFDF7';
}

/**
 * Keeps a brand accent recognizable while guaranteeing readable text on a
 * light surface: darkens toward ink until WCAG AA (4.5:1) is met.
 */
export function readableAccentOn(hex: string, background: string): string {
  let candidate = hex;
  for (let weight = 0; weight <= 1; weight += 0.1) {
    candidate = blendHex(hex, '#1A1915', weight);
    if (contrastRatio(candidate, background) >= 4.5) return candidate;
  }
  return candidate;
}

export function percent(value: number, total: number): number {
  if (total <= 0) return 0;
  return Math.min(100, Math.max(0, (value / total) * 100));
}

export function pluralMinutes(seconds: number): string {
  const minutes = Math.round(seconds / 60);
  return `${minutes} 分钟`;
}
