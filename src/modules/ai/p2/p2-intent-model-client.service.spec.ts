import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  P2IntentModelClientError,
  P2IntentModelClientService,
} from './p2-intent-model-client.service.js';
import {
  P2_INTENT_PROTOCOL_VERSION,
  P2_INTENT_SYSTEM_INSTRUCTION,
  P2_INTENT_TYPES,
} from './p2-intent-model.contract.js';
import type { P2IntentModelRequest } from './p2-intent-model.contract.js';

function makeInput(): P2IntentModelRequest {
  return {
    protocol_version: P2_INTENT_PROTOCOL_VERSION,
    segments: [
      { segment_id: 'seg_1', content: '查询布洛芬还剩多少' },
    ],
    request_context: {
      request_time: '2026-11-12T09:00:00.000Z',
      timezone: 'Asia/Shanghai',
    },
    dictionary: {
      status: 'available',
      values: {
        categories: ['退烧药', '感冒药'],
        efficacies: ['退热'],
        symptoms: ['发热'],
      },
    },
    dictionary_candidates: [],
    allowed_intent_types: [...P2_INTENT_TYPES],
  };
}

function makeModelOutput(): unknown {
  return {
    intents: [
      {
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
      },
    ],
    unresolved_segments: [],
  };
}

/** 仅模拟统一 LLM 客户端；不启动 NestJS、Ollama 或数据库。 */
describe('P2IntentModelClientService', () => {
  const generate = vi.fn();
  let service: P2IntentModelClientService;

  beforeEach(() => {
    generate.mockReset();
    service = new P2IntentModelClientService(
      { generate } as unknown as ConstructorParameters<
        typeof P2IntentModelClientService
      >[0],
    );
  });

  it('以统一 LLM_CLIENT 约定发送系统指令、受限 JSON 输入、JSON 格式及零温度', async () => {
    const modelOutput = makeModelOutput();
    generate.mockResolvedValue({ content: JSON.stringify(modelOutput) });

    await expect(service.analyze(makeInput())).resolves.toEqual(modelOutput);
    expect(generate).toHaveBeenCalledTimes(1);

    const [request] = generate.mock.calls[0] as [
      {
        messages: Array<{ role: string; content: string }>;
        responseFormat: string;
        temperature: number;
        signal?: AbortSignal;
      },
    ];

    expect(request.responseFormat).toBe('json');
    expect(request.temperature).toBe(0);
    expect(request.signal).toBeUndefined();
    expect(request.messages).toHaveLength(2);
    expect(request.messages[0]).toEqual({
      role: 'system',
      content: P2_INTENT_SYSTEM_INSTRUCTION,
    });
    expect(request.messages[1]?.role).toBe('user');
    expect(JSON.parse(request.messages[1]!.content)).toEqual(makeInput());
    expect(request.messages[1]!.content).not.toContain('userId');
  });

  it('传递同一个 AbortSignal 给统一模型客户端', async () => {
    generate.mockResolvedValue({ content: '{}' });
    const controller = new AbortController();

    await service.analyze(makeInput(), { signal: controller.signal });

    expect(generate).toHaveBeenCalledWith(
      expect.objectContaining({ signal: controller.signal }),
    );
  });

  it('JSON 对象解析成功后仍原样返回 unknown，不自行伪装成已验证的业务结果', async () => {
    const incompleteOutput = { arbitrary: 'not-yet-validated' };
    generate.mockResolvedValue({
      content: JSON.stringify(incompleteOutput),
    });

    await expect(service.analyze(makeInput())).resolves.toEqual(
      incompleteOutput,
    );
  });

  it.each([
    ['空字符串', ''],
    ['仅空白', '  \n  '],
    ['非字符串', null],
  ])('将%s响应识别为 EMPTY_MODEL_RESPONSE', async (_label, content) => {
    generate.mockResolvedValue({ content });

    await expect(service.analyze(makeInput())).rejects.toMatchObject({
      name: 'P2IntentModelClientError',
      code: 'EMPTY_MODEL_RESPONSE',
    });
  });

  it.each([
    ['无效 JSON', '{ invalid json'],
    ['Markdown 围栏', '```json\n{}\n```'],
  ])('将%s识别为 INVALID_MODEL_JSON', async (_label, content) => {
    generate.mockResolvedValue({ content });

    await expect(service.analyze(makeInput())).rejects.toMatchObject({
      code: 'INVALID_MODEL_JSON',
    });
  });

  it.each([
    ['null', 'null'],
    ['数组', '[]'],
    ['字符串', '"hello"'],
    ['数字', '123'],
    ['布尔值', 'true'],
  ])('拒绝 JSON 顶层为%s的响应', async (_label, content) => {
    generate.mockResolvedValue({ content });

    await expect(service.analyze(makeInput())).rejects.toMatchObject({
      code: 'INVALID_MODEL_RESULT',
    });
  });

  it.each([
    ['协议版本错误', { protocol_version: 'P2_INTENT_V2' }],
    ['空 segments', { segments: [] }],
    ['时间无法解析', { request_context: { request_time: 'no-date', timezone: 'Asia/Shanghai' } }],
    ['时区为空', { request_context: { request_time: '2026-11-12T09:00:00.000Z', timezone: ' ' } }],
    ['dictionary 不是对象', { dictionary: null }],
    ['候选不是数组', { dictionary_candidates: null }],
    ['意图类型列表不是数组', { allowed_intent_types: null }],
  ])('拒绝%s且不调用模型', async (_label, change) => {
    const input = { ...makeInput(), ...change };

    await expect(
      service.analyze(input as P2IntentModelRequest),
    ).rejects.toMatchObject({ code: 'INVALID_MODEL_REQUEST' });
    expect(generate).not.toHaveBeenCalled();
  });

  it.each([
    ['重复 ID', [{ segment_id: 'seg_1', content: '一' }, { segment_id: 'seg_1', content: '二' }]],
    ['空 ID', [{ segment_id: ' ', content: '查询' }]],
    ['空内容', [{ segment_id: 'seg_1', content: ' ' }]],
    ['错误 Segment 结构', [{ segment_id: 5, content: '查询' }]],
  ])('拒绝%s的 Segment', async (_label, segments) => {
    const input = { ...makeInput(), segments };

    await expect(
      service.analyze(input as unknown as P2IntentModelRequest),
    ).rejects.toMatchObject({ code: 'INVALID_MODEL_REQUEST' });
    expect(generate).not.toHaveBeenCalled();
  });

  it('模型网络或超时错误保持原样向上抛出，不吞掉异常', async () => {
    const infrastructureError = new Error('MODEL_TIMEOUT');
    generate.mockRejectedValue(infrastructureError);

    await expect(service.analyze(makeInput())).rejects.toBe(
      infrastructureError,
    );
  });

  it('序列化失败时拒绝调用模型，且不包含敏感输入的异常文本', async () => {
    const input = makeInput();
    (input as unknown as Record<string, unknown>).extra = 1n;

    try {
      await service.analyze(input);
      throw new Error('Expected analyze to reject');
    } catch (error) {
      expect(error).toBeInstanceOf(P2IntentModelClientError);
      expect(error).toMatchObject({ code: 'INVALID_MODEL_REQUEST' });
      expect((error as Error).message).not.toContain('布洛芬');
    }
    expect(generate).not.toHaveBeenCalled();
  });
});
