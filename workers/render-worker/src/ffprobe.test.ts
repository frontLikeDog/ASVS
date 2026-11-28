import { describe, expect, it } from 'vitest';
import { parseFrameRate, validateProbe, type ProbeResult } from './ffprobe';

const expected = {
  width: 1920,
  height: 1080,
  fps: 30,
  durationMs: 30000,
  frameCount: 900,
};

function probe(overrides: Partial<ProbeResult> = {}): ProbeResult {
  return {
    codecName: 'h264',
    width: 1920,
    height: 1080,
    fps: 30,
    durationMs: 30000,
    frameCount: 900,
    ...overrides,
  };
}

describe('parseFrameRate', () => {
  it('解析 ffprobe 的分数帧率', () => {
    expect(parseFrameRate('30/1')).toBe(30);
    expect(parseFrameRate('30000/1001')).toBeCloseTo(29.97, 2);
  });

  it('对缺失或非法值返回 0', () => {
    expect(parseFrameRate(undefined)).toBe(0);
    expect(parseFrameRate('0/0')).toBe(0);
    expect(parseFrameRate('nope')).toBe(0);
  });
});

describe('validateProbe', () => {
  it('完全匹配时没有错误', () => {
    expect(validateProbe(probe(), expected)).toEqual([]);
  });

  it('编码、分辨率、帧率、时长、帧数任一不符都会报错', () => {
    const errors = validateProbe(
      probe({
        codecName: 'vp9',
        width: 1280,
        height: 720,
        fps: 25,
        durationMs: 29500,
        frameCount: 750,
      }),
      expected,
    );
    expect(errors).toHaveLength(5);
    expect(errors.join('\n')).toContain('h264');
    expect(errors.join('\n')).toContain('1920×1080');
    expect(errors.join('\n')).toContain('帧率');
    expect(errors.join('\n')).toContain('时长');
    expect(errors.join('\n')).toContain('帧数');
  });

  it('时长在 250ms 容差内不算失败', () => {
    expect(validateProbe(probe({ durationMs: 30180 }), expected)).toEqual([]);
    expect(validateProbe(probe({ durationMs: 30260 }), expected)).not.toEqual([]);
  });
});

describe('validateProbe · 5B 音轨门禁', () => {
  const withAudio = {
    ...expected,
    expectAudio: { meanVolumeDb: -18.2 },
  };

  function audioProbe(overrides: Partial<NonNullable<ProbeResult['audio']>> = {}): ProbeResult {
    return probe({
      audio: {
        codecName: 'aac',
        sampleRate: 48000,
        channels: 1,
        durationMs: 30000,
        ...overrides,
      },
    });
  }

  it('合法 AAC 音轨没有错误', () => {
    expect(validateProbe(audioProbe(), withAudio)).toEqual([]);
  });

  it('静音样片（无 expectAudio）不得携带音轨', () => {
    expect(validateProbe(audioProbe(), expected).join()).toMatch(/不应包含音轨/);
  });

  it('要求音轨但缺失时报错', () => {
    expect(validateProbe(probe(), withAudio).join()).toMatch(/未找到音频流/);
  });

  it('拒绝非 AAC、低采样率与音画时长漂移', () => {
    const errors = validateProbe(
      audioProbe({ codecName: 'mp3', sampleRate: 16000, durationMs: 30800 }),
      withAudio,
    );
    const joined = errors.join('\n');
    expect(joined).toMatch(/aac/);
    expect(joined).toMatch(/22050/);
    expect(joined).toMatch(/音画时长不一致/);
  });

  it('拒绝静音音轨（meanVolumeDb ≤ -90）', () => {
    const errors = validateProbe(audioProbe(), {
      ...expected,
      expectAudio: { meanVolumeDb: -91 },
    });
    expect(errors.join()).toMatch(/静音/);
    // -inf for a fully silent track is also rejected.
    expect(
      validateProbe(audioProbe(), {
        ...expected,
        expectAudio: { meanVolumeDb: Number.NEGATIVE_INFINITY },
      }).join(),
    ).toMatch(/静音/);
  });
});
