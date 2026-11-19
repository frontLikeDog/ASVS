import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { stableStringify } from '@asvs/domain';

export function sha256Buffer(buffer: Buffer): string {
  return createHash('sha256').update(buffer).digest('hex');
}

export function sha256File(file: string): string {
  return sha256Buffer(readFileSync(file));
}

/** Digest of a value's canonical JSON; stable across key order. */
export function digestOf(value: unknown): string {
  return sha256Buffer(Buffer.from(stableStringify(value), 'utf8'));
}
