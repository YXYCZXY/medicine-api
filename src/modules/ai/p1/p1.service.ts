
import { Injectable } from '@nestjs/common';

import {
  P1ParserError,
  P1ParserService,
} from './p1-parser.service.js';

import type {
  P1ParserOptions,
} from './p1-parser.service.js';

import {
  P1ValidationError,
  P1ValidatorService,
} from './p1-validator.service.js';

import {
  P1SafetyError,
  P1SafetyGuardService,
} from './p1-safety-guard.service.js';

import {
  P1RouterService,
} from './p1-router.service.js';

import type {
  P1RouteResult,
} from './p1-router.service.js';

// ============================================================
// P1 预检查紧急响应
// ============================================================

/**
 * 在模型调用前发现明显紧急信号时，
 * 返回独立的紧急响应结果。
 *
 * 注意：
 *
 * 此时没有经过模型分类与 Schema 校验，
 * 因此不能虚构 P1Result。
 *
 * result = null 表示尚未生成完整分类结果。
 *
 * 后续响应层必须优先输出紧急安全提示，
 * 不得进入普通 P2/P3 流程。
 */
export interface P1EarlyUrgentResult {
  action: 'URGENT_RESPONSE';

  result: null;

  source:
    | 'PRE_MODEL_SAFETY_CHECK'
    | 'SAFETY_GUARD';

  detectedSignals: string[];
}

// ============================================================
// P1 编排结果
// ============================================================

/**
 * P1 编排层最终返回值。
 *
 * 包含：
 *
 * - Router 标准结果
 * - 模型调用前的紧急响应结果
 *
 * 不能根据 action === URGENT_RESPONSE
 * 假定 result 一定存在。
 */
export type P1ProcessResult =
  | P1RouteResult
  | P1EarlyUrgentResult;

// ============================================================
// P1 Service
// ============================================================

@Injectable()
export class P1Service {
  constructor(
    private readonly parser: P1ParserService,

    private readonly validator: P1ValidatorService,

    private readonly safetyGuard: P1SafetyGuardService,

    private readonly router: P1RouterService,
  ) {}

  /**
   * P1 总处理入口。
   *
   * 处理顺序：
   *
   * 1. 基础输入检查
   * 2. 紧急信号预检查
   * 3. 调用 P1 Parser
   * 4. 执行 Validator
   * 5. 执行 Safety Guard
   * 6. 执行 Router
   * 7. 统一处理异常与安全降级
   *
   * 此方法只负责 P1，
   * 不执行 P2/P3/P4 业务操作。
   */
  async process(
    userMessage: string,
    options: P1ParserOptions = {},
  ): Promise<P1ProcessResult> {
    // --------------------------------------------------------
    // 1. 用户消息基础检查
    // --------------------------------------------------------

    if (
      typeof userMessage !== 'string' ||
      userMessage.trim().length === 0
    ) {
      return this.router.safeFallback(
        'INVALID_USER_MESSAGE',
      );
    }

    try {
      // ------------------------------------------------------
      // 2. 模型调用前的紧急信号预检查
      // ------------------------------------------------------

      /**
       * 不能完全依赖模型判断紧急风险。
       *
       * 先检查原始用户消息，
       * 避免明显急症信号因为模型超时
       * 或模型错误而被忽略。
       */
      const emergencySignals =
        this.safetyGuard.detectEmergencySignals(
          userMessage,
        );

      if (emergencySignals.length > 0) {
        return this.createEarlyUrgentResult(
          emergencySignals,
          'PRE_MODEL_SAFETY_CHECK',
        );
      }

      // ------------------------------------------------------
      // 3. 检查请求是否已经取消
      // ------------------------------------------------------

      if (options.signal?.aborted) {
        return this.router.safeFallback(
          'REQUEST_CANCELLED',
        );
      }

      // ------------------------------------------------------
      // 4. 调用 Parser
      // ------------------------------------------------------

      /**
       * Parser 负责：
       *
       * - 构造 P1 System Prompt
       * - 调用统一 LLM Client
       * - 解析模型 JSON
       *
       * 返回类型为 unknown。
       */
      const rawResult =
        await this.parser.classify(
          userMessage,
          options,
        );

      // ------------------------------------------------------
      // 5. 执行 Schema 和业务一致性校验
      // ------------------------------------------------------

      /**
       * 只有经过 Validator，
       * 才能把模型结果视为合法 P1Result。
       */
      const validatedResult =
        this.validator.validate(rawResult);

      // ------------------------------------------------------
      // 6. 执行 Safety Guard
      // ------------------------------------------------------

      /**
       * Safety Guard 负责：
       *
       * - 二次检查危险信号
       * - 必要时升级风险
       * - 检查 Segment 与用户原文
       * - 禁止降低已识别的紧急风险
       */
      const safeResult =
        this.safetyGuard.evaluate(
          userMessage,
          validatedResult,
        );

      // ------------------------------------------------------
      // 7. 执行最终 Router
      // ------------------------------------------------------

      /**
       * Router 返回：
       *
       * REFUSE
       * URGENT_RESPONSE
       * CONTINUE_TO_P2
       * SAFE_FALLBACK
       *
       * Router 不执行 P2。
       */
      return this.router.route(safeResult);
    } catch (error: unknown) {
      // ------------------------------------------------------
      // 8. Safety Guard 紧急异常
      // ------------------------------------------------------

      /**
       * 安全检查明确标记需要紧急响应时，
       * 不能简单返回普通 SAFE_FALLBACK。
       */
      if (
        error instanceof P1SafetyError &&
        error.urgentResponseRequired
      ) {
        return this.createEarlyUrgentResult(
          this.safetyGuard.detectEmergencySignals(
            userMessage,
          ),
          'SAFETY_GUARD',
        );
      }

      // ------------------------------------------------------
      // 9. Schema 校验失败
      // ------------------------------------------------------

      if (error instanceof P1ValidationError) {
        return this.router.safeFallback(
          'P1_VALIDATION_FAILED',
        );
      }

      // ------------------------------------------------------
      // 10. Parser 解析失败
      // ------------------------------------------------------

      if (error instanceof P1ParserError) {
        return this.router.safeFallback(
          'P1_PARSER_FAILED',
        );
      }

      // ------------------------------------------------------
      // 11. 普通 Safety Guard 错误
      // ------------------------------------------------------

      if (error instanceof P1SafetyError) {
        return this.router.safeFallback(
          'P1_SAFETY_CHECK_FAILED',
        );
      }

      // ------------------------------------------------------
      // 12. 模型取消、超时或其他异常
      // ------------------------------------------------------

      if (options.signal?.aborted) {
        return this.router.safeFallback(
          'REQUEST_CANCELLED',
        );
      }

      /**
       * 包括：
       *
       * - Ollama 模型超时
       * - Ollama 网络错误
       * - HTTP 调用失败
       * - 未知编排异常
       *
       * 不向外暴露可能包含敏感内容的
       * 原始异常信息。
       *
       * 不将失败请求默认改成 routine。
       */
      return this.router.safeFallback(
        'P1_PROCESSING_FAILED',
      );
    }
  }

  // ==========================================================
  // 紧急响应结果构建
  // ==========================================================

  /**
   * 创建模型调用前或安全检查阶段的
   * 紧急响应结果。
   *
   * 重要：
   *
   * - 不伪造 Segment
   * - 不伪造医疗领域分类
   * - 不进入 P2
   * - 不调用模型生成紧急提示
   *
   * 后续由响应层使用经过审核的
   * 固定紧急响应文案。
   */
  private createEarlyUrgentResult(
    signals: string[],
    source: P1EarlyUrgentResult['source'],
  ): P1EarlyUrgentResult {
    return {
      action: 'URGENT_RESPONSE',

      result: null,

      source,

      detectedSignals: [
        ...new Set(signals),
      ],
    };
  }
}
