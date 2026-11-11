
import { Injectable } from '@nestjs/common';

import type { P1Result } from './schemas/p1.schema.js';

import { P1ValidatorService } from './p1-validator.service.js';

// ============================================================
// P1 Safety Error
// ============================================================

/**
 * Safety Guard 检查失败时抛出的异常。
 *
 * urgentResponseRequired:
 * true  表示发现明确紧急信号，需要优先紧急响应。
 * false 表示普通安全检查失败，应进入安全降级。
 *
 * 后续由 P1 Service 统一处理该异常。
 */
export class P1SafetyError extends Error {
  constructor(
    message: string,
    public readonly urgentResponseRequired = false,
  ) {
    super(message);
    this.name = 'P1SafetyError';
  }
}

// ============================================================
// 紧急医疗信号规则
// ============================================================

interface EmergencySignalRule {
  code: string;
  pattern: RegExp;
}

/**
 * 第一版紧急信号规则。
 *
 * 仅包含设计文档中明确列举的部分危险信号。
 *
 * 注意：
 * 1. 正则规则不是完整医学分诊标准。
 * 2. 不应仅凭未匹配到规则就认定安全。
 * 3. 正式上线前需要医学专业审核。
 * 4. 后续可以增加经过审核的规则和测试。
 */
const EMERGENCY_SIGNAL_RULES: EmergencySignalRule[] = [
  {
    code: 'severe_chest_pain',
    pattern:
      /胸口剧痛|胸部剧痛|剧烈胸痛|严重胸痛|胸痛难忍|胸口疼得厉害/gu,
  },
  {
    code: 'difficulty_breathing',
    pattern:
      /严重呼吸困难|呼吸困难|喘不过气|无法呼吸|呼吸不上来/gu,
  },
  {
    code: 'loss_of_consciousness',
    pattern:
      /突然昏迷|失去意识|意识不清|叫不醒/gu,
  },
  {
    code: 'stroke_warning',
    pattern:
      /突然口齿不清|突然说话不清|突然嘴歪|突然肢体无力|半边身子不能动/gu,
  },
  {
    code: 'severe_allergic_reaction',
    pattern:
      /严重过敏反应|过敏性休克|喉头水肿/gu,
  },
  {
    code: 'severe_bleeding',
    pattern:
      /大量出血|血流不止|止不住血/gu,
  },
  {
    code: 'suspected_severe_poisoning',
    pattern:
      /严重中毒|疑似严重中毒|误服大量药物|药物严重过量/gu,
  },
];

// ============================================================
// P1 Safety Guard Service
// ============================================================

@Injectable()
export class P1SafetyGuardService {
  constructor(
    private readonly validator: P1ValidatorService,
  ) {}

  /**
   * P1 安全检查入口。
   *
   * 输入：
   * - 用户原始消息
   * - 已通过 Validator 的 P1Result
   *
   * 输出：
   * - 安全检查后的 P1Result
   *
   * 安全原则：
   * - 不降低模型报告的风险
   * - 明确紧急信号优先处理
   * - 非医疗片段不能进入 P2
   * - 升级风险后重新执行 Validator
   */
  evaluate(
    userMessage: string,
    result: P1Result,
  ): P1Result {
    if (
      typeof userMessage !== 'string' ||
      userMessage.trim().length === 0
    ) {
      throw new P1SafetyError('用户消息不能为空');
    }

    // --------------------------------------------------------
    // 1. 独立检查用户原文中的紧急信号
    // --------------------------------------------------------

    const emergencySignals =
      this.detectEmergencySignals(userMessage);

    const hasEmergencySignals =
      emergencySignals.length > 0;

    // --------------------------------------------------------
    // 2. 确保输入符合 P1 数据协议
    // --------------------------------------------------------

    let validated: P1Result;

    try {
      validated = this.validator.validate(result);
    } catch (error) {
      if (hasEmergencySignals) {
        throw new P1SafetyError(
          'P1 结果无效，但用户消息存在紧急医疗信号',
          true,
        );
      }

      throw error;
    }

    const modelReportedEmergency =
      validated.medical_risk.level === 'emergency';

    const emergencyRequired =
      hasEmergencySignals || modelReportedEmergency;

    // --------------------------------------------------------
    // 3. 检查 Segment 内容是否来自原文
    // --------------------------------------------------------

    this.validateSegmentContents(
      userMessage,
      validated,
      emergencyRequired,
    );

    // --------------------------------------------------------
    // 4. 没有新增紧急信号，保留原始风险判断
    // --------------------------------------------------------

    if (!hasEmergencySignals) {
      // 重要：
      // 不能因为规则未命中就降低模型判断的风险。
      return validated;
    }

    // --------------------------------------------------------
    // 5. 检查是否具有医疗片段
    // --------------------------------------------------------

    const hasMedicalSegment =
      validated.segments.some(
        (segment) =>
          segment.domain === 'medical_health',
      );

    if (!hasMedicalSegment) {
      // 用户原文存在明确紧急信号，
      // 但模型错误地认为没有医疗片段。
      //
      // 不擅自虚构一个 Segment，
      // 而是要求上层优先执行紧急响应。
      throw new P1SafetyError(
        '用户消息存在紧急医疗信号，但模型未识别医疗片段',
        true,
      );
    }

    // --------------------------------------------------------
    // 6. 将医疗风险升级为 emergency
    // --------------------------------------------------------

    const updated: P1Result = {
      ...validated,

      medical_risk: {
        ...validated.medical_risk,

        applicable: true,

        level: 'emergency',

        assessment_status: 'assessed',

        risk_signals: [
          ...new Set([
            ...validated.medical_risk.risk_signals,
            ...emergencySignals,
          ]),
        ],

        recommended_action: 'emergency_response',
      },

      routing: {
        ...validated.routing,

        continue_to_p2: false,

        p2_segment_ids: [],

        urgent_response_required: true,

        stop_normal_flow: true,

        safety_notice_required: true,
      },
    };

    // --------------------------------------------------------
    // 7. 升级后重新验证结果的一致性
    // --------------------------------------------------------

    return this.validator.validate(updated);
  }

  // ==========================================================
  // 紧急信号检测
  // ==========================================================

  /**
   * 检测原文中的高风险信号。
   *
   * 该方法公开，方便后续 P1 Service
   * 在模型超时、JSON 解析失败等情况下，
   * 仍然可以独立检查明显紧急信号。
   */
  detectEmergencySignals(
    userMessage: string,
  ): string[] {
    if (
      typeof userMessage !== 'string' ||
      userMessage.trim().length === 0
    ) {
      return [];
    }

    const detectedSignals: string[] = [];

    for (const rule of EMERGENCY_SIGNAL_RULES) {
      const matches = userMessage.matchAll(
        rule.pattern,
      );

      for (const match of matches) {
        const position = match.index ?? 0;

        if (
          this.isNegatedOrHypothetical(
            userMessage,
            position,
          )
        ) {
          continue;
        }

        detectedSignals.push(rule.code);

        // 同一个风险信号只记录一次
        break;
      }
    }

    return [...new Set(detectedSignals)];
  }

  // ==========================================================
  // 否定与假设语境的基础过滤
  // ==========================================================

  /**
   * 尝试过滤明显的否定、定义或假设语境。
   *
   * 例如：
   * - 我没有严重胸痛
   * - 什么是严重胸痛
   * - 假设有人严重胸痛
   *
   * 注意：
   * 这是降低明显误报的辅助规则，
   * 不能可靠理解所有复杂否定、引用或历史语境。
   */
  private isNegatedOrHypothetical(
    message: string,
    matchPosition: number,
  ): boolean {
    const start = Math.max(
      0,
      matchPosition - 24,
    );

    const precedingText = message.slice(
      start,
      matchPosition,
    );

    // 只取当前分句，避免前面的无关内容影响判断
    const clauses = precedingText.split(
      /[，,。.!?！？；;\n]/u,
    );

    const currentClause =
      clauses[clauses.length - 1]?.trim() ?? '';

    const negationPattern =
      /(?:没有|并无|否认|未出现|未发生|不存在|不曾|未曾)(?:出现|发生|过|感觉到)?$/u;

    const hypotheticalPattern =
      /(?:什么是|解释一下|举个例子|例如|假设|如果|如何描述|怎么写)$/u;

    return (
      negationPattern.test(currentClause) ||
      hypotheticalPattern.test(currentClause)
    );
  }

  // ==========================================================
  // Segment 原文一致性校验
  // ==========================================================

  /**
   * 校验模型输出的每个 Segment
   * 是否能在用户原文中找到对应内容。
   *
   * 允许忽略空格和标点差异，
   * 但不允许凭空新增任务内容。
   */
  private validateSegmentContents(
    userMessage: string,
    result: P1Result,
    emergencyRequired: boolean,
  ): void {
    const normalizedMessage =
      this.normalizeText(userMessage);

    for (const segment of result.segments) {
      const normalizedSegment =
        this.normalizeText(segment.content);

      if (
        normalizedSegment.length === 0 ||
        !normalizedMessage.includes(
          normalizedSegment,
        )
      ) {
        throw new P1SafetyError(
          `Segment ${segment.segment_id} 的内容无法在用户原文中找到`,
          emergencyRequired,
        );
      }
    }
  }

  /**
   * 用于原文匹配的轻量归一化。
   *
   * Unicode NFKC：
   * 统一部分全角和半角字符。
   *
   * 删除：
   * - 空白字符
   * - 标点符号
   * - Unicode 符号
   */
  private normalizeText(value: string): string {
    return value
      .normalize('NFKC')
      .toLowerCase()
      .replace(/[\p{P}\p{S}\s]/gu, '');
  }
}
