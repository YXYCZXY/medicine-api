
import {
  Body,
  Controller,
  Header,
  HttpCode,
  HttpStatus,
  Post,
} from '@nestjs/common';

import {
  P1Service,
} from './p1/p1.service.js';

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
 * 当前阶段仅提供 P1 能力：
 *
 * - 领域识别
 * - 医疗风险评估
 * - 安全分流
 * - 统一响应构建
 *
 * 当前不执行：
 *
 * - P2 意图识别与参数提取
 * - P3 工具及数据库操作
 * - P4 最终自然语言回答
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
  constructor(
    private readonly p1Service: P1Service,

    private readonly responseBuilder:
      AiResponseBuilderService,
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
   * AiChatResponseDto
   *
   * 注意：
   *
   * 即使 action 为 CONTINUE_TO_P2，
   * 当前也只是完成 P1 分流，
   * 不代表 P2 已经执行。
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
    // 3. 构建统一 HTTP 响应
    // --------------------------------------------------------

    /**
     * 只能使用 Response Builder
     * 返回对外协议。
     *
     * 不直接返回：
     * - LLM 原始响应
     * - 内部 P1ProcessResult
     * - 内部异常信息
     */
    return this.responseBuilder.build(outcome);
  }
}
