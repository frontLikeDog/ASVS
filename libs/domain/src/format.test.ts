import { describe, expect, it } from 'vitest';
import { formatSrtTime, formatSrtTimeFromMs } from './format';

describe('formatSrtTime', () => {
  it('格式化零点', () => {
    expect(formatSrtTime(0)).toBe('00:00:00,000');
  });

  it('毫秒进位不会产生非法时间戳（2.9996 → 00:00:03,000）', () => {
    // The pre-5B implementation rounded seconds and milliseconds separately
    // and emitted the illegal `00:00:02,1000`.
    expect(formatSrtTime(2.9996)).toBe('00:00:03,000');
    expect(formatSrtTime(59.9999)).toBe('00:01:00,000');
  });

  it('超过一小时且毫秒进位正确', () => {
    expect(formatSrtTime(3661.9999)).toBe('01:01:02,000');
    expect(formatSrtTime(3661.5)).toBe('01:01:01,500');
  });

  it('负数夹取为零', () => {
    expect(formatSrtTime(-3)).toBe('00:00:00,000');
  });

  it('整数毫秒入口不做二次取整', () => {
    expect(formatSrtTimeFromMs(1000)).toBe('00:00:01,000');
    expect(formatSrtTimeFromMs(999)).toBe('00:00:00,999');
    expect(formatSrtTimeFromMs(3_600_000)).toBe('01:00:00,000');
  });
});
