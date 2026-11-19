/** Artificial latency for simulated service calls. Kept in one place on purpose. */
export function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    globalThis.setTimeout(resolve, ms);
  });
}
