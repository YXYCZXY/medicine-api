
import {
  IsNotEmpty,
  IsString,
  Matches,
  MaxLength,
} from 'class-validator';

import type {
  P1ProcessResult,
} from '../p1/p1.service.js';

import type {
  DomainType,
  MedicalRiskLevel,
  RiskAssessmentStatus,
} from '../p1/schemas/p1.schema.js';

// ============================================================
// 1. HTTP 请求限制
// ============================================================

/**
 * 单条用户消息最大长度。
 *
 * 当前属于 API 层的工程限制，
 * 不代表模型上下文窗口大小。
 *
 * 后续如果支持长病历或附件，
 * 应通过独立的数据输入协议处理，
 * 不直接放宽普通聊天消息长度。
 */
export const AI_CHAT_MESSAGE_MAX_LENGTH = 4000;

// ============================================================
// 2. AI 聊天请求 DTO
// ============================================================

/**
 * 前端请求体：
 *
 * {
 *   "message": "我的布洛芬还有多少？"
 * }
 *
 * 身份信息不通过该 DTO 传入。
 * 继续复用项目 P0 认证及用户上下文。
 */
export class AiChatRequestDto {
  @IsString({
    message: 'message 必须是字符串',
  })
  @IsNotEmpty({
    message: 'message 不能为空',
  })
  @Matches(/\S/u, {
    message: 'message 不能只包含空白字符',
  })
  @MaxLength(AI_CHAT_MESSAGE_MAX_LENGTH, {
    message: `message 不能超过 ${AI_CHAT_MESSAGE_MAX_LENGTH} 个字符`,
  })
  message!: string;
}

// ============================================================
// 3. HTTP 响应动作类型
// ============================================================

/**
 * 直接复用 P1 编排层的 action 类型，
 * 避免 HTTP 层和业务层维护两套枚举。
 *
 * 当前可能的值：
 *
 * CONTINUE_TO_P2
 * REFUSE
 * URGENT_RESPONSE
 * SAFE_FALLBACK
 */
export type AiChatAction =
  P1ProcessResult['action'];

// ============================================================
// 4. AI 聊天响应 DTO
// ============================================================

/**
 * 当前阶段只实现 P1。
 *
 * 因此响应中的：
 *
 * action = CONTINUE_TO_P2
 *
 * 仅表示 P1 允许进入 P2，
 * 不代表 P2 已执行，
 * 更不代表药箱、就诊等数据已查询。
 *
 * 本 DTO 不包含：
 *
 * - 模型原始输出
 * - 数据库记录
 * - 内部异常堆栈
 * - Ollama 配置
 * - 用户身份凭证
 */
export class AiChatResponseDto {
  /**
   * 当前完成的 Agent 阶段。
   */
  stage!: 'P1';

  /**
   * P1 最终路由动作。
   */
  action!: AiChatAction;

  /**
   * 展示给用户的安全消息。
   *
   * 后续由 Response Builder 根据 action
   * 生成经过审核的固定文案。
   *
   * 不应直接填入未经验证的模型原文
   * 或内部异常 message。
   */
  message!: string;

  /**
   * 领域识别结果。
   *
   * 对于模型调用前触发的紧急响应、
   * 或未完成分类的安全降级：
   *
   * domainType = null
   */
  domainType!: DomainType | null;

  /**
   * 已验证 P1Result 中的医疗风险等级。
   *
   * null 可以表示：
   *
   * - 风险评估不适用
   * - 分类失败
   * - 模型调用前提前紧急拦截
   *
   * 因此不能只凭 riskLevel=null
   * 判断当前请求没有医疗风险。
   *
   * 必须结合 action 使用。
   */
  riskLevel!: MedicalRiskLevel | null;

  /**
   * 已验证 P1Result 中的风险评估状态。
   *
   * 没有完整 P1Result 时为 null。
   */
  riskAssessmentStatus!:
    RiskAssessmentStatus | null;

  /**
   * P1 是否允许医疗片段进入 P2。
   *
   * 当前阶段不会实际执行 P2。
   */
  continueToP2!: boolean;

  /**
   * 是否需要向用户展示医疗安全提示。
   *
   * 紧急响应和需要关注的风险
   * 必须保留安全提示要求。
   */
  safetyNoticeRequired!: boolean;

  /**
   * P1 允许进入后续流程的 Segment ID。
   *
   * 紧急响应、拒绝和安全降级时
   * 必须为空数组。
   */
  p2SegmentIds!: string[];

  /**
   * 被拒绝的非医疗 Segment ID。
   *
   * 仅包含通过 P1 Validator
   * 检查的片段标识。
   *
   * 当没有可信分类结果时，
   * 使用空数组。
   */
  refusedSegmentIds!: string[];
}
