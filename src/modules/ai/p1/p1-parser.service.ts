
import {
  Inject,
  Injectable,
} from '@nestjs/common';

import {
  LLM_CLIENT,
} from '../llm/llm.interface.js';

import type {
  LlmClient,
  LlmGenerateRequest,
} from '../llm/llm.interface.js';

import {
  P1_DOMAIN_SYSTEM_PROMPT,
} from '../prompts/p1-domain.prompt.js';

// ============================================================
// P1 Parser 错误类型
// ============================================================

export type P1ParserErrorCode =
  | 'INVALID_USER_MESSAGE'
  | 'EMPTY_MODEL_RESPONSE'
  | 'INVALID_MODEL_JSON'
  | 'INVALID_MODEL_RESULT';

/**
 * P1 Parser 专用异常。
 *
 * 用于区分：
 * - 用户输入无效
 * - 模型返回空内容
 * - 模型返回非法 JSON
 * - JSON 顶层结构不正确
 *
 * 不包含用户原文或模型原始输出，
 * 避免在异常信息中泄露个人健康内容。
 */
export class P1ParserError extends Error {
  constructor(
    public readonly code: P1ParserErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'P1ParserError';
  }
}

// ============================================================
// P1 Parser 调用选项
// ============================================================

export interface P1ParserOptions {
  /**
   * 可选的取消信号。
   *
   * 当上层取消 Agent 请求时，
   * 可以传递给统一 LLM 客户端。
   */
  signal?: AbortSignal;
}

// ============================================================
// P1 Parser Service
// ============================================================

@Injectable()
export class P1ParserService {
  constructor(
    @Inject(LLM_CLIENT)
    private readonly llmClient: LlmClient,
  ) {}

  /**
   * P1 领域识别与医疗风险初评。
   *
   * 处理流程：
   *
   * 1. 校验用户消息
   * 2. 构造 System / User 消息
   * 3. 调用统一 LLM Client
   * 4. 获取模型原始文本
   * 5. 解析 JSON
   * 6. 返回 unknown
   *
   * 注意：
   *
   * 此方法不负责：
   * - P1 Schema 校验
   * - 领域与路由一致性校验
   * - 医疗紧急信号安全检查
   * - 最终路由决策
   * - P2/P3 业务执行
   *
   * 这些操作必须由后续
   * Validator、Safety Guard、Router
   * 和 P1 Service 完成。
   */
  async classify(
    userMessage: string,
    options: P1ParserOptions = {},
  ): Promise<unknown> {
    // --------------------------------------------------------
    // 1. 校验用户输入
    // --------------------------------------------------------

    if (
      typeof userMessage !== 'string' ||
      userMessage.trim().length === 0
    ) {
      throw new P1ParserError(
        'INVALID_USER_MESSAGE',
        'P1 用户消息不能为空',
      );
    }

    // 只去除首尾空白，
    // 保留消息内部的原始表达。
    const normalizedMessage = userMessage.trim();

    // --------------------------------------------------------
    // 2. 构造模型请求
    // --------------------------------------------------------

    const request: LlmGenerateRequest = {
      messages: [
        {
          role: 'system',
          content: P1_DOMAIN_SYSTEM_PROMPT,
        },
        {
          role: 'user',
          content: normalizedMessage,
        },
      ],

      // P1 必须要求模型输出 JSON
      responseFormat: 'json',

      // 尽量降低分类输出随机性
      temperature: 0,

      // 使用统一客户端的默认超时配置
      // 支持上层主动取消
      ...(options.signal
        ? { signal: options.signal }
        : {}),
    };

    // --------------------------------------------------------
    // 3. 调用统一 LLM Client
    // --------------------------------------------------------

    /**
     * 这里不捕获 OllamaClientError。
     *
     * 例如：
     * - MODEL_TIMEOUT
     * - MODEL_CANCELLED
     * - MODEL_NETWORK_ERROR
     * - MODEL_HTTP_ERROR
     *
     * 这些异常应继续向上抛出。
     *
     * 后续 P1 Service 统一处理
     * 模型异常和安全降级。
     */
    const response = await this.llmClient.generate(
      request,
    );

    // --------------------------------------------------------
    // 4. 提取模型原始内容
    // --------------------------------------------------------

    const rawContent = response.content;

    if (
      typeof rawContent !== 'string' ||
      rawContent.trim().length === 0
    ) {
      throw new P1ParserError(
        'EMPTY_MODEL_RESPONSE',
        'P1 模型返回内容为空',
      );
    }

    // --------------------------------------------------------
    // 5. 解析模型 JSON
    // --------------------------------------------------------

    let parsed: unknown;

    try {
      parsed = JSON.parse(rawContent);
    } catch {
      throw new P1ParserError(
        'INVALID_MODEL_JSON',
        'P1 模型返回的内容不是合法 JSON',
      );
    }

    // --------------------------------------------------------
    // 6. 检查 JSON 顶层类型
    // --------------------------------------------------------

    /**
     * P1 数据协议要求顶层为 JSON 对象。
     *
     * 以下均不允许：
     *
     * null
     * []
     * "hello"
     * 123
     * true
     *
     * 注意：
     * 此处只检查顶层结构，
     * 不检查完整 P1 Schema。
     */
    if (
      parsed === null ||
      typeof parsed !== 'object' ||
      Array.isArray(parsed)
    ) {
      throw new P1ParserError(
        'INVALID_MODEL_RESULT',
        'P1 模型输出必须是 JSON 对象',
      );
    }

    // --------------------------------------------------------
    // 7. 返回未验证的结构化结果
    // --------------------------------------------------------

    /**
     * 这里故意返回 unknown。
     *
     * 不能因为 JSON.parse 成功，
     * 就直接将结果断言为 P1Result。
     *
     * 下一阶段必须执行：
     *
     * P1ValidatorService.validate(parsed)
     *
     * 随后还必须执行：
     *
     * P1SafetyGuardService.evaluate(...)
     *
     * 最终由 Router 决定是否允许 P2。
     */
    return parsed;
  }
}
