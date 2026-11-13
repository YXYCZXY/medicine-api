
import {
  Body,
  Controller,
  Header,
  HttpCode,
  HttpStatus,
  Logger,
  Post,
} from '@nestjs/common';

import {
  P1Service,
} from './p1/p1.service.js';

import {
  P2OrchestratorService,
} from './p2/p2-orchestrator.service.js';

import {
  AiResponseBuilderService,
} from './ai-response-builder.service.js';

import {
  AiChatRequestDto,
} from './dto/ai-chat.dto.js';

import type {
  AiChatResponseDto,
} from './dto/ai-chat.dto.js';

/**
 * 千方记 AI Agent HTTP Controller
 *
 * 当前阶段：
 *
 * - P1 领域识别、医疗风险评估与安全分流
 * - P2 已放行医疗片段的内部意图识别与校验
 * - 保持既有 HTTP 响应构建逻辑不变
 *
 * 当前不执行：
 *
 * - P3 工具及数据库业务操作
 * - P4 最终自然语言回答
 *
 * 注意：
 *
 * 本步骤只接通 P2 内部流程，尚不在 HTTP 响应中返回 P2Result。
 * 若需对外提供 P2Result，必须先核对并扩展现有响应 DTO 与 Builder。
 *
 * 身份认证：
 *
 * 复用 AuthModule 中已经注册的
 * 全局 APP_GUARD / AuthGuard。
 *
 * 本 Controller 不使用 @Public()。
 * 不从请求体读取 userId。
 */
@Controller('ai')
export class AiController {
  private readonly logger = new Logger(AiController.name);

  constructor(
    private readonly p1Service: P1Service,

    private readonly responseBuilder:
      AiResponseBuilderService,

    private readonly p2Orchestrator:
      P2OrchestratorService,
  ) {}

  /**
   * POST /ai/chat
   *
   * Request:
   *
   * {
   *   "message": "我的布洛芬还有多少？"
   * }
   *
   * Response:
   *
   * AiChatResponseDto（现有对外协议保持不变）
   *
   * 注意：
   *
   * 只有 P1 Router 返回 CONTINUE_TO_P2 才会执行 P2。
   * P2 处理失败不会覆盖已经确定的 P1 紧急响应与安全分流。
   * P2 的成功结果暂不作为本接口的响应内容。
   */
  @Post('chat')
  @HttpCode(HttpStatus.OK)
  @Header('Cache-Control', 'no-store')
  async chat(
    @Body() request: AiChatRequestDto,
  ): Promise<AiChatResponseDto> {
    // --------------------------------------------------------
    // 1. HTTP 参数校验
    // --------------------------------------------------------

    /**
     * AiChatRequestDto 通过全局
     * ValidationPipe 进行校验。
     *
     * 包括：
     * - message 必须是字符串
     * - message 不能为空
     * - message 不能只有空白
     * - message 长度不能超过 4000
     *
     * Controller 不重复实现 DTO 校验。
     */

    // --------------------------------------------------------
    // 2. 执行 P1 处理
    // --------------------------------------------------------

    /**
     * P1Service 内部完成：
     *
     * - 模型调用前紧急信号预检查
     * - Parser
     * - Validator
     * - Safety Guard
     * - Router
     * - 安全降级
     */
    const outcome = await this.p1Service.process(
      request.message,
    );

    // --------------------------------------------------------
    // 3. 仅对 P1 已授权的医疗片段执行 P2
    // --------------------------------------------------------

    /**
     * P1ProcessResult 包含“模型前紧急响应”（result 为 null）。
     * 只根据最终 action 放行，绝不尝试拼造 P1RouteResult。
     *
     * P2Orchestrator 内部还会执行 Entry Guard，
     * 检查医疗 Segment 与 Router 白名单的一致性。
     *
     * 当前尚无经核实的用户时区来源，因此明确采用 UTC。
     * 后续处理相对时间时，需要接入可信的用户时区设置，
     * 不得把 UTC 误当作用户本地时区。
     */
    if (outcome.action === 'CONTINUE_TO_P2') {
      try {
        const p2Outcome = await this.p2Orchestrator.process(
          outcome,
          {
            request_time: new Date().toISOString(),
            timezone: 'UTC',
          },
        );

        if (p2Outcome.action === 'SAFE_FALLBACK') {
          // 只记录非敏感错误代码与校验分类码，不写入用户原文或模型响应。
          const categorySuffix =
            p2Outcome.category === undefined
              ? ''
              : `:${p2Outcome.category}`;
          this.logger.warn(
            `P2_SAFE_FALLBACK:${p2Outcome.reason}${categorySuffix}`,
          );
        } else {
          // 目前仅用于确认后端链路成功，不对外暴露健康数据。
          this.logger.debug(`P2_COMPLETED:${p2Outcome.result.status}`);
        }
      } catch {
        // P2 未知异常不能改变 P1 已验证的 HTTP 安全响应。
        // 不记录异常对象，避免泄露用户健康信息。
        this.logger.warn('P2_UNEXPECTED_FAILURE');
      }
    }

    // --------------------------------------------------------
    // 4. 构建统一 HTTP 响应
    // --------------------------------------------------------

    /**
     * 只能使用既有 Response Builder 返回对外协议。
     *
     * 不直接返回：
     * - LLM 原始响应
     * - 内部 P1ProcessResult
     * - 内部 P2ProcessResult
     * - 内部异常信息
     *
     * P2 的结果对外呈现需要单独核对 DTO/Builder，
     * 本步骤不擅自改变既有响应结构。
     */
    return this.responseBuilder.build(outcome);
  }
}
