import { formatSrtTimeFromMs } from './format';
import type { NarrationClipV1, SubtitleCueV1 } from './narration';
import { subtitleCueV1Schema } from './narration';
import { storyboardDurationMs, type StoryboardV1 } from './render';

/**
 * Server-authoritative SRT generation and validation (docs/07 §7, AC-10).
 *
 * The timeline is derived from the *frozen* storyboard frames, not from the
 * editor's seconds, so subtitles always describe the file that was rendered.
 */

const SENTENCE_SPLIT = /(?<=[。！？!?])/u;
const SRT_TIMESTAMP =
  /^(\d{2}):(\d{2}):(\d{2}),(\d{3}) --> (\d{2}):(\d{2}):(\d{2}),(\d{3})$/;

export const DEFAULT_SRT_DURATION_TOLERANCE_MS = 250;

export interface BuildSrtOptions {
  /** Slide subtitles across the speech window instead of the whole scene. */
  clips?: NarrationClipV1[];
  /** Longest single cue in characters before splitting at sentence marks. */
  maxCueChars?: number;
}

function sceneText(scene: Pick<StoryboardV1['scenes'][number], 'narration' | 'caption' | 'title'>): string {
  return (scene.narration.trim() || scene.caption.trim() || scene.title.trim()).trim();
}

/**
 * Splits one scene's text into cues of at most `maxCueChars` characters.
 *
 * Prefers sentence boundaries; a single over-long sentence is hard-wrapped so
 * no character of the narration is ever dropped from the subtitles.
 */
function splitCues(text: string, maxCueChars: number): string[] {
  const normalized = text.replace(/\s+/g, ' ').trim();
  if (!normalized) return [];
  if (normalized.length <= maxCueChars) return [normalized];
  const limit = Math.max(1, maxCueChars);
  const sentences = normalized
    .split(SENTENCE_SPLIT)
    .map((part) => part.trim())
    .filter(Boolean);
  const toCues = (sentence: string): string[] => {
    if (sentence.length <= limit) return [sentence];
    const chunks: string[] = [];
    for (let cursor = 0; cursor < sentence.length; cursor += limit) {
      chunks.push(sentence.slice(cursor, cursor + limit).trim());
    }
    return chunks.filter(Boolean);
  };
  if (sentences.length <= 1) return toCues(normalized);

  // Greedily pack whole sentences so a cue stays readable; an individual
  // over-long sentence is wrapped instead of silently widening its cue.
  const cues: string[] = [];
  let current = '';
  const flush = () => {
    if (current) cues.push(current);
    current = '';
  };
  for (const sentence of sentences) {
    if (sentence.length > limit) {
      flush();
      cues.push(...toCues(sentence));
      continue;
    }
    const candidate = current ? `${current}${sentence}` : sentence;
    if (candidate.length > limit && current) {
      flush();
      current = sentence;
    } else {
      current = candidate;
    }
  }
  flush();
  return cues;
}

/**
 * Builds the SRT from the frozen storyboard. Each scene becomes one or more
 * cues inside its own frame window; multi-sentence scenes are split by
 * character weight across the speech window (`[audioStart, audioEnd]`) so the
 * cue alignment follows the actual voice, never a guess.
 */
export function buildSrtFromTimeline(
  storyboard: StoryboardV1,
  options: BuildSrtOptions = {},
): { cues: SubtitleCueV1[]; content: string } {
  const clips = new Map((options.clips ?? []).map((clip) => [clip.sceneId, clip]));
  const maxCueChars = options.maxCueChars ?? 24;
  const cues: SubtitleCueV1[] = [];
  let offsetFrames = 0;

  for (const scene of storyboard.scenes) {
    const startMs = Math.round((offsetFrames / storyboard.fps) * 1000);
    offsetFrames += scene.durationFrames;
    const endMs = Math.round((offsetFrames / storyboard.fps) * 1000);
    const text = sceneText(scene);
    if (!text) continue;

    const clip = clips.get(scene.id);
    const speechStart = clip ? startMs + clip.startOffsetMs : startMs;
    const speechEnd = clip
      ? Math.min(endMs, speechStart + clip.durationMs)
      : endMs;
    const windowStart = Math.max(startMs, speechStart);
    const windowEnd = Math.max(windowStart + 1, speechEnd);
    const parts = splitCues(text, maxCueChars);
    const totalWeight = parts.reduce((sum, part) => sum + part.length, 0) || 1;
    const windowMs = windowEnd - windowStart;

    let cursor = windowStart;
    parts.forEach((part, index) => {
      const isLast = index === parts.length - 1;
      const share = isLast
        ? windowEnd - cursor
        : Math.max(1, Math.round((part.length / totalWeight) * windowMs));
      const cueEnd = isLast ? windowEnd : Math.min(windowEnd, cursor + share);
      if (cueEnd <= cursor) return;
      cues.push(
        subtitleCueV1Schema.parse({
          index: cues.length + 1,
          sceneId: scene.id,
          startMs: cursor,
          endMs: cueEnd,
          text: part,
        }),
      );
      cursor = cueEnd;
    });
  }

  return { cues, content: renderSrt(cues) };
}

export function renderSrt(cues: SubtitleCueV1[]): string {
  return cues
    .map(
      (cue) =>
        `${cue.index}\n${formatSrtTimeFromMs(cue.startMs)} --> ${formatSrtTimeFromMs(cue.endMs)}\n${cue.text}\n`,
    )
    .join('\n');
}

// ── Independent validation ──────────────────────────────────────────────────

export class SrtValidationError extends Error {
  readonly code = 'invalid_srt';

  constructor(
    message: string,
    readonly issues: string[],
  ) {
    super(message);
    this.name = 'SrtValidationError';
  }
}

export interface SrtValidationOptions {
  totalDurationMs: number;
  toleranceMs?: number;
}

export interface SrtValidationResult {
  ok: boolean;
  issues: string[];
  cues: SubtitleCueV1[];
}

function timestampToMs(match: RegExpMatchArray, offset: number): number | null {
  const hours = Number(match[offset]);
  const minutes = Number(match[offset + 1]);
  const seconds = Number(match[offset + 2]);
  const milliseconds = Number(match[offset + 3]);
  if (minutes > 59 || seconds > 59 || milliseconds > 999) return null;
  return hours * 3_600_000 + minutes * 60_000 + seconds * 1000 + milliseconds;
}

/**
 * Parses and validates SRT content without trusting the generator.
 *
 * Rules (any violation must fail the export, AC-10):
 * - non-empty; indices start at 1 and increase by exactly 1;
 * - timestamps match `HH:MM:SS,mmm` with `mm/ss <= 59`, `mmm <= 999`;
 * - every cue has `startMs < endMs`, consecutive cues never overlap;
 * - the last cue ends within `totalDurationMs + toleranceMs`;
 * - cue text is not blank.
 */
export function parseAndValidateSrt(
  content: string,
  options: SrtValidationOptions,
): SrtValidationResult {
  const issues: string[] = [];
  const cues: SubtitleCueV1[] = [];
  const toleranceMs = options.toleranceMs ?? DEFAULT_SRT_DURATION_TOLERANCE_MS;
  const normalized = content.replace(/\r\n/g, '\n').replace(/^\uFEFF/, '').trim();
  if (!normalized) {
    return { ok: false, issues: ['SRT 内容为空'], cues };
  }

  const blocks = normalized.split(/\n{2,}/);
  let previousEnd = 0;
  blocks.forEach((block, blockIndex) => {
    const lines = block.split('\n');
    if (lines.length < 3) {
      issues.push(`第 ${blockIndex + 1} 条字幕缺少序号、时间轴或正文`);
      return;
    }
    const indexLine = lines[0]!.trim();
    const expectedIndex = blockIndex + 1;
    if (!/^\d+$/.test(indexLine)) {
      issues.push(`第 ${blockIndex + 1} 条字幕的序号不是整数：${indexLine}`);
      return;
    }
    const index = Number(indexLine);
    if (index !== expectedIndex) {
      issues.push(`字幕序号必须是连续递增的 ${expectedIndex}，实际为 ${index}`);
    }
    const timeMatch = lines[1]!.trim().match(SRT_TIMESTAMP);
    if (!timeMatch) {
      issues.push(`第 ${index} 条字幕的时间轴格式非法：${lines[1]}`);
      return;
    }
    const startMs = timestampToMs(timeMatch, 1);
    const endMs = timestampToMs(timeMatch, 5);
    if (startMs === null || endMs === null) {
      issues.push(`第 ${index} 条字幕的时间轴含非法值（秒或毫秒越界）：${lines[1]}`);
      return;
    }
    const text = lines.slice(2).join('\n').trim();
    if (!text) {
      issues.push(`第 ${index} 条字幕正文为空`);
    }
    if (startMs >= endMs) {
      issues.push(`第 ${index} 条字幕 startMs(${startMs}) 不小于 endMs(${endMs})`);
    }
    if (blockIndex > 0 && startMs < previousEnd) {
      issues.push(`第 ${index} 条字幕与上一条重叠（${startMs}ms < ${previousEnd}ms）`);
    }
    previousEnd = Math.max(previousEnd, endMs);
    cues.push({
      index,
      sceneId: 'unknown',
      startMs,
      endMs,
      text: text || ' ',
    });
  });

  const lastEnd = cues.length > 0 ? Math.max(...cues.map((cue) => cue.endMs)) : 0;
  if (lastEnd > options.totalDurationMs + toleranceMs) {
    issues.push(
      `最后一条字幕结束于 ${lastEnd}ms，超出视频总时长 ${options.totalDurationMs}ms（容差 ${toleranceMs}ms）`,
    );
  }

  return { ok: issues.length === 0, issues, cues };
}

/** Throws `SrtValidationError` when the SRT must not be exported. */
export function assertValidSrt(
  content: string,
  options: SrtValidationOptions,
): SubtitleCueV1[] {
  const result = parseAndValidateSrt(content, options);
  if (!result.ok) {
    throw new SrtValidationError(`SRT 校验失败：${result.issues.join('；')}`, result.issues);
  }
  return result.cues;
}

/** Total video length in ms, from the same frame math the renderer uses. */
export function storyboardSrtDurationMs(storyboard: StoryboardV1): number {
  return Math.max(1, storyboardDurationMs(storyboard));
}
