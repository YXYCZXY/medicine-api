
import 'reflect-metadata';

import {
  afterEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';

import {
  P1Service,
} from './p1.service.js';

import {
  P1ParserError,
  P1ParserService,
} from './p1-parser.service.js';

import {
  P1ValidatorService,
} from './p1-validator.service.js';

import {
  P1SafetyError,
  P1SafetyGuardService,
} from './p1-safety-guard.service.js';

import {
  P1RouterService,
} from './p1-router.service.js';

import {
  OllamaClientError,
} from '../llm/ollama.service.js';

import type {
  P1Result,
} from './schemas/p1.schema.js';

// ============================================================
// 测试数据工厂
// ============================================================

/**
 * 普通医疗数据查询。
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
 * 纯非医疗请求。
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
 * 医疗 + 非医疗混合请求。
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
 * 常规风险，但信息不足。
 */
function createRoutineQuery(): P1Result {
  const result = createMedicalQuery();

  result.segments[0]!.content = '我头痛';

  result.medical_risk = {
    applicable: true,
    level: 'routine',
    assessment_status: 'insufficient_information',
    risk_signals: [],
    missing_information: [
      '疼痛程度',
      '持续时间',
    ],
    recommended_action: 'continue_with_clarification',
  };

  return result;
}

/**
 * 需要关注的医疗请求。
 */
function createAttentionQuery(): P1Result {
  const result = createRoutineQuery();

  result.segments[0]!.content = '发烧持续加重';

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
 * 模型已经识别为 emergency。
 *
 * 故意使用不命中当前 Safety Guard
 * 正则表达式的原文，验证：
 * 后端不能降低模型已经报告的紧急风险。
 */
function createEmergencyQuery(): P1Result {
  const result = createRoutineQuery();

  result.segments[0]!.content = '我胸口不舒服';

  result.medical_risk = {
    applicable: true,
    level: 'emergency',
    assessment_status: 'assessed',
    risk_signals: ['reported_emergency'],
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
 * 多个医疗任务。
 *
 * 多个医疗任务不等于 mixed。
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
// 测试上下文
// ============================================================

/**
 * 创建 P1Service 测试环境。
 *
 * 使用：
 * - Mock Parser
 * - 真实 Validator
 * - 真实 Safety Guard
 * - 真实 Router
 *
 * 不启动 NestJS 应用。
 * 不调用 Ollama。
 * 不访问数据库。
 */
function createTestContext(
  modelResult: unknown = createMedicalQuery(),
) {
  const classify = vi.fn<
    P1ParserService['classify']
  >();

  classify.mockResolvedValue(modelResult);

  const parser = {
    classify,
  } as unknown as P1ParserService;

  const validator = new P1ValidatorService();

  const safetyGuard =
    new P1SafetyGuardService(validator);

  const router =
    new P1RouterService(validator);

  const service = new P1Service(
    parser,
    validator,
    safetyGuard,
    router,
  );

  return {
    service,
    classify,
    validator,
    safetyGuard,
    router,
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

// ============================================================
// P1Service 单元测试
// ============================================================

describe('P1Service', () => {

  // ==========================================================
  // 第一组：模型调用前的安全检查
  // ==========================================================

  describe('模型调用前的安全检查', () => {

    it('明显紧急信号应该在模型调用前被拦截', async () => {
      const { service, classify } =
        createTestContext();

      const result = await service.process(
        '我胸口剧痛，而且呼吸困难',
      );

      expect(result).toEqual({
        action: 'URGENT_RESPONSE',
        result: null,
        source: 'PRE_MODEL_SAFETY_CHECK',
        detectedSignals: [
          'severe_chest_pain',
          'difficulty_breathing',
        ],
      });

      // 核心安全要求：不等待模型。
      expect(classify).not.toHaveBeenCalled();
    });

    it('紧急信号应优先于普通任务', async () => {
      const { service, classify } =
        createTestContext();

      const result = await service.process(
        '我胸口剧痛，另外帮我查询药箱',
      );

      expect(result.action).toBe(
        'URGENT_RESPONSE',
      );

      expect(result).toMatchObject({
        result: null,
        source: 'PRE_MODEL_SAFETY_CHECK',
      });

      expect(classify).not.toHaveBeenCalled();
    });

    it('空白用户消息应该安全降级', async () => {
      const { service, classify } =
        createTestContext();

      const result = await service.process(
        '   ',
      );

      expect(result).toEqual({
        action: 'SAFE_FALLBACK',
        reason: 'INVALID_USER_MESSAGE',
      });

      expect(classify).not.toHaveBeenCalled();
    });

    it('调用前已取消的请求不应该进入模型', async () => {
      const { service, classify } =
        createTestContext();

      const controller = new AbortController();

      controller.abort();

      const result = await service.process(
        '我的布洛芬还有多少',
        {
          signal: controller.signal,
        },
      );

      expect(result).toEqual({
        action: 'SAFE_FALLBACK',
        reason: 'REQUEST_CANCELLED',
      });

      expect(classify).not.toHaveBeenCalled();
    });
  });

  // ==========================================================
  // 第二组：正常编排流程
  // ==========================================================

  describe('正常编排流程', () => {

    it('普通药箱查询应该允许进入 P2', async () => {
      const { service, classify } =
        createTestContext(
          createMedicalQuery(),
        );

      const result = await service.process(
        '我的布洛芬还有多少？',
      );

      expect(classify).toHaveBeenCalledTimes(1);

      expect(result).toMatchObject({
        action: 'CONTINUE_TO_P2',
        allowedSegmentIds: ['seg_1'],
        safetyNoticeRequired: false,
      });
    });

    it('纯非医疗请求应该被拒绝', async () => {
      const { service } =
        createTestContext(
          createNonMedicalQuery(),
        );

      const result = await service.process(
        '帮我写一个 Vue 页面',
      );

      expect(result).toMatchObject({
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

    it('混合请求应该只允许医疗片段继续', async () => {
      const { service } =
        createTestContext(
          createMixedQuery(),
        );

      const result = await service.process(
        '我的布洛芬还有多少？另外帮我写一个 Vue 页面。',
      );

      expect(result).toMatchObject({
        action: 'CONTINUE_TO_P2',
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

    it('多个医疗任务应该保持 medical_health', async () => {
      const { service } =
        createTestContext(
          createMultipleMedicalQuery(),
        );

      const result = await service.process(
        '我的布洛芬还有多少？查询我的就诊记录。',
      );

      expect(result).toMatchObject({
        action: 'CONTINUE_TO_P2',
        allowedSegmentIds: [
          'seg_1',
          'seg_2',
        ],
        result: {
          domain_type: 'medical_health',
        },
      });
    });

    it('常规风险的信息不足状态应该保留', async () => {
      const { service } =
        createTestContext(
          createRoutineQuery(),
        );

      const result = await service.process(
        '我头痛',
      );

      expect(result).toMatchObject({
        action: 'CONTINUE_TO_P2',
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

    it('需要关注的请求必须保留安全提示要求', async () => {
      const { service } =
        createTestContext(
          createAttentionQuery(),
        );

      const result = await service.process(
        '发烧持续加重',
      );

      expect(result).toMatchObject({
        action: 'CONTINUE_TO_P2',
        allowedSegmentIds: ['seg_1'],
        safetyNoticeRequired: true,
        result: {
          medical_risk: {
            level: 'needs_attention',
          },
        },
      });
    });

    it('不能降低模型已识别的紧急风险', async () => {
      const { service, classify } =
        createTestContext(
          createEmergencyQuery(),
        );

      const result = await service.process(
        '我胸口不舒服',
      );

      // 原文没有命中当前预检查规则，
      // 因此模型仍然会被调用。
      expect(classify).toHaveBeenCalledTimes(1);

      expect(result).toMatchObject({
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
  });

  // ==========================================================
  // 第三组：模型及结构异常
  // ==========================================================

  describe('模型与结构异常', () => {

    it('Parser JSON 解析失败应该安全降级', async () => {
      const { service, classify } =
        createTestContext();

      classify.mockRejectedValue(
        new P1ParserError(
          'INVALID_MODEL_JSON',
          '模型返回无效 JSON',
        ),
      );

      const result = await service.process(
        '我的布洛芬还有多少',
      );

      expect(result).toEqual({
        action: 'SAFE_FALLBACK',
        reason: 'P1_PARSER_FAILED',
      });
    });

    it('Validator 拒绝非法模型结果时应该安全降级', async () => {
      const invalidResult = {
        ...createMedicalQuery(),
        stage: 'P2',
      };

      const { service } =
        createTestContext(invalidResult);

      const result = await service.process(
        '我的布洛芬还有多少',
      );

      expect(result).toEqual({
        action: 'SAFE_FALLBACK',
        reason: 'P1_VALIDATION_FAILED',
      });
    });

    it('模型返回非法顶层结构应该安全降级', async () => {
      const { service } =
        createTestContext([]);

      const result = await service.process(
        '我的布洛芬还有多少',
      );

      expect(result).toEqual({
        action: 'SAFE_FALLBACK',
        reason: 'P1_VALIDATION_FAILED',
      });
    });

    it('模型超时应该安全降级', async () => {
      const { service, classify } =
        createTestContext();

      classify.mockRejectedValue(
        new OllamaClientError(
          'MODEL_TIMEOUT',
          '模型请求超时',
        ),
      );

      const result = await service.process(
        '我的布洛芬还有多少',
      );

      expect(result).toEqual({
        action: 'SAFE_FALLBACK',
        reason: 'P1_PROCESSING_FAILED',
      });
    });

    it('未知模型异常不应该放行到 P2', async () => {
      const { service, classify } =
        createTestContext();

      classify.mockRejectedValue(
        new Error('unexpected error'),
      );

      const result = await service.process(
        '我的布洛芬还有多少',
      );

      expect(result.action).toBe(
        'SAFE_FALLBACK',
      );

      expect(result).not.toHaveProperty(
        'allowedSegmentIds',
      );
    });
  });

  // ==========================================================
  // 第四组：Safety Guard 异常处理
  // ==========================================================

  describe('Safety Guard 异常处理', () => {

    it('模型虚构 Segment 应该触发安全降级', async () => {
      const invalidResult = createRoutineQuery();

      invalidResult.segments[0]!.content =
        '查询我的全部药箱记录';

      const { service } =
        createTestContext(invalidResult);

      const result = await service.process(
        '我头痛',
      );

      expect(result).toEqual({
        action: 'SAFE_FALLBACK',
        reason: 'P1_SAFETY_CHECK_FAILED',
      });
    });

    it('Safety Guard 紧急异常应优先返回紧急响应', async () => {
      const {
        service,
        safetyGuard,
      } = createTestContext();

      // 模拟 Safety Guard 在额外安全检查中
      // 发现需要紧急响应的情况。
      vi.spyOn(
        safetyGuard,
        'evaluate',
      ).mockImplementation(() => {
        throw new P1SafetyError(
          '检测到需要紧急响应的安全异常',
          true,
        );
      });

      const result = await service.process(
        '我的布洛芬还有多少',
      );

      expect(result).toEqual({
        action: 'URGENT_RESPONSE',
        result: null,
        source: 'SAFETY_GUARD',
        detectedSignals: [],
      });
    });
  });

  // ==========================================================
  // 第五组：取消信号传递
  // ==========================================================

  describe('取消信号传递', () => {

    it('应该将 AbortSignal 传递给 Parser', async () => {
      const {
        service,
        classify,
      } = createTestContext(
        createRoutineQuery(),
      );

      const controller = new AbortController();

      const result = await service.process(
        '我头痛',
        {
          signal: controller.signal,
        },
      );

      expect(classify).toHaveBeenCalledWith(
        '我头痛',
        {
          signal: controller.signal,
        },
      );

      expect(result.action).toBe(
        'CONTINUE_TO_P2',
      );
    });

    it('模型执行期间取消请求应该安全降级', async () => {
      const {
        service,
        classify,
      } = createTestContext();

      const controller = new AbortController();

      classify.mockImplementation(async () => {
        controller.abort();

        throw new Error('request aborted');
      });

      const result = await service.process(
        '我的布洛芬还有多少',
        {
          signal: controller.signal,
        },
      );

      expect(result).toEqual({
        action: 'SAFE_FALLBACK',
        reason: 'REQUEST_CANCELLED',
      });
    });
  });
});
