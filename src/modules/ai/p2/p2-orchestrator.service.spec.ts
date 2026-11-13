import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { P1RouteResult } from '../p1/p1-router.service.js';
import { P2IntentModelClientError } from './p2-intent-model-client.service.js';
import { P2IntentValidationError } from './p2-intent-validator.service.js';
import { P2OrchestratorService } from './p2-orchestrator.service.js';
import type {
  P2DictionaryContext,
  P2Intent,
  P2ProcessResult,
  P2UnresolvedSegment,
} from './schemas/p2.schema.js';

/**
 * P2 第 16 步：只测试 Orchestrator 编排，不启动 NestJS、LLM 或数据库。
 * 依赖服务均使用测试替身，避免触发真实 UserDictionariesService。
 */
describe('P2OrchestratorService', () => {
  const segment = {
    segment_id: 'seg_1',
    content: '查一下布洛芬还剩多少',
    domain: 'medical_health',
    decision: 'continue_to_p2',
  };

  const route = {
    action: 'CONTINUE_TO_P2',
    allowedSegmentIds: ['seg_1'],
    safetyNoticeRequired: true,
    result: { segments: [segment] },
  } as unknown as P1RouteResult;

  const requestContext = {
    request_time: '2026-11-12T09:00:00.000Z',
    timezone: 'Asia/Shanghai',
  };

  const dictionary: P2DictionaryContext = {
    status: 'available',
    values: {
      categories: ['退烧药', '感冒药'],
      efficacies: ['退热'],
      symptoms: ['发热'],
    },
  };

  const candidate = {
    kind: 'category' as const,
    dictionary_value: '退烧药',
    matched_concept: '退烧药',
    source_text: '退烧药',
    relation: 'exact' as const,
  };

  const readyIntent: P2Intent = {
    intent_id: 'intent_1',
    type: 'medicine.search',
    source_segment_ids: ['seg_1'],
    state: 'ready',
    parameters: {
      medicine_names: ['布洛芬'],
      query_focus: 'inventory_quantity',
      keywords: [],
    },
    dictionary_candidates: [],
    missing_fields: [],
  };

  const clarificationIntent: P2Intent = {
    intent_id: 'intent_2',
    type: 'reminder.create',
    source_segment_ids: ['seg_1'],
    state: 'needs_clarification',
    parameters: { fields: [] },
    dictionary_candidates: [],
    missing_fields: [
      { field: 'remind_at', reason: 'unresolved_time' },
      { field: 'content', reason: 'required' },
    ],
  };

  const unresolved: P2UnresolvedSegment = {
    segment_id: 'seg_1',
    reason: 'unsupported_intent',
  };

  const entryGuard = { check: vi.fn() };
  const dictionaryContext = { load: vi.fn() };
  const dictionaryMatcher = { match: vi.fn() };
  const intentModelClient = { analyze: vi.fn() };
  const intentValidator = { validate: vi.fn() };

  let service: P2OrchestratorService;

  const rejected = (reason: string): P2ProcessResult => ({
    action: 'SAFE_FALLBACK',
    reason: reason as Extract<P2ProcessResult, { action: 'SAFE_FALLBACK' }>['reason'],
  });

  beforeEach(() => {
    vi.clearAllMocks();

    entryGuard.check.mockReturnValue({
      action: 'CONTINUE_TO_P2',
      allowedSegments: [segment],
      safetyNoticeRequired: true,
      p1Route: route,
    });
    dictionaryContext.load.mockResolvedValue(dictionary);
    dictionaryMatcher.match.mockReturnValue([candidate]);
    intentModelClient.analyze.mockResolvedValue({ intents: [], unresolved_segments: [] });
    intentValidator.validate.mockReturnValue({
      intents: [readyIntent],
      unresolved_segments: [],
    });

    service = new P2OrchestratorService(
      entryGuard as unknown as ConstructorParameters<typeof P2OrchestratorService>[0],
      dictionaryContext as unknown as ConstructorParameters<typeof P2OrchestratorService>[1],
      dictionaryMatcher as unknown as ConstructorParameters<typeof P2OrchestratorService>[2],
      intentModelClient as unknown as ConstructorParameters<typeof P2OrchestratorService>[3],
      intentValidator as unknown as ConstructorParameters<typeof P2OrchestratorService>[4],
    );
  });

  it('按 Guard → 字典 → Matcher → 模型 → Validator 顺序处理', async () => {
    const events: string[] = [];
    entryGuard.check.mockImplementation((..._args: unknown[]) => {
      events.push('guard');
      return {
        action: 'CONTINUE_TO_P2',
        allowedSegments: [segment],
        safetyNoticeRequired: true,
        p1Route: route,
      };
    });
    dictionaryContext.load.mockImplementation(async () => {
      events.push('dictionary');
      return dictionary;
    });
    dictionaryMatcher.match.mockImplementation(() => {
      events.push('matcher');
      return [candidate];
    });
    intentModelClient.analyze.mockImplementation(async () => {
      events.push('model');
      return { intents: [], unresolved_segments: [] };
    });
    intentValidator.validate.mockImplementation(() => {
      events.push('validator');
      return { intents: [readyIntent], unresolved_segments: [] };
    });

    const result = await service.process(route, requestContext);
    expect(result.action).toBe('OK');
    expect(events).toEqual(['guard', 'dictionary', 'matcher', 'model', 'validator']);
    expect(entryGuard.check).toHaveBeenCalledWith(route);
    expect(dictionaryMatcher.match).toHaveBeenCalledWith([segment], dictionary);
    expect(intentModelClient.analyze).toHaveBeenCalledTimes(1);
    expect(intentValidator.validate).toHaveBeenCalledTimes(1);

    const [modelRequest] = intentModelClient.analyze.mock.calls[0] as unknown as [
      { segments: Array<{ segment_id: string; content: string }> },
    ];
    expect(modelRequest.segments).toEqual([
      { segment_id: 'seg_1', content: segment.content },
    ]);
  });

  it.each(['REFUSE', 'URGENT_RESPONSE', 'SAFE_FALLBACK'])(
    '入口拒绝时不读取字典或调用模型：%s',
    async (action) => {
      entryGuard.check.mockReturnValue({
        action: 'SAFE_FALLBACK',
        reason: 'INVALID_P1_SOURCE',
      });
      const badRoute = { action } as unknown as P1RouteResult;
      expect(await service.process(badRoute, requestContext)).toEqual(
        rejected('INVALID_P1_SOURCE'),
      );
      expect(entryGuard.check).toHaveBeenCalledWith(badRoute);
      expect(dictionaryContext.load).not.toHaveBeenCalled();
      expect(dictionaryMatcher.match).not.toHaveBeenCalled();
      expect(intentModelClient.analyze).not.toHaveBeenCalled();
    },
  );

  it.each([
    ['非法日期', { ...requestContext, request_time: 'not-a-time' }],
    ['空时区', { ...requestContext, timezone: ' ' }],
    ['不存在的时区', { ...requestContext, timezone: 'Moon/Base' }],
  ])('拒绝%s，且不加载字典', async (_label, context) => {
    expect(await service.process(route, context)).toEqual(
      rejected('INVALID_P1_SOURCE'),
    );
    expect(dictionaryContext.load).not.toHaveBeenCalled();
  });

  it('字典服务抛异常时安全降级，不调用 Matcher 或模型', async () => {
    dictionaryContext.load.mockRejectedValue(new Error('DB unavailable'));
    expect(await service.process(route, requestContext)).toEqual(
      rejected('DICTIONARY_CONTEXT_INVALID'),
    );
    expect(dictionaryMatcher.match).not.toHaveBeenCalled();
    expect(intentModelClient.analyze).not.toHaveBeenCalled();
  });

  it.each([
    ['非法对象', null],
    ['空字典却带标签', { status: 'empty', values: dictionary.values }],
    ['available 却没有标签', {
      status: 'available',
      values: { categories: [], efficacies: [], symptoms: [] },
    }],
    ['数组存在非字符串', {
      status: 'available',
      values: { categories: ['退烧药', 123], efficacies: [], symptoms: [] },
    }],
  ])('拒绝非法字典上下文：%s', async (_label, context) => {
    dictionaryContext.load.mockResolvedValue(context);
    expect(await service.process(route, requestContext)).toEqual(
      rejected('DICTIONARY_CONTEXT_INVALID'),
    );
    expect(intentModelClient.analyze).not.toHaveBeenCalled();
  });

  it('用户字典 unavailable 时继续识别，不误当作 empty', async () => {
    const unavailable: P2DictionaryContext = {
      status: 'unavailable',
      reason: 'read_failed',
    };
    dictionaryContext.load.mockResolvedValue(unavailable);
    dictionaryMatcher.match.mockReturnValue([]);

    const result = await service.process(route, requestContext);
    expect(dictionaryMatcher.match).toHaveBeenCalledWith([segment], unavailable);
    expect(intentModelClient.analyze).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({
      action: 'OK',
      result: { dictionary_status: 'unavailable' },
    });
  });

  it('Matcher 抛异常时安全降级，模型不会调用', async () => {
    dictionaryMatcher.match.mockImplementation(() => {
      throw new Error('matcher error');
    });
    expect(await service.process(route, requestContext)).toEqual(
      rejected('DICTIONARY_CONTEXT_INVALID'),
    );
    expect(intentModelClient.analyze).not.toHaveBeenCalled();
  });

  it('模型返回无效 JSON 类错误时归类为 MODEL_OUTPUT_INVALID', async () => {
    intentModelClient.analyze.mockRejectedValue(
      new P2IntentModelClientError('INVALID_MODEL_JSON'),
    );
    expect(await service.process(route, requestContext)).toEqual(
      rejected('MODEL_OUTPUT_INVALID'),
    );
    expect(intentValidator.validate).not.toHaveBeenCalled();
  });

  it('模型输入无效时归类为 MODEL_FAILED', async () => {
    intentModelClient.analyze.mockRejectedValue(
      new P2IntentModelClientError('INVALID_MODEL_REQUEST'),
    );
    expect(await service.process(route, requestContext)).toEqual(
      rejected('MODEL_FAILED'),
    );
  });

  it('底层模型调用超时或网络异常时安全降级', async () => {
    intentModelClient.analyze.mockRejectedValue(new Error('MODEL_TIMEOUT'));
    expect(await service.process(route, requestContext)).toEqual(
      rejected('MODEL_FAILED'),
    );
  });

  it('Validator 发现协议违规时拒绝全部结果，并透传分类码', async () => {
    intentValidator.validate.mockImplementation(() => {
      throw new P2IntentValidationError(
        'INVALID_DICTIONARY_CANDIDATE_NOT_PERMITTED',
      );
    });
    expect(await service.process(route, requestContext)).toEqual({
      action: 'SAFE_FALLBACK',
      reason: 'P2_VALIDATION_FAILED',
      category: 'INVALID_DICTIONARY_CANDIDATE_NOT_PERMITTED',
    });
  });

  it('Validator 抛出未知异常也不能放行，分类为 UNEXPECTED', async () => {
    intentValidator.validate.mockImplementation(() => {
      throw new Error('unexpected');
    });
    expect(await service.process(route, requestContext)).toEqual({
      action: 'SAFE_FALLBACK',
      reason: 'P2_VALIDATION_FAILED',
      category: 'UNEXPECTED',
    });
  });

  it('全部意图已准备好时返回 ready，并继承 P1 安全提示', async () => {
    const result = await service.process(route, requestContext);
    expect(result).toEqual({
      action: 'OK',
      result: {
        stage: 'P2',
        status: 'ready',
        safety_notice_required: true,
        dictionary_status: 'available',
        intents: [readyIntent],
        clarifications: [],
        unresolved_segments: [],
      },
    });
  });

  it('部分 ready、部分需澄清时返回 partial，并收集每个缺参项', async () => {
    intentValidator.validate.mockReturnValue({
      intents: [readyIntent, clarificationIntent],
      unresolved_segments: [],
    });
    const result = await service.process(route, requestContext);
    expect(result).toMatchObject({
      action: 'OK',
      result: {
        status: 'partial',
        clarifications: [
          { intent_id: 'intent_2', field: 'remind_at', reason: 'unresolved_time' },
          { intent_id: 'intent_2', field: 'content', reason: 'required' },
        ],
      },
    });
  });

  it('所有意图都需澄清时返回 needs_clarification', async () => {
    intentValidator.validate.mockReturnValue({
      intents: [clarificationIntent],
      unresolved_segments: [],
    });
    expect(await service.process(route, requestContext)).toMatchObject({
      action: 'OK',
      result: { status: 'needs_clarification' },
    });
  });

  it('没有 ready 意图、只存在 unresolved 时返回 needs_clarification', async () => {
    intentValidator.validate.mockReturnValue({
      intents: [],
      unresolved_segments: [unresolved],
    });
    expect(await service.process(route, requestContext)).toMatchObject({
      action: 'OK',
      result: {
        status: 'needs_clarification',
        unresolved_segments: [unresolved],
      },
    });
  });

  it('存在 ready 意图和未解析片段时返回 partial', async () => {
    intentValidator.validate.mockReturnValue({
      intents: [readyIntent],
      unresolved_segments: [unresolved],
    });
    expect(await service.process(route, requestContext)).toMatchObject({
      action: 'OK',
      result: { status: 'partial' },
    });
  });

  it('正确将 AbortSignal 传递给模型客户端', async () => {
    const controller = new AbortController();
    await service.process(route, requestContext, { signal: controller.signal });
    expect(intentModelClient.analyze).toHaveBeenCalledWith(
      expect.any(Object),
      { signal: controller.signal },
    );
  });

  it('安全提示为 false 时原样传递，不能被模型输出覆盖', async () => {
    entryGuard.check.mockReturnValue({
      action: 'CONTINUE_TO_P2',
      allowedSegments: [segment],
      safetyNoticeRequired: false,
      p1Route: route,
    });
    const result = await service.process(route, requestContext);
    expect(result).toMatchObject({
      action: 'OK',
      result: { safety_notice_required: false },
    });
  });
});
