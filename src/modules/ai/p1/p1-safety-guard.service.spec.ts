
import 'reflect-metadata';

import { describe, expect, it } from 'vitest';

import {
  P1SafetyError,
  P1SafetyGuardService,
} from './p1-safety-guard.service.js';

import {
  P1ValidationError,
  P1ValidatorService,
} from './p1-validator.service.js';

import type {
  P1Result,
} from './schemas/p1.schema.js';

// ============================================================
// 测试数据工厂
// ============================================================

/**
 * 普通医疗数据查询
 *
 * 风险不适用，允许进入 P2。
 */
function createMedicalQuery(): P1Result {
  return {
    stage: 'P1',
    domain_type: 'medical_health',

    segments: [
      {
        segment_id: 'seg_1',
        content: '我的布洛芬还有多少',
        domain: 'medical_health',
        decision: 'continue_to_p2',
      },
    ],

    medical_risk: {
      applicable: false,
      level: null,
      assessment_status: 'not_applicable',
      risk_signals: [],
      missing_information: [],
      recommended_action: 'not_applicable',
    },

    routing: {
      continue_to_p2: true,
      p2_segment_ids: ['seg_1'],
      refused_segment_ids: [],
      urgent_response_required: false,
      stop_normal_flow: false,
      safety_notice_required: false,
    },
  };
}

/**
 * 常规症状咨询
 *
 * 有风险评估需求，但目前信息不足。
 */
function createRoutineQuery(): P1Result {
  const result = createMedicalQuery();

  result.segments[0].content = '我头痛';

  result.medical_risk = {
    applicable: true,
    level: 'routine',
    assessment_status: 'insufficient_information',
    risk_signals: [],
    missing_information: ['疼痛程度', '持续时间'],
    recommended_action: 'continue_with_clarification',
  };

  return result;
}

/**
 * 需要关注的医疗请求
 */
function createAttentionQuery(): P1Result {
  const result = createRoutineQuery();

  result.segments[0].content = '发烧持续加重';

  result.medical_risk = {
    applicable: true,
    level: 'needs_attention',
    assessment_status: 'assessed',
    risk_signals: ['worsening_symptoms'],
    missing_information: [],
    recommended_action: 'seek_medical_attention',
  };

  result.routing.safety_notice_required = true;

  return result;
}

/**
 * 模型已经识别为紧急风险
 */
function createEmergencyQuery(): P1Result {
  const result = createRoutineQuery();

  result.segments[0].content = '我胸口剧痛，呼吸困难';

  result.medical_risk = {
    applicable: true,
    level: 'emergency',
    assessment_status: 'assessed',
    risk_signals: ['severe_chest_pain'],
    missing_information: [],
    recommended_action: 'emergency_response',
  };

  result.routing = {
    continue_to_p2: false,
    p2_segment_ids: [],
    refused_segment_ids: [],
    urgent_response_required: true,
    stop_normal_flow: true,
    safety_notice_required: true,
  };

  return result;
}

/**
 * 医疗 + 非医疗混合请求
 */
function createMixedQuery(): P1Result {
  const result = createRoutineQuery();

  result.domain_type = 'mixed';

  result.segments = [
    {
      segment_id: 'seg_1',
      content: '我发烧了',
      domain: 'medical_health',
      decision: 'continue_to_p2',
    },
    {
      segment_id: 'seg_2',
      content: '帮我写一个 Vue 页面',
      domain: 'non_medical_health',
      decision: 'refuse',
    },
  ];

  result.routing.refused_segment_ids = ['seg_2'];

  return result;
}

/**
 * 模型错误地把医疗急症归为非医疗领域。
 *
 * 这是结构合法但语义分类错误的模拟结果。
 */
function createMisclassifiedQuery(): P1Result {
  const result = createMedicalQuery();

  result.domain_type = 'non_medical_health';

  result.segments = [
    {
      segment_id: 'seg_1',
      content: '我胸口剧痛',
      domain: 'non_medical_health',
      decision: 'refuse',
    },
  ];

  result.routing = {
    continue_to_p2: false,
    p2_segment_ids: [],
    refused_segment_ids: ['seg_1'],
    urgent_response_required: false,
    stop_normal_flow: true,
    safety_notice_required: false,
  };

  return result;
}

/**
 * 验证 Safety Guard 异常及其紧急标记。
 */
function expectSafetyError(
  action: () => unknown,
  urgent: boolean,
): void {
  let caught: unknown;

  try {
    action();
  } catch (error) {
    caught = error;
  }

  expect(caught).toBeInstanceOf(P1SafetyError);

  expect(
    (caught as P1SafetyError).urgentResponseRequired,
  ).toBe(urgent);
}

// ============================================================
// Safety Guard 单元测试
// ============================================================

describe('P1SafetyGuardService', () => {
  const validator = new P1ValidatorService();

  const guard = new P1SafetyGuardService(validator);

  // ==========================================================
  // 第一组：正常风险保持
  // ==========================================================

  describe('正常风险保持', () => {
    it('普通药箱查询应该保持风险不适用', () => {
      const input = createMedicalQuery();

      const result = guard.evaluate(
        '我的布洛芬还有多少？',
        input,
      );

      expect(result.medical_risk.applicable).toBe(false);
      expect(result.medical_risk.level).toBeNull();

      expect(result.routing.continue_to_p2).toBe(true);
      expect(result.routing.p2_segment_ids).toEqual([
        'seg_1',
      ]);
    });

    it('没有命中紧急规则时应保留 routine', () => {
      const input = createRoutineQuery();

      const result = guard.evaluate('我头痛', input);

      expect(result.medical_risk.level).toBe('routine');

      expect(
        result.medical_risk.assessment_status,
      ).toBe('insufficient_information');

      expect(result.routing.continue_to_p2).toBe(true);
    });

    it('没有新增紧急信号时应保留 needs_attention', () => {
      const input = createAttentionQuery();

      const result = guard.evaluate(
        '发烧持续加重',
        input,
      );

      expect(result.medical_risk.level).toBe(
        'needs_attention',
      );

      expect(
        result.routing.safety_notice_required,
      ).toBe(true);
    });

    it('不能降低模型已经识别的 emergency', () => {
      const input = createEmergencyQuery();

      // 原文没有命中当前正则规则，
      // 但模型已经报告 emergency。
      input.segments[0].content = '我胸口不舒服';

      const result = guard.evaluate(
        '我胸口不舒服',
        input,
      );

      expect(result.medical_risk.level).toBe('emergency');

      expect(result.routing.continue_to_p2).toBe(false);

      expect(
        result.routing.urgent_response_required,
      ).toBe(true);

      expect(result.routing.stop_normal_flow).toBe(true);
    });
  });

  // ==========================================================
  // 第二组：紧急信号检测
  // ==========================================================

  describe('紧急信号检测', () => {
    it('应该检测严重胸痛和呼吸困难', () => {
      const signals = guard.detectEmergencySignals(
        '我胸口剧痛，而且呼吸困难',
      );

      expect(signals).toContain('severe_chest_pain');

      expect(signals).toContain('difficulty_breathing');
    });

    it('同类紧急信号不应该重复记录', () => {
      const signals = guard.detectEmergencySignals(
        '胸口剧痛，并且胸部剧痛',
      );

      expect(signals).toEqual(['severe_chest_pain']);
    });

    it('应该过滤当前规则支持的简单否定和假设表达', () => {
      const negated = guard.detectEmergencySignals(
        '我没有胸口剧痛',
      );

      const hypothetical = guard.detectEmergencySignals(
        '假设胸口剧痛，应该怎么办？',
      );

      expect(negated).toEqual([]);
      expect(hypothetical).toEqual([]);
    });

    it('空消息不应该产生紧急信号', () => {
      expect(guard.detectEmergencySignals('')).toEqual([]);

      expect(guard.detectEmergencySignals('   ')).toEqual(
        [],
      );
    });
  });

  // ==========================================================
  // 第三组：紧急风险升级
  // ==========================================================

  describe('紧急风险升级', () => {
    it('应该将 routine 升级为 emergency', () => {
      const input = createRoutineQuery();

      input.segments[0].content =
        '我胸口剧痛，而且呼吸困难';

      const result = guard.evaluate(
        '我胸口剧痛，而且呼吸困难',
        input,
      );

      expect(result.medical_risk.applicable).toBe(true);

      expect(result.medical_risk.level).toBe('emergency');

      expect(
        result.medical_risk.assessment_status,
      ).toBe('assessed');

      expect(
        result.medical_risk.recommended_action,
      ).toBe('emergency_response');

      expect(result.medical_risk.risk_signals).toContain(
        'severe_chest_pain',
      );

      expect(result.medical_risk.risk_signals).toContain(
        'difficulty_breathing',
      );

      expect(result.routing.continue_to_p2).toBe(false);
      expect(result.routing.p2_segment_ids).toEqual([]);

      expect(
        result.routing.urgent_response_required,
      ).toBe(true);

      expect(result.routing.stop_normal_flow).toBe(true);

      expect(
        result.routing.safety_notice_required,
      ).toBe(true);
    });

    it('应该将错误的不适用判断升级为 emergency', () => {
      const input = createMedicalQuery();

      input.segments[0].content = '我胸口剧痛';

      const result = guard.evaluate(
        '我胸口剧痛',
        input,
      );

      expect(result.medical_risk.applicable).toBe(true);
      expect(result.medical_risk.level).toBe('emergency');

      expect(result.routing.continue_to_p2).toBe(false);
      expect(result.routing.p2_segment_ids).toEqual([]);
    });

    it('应该将 needs_attention 升级为 emergency', () => {
      const input = createAttentionQuery();

      input.segments[0].content = '我胸口剧痛';

      const result = guard.evaluate(
        '我胸口剧痛',
        input,
      );

      expect(result.medical_risk.level).toBe('emergency');

      // 保留模型原有风险信号，同时增加新信号
      expect(result.medical_risk.risk_signals).toContain(
        'worsening_symptoms',
      );

      expect(result.medical_risk.risk_signals).toContain(
        'severe_chest_pain',
      );

      expect(
        result.medical_risk.recommended_action,
      ).toBe('emergency_response');
    });

    it('混合请求出现紧急风险时应该清空 P2 列表', () => {
      const input = createMixedQuery();

      input.segments[0].content = '我胸口剧痛';

      const result = guard.evaluate(
        '我胸口剧痛，另外帮我写一个 Vue 页面',
        input,
      );

      expect(result.domain_type).toBe('mixed');

      expect(result.medical_risk.level).toBe('emergency');

      expect(result.routing.continue_to_p2).toBe(false);

      expect(result.routing.p2_segment_ids).toEqual([]);

      // 非医疗片段仍保留在拒绝列表中
      expect(result.routing.refused_segment_ids).toEqual([
        'seg_2',
      ]);

      expect(result.routing.stop_normal_flow).toBe(true);
    });
  });

  // ==========================================================
  // 第四组：错误分类与非法模型结果
  // ==========================================================

  describe('错误分类与非法结果', () => {
    it('错误将急症分类为非医疗时应触发紧急异常', () => {
      const input = createMisclassifiedQuery();

      expectSafetyError(
        () => guard.evaluate('我胸口剧痛', input),
        true,
      );
    });

    it('紧急原文遇到非法模型结果应触发紧急异常', () => {
      const input = createMedicalQuery();

      input.segments[0].content = '我胸口剧痛';

      // 故意制造内部路由矛盾
      input.routing.continue_to_p2 = false;

      expectSafetyError(
        () => guard.evaluate('我胸口剧痛', input),
        true,
      );
    });

    it('普通原文遇到非法模型结果应拒绝校验', () => {
      const input = createMedicalQuery();

      // 故意制造内部路由矛盾
      input.routing.continue_to_p2 = false;

      expect(() =>
        guard.evaluate('我的布洛芬还有多少', input),
      ).toThrow(P1ValidationError);
    });
  });

  // ==========================================================
  // 第五组：Segment 原文一致性
  // ==========================================================

  describe('Segment 原文一致性', () => {
    it('普通请求存在虚构 Segment 时应抛出安全异常', () => {
      const input = createRoutineQuery();

      input.segments[0].content = '帮我查我的药箱';

      expectSafetyError(
        () => guard.evaluate('我头痛', input),
        false,
      );
    });

    it('紧急请求存在虚构 Segment 时应保留紧急标记', () => {
      const input = createRoutineQuery();

      input.segments[0].content = '帮我查药箱';

      expectSafetyError(
        () => guard.evaluate('我胸口剧痛', input),
        true,
      );
    });

    it('应该允许空格和标点差异', () => {
      const input = createRoutineQuery();

      input.segments[0].content = '我胸口剧痛';

      const result = guard.evaluate(
        '我 胸口剧痛！',
        input,
      );

      expect(result.medical_risk.level).toBe('emergency');

      expect(result.routing.continue_to_p2).toBe(false);
    });

    it('空白用户消息应该抛出安全异常', () => {
      expectSafetyError(
        () => guard.evaluate('   ', createMedicalQuery()),
        false,
      );
    });
  });
});
