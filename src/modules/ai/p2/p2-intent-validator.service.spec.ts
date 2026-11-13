import { describe, expect, it } from 'vitest';

import {
  P2IntentValidationError,
  P2IntentValidatorService,
} from './p2-intent-validator.service.js';
import {
  P2_INTENT_PROTOCOL_VERSION,
  P2_INTENT_TYPES,
} from './p2-intent-model.contract.js';
import type {
  P2IntentModelRequest,
  P2IntentModelResponse,
} from './p2-intent-model.contract.js';
import type {
  P2DictionaryCandidate,
  P2Intent,
} from './schemas/p2.schema.js';

const validator = new P2IntentValidatorService();

const feverCandidate: P2DictionaryCandidate = {
  kind: 'symptom',
  dictionary_value: '发热',
  matched_concept: '发热',
  source_text: '发烧',
  relation: 'alias',
};

function request(): P2IntentModelRequest {
  return {
    protocol_version: P2_INTENT_PROTOCOL_VERSION,
    segments: [{ segment_id: 'seg_1', content: '帮我看看布洛芬还剩多少' }],
    request_context: {
      request_time: '2026-11-12T09:00:00.000Z',
      timezone: 'Asia/Shanghai',
    },
    dictionary: {
      status: 'available',
      values: {
        categories: ['退烧药'],
        efficacies: ['退热'],
        symptoms: ['发热'],
      },
    },
    dictionary_candidates: [feverCandidate],
    allowed_intent_types: [...P2_INTENT_TYPES],
  };
}

function medicineSearch(): Extract<P2Intent, { type: 'medicine.search' }> {
  return {
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
}

function output(): P2IntentModelResponse {
  return { intents: [medicineSearch()], unresolved_segments: [] };
}

function expectRejected(value: unknown, context: P2IntentModelRequest = request()): void {
  expect(() => validator.validate(value, context)).toThrow(P2IntentValidationError);
}

function expectRejectedWith(
  value: unknown,
  category: string,
  context: P2IntentModelRequest = request(),
): void {
  try {
    validator.validate(value, context);
    throw new Error('expected validation failure');
  } catch (error) {
    expect(error).toBeInstanceOf(P2IntentValidationError);
    expect((error as P2IntentValidationError).message).toBe('P2_VALIDATION_FAILED');
    expect((error as P2IntentValidationError).category).toBe(category);
  }
}

function withChangedIntent(change: Record<string, unknown>): unknown {
  return {
    ...output(),
    intents: [{ ...medicineSearch(), ...change }],
  };
}

describe('P2IntentValidatorService', () => {
  it('通过合法 medicine.search 意图，保留原结果引用', () => {
    const result = output();
    expect(validator.validate(result, request())).toBe(result);
  });

  it('支持一个 Segment 对应多个合法意图', () => {
    const result: P2IntentModelResponse = {
      intents: [
        medicineSearch(),
        {
          intent_id: 'intent_2',
          type: 'medical.consult',
          source_segment_ids: ['seg_1'],
          state: 'ready',
          parameters: { symptoms: ['发烧'], medicine_names: [], keywords: [] },
          dictionary_candidates: [feverCandidate],
          missing_fields: [],
        },
      ],
      unresolved_segments: [],
    };
    expect(validator.validate(result, request())).toBe(result);
  });

  it('支持多个 Segment 分配给不同意图', () => {
    const context = request();
    context.segments.push({ segment_id: 'seg_2', content: '查询昨天就诊记录' });
    const result: P2IntentModelResponse = {
      intents: [
        medicineSearch(),
        {
          intent_id: 'intent_2',
          type: 'visit.search',
          source_segment_ids: ['seg_2'],
          state: 'ready',
          parameters: {
            symptom_keywords: [],
            keywords: [],
            time_range: { raw_text: '昨天' },
            order: 'recent_first',
          },
          dictionary_candidates: [],
          missing_fields: [],
        },
      ],
      unresolved_segments: [],
    };
    expect(validator.validate(result, context)).toBe(result);
  });

  it('允许把未识别的 Segment 明确列入 unresolved_segments', () => {
    const context = request();
    context.segments.push({ segment_id: 'seg_2', content: '其他医疗相关内容' });
    const result: P2IntentModelResponse = {
      ...output(),
      unresolved_segments: [{ segment_id: 'seg_2', reason: 'unsupported_intent' }],
    };
    expect(validator.validate(result, context)).toBe(result);
  });

  it('允许全部 Segment 明确标记为未解析', () => {
    const result: P2IntentModelResponse = {
      intents: [],
      unresolved_segments: [{ segment_id: 'seg_1', reason: 'insufficient_information' }],
    };
    expect(validator.validate(result, request())).toBe(result);
  });

  it.each([
    ['null', null],
    ['数组', []],
    ['字符串', 'invalid'],
    ['缺少 intents', { unresolved_segments: [] }],
    ['缺少 unresolved_segments', { intents: [] }],
    ['多余的整体状态', { ...output(), status: 'ready' }],
    ['多余的安全提示', { ...output(), safety_notice_required: false }],
    ['intents 不是数组', { intents: {}, unresolved_segments: [] }],
  ])('拒绝错误的顶层结构：%s', (_label, value) => {
    expectRejected(value);
  });

  it.each([
    ['未知意图', { type: 'medicine.execute' }],
    ['重复意图 ID', { intent_id: ' ' }],
    ['未授权 Segment', { source_segment_ids: ['seg_99'] }],
    ['重复的 Segment 引用', { source_segment_ids: ['seg_1', 'seg_1'] }],
    ['空 Segment 引用', { source_segment_ids: [] }],
    ['未知状态', { state: 'completed' }],
    ['多余字段', { unexpected: 'value' }],
    ['缺少 parameters', { parameters: undefined }],
  ])('拒绝非法意图：%s', (_label, change) => {
    expectRejected(withChangedIntent(change));
  });

  it('拒绝两个意图使用相同 intent_id', () => {
    expectRejected({
      ...output(),
      intents: [medicineSearch(), medicineSearch()],
    });
  });

  it('拒绝未覆盖的授权 Segment', () => {
    const context = request();
    context.segments.push({ segment_id: 'seg_2', content: '查询之前的就诊' });
    expectRejectedWith(output(), 'INVALID_SEGMENT_COVERAGE', context);
  });

  it('拒绝已识别 Segment 又被标记为未解析', () => {
    expectRejectedWith(
      {
        ...output(),
        unresolved_segments: [{ segment_id: 'seg_1', reason: 'unsupported_intent' }],
      },
      'INVALID_SEGMENT_COVERAGE',
    );
  });

  it('拒绝重复或未授权的未解析 Segment', () => {
    expectRejected({
      intents: [],
      unresolved_segments: [
        { segment_id: 'seg_1', reason: 'unsupported_intent' },
        { segment_id: 'seg_1', reason: 'insufficient_information' },
      ],
    });
    expectRejected({
      intents: [],
      unresolved_segments: [{ segment_id: 'seg_99', reason: 'unsupported_intent' }],
    });
  });

  it('拒绝非法的 unresolved 原因', () => {
    expectRejected({
      intents: [],
      unresolved_segments: [{ segment_id: 'seg_1', reason: 'model_error' }],
    });
  });

  it('拒绝伪造的字典标签', () => {
    expectRejectedWith(
      withChangedIntent({
        dictionary_candidates: [{ ...feverCandidate, dictionary_value: '糖尿病' }],
      }),
      'INVALID_DICTIONARY_CANDIDATE_SHAPE',
    );
  });

  it('拒绝字典中真实存在，但不属于 Matcher 输入候选的标签', () => {
    expectRejectedWith(
      withChangedIntent({
        dictionary_candidates: [{ ...feverCandidate, source_text: '高烧' }],
      }),
      'INVALID_DICTIONARY_CANDIDATE_NOT_PERMITTED',
    );
  });

  it('拒绝同一意图内重复字典候选', () => {
    expectRejectedWith(
      withChangedIntent({
        dictionary_candidates: [feverCandidate, feverCandidate],
      }),
      'INVALID_DICTIONARY_CANDIDATE_DUPLICATE',
    );
  });

  it.each([
    { source: 'segment', target: 'medicine_names', value: '布洛芬', reason: '直接提及' },
    { category: '感冒咳嗽', efficacy: '退烧', symptom: '发热咳嗽' },
  ])('拒绝真实模型曾返回的错误候选结构：%j', (candidate) => {
    const context = request();
    context.dictionary_candidates = [];
    expectRejectedWith(
      withChangedIntent({ dictionary_candidates: [candidate] }),
      'INVALID_DICTIONARY_CANDIDATE_SHAPE',
      context,
    );
  });

  it('用户字典不可用时，不允许模型输出字典候选', () => {
    const context = request();
    context.dictionary = { status: 'unavailable', reason: 'read_failed' };
    context.dictionary_candidates = [];
    expectRejected(withChangedIntent({ dictionary_candidates: [feverCandidate] }), context);
  });

  it('用户字典为空时，空候选仍允许合法查询意图', () => {
    const context = request();
    context.dictionary = {
      status: 'empty',
      values: { categories: [], efficacies: [], symptoms: [] },
    };
    context.dictionary_candidates = [];
    expect(validator.validate(output(), context)).toEqual(output());
  });

  it.each([
    ['ready 却报告缺参', {
      state: 'ready',
      missing_fields: [{ field: 'selector', reason: 'required' }],
    }],
    ['需要澄清却没有缺参', { state: 'needs_clarification', missing_fields: [] }],
    ['非法缺参原因', {
      state: 'needs_clarification',
      missing_fields: [{ field: 'target', reason: 'unknown' }],
    }],
  ])('拒绝缺参状态不一致：%s', (_label, change) => {
    expectRejected(withChangedIntent(change));
  });

  it('允许需澄清的写入意图，并拒绝没有目标却标记 ready 的更新', () => {
    const clarification = withChangedIntent({
      type: 'medicine.update',
      state: 'needs_clarification',
      parameters: { selector: {}, fields: [] },
      missing_fields: [{ field: 'selector', reason: 'unresolved_reference' }],
    });
    expect(validator.validate(clarification, request())).toEqual(clarification);

    expectRejected(withChangedIntent({
      type: 'medicine.update',
      parameters: { selector: {}, fields: [{ field_name: '数量', raw_value: '3' }] },
    }));
  });

  it('拒绝 create ready 却没有任何字段', () => {
    expectRejected(withChangedIntent({
      type: 'reminder.create',
      parameters: { fields: [] },
    }));
  });

  it('拒绝 delete ready 却没有目标', () => {
    expectRejected(withChangedIntent({
      type: 'visit.delete',
      parameters: { selector: {} },
    }));
  });

  it('接受具有目标与显式字段的 update 语义参数', () => {
    const result = withChangedIntent({
      type: 'medicine.update',
      parameters: {
        selector: { name: '布洛芬' },
        fields: [{ field_name: '数量', raw_value: '3' }],
      },
    });
    expect(validator.validate(result, request())).toEqual(result);
  });

  it.each([
    ['查询焦点非法', { query_focus: 'prescribe' }],
    ['缺少药品数组', { medicine_names: undefined }],
    ['药品数组元素非法', { medicine_names: ['布洛芬', ''] }],
    ['多余参数', { diagnosis: '流感' }],
  ])('拒绝错误的 medicine.search 参数：%s', (_label, change) => {
    expectRejectedWith(
      withChangedIntent({
        parameters: { ...medicineSearch().parameters, ...change },
      }),
      'INVALID_INTENT_PARAMETERS',
    );
  });

  it('拒绝无效的就诊查询时间和数量', () => {
    expectRejected(withChangedIntent({
      type: 'visit.search',
      parameters: {
        symptom_keywords: [],
        keywords: [],
        time_range: { raw_text: '昨天', start: 'not-a-time' },
      },
    }));
    expectRejected(withChangedIntent({
      type: 'visit.search',
      parameters: { symptom_keywords: [], keywords: [], limit: -1 },
    }));
  });

  it.each([
    { start: null },
    { end: null },
    { start: null, end: null },
  ])('拒绝真实模型曾返回的 null 时间边界：%j', (boundaries) => {
    expectRejectedWith(
      withChangedIntent({
        type: 'visit.search',
        parameters: {
          symptom_keywords: [],
          keywords: [],
          time_range: { raw_text: '最近', ...boundaries },
        },
      }),
      'INVALID_INTENT_PARAMETERS',
    );
  });

  it('允许无法确定边界的相对时间仅保留原文', () => {
    const result = withChangedIntent({
      type: 'visit.search',
      parameters: {
        symptom_keywords: [],
        keywords: [],
        time_range: { raw_text: '最近' },
      },
    });
    expect(validator.validate(result, request())).toBe(result);
  });

  it('拒绝重复的输入 Segment ID 或不完整意图类型白名单', () => {
    const duplicate = request();
    duplicate.segments.push({ segment_id: 'seg_1', content: '重复内容' });
    expectRejected(output(), duplicate);

    const incomplete = request();
    incomplete.allowed_intent_types = ['medicine.search'];
    expectRejected(output(), incomplete);
  });

  it('异常不携带用户原文或字典敏感内容', () => {
    try {
      validator.validate(withChangedIntent({ type: 'invalid' }), request());
      throw new Error('expected validation failure');
    } catch (error) {
      expect(error).toBeInstanceOf(P2IntentValidationError);
      expect((error as Error).message).toBe('P2_VALIDATION_FAILED');
      expect((error as P2IntentValidationError).category).toBe('INVALID_INTENT_TYPE');
      expect((error as Error).message).not.toContain('布洛芬');
      expect((error as P2IntentValidationError).category).not.toContain('布洛芬');
    }
  });

  it.each([
    [
      '多余的整体状态',
      { ...output(), status: 'ready' },
      'INVALID_TOP_LEVEL',
    ],
    [
      '未知意图类型',
      withChangedIntent({ type: 'medicine.execute' }),
      'INVALID_INTENT_TYPE',
    ],
    [
      '未授权 Segment',
      withChangedIntent({ source_segment_ids: ['seg_99'] }),
      'INVALID_SEGMENT_REFERENCE',
    ],
    [
      'ready 却报告缺参',
      withChangedIntent({
        state: 'ready',
        missing_fields: [{ field: 'selector', reason: 'required' }],
      }),
      'INVALID_STATE',
    ],
  ])('失败分类码：%s', (_label, value, category) => {
    expectRejectedWith(value, category);
  });

  it('请求上下文非法时返回 INVALID_REQUEST_CONTEXT', () => {
    const incomplete = request();
    incomplete.allowed_intent_types = ['medicine.search'];
    expectRejectedWith(output(), 'INVALID_REQUEST_CONTEXT', incomplete);
  });
});
