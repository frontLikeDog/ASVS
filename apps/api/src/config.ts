import path from 'node:path';
import { parseGitHubRepoRef, type GitHubRepoRef } from '@asvs/domain';
import type { GitHubReadOnlyPort } from '@asvs/ports';
import {
  GitHubAppReadOnlyClient,
  UnconfiguredGitHubReadOnlyClient,
} from './github/github-app-client';

export interface GitHubEnvConfig {
  appId?: string;
  installationId?: string;
  privateKeyPath?: string;
  privateKeyPem?: string;
  defaultRepo?: GitHubRepoRef;
  apiBaseUrl?: string;
}

export interface ApiConfig {
  host: string;
  port: number;
  dbPath: string;
  corsOrigins: string[];
  logLevel: string;
  github: GitHubEnvConfig;
}

const DEFAULT_CORS_ORIGINS = ['http://localhost:4200', 'http://127.0.0.1:4200'];

export function loadConfig(env: NodeJS.ProcessEnv = process.env): ApiConfig {
  const port = Number.parseInt(env.ASVS_API_PORT ?? '4300', 10);
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new Error(`ASVS_API_PORT 无效：${env.ASVS_API_PORT}`);
  }

  const dbPath = env.ASVS_DB_PATH?.trim() || path.resolve(process.cwd(), 'data/asvs.sqlite');
  const origins = env.ASVS_CORS_ORIGIN?.split(',')
    .map((origin) => origin.trim())
    .filter(Boolean);

  const defaultRepoRaw = env.GITHUB_DEFAULT_REPO?.trim();
  const defaultRepo = defaultRepoRaw ? parseGitHubRepoRef(defaultRepoRaw) : undefined;
  const rawPrivateKey = env.GITHUB_APP_PRIVATE_KEY?.trim();

  return {
    host: env.ASVS_API_HOST?.trim() || '127.0.0.1',
    port,
    dbPath,
    corsOrigins: origins && origins.length > 0 ? origins : DEFAULT_CORS_ORIGINS,
    logLevel: env.ASVS_LOG_LEVEL?.trim() || 'info',
    github: {
      appId: env.GITHUB_APP_ID?.trim() || undefined,
      installationId: env.GITHUB_APP_INSTALLATION_ID?.trim() || undefined,
      privateKeyPath: env.GITHUB_APP_PRIVATE_KEY_PATH?.trim() || undefined,
      privateKeyPem: rawPrivateKey ? rawPrivateKey.replace(/\\n/g, '\n') : undefined,
      defaultRepo,
      apiBaseUrl: env.GITHUB_API_BASE_URL?.trim() || undefined,
    },
  };
}

export function createGitHubPortFromConfig(config: GitHubEnvConfig): GitHubReadOnlyPort {
  const hasAny = Boolean(
    config.appId || config.installationId || config.privateKeyPath || config.privateKeyPem,
  );
  if (!hasAny) {
    return new UnconfiguredGitHubReadOnlyClient({ defaultRepo: config.defaultRepo });
  }

  const missing: string[] = [];
  if (!config.appId) missing.push('GITHUB_APP_ID');
  if (!config.installationId) missing.push('GITHUB_APP_INSTALLATION_ID');
  if (!config.privateKeyPath && !config.privateKeyPem) {
    missing.push('GITHUB_APP_PRIVATE_KEY_PATH');
  }

  if (missing.length > 0) {
    return new UnconfiguredGitHubReadOnlyClient({
      defaultRepo: config.defaultRepo,
      reason: `GitHub App 配置不完整，缺少：${missing.join(', ')}。`,
    });
  }

  return new GitHubAppReadOnlyClient({
    appId: config.appId!,
    installationId: config.installationId!,
    privateKeyPath: config.privateKeyPath,
    privateKeyPem: config.privateKeyPem,
    defaultRepo: config.defaultRepo,
    apiBaseUrl: config.apiBaseUrl,
  });
}
