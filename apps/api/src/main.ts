import { buildApp } from './app';
import { loadConfig } from './config';

const config = loadConfig();
const { app } = await buildApp({
  dbPath: config.dbPath,
  corsOrigins: config.corsOrigins,
  logger: { level: config.logLevel },
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
    { dbPath: config.dbPath, storage: 'sqlite' },
    `ASVS API 已启动：http://${config.host}:${config.port}`,
  );
} catch (error) {
  app.log.error(error, 'API 启动失败');
  process.exit(1);
}
