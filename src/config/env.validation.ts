import { isUUID } from 'class-validator';

/**
 * 启动时校验必填环境变量，避免运行到第一个请求才报错
 */
export function validateEnv(
  config: Record<string, unknown>,
): Record<string, unknown> {
  const errors: string[] = [];

  const databaseUrl = config.DATABASE_URL;
  if (typeof databaseUrl !== 'string' || databaseUrl.trim() === '') {
    errors.push('DATABASE_URL 必填');
  }

  const devUserId = config.DEV_USER_ID;
  if (typeof devUserId !== 'string' || !isUUID(devUserId)) {
    errors.push('DEV_USER_ID 必须是 UUID');
  }

  const port = config.PORT;
  if (port !== undefined && port !== '') {
    const value = Number(port);
    if (!Number.isInteger(value) || value <= 0 || value > 65535) {
      errors.push('PORT 必须是 1-65535 之间的整数');
    }
  }

  if (errors.length > 0) {
    throw new Error(`环境变量配置错误：${errors.join('；')}`);
  }

  return config;
}
