import '@testing-library/jest-dom/vitest';

/**
 * Node 22+ exposes `localStorage` as an experimental global that is undefined
 * without `--localstorage-file`, and jsdom 26 leaves it absent as well. Zustand
 * `persist` needs a Storage implementation, so tests get a deterministic
 * in-memory one. It is only installed when no working storage exists.
 */
function createMemoryStorage(): Storage {
  const values = new Map<string, string>();
  return {
    get length() {
      return values.size;
    },
    key(index: number) {
      return Array.from(values.keys())[index] ?? null;
    },
    getItem(key: string) {
      return values.get(key) ?? null;
    },
    setItem(key: string, value: string) {
      values.set(key, String(value));
    },
    removeItem(key: string) {
      values.delete(key);
    },
    clear() {
      values.clear();
    },
  };
}

const existing = typeof globalThis.localStorage !== 'undefined' ? globalThis.localStorage : undefined;
if (!existing) {
  const storage = createMemoryStorage();
  Object.defineProperty(globalThis, 'localStorage', {
    value: storage,
    configurable: true,
  });
  if (typeof window !== 'undefined') {
    Object.defineProperty(window, 'localStorage', {
      value: storage,
      configurable: true,
    });
  }
}
