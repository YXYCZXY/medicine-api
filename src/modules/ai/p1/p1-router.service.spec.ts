
import 'reflect-metadata';

import { describe, expect, it } from 'vitest';

import { P1RouterService } from './p1-router.service.js';
import { P1ValidatorService } from './p1-validator.service.js';

import type { P1Result } from './schemas/p1.schema.js';

// ============================================================
// 测试数据工厂
// ============================================================

/**
 * 普通医疗数据查询
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
 * 纯非医疗请求
 * 必须拒绝，不进入 P2。
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
 * 医疗 + 非医疗混合请求
 * 只有医疗片段允许进入 P2。
 */
function createMixedQuery(): P1Result {
  const result = createMedicalQuery();

  result.domain_type = 'mixed';
  result.segments.push({
    segment_id: 'seg_2',
    content: '帮我写一个 Vue 页面',
    domain: 'non_medical_health',
    decision: 'refuse',
  });

  result.routing.refused_segment_ids = ['seg_2'];

  return result;
}

/**
 * 常规症状咨询
 * 当前信息不足，但未识别出明确紧急信号。
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
 * 允许继续 P2，但必须保留安全提示要求。
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
 * 紧急医疗请求
 * 必须停止普通流程。
 */
function createEmergencyQuery(): P1Result {
  const result = createRoutineQuery();

  result.segments[0].content = '我胸口剧痛并且呼吸困难';

  result.medical_risk = {
    applicable: true,
    level: 'emergency',
    assessment_status: 'assessed',
    risk_signals: [
      'severe_chest_pain',
      'difficulty_breathing',
    ],
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
 * 混合请求 + 紧急风险
 * 必须同时保留非医疗拒绝结果，
 * 并阻断全部普通 P2/P3 流程。
 */
function createMixedEmergencyQuery(): P1Result {
  const result = createEmergencyQuery();

  result.domain_type = 'mixed';

  result.segments.push({
    segment_id: 'seg_2',
    content: '帮我写一个 Vue 页面',
    domain: 'non_medical_health',
    decision: 'refuse',
  });

  result.routing.refused_segment_ids = ['seg_2'];

  return result;
}

/**
 * 多个医疗任务，但不是 mixed。
 */
function createMultipleMedicalQuery(): P1Result {
  const result = createMedicalQuery();

  result.segments.push({
    segment_id: 'seg_2',
    content: '查询我的就诊记录',
    domain: 'medical_health',
    decision: 'continue_to_p2',
  });

  result.routing.p2_segment_ids = [
    'seg_1',
    'seg_2',
  ];

  return result;
}

// ============================================================
// P1 Router 单元测试
// ============================================================

describe('P1RouterService', () => {
  const validator = new P1ValidatorService();
  const router = new P1RouterService(validator);

  // ==========================================================
  // 第一组：正常路由
  // ==========================================================

  describe('正常路由', () => {
    it('纯非医疗请求应该返回 REFUSE', () => {
      const input = createNonMedicalQuery();

      const route = router.route(input);

      expect(route.action).toBe('REFUSE');

      expect(route).toMatchObject({
        action: 'REFUSE',
        result: {
          domain_type: 'non_medical_health',
          routing: {
            continue_to_p2: false,
            p2_segment_ids: [],
            refused_segment_ids: ['seg_1'],
          },
        },
      });
    });

    it('医疗数据查询应该进入 P2', () => {
      const route = router.route(
        createMedicalQuery(),
      );

      expect(route.action).toBe('CONTINUE_TO_P2');

      expect(route).toMatchObject({
        action: 'CONTINUE_TO_P2',
        allowedSegmentIds: ['seg_1'],
        safetyNoticeRequired: false,
      });
    });

    it('常规风险且信息不足时允许继续 P2', () => {
      const route = router.route(
        createRoutineQuery(),
      );

      expect(route.action).toBe('CONTINUE_TO_P2');

      expect(route).toMatchObject({
        allowedSegmentIds: ['seg_1'],
        result: {
          medical_risk: {
            level: 'routine',
            assessment_status:
              'insufficient_information',
            recommended_action:
              'continue_with_clarification',
          },
        },
      });
    });

    it('需要关注时应该继续 P2 并要求安全提示', () => {
      const route = router.route(
        createAttentionQuery(),
      );

      expect(route.action).toBe('CONTINUE_TO_P2');

      expect(route).toMatchObject({
        allowedSegmentIds: ['seg_1'],
        safetyNoticeRequired: true,
      });
    });

    it('混合请求只允许医疗片段进入 P2', () => {
      const route = router.route(
        createMixedQuery(),
      );

      expect(route.action).toBe('CONTINUE_TO_P2');

      expect(route).toMatchObject({
        allowedSegmentIds: ['seg_1'],
        result: {
          domain_type: 'mixed',
          routing: {
            p2_segment_ids: ['seg_1'],
            refused_segment_ids: ['seg_2'],
          },
        },
      });
    });

    it('多个医疗任务都应该进入 P2', () => {
      const route = router.route(
        createMultipleMedicalQuery(),
      );

      expect(route.action).toBe('CONTINUE_TO_P2');

      expect(route).toMatchObject({
        allowedSegmentIds: [
          'seg_1',
          'seg_2',
        ],
        result: {
          domain_type: 'medical_health',
        },
      });
    });

    it('模型要求常规安全提示时应该保留', () => {
      const input = createRoutineQuery();

      input.routing.safety_notice_required = true;

      const route = router.route(input);

      expect(route.action).toBe('CONTINUE_TO_P2');

      expect(route).toMatchObject({
        safetyNoticeRequired: true,
      });
    });
  });

  // ==========================================================
  // 第二组：紧急安全路由
  // ==========================================================

  describe('紧急安全路由', () => {
    it('紧急风险应该返回 URGENT_RESPONSE', () => {
      const route = router.route(
        createEmergencyQuery(),
      );

      expect(route.action).toBe('URGENT_RESPONSE');

      expect(route).toMatchObject({
        action: 'URGENT_RESPONSE',
        result: {
          medical_risk: {
            level: 'emergency',
          },
          routing: {
            continue_to_p2: false,
            p2_segment_ids: [],
            urgent_response_required: true,
            stop_normal_flow: true,
          },
        },
      });
    });

    it('混合请求中的紧急风险应该阻断普通流程', () => {
      const route = router.route(
        createMixedEmergencyQuery(),
      );

      expect(route.action).toBe('URGENT_RESPONSE');

      expect(route).toMatchObject({
        result: {
          domain_type: 'mixed',
          routing: {
            continue_to_p2: false,
            p2_segment_ids: [],
            refused_segment_ids: ['seg_2'],
            urgent_response_required: true,
            stop_normal_flow: true,
          },
        },
      });
    });

    it('紧急路由不应该返回可执行的 P2 任务列表', () => {
      const route = router.route(
        createEmergencyQuery(),
      );

      expect(route.action).toBe('URGENT_RESPONSE');

      expect(route).not.toHaveProperty(
        'allowedSegmentIds',
      );
    });
  });

  // ==========================================================
  // 第三组：非法数据安全降级
  // ==========================================================

  describe('非法数据安全降级', () => {
    it('null 输入应该返回 SAFE_FALLBACK', () => {
      const route = router.route(null);

      expect(route).toEqual({
        action: 'SAFE_FALLBACK',
        reason: 'P1_RESULT_VALIDATION_FAILED',
      });
    });

    it('非法 stage 应该安全降级', () => {
      const input = {
        ...createMedicalQuery(),
        stage: 'P2',
      };

      const route = router.route(input);

      expect(route.action).toBe('SAFE_FALLBACK');
    });

    it('额外的未知字段应该安全降级', () => {
      const input = {
        ...createMedicalQuery(),
        unexpected_field: true,
      };

      const route = router.route(input);

      expect(route.action).toBe('SAFE_FALLBACK');
    });

    it('空 segments 应该安全降级', () => {
      const input = createMedicalQuery();

      input.segments = [];

      const route = router.route(input);

      expect(route.action).toBe('SAFE_FALLBACK');
    });

    it('整体领域与 Segment 不一致应该安全降级', () => {
      const input = createMixedQuery();

      input.domain_type = 'medical_health';

      const route = router.route(input);

      expect(route.action).toBe('SAFE_FALLBACK');
    });

    it('非医疗片段混入 P2 应该安全降级', () => {
      const input = createMixedQuery();

      input.routing.p2_segment_ids = [
        'seg_1',
        'seg_2',
      ];

      const route = router.route(input);

      expect(route.action).toBe('SAFE_FALLBACK');
    });

    it('遗漏非医疗拒绝列表应该安全降级', () => {
      const input = createMixedQuery();

      input.routing.refused_segment_ids = [];

      const route = router.route(input);

      expect(route.action).toBe('SAFE_FALLBACK');
    });

    it('紧急风险错误地允许 P2 应该安全降级', () => {
      const input = createEmergencyQuery();

      input.routing.continue_to_p2 = true;
      input.routing.p2_segment_ids = ['seg_1'];

      const route = router.route(input);

      expect(route.action).toBe('SAFE_FALLBACK');
    });

    it('紧急风险未停止普通流程应该安全降级', () => {
      const input = createEmergencyQuery();

      input.routing.stop_normal_flow = false;

      const route = router.route(input);

      expect(route.action).toBe('SAFE_FALLBACK');
    });

    it('需要关注却没有安全提示应该安全降级', () => {
      const input = createAttentionQuery();

      input.routing.safety_notice_required = false;

      const route = router.route(input);

      expect(route.action).toBe('SAFE_FALLBACK');
    });

    it('重复 Segment ID 应该安全降级', () => {
      const input = createMultipleMedicalQuery();

      input.segments[1].segment_id = 'seg_1';

      const route = router.route(input);

      expect(route.action).toBe('SAFE_FALLBACK');
    });
  });

  // ==========================================================
  // 第四组：SAFE_FALLBACK 协议
  // ==========================================================

  describe('SAFE_FALLBACK 协议', () => {
    it('应该生成明确的安全降级结果', () => {
      const route = router.safeFallback(
        'MODEL_TIMEOUT',
      );

      expect(route).toEqual({
        action: 'SAFE_FALLBACK',
        reason: 'MODEL_TIMEOUT',
      });

      expect(route).not.toHaveProperty(
        'allowedSegmentIds',
      );

      expect(route).not.toHaveProperty(
        'result',
      );
    });
  });
});
