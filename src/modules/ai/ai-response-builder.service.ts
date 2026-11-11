
import { Injectable } from '@nestjs/common';

import type {
  AiChatResponseDto,
} from './dto/ai-chat.dto.js';

import type {
  P1ProcessResult,
} from './p1/p1.service.js';

// ============================================================
// 1. 固定用户响应文案
// ============================================================

/**
 * 所有消息均由后端固定提供。
 *
 * 不直接使用：
 * - LLM 原始输出
 * - 用户原始输入
 * - 内部错误 message
 * - Ollama 错误信息
 *
 * 以下文案是工程初稿，
 * 上线前需要适当的医疗安全审核。
 */

const RESPONSE_MESSAGES = {
  /**
   * 普通医疗请求。
   *
   * P1 仅完成分类，
   * 尚未执行 P2/P3。
   */
  CONTINUE:
    '你的请求已完成初步分类。' +
    '当前尚未执行药箱查询、健康记录查询或其他业务操作。',

  /**
   * 包含医疗与非医疗任务。
   */
  MIXED:
    '你的医疗健康请求已完成初步分类。' +
    '其中的非医疗健康任务暂不支持。' +
    '当前尚未执行后续健康业务操作。',

  /**
   * 需要专业医疗关注。
   */
  NEEDS_ATTENTION:
    '你描述的健康情况可能需要及时获得专业医疗评估。' +
    '如果症状加重或出现危急表现，请立即寻求紧急医疗帮助。' +
    '当前仅完成初步分类，尚未执行后续业务操作。',

  /**
   * 当前医疗信息不足。
   */
  INSUFFICIENT_INFORMATION:
    '目前提供的信息不足以充分判断健康风险。' +
    '建议补充症状的持续时间、严重程度和其他伴随情况。' +
    '当前仅完成初步分类，尚未执行后续业务操作。',

  /**
   * 非医疗请求。
   */
  REFUSE:
    '当前千方记 AI Agent 仅处理医疗健康' +
    '及个人健康管理相关请求。' +
    '这条请求暂不属于支持范围。',

  /**
   * 紧急医疗风险。
   *
   * 不等待 P2/P3，
   * 不生成自行用药方案。
   */
  URGENT:
    '你描述的情况可能涉及紧急健康风险。' +
    '请立即联系当地急救服务或寻求急诊帮助，' +
    '不要等待本应用继续分析或查询。' +
    '如有他人在场，可以请其协助联系急救服务。',

  /**
   * 无法安全完成分类。
   *
   * 不向用户披露：
   * - 网络错误
   * - 模型错误
   * - Schema 校验错误
   * - 内部堆栈
   */
  SAFE_FALLBACK:
    '当前无法可靠地完成这条请求的安全分类，' +
    '因此未执行后续健康业务操作。' +
    '请检查输入后重试。' +
    '如果你正出现严重或迅速恶化的症状，' +
    '请及时寻求医疗帮助，' +
    '有紧急危险时立即联系当地急救服务。',
} as const;

// ============================================================
// 2. Response Builder
// ============================================================

@Injectable()
export class AiResponseBuilderService {
  /**
   * 将经过 P1Service 处理的路由结果
   * 转换为统一 HTTP 响应。
   *
   * 重要：
   *
   * 此方法的输入应来自：
   *
   * P1Service.process(...)
   *
   * 不允许 HTTP Controller
   * 将模型原始 JSON 直接传入。
   *
   * Builder 不执行 P1 校验、
   * 不调用模型、不执行数据库操作。
   */
  build(
    outcome: P1ProcessResult,
  ): AiChatResponseDto {
    switch (outcome.action) {
      case 'CONTINUE_TO_P2':
        return this.buildContinueResponse(
          outcome,
        );

      case 'REFUSE':
        return this.buildRefuseResponse(
          outcome,
        );

      case 'URGENT_RESPONSE':
        return this.buildUrgentResponse(
          outcome,
        );

      case 'SAFE_FALLBACK':
        return this.buildFallbackResponse();

      default:
        return this.assertNever(outcome);
    }
  }

  // ==========================================================
  // 3. 正常医疗请求
  // ==========================================================

  private buildContinueResponse(
    outcome: Extract<
      P1ProcessResult,
      { action: 'CONTINUE_TO_P2' }
    >,
  ): AiChatResponseDto {
    const result = outcome.result;

    const risk = result.medical_risk;

    let message: string = RESPONSE_MESSAGES.CONTINUE;

    // 需要专业医疗关注时，安全提示优先
    if (risk.level === 'needs_attention') {
      message = RESPONSE_MESSAGES.NEEDS_ATTENTION;
    } else if (
      risk.applicable &&
      risk.assessment_status ===
        'insufficient_information'
    ) {
      message =
        RESPONSE_MESSAGES.INSUFFICIENT_INFORMATION;
    } else if (result.domain_type === 'mixed') {
      message = RESPONSE_MESSAGES.MIXED;
    }

    return {
      stage: 'P1',

      action: 'CONTINUE_TO_P2',

      message,

      domainType: result.domain_type,

      riskLevel: risk.level,

      riskAssessmentStatus:
        risk.assessment_status,

      // 只表示允许继续，
      // 不表示 P2 已经执行
      continueToP2: true,

      safetyNoticeRequired:
        outcome.safetyNoticeRequired,

      // 使用 Router 最终允许的 Segment
      p2SegmentIds: [
        ...outcome.allowedSegmentIds,
      ],

      refusedSegmentIds: [
        ...result.routing.refused_segment_ids,
      ],
    };
  }

  // ==========================================================
  // 4. 非医疗请求拒绝
  // ==========================================================

  private buildRefuseResponse(
    outcome: Extract<
      P1ProcessResult,
      { action: 'REFUSE' }
    >,
  ): AiChatResponseDto {
    const result = outcome.result;

    return {
      stage: 'P1',

      action: 'REFUSE',

      message: RESPONSE_MESSAGES.REFUSE,

      domainType: result.domain_type,

      riskLevel: result.medical_risk.level,

      riskAssessmentStatus:
        result.medical_risk.assessment_status,

      continueToP2: false,

      safetyNoticeRequired: false,

      p2SegmentIds: [],

      refusedSegmentIds: [
        ...result.routing.refused_segment_ids,
      ],
    };
  }

  // ==========================================================
  // 5. 紧急医疗响应
  // ==========================================================

  /**
   * 兼容两种紧急响应来源：
   *
   * A. 模型调用前发现明显紧急信号
   *    outcome.result === null
   *
   * B. 已验证的 P1Result 判定 emergency
   *    outcome.result !== null
   *
   * 不伪造尚未获得的分类或风险字段。
   */
  private buildUrgentResponse(
    outcome: Extract<
      P1ProcessResult,
      { action: 'URGENT_RESPONSE' }
    >,
  ): AiChatResponseDto {
    const validatedResult = outcome.result;

    return {
      stage: 'P1',

      action: 'URGENT_RESPONSE',

      message: RESPONSE_MESSAGES.URGENT,

      domainType:
        validatedResult?.domain_type ?? null,

      riskLevel:
        validatedResult?.medical_risk.level ?? null,

      riskAssessmentStatus:
        validatedResult?.medical_risk
          .assessment_status ?? null,

      // 紧急情况下强制停止普通流程
      continueToP2: false,

      safetyNoticeRequired: true,

      p2SegmentIds: [],

      // 如果有可信分类结果，
      // 保留非医疗任务的拒绝信息。
      //
      // 没有可信结果时，不虚构 Segment。
      refusedSegmentIds: validatedResult
        ? [
            ...validatedResult.routing
              .refused_segment_ids,
          ]
        : [],
    };
  }

  // ==========================================================
  // 6. 安全降级响应
  // ==========================================================

  /**
   * SAFE_FALLBACK 可能来自：
   *
   * - 无效用户输入
   * - 模型超时
   * - 网络异常
   * - JSON 解析失败
   * - Schema 校验失败
   * - Safety Guard 检查失败
   * - 请求取消
   *
   * 无论内部原因是什么，
   * 都不能伪造 P1 风险评估结果。
   *
   * 为避免泄露内部错误细节，
   * 对外使用统一固定文案。
   */
  private buildFallbackResponse():
    AiChatResponseDto {
    return {
      stage: 'P1',

      action: 'SAFE_FALLBACK',

      message:
        RESPONSE_MESSAGES.SAFE_FALLBACK,

      domainType: null,

      riskLevel: null,

      riskAssessmentStatus: null,

      continueToP2: false,

      // 风险尚未可靠评估，
      // 保留安全提示要求
      safetyNoticeRequired: true,

      p2SegmentIds: [],

      refusedSegmentIds: [],
    };
  }

  // ==========================================================
  // 7. 编译期穷尽性检查
  // ==========================================================

  /**
   * 如果未来增加新的路由动作，
   * TypeScript 会要求更新这里的映射。
   *
   * 防止新增动作却没有响应处理逻辑。
   */
  private assertNever(
    value: never,
  ): never {
    throw new Error(
      '未支持的 P1 响应动作',
    );
  }
}
