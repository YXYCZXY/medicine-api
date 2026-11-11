
import 'reflect-metadata';

import { describe, expect, it } from 'vitest';

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
 * 正常医疗数据查询：
 * 查询药箱中的布洛芬数量。
 *
 * 预期：
 * - 医疗健康领域
 * - 无需症状风险评估
 * - 允许进入 P2
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
 * 纯非医疗请求：
 * 请求编写 Vue 页面。
 *
 * 预期：
 * - 非医疗领域
 * - 拒绝
 * - 不进入 P2
 */
function createNonMedicalQuery(): P1Result {
  return {
    stage: 'P1',
    domain_type: 'non_medical_health',

    segments: [
      {
        segment_id: 'seg_1',
        content: '帮我写一个 Vue 页面',
        domain: 'non_medical_health',
        decision: 'refuse',
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
      continue_to_p2: false,
      p2_segment_ids: [],
      refused_segment_ids: ['seg_1'],
      urgent_response_required: false,
      stop_normal_flow: true,
      safety_notice_required: false,
    },
  };
}

/**
 * 混合请求：
 * 医疗咨询 + Vue 页面开发。
 *
 * 预期：
 * - mixed
 * - 只允许医疗片段进入 P2
 * - 非医疗片段拒绝
 */
function createMixedQuery(): P1Result {
  return {
    stage: 'P1',
    domain_type: 'mixed',

    segments: [
      {
        segment_id: 'seg_1',
        content: '我感冒发烧应该怎么办',
        domain: 'medical_health',
        decision: 'continue_to_p2',
      },
      {
        segment_id: 'seg_2',
        content: '帮我生成一个 Vue 页面',
        domain: 'non_medical_health',
        decision: 'refuse',
      },
    ],

    medical_risk: {
      applicable: true,
      level: 'routine',
      assessment_status: 'insufficient_information',
      risk_signals: [],
      missing_information: [
        '当前体温',
        '发热持续时间',
        '伴随症状',
      ],
      recommended_action: 'continue_with_clarification',
    },

    routing: {
      continue_to_p2: true,
      p2_segment_ids: ['seg_1'],
      refused_segment_ids: ['seg_2'],
      urgent_response_required: false,
      stop_normal_flow: false,
      safety_notice_required: false,
    },
  };
}

/**
 * 紧急医疗请求：
 * 严重胸痛 + 呼吸困难。
 *
 * 预期：
 * - emergency
 * - 必须阻断普通 P2/P3
 * - 必须要求紧急安全响应
 */
function createEmergencyQuery(): P1Result {
  return {
    stage: 'P1',
    domain_type: 'medical_health',

    segments: [
      {
        segment_id: 'seg_1',
        content: '我胸口剧痛并且呼吸困难',
        domain: 'medical_health',
        decision: 'continue_to_p2',
      },
    ],

    medical_risk: {
      applicable: true,
      level: 'emergency',
      assessment_status: 'assessed',
      risk_signals: [
        'severe_chest_pain',
        'difficulty_breathing',
      ],
      missing_information: [],
      recommended_action: 'emergency_response',
    },

    routing: {
      continue_to_p2: false,
      p2_segment_ids: [],
      refused_segment_ids: [],
      urgent_response_required: true,
      stop_normal_flow: true,
      safety_notice_required: true,
    },
  };
}

/**
 * 需要关注的医疗请求。
 */
function createAttentionQuery(): P1Result {
  const result = createEmergencyQuery();

  result.segments[0].content = '我的发烧症状持续加重';

  result.medical_risk.level = 'needs_attention';
  result.medical_risk.risk_signals = [
    'worsening_symptoms',
  ];
  result.medical_risk.recommended_action =
    'seek_medical_attention';

  result.routing.continue_to_p2 = true;
  result.routing.p2_segment_ids = ['seg_1'];
  result.routing.urgent_response_required = false;
  result.routing.stop_normal_flow = false;

  return result;
}

// ============================================================
// P1 Validator 测试
// ============================================================

describe('P1ValidatorService', () => {
  const validator = new P1ValidatorService();

  // ==========================================================
  // 第一组：合法数据
  // ==========================================================

  describe('合法 P1 输出', () => {
    it('应该接受正常医疗数据查询', () => {
      const input = createMedicalQuery();

      const result = validator.validate(input);

      expect(result.stage).toBe('P1');
      expect(result.domain_type).toBe('medical_health');

      expect(result.medical_risk.applicable).toBe(false);
      expect(result.medical_risk.level).toBeNull();

      expect(result.routing.continue_to_p2).toBe(true);
      expect(result.routing.p2_segment_ids).toEqual([
        'seg_1',
      ]);
    });

    it('应该接受纯非医疗请求', () => {
      const result = validator.validate(
        createNonMedicalQuery(),
      );

      expect(result.domain_type).toBe(
        'non_medical_health',
      );

      expect(result.routing.continue_to_p2).toBe(false);
      expect(result.routing.stop_normal_flow).toBe(true);
      expect(result.routing.refused_segment_ids).toEqual([
        'seg_1',
      ]);
    });

    it('应该接受合法的混合请求', () => {
      const result = validator.validate(
        createMixedQuery(),
      );

      expect(result.domain_type).toBe('mixed');

      expect(result.routing.p2_segment_ids).toEqual([
        'seg_1',
      ]);

      expect(result.routing.refused_segment_ids).toEqual([
        'seg_2',
      ]);
    });

    it('应该接受合法的紧急风险请求', () => {
      const result = validator.validate(
        createEmergencyQuery(),
      );

      expect(result.medical_risk.level).toBe('emergency');

      expect(
        result.routing.urgent_response_required,
      ).toBe(true);

      expect(result.routing.continue_to_p2).toBe(false);
      expect(result.routing.p2_segment_ids).toEqual([]);
      expect(result.routing.stop_normal_flow).toBe(true);
    });

    it('应该接受需要关注的医疗请求', () => {
      const result = validator.validate(
        createAttentionQuery(),
      );

      expect(result.medical_risk.level).toBe(
        'needs_attention',
      );

      expect(result.routing.safety_notice_required).toBe(
        true,
      );

      expect(result.routing.continue_to_p2).toBe(true);
    });

    it('应该允许常规风险同时标记信息不足', () => {
      const result = validator.validate(
        createMixedQuery(),
      );

      expect(result.medical_risk.level).toBe('routine');

      expect(result.medical_risk.assessment_status).toBe(
        'insufficient_information',
      );

      expect(
        result.medical_risk.recommended_action,
      ).toBe('continue_with_clarification');
    });
  });

  // ==========================================================
  // 第二组：结构校验
  // ==========================================================

  describe('结构校验', () => {
    it('应该拒绝 null', () => {
      expect(() => validator.validate(null)).toThrow(
        P1ValidationError,
      );
    });

    it('应该拒绝数组作为顶层输出', () => {
      expect(() => validator.validate([])).toThrow(
        P1ValidationError,
      );
    });

    it('应该拒绝错误的 stage', () => {
      const input = {
        ...createMedicalQuery(),
        stage: 'P2',
      };

      expect(() => validator.validate(input)).toThrow(
        P1ValidationError,
      );
    });

    it('应该拒绝非法领域枚举', () => {
      const input = {
        ...createMedicalQuery(),
        domain_type: 'unknown_domain',
      };

      expect(() => validator.validate(input)).toThrow(
        P1ValidationError,
      );
    });

    it('应该拒绝空 segments', () => {
      const input = createMedicalQuery();

      input.segments = [];

      expect(() => validator.validate(input)).toThrow(
        P1ValidationError,
      );
    });

    it('应该拒绝缺少必要字段的 Segment', () => {
      const input = createMedicalQuery();

      input.segments[0].content = '';

      expect(() => validator.validate(input)).toThrow(
        P1ValidationError,
      );
    });

    it('应该拒绝额外的未知字段', () => {
      const input = {
        ...createMedicalQuery(),
        unexpected_field: 'invalid',
      };

      expect(() => validator.validate(input)).toThrow(
        P1ValidationError,
      );
    });

    it('应该拒绝错误的布尔字段类型', () => {
      const input = {
        ...createMedicalQuery(),
        routing: {
          ...createMedicalQuery().routing,
          continue_to_p2: 'true',
        },
      };

      expect(() => validator.validate(input)).toThrow(
        P1ValidationError,
      );
    });
  });

  // ==========================================================
  // 第三组：领域一致性
  // ==========================================================

  describe('领域与 Segment 一致性', () => {
    it('应该拒绝重复的 Segment ID', () => {
      const input = createMixedQuery();

      input.segments[1].segment_id = 'seg_1';

      expect(() => validator.validate(input)).toThrow(
        P1ValidationError,
      );
    });

    it('应该拒绝非医疗片段进入 P2 的决定', () => {
      const input = createNonMedicalQuery();

      input.segments[0].decision = 'continue_to_p2';

      expect(() => validator.validate(input)).toThrow(
        P1ValidationError,
      );
    });

    it('应该拒绝整体领域与片段领域不一致', () => {
      const input = createMixedQuery();

      input.domain_type = 'medical_health';

      expect(() => validator.validate(input)).toThrow(
        P1ValidationError,
      );
    });

    it('应该拒绝非医疗片段进入 P2 路由列表', () => {
      const input = createMixedQuery();

      input.routing.p2_segment_ids = [
        'seg_1',
        'seg_2',
      ];

      expect(() => validator.validate(input)).toThrow(
        P1ValidationError,
      );
    });

    it('应该拒绝遗漏非医疗拒绝列表', () => {
      const input = createMixedQuery();

      input.routing.refused_segment_ids = [];

      expect(() => validator.validate(input)).toThrow(
        P1ValidationError,
      );
    });
  });

  // ==========================================================
  // 第四组：医疗风险一致性
  // ==========================================================

  describe('医疗风险一致性', () => {
    it('应该拒绝风险不适用却设置风险等级', () => {
      const input = createMedicalQuery();

      input.medical_risk.level = 'routine';

      expect(() => validator.validate(input)).toThrow(
        P1ValidationError,
      );
    });

    it('应该拒绝风险适用但没有风险等级', () => {
      const input = createMedicalQuery();

      input.medical_risk.applicable = true;
      input.medical_risk.level = null;
      input.medical_risk.assessment_status = 'assessed';

      expect(() => validator.validate(input)).toThrow(
        P1ValidationError,
      );
    });

    it('应该拒绝紧急风险使用普通推荐动作', () => {
      const input = createEmergencyQuery();

      input.medical_risk.recommended_action =
        'continue_to_p2';

      expect(() => validator.validate(input)).toThrow(
        P1ValidationError,
      );
    });

    it('应该拒绝纯非医疗请求启用风险评估', () => {
      const input = createNonMedicalQuery();

      input.medical_risk.applicable = true;
      input.medical_risk.level = 'routine';
      input.medical_risk.assessment_status = 'assessed';
      input.medical_risk.recommended_action =
        'continue_to_p2';

      expect(() => validator.validate(input)).toThrow(
        P1ValidationError,
      );
    });
  });

  // ==========================================================
  // 第五组：紧急安全路由
  // ==========================================================

  describe('紧急安全路由', () => {
    it('应该拒绝紧急风险继续进入 P2', () => {
      const input = createEmergencyQuery();

      input.routing.continue_to_p2 = true;
      input.routing.p2_segment_ids = ['seg_1'];

      expect(() => validator.validate(input)).toThrow(
        P1ValidationError,
      );
    });

    it('应该拒绝紧急风险没有停止普通流程', () => {
      const input = createEmergencyQuery();

      input.routing.stop_normal_flow = false;

      expect(() => validator.validate(input)).toThrow(
        P1ValidationError,
      );
    });

    it('应该拒绝紧急风险关闭紧急响应标记', () => {
      const input = createEmergencyQuery();

      input.routing.urgent_response_required = false;

      expect(() => validator.validate(input)).toThrow(
        P1ValidationError,
      );
    });

    it('应该拒绝紧急风险不要求安全提示', () => {
      const input = createEmergencyQuery();

      input.routing.safety_notice_required = false;

      expect(() => validator.validate(input)).toThrow(
        P1ValidationError,
      );
    });

    it('应该拒绝需要关注却不要求安全提示', () => {
      const input = createAttentionQuery();

      input.routing.safety_notice_required = false;

      expect(() => validator.validate(input)).toThrow(
        P1ValidationError,
      );
    });
  });
});
