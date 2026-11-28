import { describe, expect, it } from 'vitest';
import { parseFreezedetectLog } from './media-qa';

/**
 * `freezedetect` prints nothing at all for a clip that is frozen through its
 * last frame on some ffmpeg builds, and only `freeze_start` on others. Both
 * must yield a blocker-worthy span — otherwise a completely static capture
 * would silently pass `qa_capture` (docs/16 §9.1 #13).
 *
 * Real log excerpts below were captured from ffmpeg 63.1 (`-vf freezedetect`).
 */
describe('parseFreezedetectLog', () => {
  it('解析完整的 freeze_start → duration → end 区间', () => {
    const stderr = [
      '[Parsed_freezedetect_0 @ 0x1] lavfi.freezedetect.freeze_start: 0',
      '[Parsed_freezedetect_0 @ 0x1] lavfi.freezedetect.freeze_duration: 4',
      '[Parsed_freezedetect_0 @ 0x1] lavfi.freezedetect.freeze_end: 4',
    ].join('\n');
    expect(parseFreezedetectLog(stderr)).toEqual([
      { startMs: 0, endMs: 4000, durationMs: 4000 },
    ]);
  });

  it('整段静止：只有 freeze_start 时按最后渲染时间收口', () => {
    // Real output of a 8 s static clip: only freeze_start, plus progress lines.
    const stderr = [
      '[Parsed_freezedetect_0 @ 0x1] lavfi.freezedetect.freeze_start: 0',
      'frame=  240 fps=0.0 q=-0.0 Lsize=N/A time=00:00:08.00 bitrate=N/A speed= 664x',
    ].join('\n');
    expect(parseFreezedetectLog(stderr)).toEqual([
      { startMs: 0, endMs: 8000, durationMs: 8000 },
    ]);
  });

  it('只有 freeze_start 且没有任何进度行时返回空，而不是伪造区间', () => {
    const stderr = '[Parsed_freezedetect_0 @ 0x1] lavfi.freezedetect.freeze_start: 2.5';
    expect(parseFreezedetectLog(stderr)).toEqual([]);
  });

  it('区间起点会叠加 -ss 偏移，供 real_demo 局部检测使用', () => {
    const stderr = [
      '[Parsed_freezedetect_0 @ 0x1] lavfi.freezedetect.freeze_start: 1',
      '[Parsed_freezedetect_0 @ 0x1] lavfi.freezedetect.freeze_duration: 3',
      '[Parsed_freezedetect_0 @ 0x1] lavfi.freezedetect.freeze_end: 4',
      'frame=   90 fps=0.0 q=-0.0 Lsize=N/A time=00:00:04.00 bitrate=N/A speed= 300x',
    ].join('\n');
    expect(parseFreezedetectLog(stderr, 5000)).toEqual([
      { startMs: 6000, endMs: 9000, durationMs: 3000 },
    ]);
  });

  it('多段静止：先结束后开始的区间互不吞并', () => {
    const stderr = [
      'lavfi.freezedetect.freeze_start: 0',
      'lavfi.freezedetect.freeze_duration: 2',
      'lavfi.freezedetect.freeze_end: 2',
      'lavfi.freezedetect.freeze_start: 6',
      'lavfi.freezedetect.freeze_duration: 1.5',
      'lavfi.freezedetect.freeze_end: 7.5',
      'frame=  240 fps=0.0 q=-0.0 Lsize=N/A time=00:00:08.00 bitrate=N/A speed= 664x',
    ].join('\n');
    expect(parseFreezedetectLog(stderr)).toEqual([
      { startMs: 0, endMs: 2000, durationMs: 2000 },
      { startMs: 6000, endMs: 7500, durationMs: 1500 },
    ]);
  });

  it('freeze_start 之后重新冻结时不会误用上一段的 freeze_duration', () => {
    const stderr = [
      'lavfi.freezedetect.freeze_start: 0',
      'lavfi.freezedetect.freeze_duration: 2',
      'lavfi.freezedetect.freeze_end: 2',
      'lavfi.freezedetect.freeze_start: 5',
      'frame=  240 fps=0.0 q=-0.0 Lsize=N/A time=00:00:06.00 bitrate=N/A speed= 664x',
    ].join('\n');
    expect(parseFreezedetectLog(stderr)).toEqual([
      { startMs: 0, endMs: 2000, durationMs: 2000 },
      { startMs: 5000, endMs: 6000, durationMs: 1000 },
    ]);
  });
});
