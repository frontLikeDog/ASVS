import path from 'node:path';

export interface ApiConfig {
  host: string;
  port: number;
  dbPath: string;
  corsOrigins: string[];
  logLevel: string;
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

  return {
    host: env.ASVS_API_HOST?.trim() || '127.0.0.1',
    port,
    dbPath,
    corsOrigins: origins && origins.length > 0 ? origins : DEFAULT_CORS_ORIGINS,
    logLevel: env.ASVS_LOG_LEVEL?.trim() || 'info',
  };
}
