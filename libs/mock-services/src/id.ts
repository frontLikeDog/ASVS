let fallbackCounter = 0;

export function newId(prefix: string): string {
  const cryptoObject = globalThis.crypto;
  if (cryptoObject && typeof cryptoObject.randomUUID === 'function') {
    return `${prefix}_${cryptoObject.randomUUID().slice(0, 8)}`;
  }
  fallbackCounter += 1;
  return `${prefix}_${Date.now().toString(36)}${fallbackCounter.toString(36)}`;
}

export function nowIso(): string {
  return new Date().toISOString();
}
