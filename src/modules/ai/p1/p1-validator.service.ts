
import { Injectable } from '@nestjs/common';
import { plainToInstance, Type } from 'class-transformer';
import {
  ArrayMinSize,
  IsArray,
  IsBoolean,
  IsIn,
  IsNotEmpty,
  IsObject,
  IsString,
  ValidateIf,
  ValidateNested,
  validateSync,
} from 'class-validator';

import type { P1Result } from './schemas/p1.schema.ts';

// ============================================================
// P1 Validation Error
// ============================================================

export class P1ValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'P1ValidationError';
  }
}

// ============================================================
// P1 Segment DTO
// ============================================================

class P1SegmentDto {
  @IsString()
  @IsNotEmpty()
  segment_id!: string;

  @IsString()
  @IsNotEmpty()
  content!: string;

  @IsIn(['medical_health', 'non_medical_health'])
  domain!: string;

  @IsIn(['continue_to_p2', 'refuse'])
  decision!: string;
}

// ============================================================
// P1 Medical Risk DTO
// ============================================================

class P1MedicalRiskDto {
  @IsBoolean()
  applicable!: boolean;

  @ValidateIf((_, value) => value !== null)
  @IsIn(['emergency', 'needs_attention', 'routine'])
  level!: string | null;

  @IsIn([
    'assessed',
    'insufficient_information',
    'not_applicable',
  ])
  assessment_status!: string;

  @IsArray()
  @IsString({ each: true })
  risk_signals!: string[];

  @IsArray()
  @IsString({ each: true })
  missing_information!: string[];

  @IsIn([
    'emergency_response',
    'seek_medical_attention',
    'continue_to_p2',
    'continue_with_clarification',
    'not_applicable',
  ])
  recommended_action!: string;
}

// ============================================================
// P1 Routing DTO
// ============================================================

class P1RoutingDto {
  @IsBoolean()
  continue_to_p2!: boolean;

  @IsArray()
  @IsString({ each: true })
  p2_segment_ids!: string[];

  @IsArray()
  @IsString({ each: true })
  refused_segment_ids!: string[];

  @IsBoolean()
  urgent_response_required!: boolean;

  @IsBoolean()
  stop_normal_flow!: boolean;

  @IsBoolean()
  safety_notice_required!: boolean;
}

// ============================================================
// P1 Result DTO
// ============================================================

class P1ResultDto {
  @IsIn(['P1'])
  stage!: string;

  @IsIn([
    'medical_health',
    'non_medical_health',
    'mixed',
  ])
  domain_type!: string;

  @IsArray()
  @ArrayMinSize(1)
  @ValidateNested({ each: true })
  @Type(() => P1SegmentDto)
  segments!: P1SegmentDto[];

  @IsObject()
  @ValidateNested()
  @Type(() => P1MedicalRiskDto)
  medical_risk!: P1MedicalRiskDto;

  @IsObject()
  @ValidateNested()
  @Type(() => P1RoutingDto)
  routing!: P1RoutingDto;
}

// ============================================================
// P1 Validator Service
// ============================================================

@Injectable()
export class P1ValidatorService {
  /**
   * P1 模型输出统一校验入口
   *
   * 第一层：JSON 对象结构与字段类型校验
   * 第二层：领域、风险与路由之间的业务一致性校验
   *
   * 校验失败时抛出 P1ValidationError。
   * 本服务不执行安全降级或调用 P2。
   */
  validate(input: unknown): P1Result {
    // --------------------------------------------------------
    // 1. 顶层输入检查
    // --------------------------------------------------------

    if (
      input === null ||
      typeof input !== 'object' ||
      Array.isArray(input)
    ) {
      throw new P1ValidationError(
        'P1 模型输出必须是 JSON 对象',
      );
    }

    // --------------------------------------------------------
    // 2. 转换为 DTO
    // --------------------------------------------------------

    const result = plainToInstance(P1ResultDto, input);

    // --------------------------------------------------------
    // 3. 结构和类型校验
    // --------------------------------------------------------

    const errors = validateSync(result, {
      whitelist: true,
      forbidNonWhitelisted: true,
      forbidUnknownValues: true,
      stopAtFirstError: false,
    });

    if (errors.length > 0) {
      throw new P1ValidationError(
        'P1 模型输出结构校验失败',
      );
    }

    const validated = result as unknown as P1Result;

    // --------------------------------------------------------
    // 4. 跨字段业务规则校验
    // --------------------------------------------------------

    this.validateBusinessRules(validated);

    return validated;
  }

  /**
   * 检查 P1 输出的业务一致性。
   *
   * 注意：
   * - 不信任模型提供的最终路由决定。
   * - 非医疗片段不能进入 P2。
   * - 紧急风险必须停止普通流程。
   * - 不一致的结果直接拒绝，不擅自修改风险等级。
   */
  private validateBusinessRules(result: P1Result): void {
    const {
      segments,
      domain_type,
      medical_risk,
      routing,
    } = result;

    const fail = (message: string): never => {
      throw new P1ValidationError(message);
    };

    // ========================================================
    // 规则 1：Segment ID 必须唯一
    // ========================================================

    const allIds = segments.map(
      (segment) => segment.segment_id,
    );

    if (new Set(allIds).size !== allIds.length) {
      fail('Segment ID 存在重复');
    }

    // ========================================================
    // 规则 2：Segment 领域与处理决定必须一致
    // ========================================================

    for (const segment of segments) {
      if (
        segment.domain === 'medical_health' &&
        segment.decision !== 'continue_to_p2'
      ) {
        fail(
          '医疗片段的领域决定必须为 continue_to_p2',
        );
      }

      if (
        segment.domain === 'non_medical_health' &&
        segment.decision !== 'refuse'
      ) {
        fail('非医疗片段必须标记为 refuse');
      }
    }

    // ========================================================
    // 规则 3：提取医疗与非医疗 Segment ID
    // ========================================================

    const medicalIds = segments
      .filter(
        (segment) =>
          segment.domain === 'medical_health',
      )
      .map((segment) => segment.segment_id);

    const nonMedicalIds = segments
      .filter(
        (segment) =>
          segment.domain === 'non_medical_health',
      )
      .map((segment) => segment.segment_id);

    const hasMedical = medicalIds.length > 0;

    const hasNonMedical = nonMedicalIds.length > 0;

    // ========================================================
    // 规则 4：整体领域必须与 Segment 分类一致
    // ========================================================

    const expectedDomain =
      hasMedical && hasNonMedical
        ? 'mixed'
        : hasMedical
          ? 'medical_health'
          : 'non_medical_health';

    if (domain_type !== expectedDomain) {
      fail('整体领域与 Segment 领域不一致');
    }

    // ========================================================
    // 规则 5：医疗风险适用性校验
    // ========================================================

    // 纯非医疗请求不能启用医疗风险评估
    if (!hasMedical && medical_risk.applicable) {
      fail('纯非医疗请求不能启用医疗风险评估');
    }

    if (!medical_risk.applicable) {
      // 风险不适用时必须使用固定状态
      if (
        medical_risk.level !== null ||
        medical_risk.assessment_status !==
          'not_applicable' ||
        medical_risk.recommended_action !==
          'not_applicable'
      ) {
        fail(
          '风险不适用时，风险字段必须为不适用状态',
        );
      }
    } else {
      // 风险适用时必须提供风险等级和评估状态
      if (
        medical_risk.level === null ||
        medical_risk.assessment_status ===
          'not_applicable'
      ) {
        fail(
          '风险适用时必须提供有效风险等级和评估状态',
        );
      }

      // 根据风险等级推导正确的推荐动作
      const expectedAction =
        medical_risk.level === 'emergency'
          ? 'emergency_response'
          : medical_risk.level === 'needs_attention'
            ? 'seek_medical_attention'
            : medical_risk.assessment_status ===
                'insufficient_information'
              ? 'continue_with_clarification'
              : 'continue_to_p2';

      if (
        medical_risk.recommended_action !==
        expectedAction
      ) {
        fail('风险等级与建议动作不一致');
      }
    }

    // ========================================================
    // 规则 6：判断是否存在紧急风险
    // ========================================================

    const emergency =
      medical_risk.applicable &&
      medical_risk.level === 'emergency';

    // ========================================================
    // 规则 7：路由 Segment ID 一致性校验
    // ========================================================

    /**
     * 比较实际 ID 与预期 ID。
     *
     * 要求：
     * - 数量相同
     * - 不允许重复
     * - 每个实际 ID 都属于预期集合
     */
    const assertSameIds = (
      actual: string[],
      expected: string[],
      fieldName: string,
    ): void => {
      if (
        actual.length !== expected.length ||
        new Set(actual).size !== actual.length ||
        !actual.every((id) =>
          expected.includes(id),
        )
      ) {
        fail(
          `${fieldName} 与片段分类不一致`,
        );
      }
    };

    // 非医疗片段必须全部拒绝
    assertSameIds(
      routing.refused_segment_ids,
      nonMedicalIds,
      'refused_segment_ids',
    );

    // 紧急请求必须清空 P2 路由
    assertSameIds(
      routing.p2_segment_ids,
      emergency ? [] : medicalIds,
      'p2_segment_ids',
    );

    // ========================================================
    // 规则 8：是否允许继续 P2
    // ========================================================

    const shouldContinue =
      hasMedical && !emergency;

    if (
      routing.continue_to_p2 !== shouldContinue
    ) {
      fail(
        'continue_to_p2 与领域或风险不一致',
      );
    }

    // ========================================================
    // 规则 9：紧急响应标记必须一致
    // ========================================================

    if (
      routing.urgent_response_required !==
      emergency
    ) {
      fail(
        'urgent_response_required 与紧急风险不一致',
      );
    }

    // ========================================================
    // 规则 10：普通流程停止标记必须一致
    // ========================================================

    // 紧急请求或纯非医疗请求必须停止普通流程
    const shouldStop =
      emergency || !hasMedical;

    if (
      routing.stop_normal_flow !== shouldStop
    ) {
      fail(
        'stop_normal_flow 与最终路由不一致',
      );
    }

    // ========================================================
    // 规则 11：高风险与需要关注时必须提示安全信息
    // ========================================================

    if (
      (
        emergency ||
        medical_risk.level === 'needs_attention'
      ) &&
      !routing.safety_notice_required
    ) {
      fail(
        '高风险或需要关注的请求必须要求安全提示',
      );
    }
  }
}
