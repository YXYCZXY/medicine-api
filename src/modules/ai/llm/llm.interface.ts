
/**
 * 千方记 AI Agent
 * 统一 LLM 调用协议
 *
 * 适用于 P1 / P2 / P3 / P4。
 *
 * 本文件只定义接口和依赖注入 Token，
 * 不包含具体模型调用代码。
 */

// ============================================================
// 1. 消息角色
// ============================================================

export type LlmMessageRole =
  | 'system'
  | 'user'
  | 'assistant';

// ============================================================
// 2. 模型消息
// ============================================================

export interface LlmMessage {
  role: LlmMessageRole;
  content: string;
}

// ============================================================
// 3. 输出格式
// ============================================================

/**
 * json:
 * 要求模型生成 JSON 格式的文本。
 *
 * text:
 * 普通自然语言文本。
 *
 * 注意：
 * json 模式不代表结果已经可信。
 * P1 仍必须执行 Validator 和 Safety Guard。
 */
export type LlmResponseFormat =
  | 'json'
  | 'text';

// ============================================================
// 4. 模型调用请求
// ============================================================

export interface LlmGenerateRequest {
  /**
   * 发送给模型的消息列表。
   */
  messages: readonly LlmMessage[];

  /**
   * 期望的输出格式。
   */
  responseFormat: LlmResponseFormat;

  /**
   * 生成温度。
   *
   * 建议 P1 使用较低温度，
   * 以减少分类输出的随机性。
   */
  temperature?: number;

  /**
   * 请求超时时间，单位毫秒。
   *
   * 具体默认值由模型客户端实现。
   */
  timeoutMs?: number;

  /**
   * 可选的外部取消信号。
   *
   * 用于用户取消请求，
   * 或上层终止 Agent 执行。
   */
  signal?: AbortSignal;
}

// ============================================================
// 5. 模型响应
// ============================================================

export interface LlmGenerateResponse {
  /**
   * 模型生成的原始文本。
   *
   * 如果请求 JSON 模式，
   * 这里仍然返回字符串。
   *
   * JSON.parse 和 Schema 校验
   * 由 P1 Parser / Validator 负责。
   */
  content: string;

  /**
   * 实际使用的模型名称。
   */
  model: string;
}

// ============================================================
// 6. 统一 LLM 客户端接口
// ============================================================

export interface LlmClient {
  /**
   * 调用模型生成内容。
   *
   * 成功：
   * 返回模型原始文本及模型名称。
   *
   * 失败：
   * 抛出异常，由上层处理安全降级。
   *
   * 模型客户端不负责：
   * - P1 领域识别
   * - 医疗风险判断
   * - Schema 业务校验
   * - P2/P3 路由决策
   */
  generate(
    request: LlmGenerateRequest,
  ): Promise<LlmGenerateResponse>;
}

// ============================================================
// 7. NestJS 依赖注入 Token
// ============================================================

/**
 * TypeScript interface 在运行时不存在，
 * 因此 NestJS 不能直接使用 LlmClient
 * 作为依赖注入 Token。
 *
 * 后续 AiModule 将通过该 Token
 * 绑定 OllamaService 实例。
 */
export const LLM_CLIENT = Symbol('LLM_CLIENT');
