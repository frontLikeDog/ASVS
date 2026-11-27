import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildApp } from './app';
import { createGitHubPortFromConfig, loadConfig } from './config';
import { loadApiLocalEnv } from './env';

const apiDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
loadApiLocalEnv(apiDir);

const config = loadConfig();
const github = createGitHubPortFromConfig(config.github);
const { app } = await buildApp({
  dbPath: config.dbPath,
  corsOrigins: config.corsOrigins,
  logger: { level: config.logLevel },
  github,
  artifactDir: config.artifactDir,
  maxAttempts: config.workerMaxAttempts,
  leaseTtlMs: config.leaseTtlMs,
  schedulerIntervalMs: config.schedulerIntervalMs,
});

const shutdown = async (signal: string): Promise<void> => {
  app.log.info({ signal }, '正在关闭 API');
  try {
    await app.close();
    process.exit(0);
  } catch (error) {
    app.log.error(error, '关闭 API 失败');
    process.exit(1);
  }
};

process.once('SIGINT', () => void shutdown('SIGINT'));
process.once('SIGTERM', () => void shutdown('SIGTERM'));

try {
  await app.listen({ host: config.host, port: config.port });
  app.log.info(
    {
      dbPath: config.dbPath,
      artifactDir: config.artifactDir,
      storage: 'sqlite',
      githubConfigured: github.isConfigured(),
    },
    `ASVS API 已启动：http://${config.host}:${config.port}`,
  );
} catch (error) {
  app.log.error(error, 'API 启动失败');
  process.exit(1);
}
