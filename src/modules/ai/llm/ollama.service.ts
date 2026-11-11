
import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import type {
  LlmClient,
  LlmGenerateRequest,
  LlmGenerateResponse,
} from './llm.interface.js';

// ============================================================
// Ollama 配置
// ============================================================

const DEFAULT_OLLAMA_BASE_URL =
  'http://127.0.0.1:11434';

const DEFAULT_TIMEOUT_MS = 60_000;

// ============================================================
// Ollama 错误类型
// ============================================================

export type OllamaErrorCode =
  | 'MODEL_NOT_CONFIGURED'
  | 'INVALID_CONFIGURATION'
  | 'INVALID_REQUEST'
  | 'MODEL_TIMEOUT'
  | 'MODEL_CANCELLED'
  | 'MODEL_HTTP_ERROR'
  | 'MODEL_NETWORK_ERROR'
  | 'MODEL_RESPONSE_INVALID';

/**
 * 统一 Ollama 调用异常。
 *
 * 不包含用户消息或模型原始输出，
 * 避免将敏感健康内容写入错误信息。
 */
export class OllamaClientError extends Error {
  constructor(
    public readonly code: OllamaErrorCode,
    message: string,
    public readonly statusCode?: number,
  ) {
    super(message);
    this.name = 'OllamaClientError';
  }
}

// ============================================================
// 辅助函数
// ============================================================

function isRecord(
  value: unknown,
): value is Record<string, unknown> {
  return (
    value !== null &&
    typeof value === 'object' &&
    !Array.isArray(value)
  );
}

// ============================================================
// Ollama Service
// ============================================================

@Injectable()
export class OllamaService implements LlmClient {
  constructor(
    private readonly configService: ConfigService,
  ) {}

  /**
   * 统一模型生成入口。
   *
   * 只负责模型通信和响应格式检查。
   *
   * 不负责：
   * - P1 领域识别
   * - 医疗风险评估
   * - P1 JSON.parse
   * - P1 Schema 校验
   * - Safety Guard
   * - Router
   */
  async generate(
    request: LlmGenerateRequest,
  ): Promise<LlmGenerateResponse> {
    // --------------------------------------------------------
    // 1. 校验请求参数
    // --------------------------------------------------------

    this.validateRequest(request);

    // --------------------------------------------------------
    // 2. 读取模型配置
    // --------------------------------------------------------

    const model = this.getModelName();
    const endpoint = this.getEndpoint();

    const timeoutMs =
      request.timeoutMs ?? DEFAULT_TIMEOUT_MS;

    // --------------------------------------------------------
    // 3. 构造 Ollama 请求
    // --------------------------------------------------------

    const requestBody = {
      model,

      messages: request.messages.map((message) => ({
        role: message.role,
        content: message.content,
      })),

      stream: false,

      ...(request.responseFormat === 'json'
        ? { format: 'json' }
        : {}),

      ...(request.temperature !== undefined
        ? {
            options: {
              temperature: request.temperature,
            },
          }
        : {}),
    };

    // --------------------------------------------------------
    // 4. 超时与取消控制
    // --------------------------------------------------------

    const controller = new AbortController();

    let timedOut = false;

    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, timeoutMs);

    const forwardAbort = (): void => {
      controller.abort();
    };

    // 如果上层请求已经取消，直接传递取消状态
    if (request.signal?.aborted) {
      controller.abort();
    } else {
      request.signal?.addEventListener(
        'abort',
        forwardAbort,
        { once: true },
      );
    }

    // --------------------------------------------------------
    // 5. 发送请求
    // --------------------------------------------------------

    try {
      const response = await fetch(endpoint, {
        method: 'POST',

        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json',
        },

        body: JSON.stringify(requestBody),

        signal: controller.signal,
      });

      // ------------------------------------------------------
      // 6. HTTP 状态检查
      // ------------------------------------------------------

      if (!response.ok) {
        throw new OllamaClientError(
          'MODEL_HTTP_ERROR',
          `Ollama HTTP 请求失败：${response.status}`,
          response.status,
        );
      }

      // ------------------------------------------------------
      // 7. 解析 Ollama HTTP 响应
      // ------------------------------------------------------

      let payload: unknown;

      try {
        payload = await response.json();
      } catch {
        throw new OllamaClientError(
          'MODEL_RESPONSE_INVALID',
          'Ollama 返回的 HTTP 响应不是合法 JSON',
        );
      }

      // ------------------------------------------------------
      // 8. 校验响应结构
      // ------------------------------------------------------

      if (!isRecord(payload)) {
        throw new OllamaClientError(
          'MODEL_RESPONSE_INVALID',
          'Ollama 响应必须是 JSON 对象',
        );
      }

      const responseModel = payload['model'];
      const message = payload['message'];
      const done = payload['done'];

      if (
        typeof responseModel !== 'string' ||
        responseModel.trim().length === 0 ||
        !isRecord(message) ||
        done !== true
      ) {
        throw new OllamaClientError(
          'MODEL_RESPONSE_INVALID',
          'Ollama 响应结构不完整',
        );
      }

      const content = message['content'];

      if (
        typeof content !== 'string' ||
        content.trim().length === 0
      ) {
        throw new OllamaClientError(
          'MODEL_RESPONSE_INVALID',
          'Ollama 返回了空模型内容',
        );
      }

      // ------------------------------------------------------
      // 9. 返回统一 LLM 响应
      // ------------------------------------------------------

      return {
        content,
        model: responseModel,
      };
    } catch (error: unknown) {
      // ------------------------------------------------------
      // 10. 统一异常处理
      // ------------------------------------------------------

      // 如果上层主动取消，优先返回取消错误
      if (request.signal?.aborted) {
        throw new OllamaClientError(
          'MODEL_CANCELLED',
          '模型请求已取消',
        );
      }

      // 如果本地请求超时，返回超时错误
      if (timedOut) {
        throw new OllamaClientError(
          'MODEL_TIMEOUT',
          '模型请求超时',
        );
      }

      // 保留已经识别出的业务异常
      if (error instanceof OllamaClientError) {
        throw error;
      }

      // 其他异常统一视为网络通信失败
      throw new OllamaClientError(
        'MODEL_NETWORK_ERROR',
        '无法连接 Ollama 模型服务',
      );
    } finally {
      // ------------------------------------------------------
      // 11. 清理超时定时器和监听器
      // ------------------------------------------------------

      clearTimeout(timer);

      request.signal?.removeEventListener(
        'abort',
        forwardAbort,
      );
    }
  }

  // ==========================================================
  // 模型配置
  // ==========================================================

  /**
   * 获取模型名称。
   *
   * 模型名称由环境变量 OLLAMA_MODEL 提供，
   * 不在代码中硬编码具体模型。
   *
   * 配置缺失时拒绝调用，不能猜测模型名称。
   */
  private getModelName(): string {
    const model = this.configService
      .get<string>('OLLAMA_MODEL')
      ?.trim();

    if (!model) {
      throw new OllamaClientError(
        'MODEL_NOT_CONFIGURED',
        '尚未配置 OLLAMA_MODEL',
      );
    }

    return model;
  }

  /**
   * 获取 Ollama API 地址。
   *
   * 环境变量：
   * OLLAMA_BASE_URL
   *
   * 默认：
   * http://127.0.0.1:11434
   *
   * 这里只定义默认值，不代表当前环境
   * 已经能够访问该地址。
   */
  private getEndpoint(): string {
    const configuredUrl = this.configService
      .get<string>('OLLAMA_BASE_URL')
      ?.trim();

    const baseUrl =
      configuredUrl || DEFAULT_OLLAMA_BASE_URL;

    let url: URL;

    try {
      url = new URL(baseUrl);
    } catch {
      throw new OllamaClientError(
        'INVALID_CONFIGURATION',
        'OLLAMA_BASE_URL 不是合法 URL',
      );
    }

    if (
      !['http:', 'https:'].includes(url.protocol) ||
      !url.hostname ||
      url.username ||
      url.password ||
      url.search ||
      url.hash
    ) {
      throw new OllamaClientError(
        'INVALID_CONFIGURATION',
        'OLLAMA_BASE_URL 配置无效',
      );
    }

    return new URL('/api/chat', url).toString();
  }

  // ==========================================================
  // 请求参数校验
  // ==========================================================

  private validateRequest(
    request: LlmGenerateRequest,
  ): void {
    if (
      !request ||
      !Array.isArray(request.messages) ||
      request.messages.length === 0
    ) {
      throw new OllamaClientError(
        'INVALID_REQUEST',
        '模型消息列表不能为空',
      );
    }

    // 检查消息结构
    for (const message of request.messages) {
      if (
        !message ||
        !['system', 'user', 'assistant'].includes(
          message.role,
        ) ||
        typeof message.content !== 'string' ||
        message.content.trim().length === 0
      ) {
        throw new OllamaClientError(
          'INVALID_REQUEST',
          '模型消息格式无效',
        );
      }
    }

    // 检查输出格式
    if (
      request.responseFormat !== 'json' &&
      request.responseFormat !== 'text'
    ) {
      throw new OllamaClientError(
        'INVALID_REQUEST',
        '不支持的模型响应格式',
      );
    }

    // 检查 temperature
    if (
      request.temperature !== undefined &&
      (
        !Number.isFinite(request.temperature) ||
        request.temperature < 0 ||
        request.temperature > 2
      )
    ) {
      throw new OllamaClientError(
        'INVALID_REQUEST',
        'temperature 必须在 0 到 2 之间',
      );
    }

    // 检查 timeoutMs
    if (
      request.timeoutMs !== undefined &&
      (
        !Number.isSafeInteger(request.timeoutMs) ||
        request.timeoutMs <= 0
      )
    ) {
      throw new OllamaClientError(
        'INVALID_REQUEST',
        'timeoutMs 必须为正整数',
      );
    }
  }
}
