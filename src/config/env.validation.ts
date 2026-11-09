import { smsConfigErrors } from './sms-hook.config.js';

/**
 * 启动时校验必填环境变量，避免运行到第一个请求才报错
 */
export function validateEnv(
  config: Record<string, unknown>,
): Record<string, unknown> {
  const errors: string[] = smsConfigErrors(config);

  const databaseUrl = config.DATABASE_URL;
  if (typeof databaseUrl !== 'string' || databaseUrl.trim() === '') {
    errors.push('DATABASE_URL 必填');
  }

  const port = config.PORT;
  const adminKey = config.SUPABASE_SERVICE_ROLE_KEY;
  if (adminKey !== undefined && adminKey !== '' && (typeof adminKey !== 'string' || adminKey !== adminKey.trim() || /[\r\n\0]/.test(adminKey))) errors.push('SUPABASE_SERVICE_ROLE_KEY 不可包含空白或控制字符');
  if (config.HOST !== undefined && (typeof config.HOST !== 'string' || !config.HOST.trim())) {
    errors.push('HOST 不可为空');
  }
  const supabaseUrl = config.SUPABASE_URL;
  try {
    const parsed = new URL(typeof supabaseUrl === 'string' ? supabaseUrl : '');
    if (parsed.protocol !== 'https:' || parsed.username || parsed.password || parsed.search || parsed.hash || !['', '/'].includes(parsed.pathname)) throw new Error();
  } catch { errors.push('SUPABASE_URL 必须为 HTTPS 项目根地址'); }
  if (typeof config.SUPABASE_PUBLISHABLE_KEY !== 'string' || !config.SUPABASE_PUBLISHABLE_KEY.trim()) errors.push('SUPABASE_PUBLISHABLE_KEY 必填');
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
