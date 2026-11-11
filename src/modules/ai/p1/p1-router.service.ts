
import { Injectable } from '@nestjs/common';

import type { P1Result } from './schemas/p1.schema.js';

import { P1ValidatorService } from './p1-validator.service.js';

// ============================================================
// P1 Route Result
// ============================================================

/**
 * P1 最终路由结果。
 *
 * REFUSE:
 * 纯非医疗请求，不进入 P2。
 *
 * URGENT_RESPONSE:
 * 存在紧急医疗风险，停止普通 P2/P3 流程。
 *
 * CONTINUE_TO_P2:
 * 允许经过筛选的医疗片段进入 P2。
 *
 * SAFE_FALLBACK:
 * 输入或处理过程异常，禁止继续普通流程。
 */
export type P1RouteResult =
  | {
      action: 'REFUSE';
      result: P1Result;
    }
  | {
      action: 'URGENT_RESPONSE';
      result: P1Result;
    }
  | {
      action: 'CONTINUE_TO_P2';
      result: P1Result;
      allowedSegmentIds: string[];
      safetyNoticeRequired: boolean;
    }
  | {
      action: 'SAFE_FALLBACK';
      reason: string;
    };

// ============================================================
// P1 Router Service
// ============================================================

@Injectable()
export class P1RouterService {
  constructor(
    private readonly validator: P1ValidatorService,
  ) {}

  /**
   * P1 最终路由入口。
   *
   * 调用约定：
   * 1. 上层必须先执行 P1 Safety Guard。
   * 2. Router 再次执行 Validator，防止非法结果进入路由。
   * 3. Router 只返回动作，不执行 P2/P3。
   *
   * 注意：
   * Router 无法单独发现模型遗漏的医疗急症。
   * 这一职责由 Safety Guard 结合用户原文完成。
   */
  route(input: unknown): P1RouteResult {
    let result: P1Result;

    // --------------------------------------------------------
    // 1. 最终结构及业务一致性校验
    // --------------------------------------------------------

    try {
      result = this.validator.validate(input);
    } catch {
      return this.safeFallback(
        'P1_RESULT_VALIDATION_FAILED',
      );
    }

    const {
      domain_type,
      segments,
      medical_risk,
      routing,
    } = result;

    // --------------------------------------------------------
    // 2. 根据 Segment 推导允许的医疗片段
    // --------------------------------------------------------

    const medicalSegmentIds = segments
      .filter(
        (segment) =>
          segment.domain === 'medical_health',
      )
      .map((segment) => segment.segment_id);

    const hasMedicalSegments =
      medicalSegmentIds.length > 0;

    // --------------------------------------------------------
    // 3. 纯非医疗请求：拒绝
    // --------------------------------------------------------

    if (domain_type === 'non_medical_health') {
      return {
        action: 'REFUSE',
        result,
      };
    }

    // --------------------------------------------------------
    // 4. 紧急医疗风险：优先阻断
    // --------------------------------------------------------

    if (medical_risk.level === 'emergency') {
      return {
        action: 'URGENT_RESPONSE',
        result,
      };
    }

    // --------------------------------------------------------
    // 5. 防御性检查：是否存在允许的医疗片段
    // --------------------------------------------------------

    if (!hasMedicalSegments) {
      return this.safeFallback(
        'NO_ALLOWED_MEDICAL_SEGMENTS',
      );
    }

    // --------------------------------------------------------
    // 6. 防御性检查：普通 P2 路由状态
    // --------------------------------------------------------

    if (
      !routing.continue_to_p2 ||
      routing.stop_normal_flow ||
      routing.urgent_response_required
    ) {
      return this.safeFallback(
        'P1_ROUTING_STATE_INCONSISTENT',
      );
    }

    // --------------------------------------------------------
    // 7. 只允许医疗片段进入 P2
    // --------------------------------------------------------

    /**
     * 不直接使用模型输出的 p2_segment_ids
     * 作为最终授权依据。
     *
     * 即使 Validator 已经验证列表一致，
     * 这里仍根据实际 Segment 领域重新推导。
     */
    const allowedSegmentIds = [
      ...medicalSegmentIds,
    ];

    // --------------------------------------------------------
    // 8. 判断是否需要医疗安全提示
    // --------------------------------------------------------

    /**
     * needs_attention 必须要求安全提示。
     *
     * 其他非紧急情况允许保留 Validator
     * 已经通过的 safety_notice_required 标记。
     */
    const safetyNoticeRequired =
      medical_risk.level === 'needs_attention' ||
      routing.safety_notice_required;

    // --------------------------------------------------------
    // 9. 允许继续到 P2
    // --------------------------------------------------------

    return {
      action: 'CONTINUE_TO_P2',
      result,
      allowedSegmentIds,
      safetyNoticeRequired,
    };
  }

  // ==========================================================
  // 安全降级
  // ==========================================================

  /**
   * 构建安全降级路由。
   *
   * 使用场景：
   * - JSON 解析失败
   * - Schema 校验失败
   * - 模型结果字段矛盾
   * - 模型超时或不可用
   * - 普通路由状态异常
   *
   * SAFE_FALLBACK 不包含可执行的 P2 任务。
   *
   * 这里的 reason 是后端内部错误代码，
   * 不应直接作为面向用户的错误文案。
   *
   * 如果上层已经从用户原文检测出紧急信号，
   * 应优先进行紧急响应，而不能仅返回普通
   * SAFE_FALLBACK。
   */
  safeFallback(reason: string): P1RouteResult {
    return {
      action: 'SAFE_FALLBACK',
      reason,
    };
  }
}
