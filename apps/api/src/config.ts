import path from 'node:path';
import { parseGitHubRepoRef, type GitHubRepoRef } from '@asvs/domain';
import type { GitHubReadOnlyPort, SpeechRuntimeConfig } from '@asvs/ports';
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
  /** Narration (TTS) configuration; `unconfigured` fails closed with 503. */
  speech: SpeechRuntimeConfig;
  /** Root for server-rendered MP4 / manifest / receipt artifacts. */
  artifactDir: string;
  /** How many render subprocesses may run at once (SQLite single writer). */
  maxConcurrentRenders: number;
  /** Job lease TTL; a missed heartbeat past this marks the worker as crashed. */
  leaseTtlMs: number;
  /** Attempts before a crashing worker turns the run into a terminal failure. */
  workerMaxAttempts: number;
  /** Scheduler poll interval. */
  schedulerIntervalMs: number;
  /** Explicit worker script path; defaults to the in-repo tsx entry. */
  workerScript?: string;
}

const SPEECH_PROVIDERS = ['unconfigured', 'openai_compatible', 'deterministic_test'] as const;

/**
 * Reads TTS settings. Nothing here ever surfaces the key: it is only used to
 * build the Authorization header, and `isConfigured()` is false without it.
 */
export function loadSpeechConfig(env: NodeJS.ProcessEnv = process.env): SpeechRuntimeConfig {
  const rawProvider = env.ASVS_TTS_PROVIDER?.trim() || 'unconfigured';
  const provider = SPEECH_PROVIDERS.find((item) => item === rawProvider);
  if (!provider) {
    throw new Error(
      `ASVS_TTS_PROVIDER 无效：${rawProvider}（可选 ${SPEECH_PROVIDERS.join(' / ')}）`,
    );
  }
  return {
    provider,
    apiUrl: env.ASVS_TTS_API_URL?.trim() || undefined,
    apiKey: env.ASVS_TTS_API_KEY?.trim() || undefined,
    model: env.ASVS_TTS_MODEL?.trim() || 'tts-1',
    voiceZh: env.ASVS_TTS_VOICE_ZH?.trim() || 'alloy',
    voiceEn: env.ASVS_TTS_VOICE_EN?.trim() || 'alloy',
    license:
      env.ASVS_TTS_LICENSE?.trim() ||
      (provider === 'deterministic_test'
        ? 'internal-deterministic-test-only'
        : 'provider-terms'),
    timeoutMs: readPositiveInt(env, 'ASVS_TTS_TIMEOUT_MS', 30_000, { min: 1_000, max: 300_000 }),
    maxRetries: readPositiveInt(env, 'ASVS_TTS_MAX_RETRIES', 3, { min: 0, max: 5 }),
  };
}

const DEFAULT_CORS_ORIGINS = ['http://localhost:4200', 'http://127.0.0.1:4200'];

function readPositiveInt(
  env: NodeJS.ProcessEnv,
  key: string,
  fallback: number,
  { min = 1, max = Number.MAX_SAFE_INTEGER }: { min?: number; max?: number } = {},
): number {
  const raw = env[key]?.trim();
  if (!raw) return fallback;
  const value = Number.parseInt(raw, 10);
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new Error(`${key} 无效：${raw}（需要 ${min}–${max} 的整数）`);
  }
  return value;
}

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

  const artifactDir =
    env.ASVS_ARTIFACT_DIR?.trim() || path.resolve(path.dirname(dbPath), 'artifacts');

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
    speech: loadSpeechConfig(env),
    artifactDir,
    maxConcurrentRenders: readPositiveInt(env, 'ASVS_MAX_CONCURRENT_RENDERS', 1, { min: 1, max: 8 }),
    leaseTtlMs: readPositiveInt(env, 'ASVS_LEASE_TTL_MS', 15_000, { min: 3_000, max: 600_000 }),
    workerMaxAttempts: readPositiveInt(env, 'ASVS_WORKER_MAX_ATTEMPTS', 3, { min: 1, max: 10 }),
    schedulerIntervalMs: readPositiveInt(env, 'ASVS_SCHEDULER_INTERVAL_MS', 500, {
      min: 50,
      max: 60_000,
    }),
    workerScript: env.ASVS_RENDER_WORKER_SCRIPT?.trim() || undefined,
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
