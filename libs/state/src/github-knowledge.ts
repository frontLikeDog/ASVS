import { parseGitHubRepoRef } from '@asvs/domain';
import type { GitHubRepoRef, Project, SourceConnection } from '@asvs/domain';
import type { GitHubKnowledgeClientPort } from '@asvs/ports';
import { useWorkspaceSyncStore } from './workspace-sync-store';

let overrideClient: GitHubKnowledgeClientPort | null = null;
const cachedClients = new Map<string, GitHubKnowledgeClientPort>();

/**
 * Lazy-loads `@asvs/adapters-http` so the 4A/4B/4C HTTP client and its Zod
 * schemas stay out of the initial browser chunk (`bundle-budget.json`).
 */
export async function getGitHubKnowledgeClient(
  baseUrl?: string,
): Promise<GitHubKnowledgeClientPort> {
  if (overrideClient) return overrideClient;
  const resolved =
    (baseUrl ?? useWorkspaceSyncStore.getState().config.baseUrl ?? '/api').trim() || '/api';
  let client = cachedClients.get(resolved);
  if (!client) {
    const { HttpGitHubKnowledgeClient } = await import('@asvs/adapters-http');
    client = new HttpGitHubKnowledgeClient({ baseUrl: resolved });
    cachedClients.set(resolved, client);
  }
  return client;
}

export function configureGitHubKnowledgeClient(client: GitHubKnowledgeClientPort): void {
  overrideClient = client;
}

export function resetGitHubKnowledgeClient(): void {
  overrideClient = null;
  cachedClients.clear();
}

export interface RealGitHubSourceBinding {
  source: SourceConnection;
  repo: GitHubRepoRef;
  branch: string;
}

/**
 * Returns the real (non-demo) GitHub repository source bound to a project, if any.
 * Demo projects (`demo: true` on the GitHub source) always return `null` so
 * existing local simulation flows remain untouched.
 */
export function parseProjectGitHubSource(
  project: Pick<Project, 'sources'> | undefined,
): RealGitHubSourceBinding | null {
  if (!project) return null;
  const source = project.sources.find(
    (item) => item.kind === 'github' && item.demo === false && item.status === 'connected',
  );
  if (!source) return null;
  try {
    const repo = parseGitHubRepoRef(source.name);
    return {
      source,
      repo,
      branch: source.scope?.trim() || 'main',
    };
  } catch {
    return null;
  }
}
