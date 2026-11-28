import { describe, expect, it } from 'vitest';
import {
  DEFAULT_NARRATION_START_OFFSET_MS,
  NarrationOverflowError,
  buildStoryboardV1,
  narrationClipV1Schema,
  reconcileStoryboardWithNarration,
  type NarrationClipV1,
  type StoryboardV1,
  type VideoProject,
  type Scene,
} from './index';
import { buildSrtFromTimeline, parseAndValidateSrt, assertValidSrt } from './srt';

function scene(overrides: Partial<Scene>): Scene {
  return {
    id: 'scene_1',
    order: 0,
    revision: 1,
    title: '标题',
    intent: '',
    narration: '默认旁白',
    caption: '默认字幕',
    durationSec: 4,
    visualType: 'title',
    templateId: 'tpl_signal',
    claimIds: [],
    status: 'approved',
    look: 'cinematic',
    brightness: 1,
    vignette: true,
    ...overrides,
  };
}

function video(scenes: Scene[]): VideoProject {
  return {
    id: 'vid_srt',
    projectId: 'proj_srt',
    title: 'SRT 测试',
    mode: 'release_video',
    stage: 'storyboard_ready',
    fps: 30,
    brief: {
      objective: '',
      audience: '',
      featureIds: [],
      durationSec: 30,
      aspect: '16:9',
      language: 'zh-CN',
      tone: 'confident',
      style: 'editorial',
      templateId: 'tpl_signal',
      useRealCapture: false,
      useGeneratedVisuals: false,
      cta: '',
      bannedPhrases: [],
    },
    scenes,
    directorMessages: [],
    scriptVersion: 1,
    createdAt: '2026-11-01T00:00:00.000Z',
    updatedAt: '2026-11-01T00:00:00.000Z',
    demo: true,
  };
}

function clip(sceneId: string, overrides: Partial<NarrationClipV1> = {}): NarrationClipV1 {
  return narrationClipV1Schema.parse({
    sceneId,
    sceneRevision: 1,
    text: '测试旁白',
    cacheKey: 'a'.repeat(64),
    src: `audio/${sceneId}.wav`,
    mimeType: 'audio/wav',
    sha256: 'b'.repeat(64),
    byteSize: 4800,
    durationMs: 2000,
    sampleRate: 48000,
    channels: 1,
    startOffsetMs: DEFAULT_NARRATION_START_OFFSET_MS,
    provider: 'deterministic_test',
    voiceId: 'zh-test',
    language: 'zh-CN',
    license: 'internal-deterministic-test-only',
    synthetic: true,
    ...overrides,
  });
}

describe('buildSrtFromTimeline', () => {
  it('按冻结帧率生成连续、单调、不越界的字幕', () => {
    const storyboard = buildStoryboardV1(
      video([
        scene({ id: 'a', order: 0, durationSec: 4, caption: '第一段字幕', narration: '' }),
        scene({ id: 'b', order: 1, durationSec: 6.5, caption: '第二段字幕', narration: '' }),
      ]),
    );
    const { cues, content } = buildSrtFromTimeline(storyboard);

    expect(cues).toHaveLength(2);
    expect(content).toContain('1\n00:00:00,000 --> 00:00:04,000\n第一段字幕');
    expect(content).toContain('2\n00:00:04,000 --> 00:00:10,500\n第二段字幕');

    const validation = parseAndValidateSrt(content, { totalDurationMs: 10_500 });
    expect(validation.ok).toBe(true);
    expect(validation.cues).toHaveLength(2);
  });

  it('多句镜头按字符权重切分，且全部落在镜头窗口内', () => {
    const text = '首先打开看板。随后邀请同事。最后一起发布。';
    const storyboard = buildStoryboardV1(
      video([scene({ id: 'a', order: 0, durationSec: 6, caption: text, narration: '' })]),
    );
    const { cues, content } = buildSrtFromTimeline(storyboard, { maxCueChars: 8 });

    expect(cues.length).toBeGreaterThanOrEqual(2);
    expect(cues.map((cue) => cue.text).join('')).toBe(text);
    for (const cue of cues) {
      expect(cue.startMs).toBeGreaterThanOrEqual(0);
      expect(cue.endMs).toBeLessThanOrEqual(6000);
      expect(cue.startMs).toBeLessThan(cue.endMs);
    }
    for (let index = 1; index < cues.length; index += 1) {
      expect(cues[index]!.startMs).toBeGreaterThanOrEqual(cues[index - 1]!.endMs);
    }
    expect(parseAndValidateSrt(content, { totalDurationMs: 6000 }).ok).toBe(true);
  });

  it('有旁白时字幕窗口跟随语音而不是整镜头', () => {
    const storyboard = buildStoryboardV1(
      video([scene({ id: 'a', order: 0, durationSec: 6, caption: '跟读语音', narration: '' })]),
    );
    const { cues } = buildSrtFromTimeline(storyboard, {
      clips: [clip('a', { durationMs: 2500, startOffsetMs: 300 })],
      maxCueChars: 24,
    });
    expect(cues[0]!.startMs).toBe(300);
    expect(cues[0]!.endMs).toBe(2800);
  });

  it('超过单条上限的单句硬换行，绝不丢字', () => {
    const text = '这是一句非常非常长并且没有任何句号的旁白用于验证硬换行不会丢字';
    const storyboard = buildStoryboardV1(
      video([scene({ id: 'a', order: 0, durationSec: 8, caption: text, narration: '' })]),
    );
    const { cues } = buildSrtFromTimeline(storyboard, { maxCueChars: 10 });
    expect(cues.length).toBeGreaterThan(1);
    expect(cues.map((cue) => cue.text).join('')).toBe(text);
  });
});

describe('parseAndValidateSrt', () => {
  const valid = '1\n00:00:00,000 --> 00:00:02,000\n第一句\n\n2\n00:00:02,000 --> 00:00:04,000\n第二句\n';

  it('接受合法 SRT', () => {
    const result = parseAndValidateSrt(valid, { totalDurationMs: 4000 });
    expect(result.ok).toBe(true);
    expect(result.cues).toHaveLength(2);
  });

  it('拒绝空内容', () => {
    expect(parseAndValidateSrt('  ', { totalDurationMs: 4000 }).ok).toBe(false);
  });

  it('拒绝非法毫秒（1000）时间戳', () => {
    const bad = '1\n00:00:00,000 --> 00:00:02,1000\n越界毫秒\n';
    const result = parseAndValidateSrt(bad, { totalDurationMs: 4000 });
    expect(result.ok).toBe(false);
    expect(result.issues.join()).toMatch(/时间轴格式非法/);
  });

  it('拒绝秒数越界的时间戳', () => {
    const bad = '1\n00:00:00,000 --> 00:00:75,000\n秒数越界\n';
    expect(parseAndValidateSrt(bad, { totalDurationMs: 90_000 }).ok).toBe(false);
  });

  it('拒绝不连续序号', () => {
    const bad = '2\n00:00:00,000 --> 00:00:02,000\n跳过 1\n';
    const result = parseAndValidateSrt(bad, { totalDurationMs: 4000 });
    expect(result.ok).toBe(false);
    expect(result.issues.join()).toMatch(/连续递增/);
  });

  it('拒绝重叠时间轴', () => {
    const bad = '1\n00:00:00,000 --> 00:00:03,000\n第一条\n\n2\n00:00:02,000 --> 00:00:04,000\n第二条\n';
    const result = parseAndValidateSrt(bad, { totalDurationMs: 4000 });
    expect(result.ok).toBe(false);
    expect(result.issues.join()).toMatch(/重叠/);
  });

  it('拒绝倒退时间轴（start >= end）', () => {
    const bad = '1\n00:00:02,000 --> 00:00:01,000\n倒退\n';
    expect(parseAndValidateSrt(bad, { totalDurationMs: 4000 }).ok).toBe(false);
  });

  it('拒绝超出视频总时长（含容差）', () => {
    const bad = '1\n00:00:00,000 --> 00:00:05,000\n超长\n';
    expect(parseAndValidateSrt(bad, { totalDurationMs: 4000 }).ok).toBe(false);
    expect(parseAndValidateSrt(bad, { totalDurationMs: 4000, toleranceMs: 1200 }).ok).toBe(true);
  });

  it('拒绝空正文', () => {
    const bad = '1\n00:00:00,000 --> 00:00:02,000\n\n';
    expect(parseAndValidateSrt(bad, { totalDurationMs: 4000 }).ok).toBe(false);
  });

  it('assertValidSrt 在非法内容时抛出', () => {
    expect(() => assertValidSrt('不是 SRT', { totalDurationMs: 4000 })).toThrow(/SRT 校验失败/);
  });
});

describe('reconcileStoryboardWithNarration', () => {
  const base = (): StoryboardV1 =>
    buildStoryboardV1(
      video([
        scene({ id: 'a', order: 0, durationSec: 4, narration: '第一段旁白' }),
        scene({ id: 'b', order: 1, durationSec: 4, narration: '第二段旁白' }),
      ]),
    );

  it('旁白在镜头内时保持帧数不变', () => {
    const result = reconcileStoryboardWithNarration(base(), [
      clip('a', { durationMs: 2000 }),
      clip('b', { durationMs: 2000 }),
    ]);
    expect(result.adjustments).toHaveLength(0);
    expect(result.storyboard.scenes.map((item) => item.durationFrames)).toEqual([120, 120]);
  });

  it('extend_scene 自动延展超长镜头并记录 adjustment', () => {
    const result = reconcileStoryboardWithNarration(
      base(),
      [clip('a', { durationMs: 4800 })],
      { policy: 'extend_scene' },
    );
    // 150 offset + 4800 audio + 200 tail = 5150ms → ceil(5.15 * 30) = 155 frames
    expect(result.storyboard.scenes[0]!.durationFrames).toBe(155);
    expect(result.storyboard.scenes[1]!.durationFrames).toBe(120);
    expect(result.adjustments).toEqual([
      {
        sceneId: 'a',
        originalDurationFrames: 120,
        effectiveDurationFrames: 155,
        audioDurationMs: 4800,
        overflowMs: expect.any(Number),
      },
    ]);
  });

  it('fail_on_overflow 抛结构化错误且指出镜头与溢出毫秒', () => {
    let caught: unknown;
    try {
      reconcileStoryboardWithNarration(base(), [clip('b', { durationMs: 6000 })], {
        policy: 'fail_on_overflow',
      });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(NarrationOverflowError);
    const overflow = caught as NarrationOverflowError;
    expect(overflow.code).toBe('narration_overflow');
    expect(overflow.sceneId).toBe('b');
    expect(overflow.overflowMs).toBeGreaterThan(0);
  });

  it('没有旁白文本的镜头保留原帧数', () => {
    const storyboard = buildStoryboardV1(
      video([scene({ id: 'a', order: 0, durationSec: 3, narration: '', caption: '' })]),
    );
    const result = reconcileStoryboardWithNarration(storyboard, []);
    expect(result.adjustments).toHaveLength(0);
    expect(result.storyboard.scenes[0]!.durationFrames).toBe(90);
  });

  it('拒绝未知镜头或重复片段', () => {
    expect(() =>
      reconcileStoryboardWithNarration(base(), [clip('missing')]),
    ).toThrow(/不存在的镜头/);
    expect(() =>
      reconcileStoryboardWithNarration(base(), [clip('a'), clip('a')]),
    ).toThrow(/多个旁白片段/);
  });

  it('延展后的 SRT 时间轴与冻结时长一致', () => {
    const result = reconcileStoryboardWithNarration(base(), [
      clip('a', { durationMs: 4800, startOffsetMs: 150 }),
    ]);
    const { content } = buildSrtFromTimeline(result.storyboard, { clips: result.clips });
    const totalMs = Math.round(
      (result.storyboard.scenes.reduce((sum, item) => sum + item.durationFrames, 0) /
        result.storyboard.fps) *
        1000,
    );
    expect(parseAndValidateSrt(content, { totalDurationMs: totalMs }).ok).toBe(true);
  });
});
