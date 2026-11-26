import { describe, expect, it } from 'vitest';
import { planClip } from './media';

describe('planClip', () => {
  it('从首个断言后 800ms 开始，避开录制起点的加载壳', () => {
    expect(
      planClip({ rawDurationMs: 20_000, firstMeaningfulAtMs: 2_000, clipDurationMs: 14_000 }),
    ).toEqual({ startMs: 2800, durationMs: 14_000 });
  });

  it('永不越过 raw 结尾', () => {
    expect(
      planClip({ rawDurationMs: 10_000, firstMeaningfulAtMs: 2_000, clipDurationMs: 14_000 }),
    ).toEqual({ startMs: 2800, durationMs: 7200 });
  });

  it('极早的断言也不会越过 raw 结尾', () => {
    expect(
      planClip({ rawDurationMs: 20_000, firstMeaningfulAtMs: 100, clipDurationMs: 14_000 }),
    ).toEqual({ startMs: 900, durationMs: 14_000 });
  });

  it('极短录屏仍给出合法区间', () => {
    const clip = planClip({
      rawDurationMs: 800,
      firstMeaningfulAtMs: 0,
      clipDurationMs: 14_000,
    });
    expect(clip.startMs).toBe(0);
    expect(clip.durationMs).toBe(800);
  });
});
