import type { OrchestrationClientPort } from '@asvs/ports';
import { useWorkspaceSyncStore } from './workspace-sync-store';

let overrideClient: OrchestrationClientPort | null = null;
const cachedClients = new Map<string, OrchestrationClientPort>();

/**
 * Lazy-loads `@asvs/adapters-http` so the orchestration client and its Zod
 * schemas stay out of the initial browser chunk (`bundle-budget.json`). Mirrors
 * the 4A/4B/4C pattern in `github-knowledge.ts`: a configured override wins,
 * otherwise one cached HTTP client per base URL.
 */
export async function getOrchestrationClient(baseUrl?: string): Promise<OrchestrationClientPort> {
  if (overrideClient) return overrideClient;
  const resolved =
    (baseUrl ?? useWorkspaceSyncStore.getState().config.baseUrl ?? '/api').trim() || '/api';
  let client = cachedClients.get(resolved);
  if (!client) {
    const { HttpOrchestrationClient } = await import('@asvs/adapters-http');
    client = new HttpOrchestrationClient({ baseUrl: resolved });
    cachedClients.set(resolved, client);
  }
  return client;
}

export function configureOrchestrationClient(client: OrchestrationClientPort): void {
  overrideClient = client;
}

export function resetOrchestrationClient(): void {
  overrideClient = null;
  cachedClients.clear();
}

/**
 * Stable idempotency key for a user-initiated run. Reusing it for a retry of
 * the same click is what makes the server create exactly one run — a manual
 * retry of a failed run goes through `/retry`, not a new POST.
 */
export function buildRunIdempotencyKey(videoId: string, now: number = Date.now()): string {
  const random = Math.random().toString(36).slice(2, 10);
  return `${videoId}-${now.toString(36)}-${random}`;
}
