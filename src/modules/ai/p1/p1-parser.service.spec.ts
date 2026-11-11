
import 'reflect-metadata';

import {
  describe,
  expect,
  it,
  vi,
} from 'vitest';

import {
  P1ParserError,
  P1ParserService,
} from './p1-parser.service.js';

import {
  P1_DOMAIN_SYSTEM_PROMPT,
} from '../prompts/p1-domain.prompt.js';

import type {
  LlmClient,
} from '../llm/llm.interface.js';

// ============================================================
// 测试配置
// ============================================================

const TEST_MODEL = 'mock-model';

// ============================================================
// 测试工具
// ============================================================

/**
 * 创建 Mock LLM Client 和 P1ParserService。
 *
 * 不连接真实 Ollama。
 *
 * 可以使用 generate.mockResolvedValue()
 * 和 generate.mockRejectedValue()
 * 模拟任意模型结果或异常。
 */
function createTestContext(
  content: unknown = '{"stage":"P1"}',
) {
  const generate = vi.fn<LlmClient['generate']>();

  generate.mockResolvedValue({
    content: content as string,
    model: TEST_MODEL,
  });

  const client: LlmClient = {
    generate,
  };

  const parser = new P1ParserService(client);

  return {
    parser,
    generate,
  };
}

// ============================================================
// P1 Parser 单元测试
// ============================================================

describe('P1ParserService', () => {

  // ==========================================================
  // 第一组：模型请求构建
  // ==========================================================

  describe('模型请求构建', () => {

    it('应该正确发送 System Prompt 和用户消息', async () => {
      const { parser, generate } =
        createTestContext();

      await parser.classify(
        '我的布洛芬还有多少？',
      );

      expect(generate).toHaveBeenCalledTimes(1);

      const request = generate.mock.calls[0]![0];

      expect(request.messages).toEqual([
        {
          role: 'system',
          content: P1_DOMAIN_SYSTEM_PROMPT,
        },
        {
          role: 'user',
          content: '我的布洛芬还有多少？',
        },
      ]);
    });

    it('应该使用 JSON 模式和低温度', async () => {
      const { parser, generate } =
        createTestContext();

      await parser.classify('我头痛');

      const request = generate.mock.calls[0]![0];

      expect(request.responseFormat).toBe('json');

      expect(request.temperature).toBe(0);

      expect(request.messages).toHaveLength(2);
    });

    it('应该只去除用户消息首尾空白', async () => {
      const { parser, generate } =
        createTestContext();

      await parser.classify(
        '  我胸口剧痛，而且 呼吸困难！  ',
      );

      const request = generate.mock.calls[0]![0];

      expect(request.messages[1]).toEqual({
        role: 'user',
        content: '我胸口剧痛，而且 呼吸困难！',
      });
    });

    it('应该将 AbortSignal 传递给 LLM Client', async () => {
      const { parser, generate } =
        createTestContext();

      const controller = new AbortController();

      await parser.classify(
        '我头痛',
        {
          signal: controller.signal,
        },
      );

      const request = generate.mock.calls[0]![0];

      expect(request.signal).toBe(
        controller.signal,
      );
    });

    it('未提供取消信号时不应该添加 signal', async () => {
      const { parser, generate } =
        createTestContext();

      await parser.classify('查询我的药箱');

      const request = generate.mock.calls[0]![0];

      expect(request).not.toHaveProperty(
        'signal',
      );
    });
  });

  // ==========================================================
  // 第二组：合法 JSON 解析
  // ==========================================================

  describe('合法 JSON 解析', () => {

    it('应该正确解析 JSON 对象', async () => {
      const modelResult = {
        stage: 'P1',
        domain_type: 'medical_health',
        segments: [],
      };

      const { parser } = createTestContext(
        JSON.stringify(modelResult),
      );

      const result = await parser.classify(
        '我的布洛芬还有多少？',
      );

      expect(result).toEqual(modelResult);
    });

    it('应该保留模型生成的嵌套结构', async () => {
      const modelResult = {
        stage: 'P1',
        domain_type: 'mixed',

        segments: [
          {
            segment_id: 'seg_1',
            content: '我头痛',
            domain: 'medical_health',
            decision: 'continue_to_p2',
          },
          {
            segment_id: 'seg_2',
            content: '帮我写一个 Vue 页面',
            domain: 'non_medical_health',
            decision: 'refuse',
          },
        ],

        medical_risk: {
          applicable: true,
          level: 'routine',
          assessment_status:
            'insufficient_information',
          risk_signals: [],
          missing_information: [
            '疼痛程度',
            '持续时间',
          ],
          recommended_action:
            'continue_with_clarification',
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

      const { parser } = createTestContext(
        JSON.stringify(modelResult),
      );

      const result = await parser.classify(
        '我头痛，另外帮我写一个 Vue 页面',
      );

      expect(result).toEqual(modelResult);
    });

    it('应该允许合法 JSON 对象但不提前执行 Schema 校验', async () => {
      const { parser } = createTestContext(
        '{}',
      );

      const result = await parser.classify(
        '测试消息',
      );

      // Parser 只检查顶层是否为 JSON 对象。
      // 缺少 P1 字段应交给 Validator 拒绝。
      expect(result).toEqual({});
    });
  });

  // ==========================================================
  // 第三组：用户输入校验
  // ==========================================================

  describe('用户输入校验', () => {

    it('应该拒绝空字符串', async () => {
      const { parser, generate } =
        createTestContext();

      await expect(
        parser.classify(''),
      ).rejects.toMatchObject({
        name: 'P1ParserError',
        code: 'INVALID_USER_MESSAGE',
      });

      expect(generate).not.toHaveBeenCalled();
    });

    it('应该拒绝只有空白字符的消息', async () => {
      const { parser, generate } =
        createTestContext();

      await expect(
        parser.classify('   \n  '),
      ).rejects.toMatchObject({
        code: 'INVALID_USER_MESSAGE',
      });

      expect(generate).not.toHaveBeenCalled();
    });

    it('应该拒绝运行时传入的非字符串', async () => {
      const { parser, generate } =
        createTestContext();

      await expect(
        parser.classify(
          null as unknown as string,
        ),
      ).rejects.toMatchObject({
        code: 'INVALID_USER_MESSAGE',
      });

      expect(generate).not.toHaveBeenCalled();
    });
  });

  // ==========================================================
  // 第四组：模型输出格式校验
  // ==========================================================

  describe('模型输出格式校验', () => {

    it('应该拒绝模型返回空字符串', async () => {
      const { parser } = createTestContext('');

      await expect(
        parser.classify('我头痛'),
      ).rejects.toMatchObject({
        code: 'EMPTY_MODEL_RESPONSE',
      });
    });

    it('应该拒绝模型返回纯空白内容', async () => {
      const { parser } = createTestContext(
        '   \n  ',
      );

      await expect(
        parser.classify('我头痛'),
      ).rejects.toMatchObject({
        code: 'EMPTY_MODEL_RESPONSE',
      });
    });

    it('应该拒绝非法 JSON', async () => {
      const { parser } = createTestContext(
        '{ "stage": "P1", }',
      );

      await expect(
        parser.classify('我头痛'),
      ).rejects.toMatchObject({
        code: 'INVALID_MODEL_JSON',
      });
    });

    it('应该拒绝 Markdown 代码块包裹的 JSON', async () => {
      const { parser } = createTestContext(
        [
          '```json',
          '{"stage":"P1"}',
          '```',
        ].join('\n'),
      );

      await expect(
        parser.classify('我头痛'),
      ).rejects.toMatchObject({
        code: 'INVALID_MODEL_JSON',
      });
    });

    it('应该拒绝 JSON 前后的额外解释', async () => {
      const { parser } = createTestContext(
        '分析结果：{"stage":"P1"}',
      );

      await expect(
        parser.classify('我头痛'),
      ).rejects.toMatchObject({
        code: 'INVALID_MODEL_JSON',
      });
    });
  });

  // ==========================================================
  // 第五组：JSON 顶层结构检查
  // ==========================================================

  describe('JSON 顶层结构检查', () => {

    it('应该拒绝 JSON null', async () => {
      const { parser } = createTestContext(
        'null',
      );

      await expect(
        parser.classify('测试'),
      ).rejects.toMatchObject({
        code: 'INVALID_MODEL_RESULT',
      });
    });

    it('应该拒绝 JSON 数组', async () => {
      const { parser } = createTestContext(
        '[{"stage":"P1"}]',
      );

      await expect(
        parser.classify('测试'),
      ).rejects.toMatchObject({
        code: 'INVALID_MODEL_RESULT',
      });
    });

    it('应该拒绝 JSON 字符串', async () => {
      const { parser } = createTestContext(
        '"hello"',
      );

      await expect(
        parser.classify('测试'),
      ).rejects.toMatchObject({
        code: 'INVALID_MODEL_RESULT',
      });
    });

    it('应该拒绝 JSON 数字和布尔值', async () => {
      for (const content of [
        '123',
        'true',
        'false',
      ]) {
        const { parser } = createTestContext(
          content,
        );

        await expect(
          parser.classify('测试'),
        ).rejects.toMatchObject({
          code: 'INVALID_MODEL_RESULT',
        });
      }
    });
  });

  // ==========================================================
  // 第六组：上游模型异常透传
  // ==========================================================

  describe('模型异常透传', () => {

    it('应该将模型超时异常原样向上抛出', async () => {
      const { parser, generate } =
        createTestContext();

      const modelError = Object.assign(
        new Error('模型请求超时'),
        {
          code: 'MODEL_TIMEOUT',
        },
      );

      generate.mockRejectedValue(modelError);

      await expect(
        parser.classify('我头痛'),
      ).rejects.toBe(modelError);
    });

    it('应该将模型取消异常原样向上抛出', async () => {
      const { parser, generate } =
        createTestContext();

      const modelError = Object.assign(
        new Error('模型请求已取消'),
        {
          code: 'MODEL_CANCELLED',
        },
      );

      generate.mockRejectedValue(modelError);

      await expect(
        parser.classify('我头痛'),
      ).rejects.toBe(modelError);
    });
  });

  // ==========================================================
  // 第七组：Parser 异常类型
  // ==========================================================

  describe('Parser 异常类型', () => {

    it('应该生成明确的 P1ParserError', () => {
      const error = new P1ParserError(
        'INVALID_MODEL_JSON',
        '模型输出不是合法 JSON',
      );

      expect(error).toBeInstanceOf(Error);

      expect(error).toBeInstanceOf(
        P1ParserError,
      );

      expect(error.name).toBe('P1ParserError');

      expect(error.code).toBe(
        'INVALID_MODEL_JSON',
      );
    });
  });
});
