
import { smsConfigErrors } from './sms-hook.config.js';

/**
 * 启动时校验环境变量。
 *
 * 保留现有：
 * - 数据库配置
 * - Supabase 配置
 * - 短信配置
 * - HOST / PORT 配置
 *
 * 新增：
 * - OLLAMA_BASE_URL
 * - OLLAMA_MODEL
 *
 * 注意：
 * 此处只检查配置格式。
 * 不连接 Ollama，也不检查模型是否已安装。
 */
export function validateEnv(
  config: Record<string, unknown>,
): Record<string, unknown> {
  const errors: string[] = smsConfigErrors(config);

  // ==========================================================
  // 1. 数据库配置
  // ==========================================================

  const databaseUrl = config.DATABASE_URL;

  if (
    typeof databaseUrl !== 'string' ||
    databaseUrl.trim() === ''
  ) {
    errors.push('DATABASE_URL 必填');
  }

  // ==========================================================
  // 2. Supabase 配置
  // ==========================================================

  const adminKey = config.SUPABASE_SERVICE_ROLE_KEY;

  if (
    adminKey !== undefined &&
    adminKey !== '' &&
    (
      typeof adminKey !== 'string' ||
      adminKey !== adminKey.trim() ||
      /[\r\n\0]/.test(adminKey)
    )
  ) {
    errors.push(
      'SUPABASE_SERVICE_ROLE_KEY 不可包含空白或控制字符',
    );
  }

  const supabaseUrl = config.SUPABASE_URL;

  try {
    const parsed = new URL(
      typeof supabaseUrl === 'string'
        ? supabaseUrl
        : '',
    );

    if (
      parsed.protocol !== 'https:' ||
      parsed.username ||
      parsed.password ||
      parsed.search ||
      parsed.hash ||
      !['', '/'].includes(parsed.pathname)
    ) {
      throw new Error();
    }
  } catch {
    errors.push(
      'SUPABASE_URL 必须为 HTTPS 项目根地址',
    );
  }

  if (
    typeof config.SUPABASE_PUBLISHABLE_KEY !== 'string' ||
    !config.SUPABASE_PUBLISHABLE_KEY.trim()
  ) {
    errors.push(
      'SUPABASE_PUBLISHABLE_KEY 必填',
    );
  }

  // ==========================================================
  // 3. HOST 配置
  // ==========================================================

  if (
    config.HOST !== undefined &&
    (
      typeof config.HOST !== 'string' ||
      !config.HOST.trim()
    )
  ) {
    errors.push('HOST 不可为空');
  }

  // ==========================================================
  // 4. PORT 配置
  // ==========================================================

  const port = config.PORT;

  if (
    port !== undefined &&
    port !== ''
  ) {
    const value = Number(port);

    if (
      !Number.isInteger(value) ||
      value <= 0 ||
      value > 65535
    ) {
      errors.push(
        'PORT 必须是 1-65535 之间的整数',
      );
    }
  }

  // ==========================================================
  // 5. Ollama API 地址配置
  // ==========================================================

  /**
   * OLLAMA_BASE_URL 为可选配置。
   *
   * 不配置时，OllamaService 使用：
   * http://127.0.0.1:11434
   *
   * 配置后必须满足：
   * - 合法的 HTTP / HTTPS URL
   * - 包含有效主机名
   * - 不包含用户名或密码
   * - 不包含查询参数或 Fragment
   * - 不包含额外路径
   * - 不包含首尾空白或控制字符
   *
   * 不在启动时发起网络请求。
   */
  const ollamaBaseUrl = config.OLLAMA_BASE_URL;

  if (
    ollamaBaseUrl !== undefined &&
    ollamaBaseUrl !== ''
  ) {
    if (
      typeof ollamaBaseUrl !== 'string' ||
      ollamaBaseUrl !== ollamaBaseUrl.trim() ||
      /[\r\n\0]/.test(ollamaBaseUrl)
    ) {
      errors.push(
        'OLLAMA_BASE_URL 格式无效',
      );
    } else {
      try {
        const parsed = new URL(ollamaBaseUrl);

        if (
          !['http:', 'https:'].includes(
            parsed.protocol,
          ) ||
          !parsed.hostname ||
          parsed.username ||
          parsed.password ||
          parsed.search ||
          parsed.hash ||
          !['', '/'].includes(parsed.pathname)
        ) {
          throw new Error();
        }
      } catch {
        errors.push(
          'OLLAMA_BASE_URL 必须为合法的 HTTP/HTTPS 服务根地址',
        );
      }
    }
  }

  // ==========================================================
  // 6. Ollama 模型名称配置
  // ==========================================================

  /**
   * OLLAMA_MODEL 在当前开发阶段允许缺失。
   *
   * 原因：
   * - 不强制所有后端环境启动 Ollama
   * - P1 的明显紧急信号预检查不依赖模型
   * - 模型缺失时由 OllamaService 抛出异常
   * - P1Service 将模型异常转为安全降级
   *
   * 一旦配置模型名称，要求：
   * - 必须是非空字符串
   * - 不包含空白字符
   * - 不包含控制字符
   *
   * 允许包含：
   * - /
   * - :
   * - .
   * - -
   * - _
   *
   * 因此支持 hf.co/...:Q4_K_M 形式。
   */
  const ollamaModel = config.OLLAMA_MODEL;

  if (
    ollamaModel !== undefined &&
    ollamaModel !== ''
  ) {
    if (
      typeof ollamaModel !== 'string' ||
      ollamaModel !== ollamaModel.trim() ||
      /[\s\x00-\x1f\x7f]/u.test(ollamaModel)
    ) {
      errors.push(
        'OLLAMA_MODEL 必须是不包含空白或控制字符的模型名称',
      );
    }
  }

  // ==========================================================
  // 7. 汇总校验结果
  // ==========================================================

  if (errors.length > 0) {
    throw new Error(
      `环境变量配置错误：${errors.join('；')}`,
    );
  }

  return config;
}
