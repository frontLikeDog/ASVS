// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { looksBinary } from './policy';

describe('looksBinary', () => {
  it('accepts ASCII and valid Chinese UTF-8 text', () => {
    expect(looksBinary(Buffer.from('export const x = 1;\n', 'utf8'))).toBe(false);
    expect(looksBinary(Buffer.from('# 增量知识索引\n\n支持中文注释与文档。\n', 'utf8'))).toBe(
      false,
    );
  });

  it('does not flag valid multi-byte UTF-8 split across the sniffBytes boundary', () => {
    // 15 ASCII bytes + 3-byte Chinese char ("中") => bytes 15..17 straddle sniffBytes = 16.
    const textBytes = Buffer.from('0123456789abcde中文内容继续', 'utf8');
    expect(looksBinary(textBytes, 16)).toBe(false);
  });

  it('flags raw invalid UTF-8 bytes without NUL or control characters as binary', () => {
    const rawInvalid = new Uint8Array([0xff, 0xfe, 0x80, 0x81, 0x41, 0x42]);
    expect(looksBinary(rawInvalid)).toBe(true);
  });

  it('flags truncated UTF-8 at EOF, NUL bytes, and high control-char density', () => {
    // Truncated 3-byte UTF-8 lead/continuation at end of file (sample.length <= sniffBytes).
    const truncatedAtEof = new Uint8Array([0x41, 0x42, 0xe4, 0xb8]);
    expect(looksBinary(truncatedAtEof, 16)).toBe(true);

    // NUL byte.
    expect(looksBinary(new Uint8Array([0x23, 0x20, 0x00, 0x41]))).toBe(true);

    // >2% control characters (excluding \t, \n, \r).
    const controls = new Uint8Array(50).fill(0x41);
    controls[0] = 0x01;
    controls[1] = 0x02;
    expect(looksBinary(controls)).toBe(true);
  });
});
