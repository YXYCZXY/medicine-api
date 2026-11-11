
import {
  afterEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';

import type { ConfigService } from '@nestjs/config';

import {
  OllamaClientError,
  OllamaService,
} from './ollama.service.js';

import type {
  LlmGenerateRequest,
} from './llm.interface.js';

// ============================================================
// 测试配置
// ============================================================

const TEST_MODEL = 'qwen2.5:7b';

const TEST_BASE_URL = 'http://127.0.0.1:11434';

const TEST_ENDPOINT =
  'http://127.0.0.1:11434/api/chat';

// ============================================================
// 测试工具函数
// ============================================================

/**
 * 创建 OllamaService 实例。
 *
 * 使用假的 ConfigService，
 * 不读取真实环境变量。
 */
function createService(
  overrides: Record<string, string | undefined> = {},
): OllamaService {
  const values: Record<string, string | undefined> = {
    OLLAMA_MODEL: TEST_MODEL,
    OLLAMA_BASE_URL: TEST_BASE_URL,
    ...overrides,
  };

  const configService = {
    get: (key: string) => values[key],
  } as unknown as ConfigService;

  return new OllamaService(configService);
}

/**
 * 创建标准模型请求。
 */
function createRequest(): LlmGenerateRequest {
  return {
    messages: [
      {
        role: 'system',
        content: '你是千方记 P1 分类模块',
      },
      {
        role: 'user',
        content: '我的布洛芬还有多少？',
      },
    ],
    responseFormat: 'json',
    temperature: 0,
    timeoutMs: 5000,
  };
}

/**
 * 构造 Ollama HTTP JSON 响应。
 */
function jsonResponse(
  payload: unknown,
  status = 200,
): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: {
      'Content-Type': 'application/json',
    },
  });
}

/**
 * 构造标准 Ollama 成功响应。
 */
function successResponse(
  content = '{"stage":"P1"}',
  model = TEST_MODEL,
): Response {
  return jsonResponse({
    model,
    message: {
      role: 'assistant',
      content,
    },
    done: true,
  });
}

/**
 * Mock 全局 fetch，返回指定响应。
 */
function mockFetchResponse(response: Response) {
  const fetchMock = vi.fn<typeof fetch>(
    async () => response,
  );

  vi.stubGlobal('fetch', fetchMock);

  return fetchMock;
}

/**
 * 模拟一个一直等待、
 * 直到收到 AbortSignal 才停止的 HTTP 请求。
 *
 * 用于测试：
 * - 模型请求超时
 * - 用户主动取消
 */
function mockAbortableFetch() {
  const fetchMock = vi.fn<typeof fetch>(
    async (_url, init) =>
      new Promise<Response>((_resolve, reject) => {
        const signal = init?.signal;

        if (!signal) {
          reject(
            new Error('测试请求缺少 AbortSignal'),
          );
          return;
        }

        const rejectAbort = (): void => {
          reject(
            new DOMException(
              'The operation was aborted',
              'AbortError',
            ),
          );
        };

        if (signal.aborted) {
          rejectAbort();
          return;
        }

        signal.addEventListener(
          'abort',
          rejectAbort,
          { once: true },
        );
      }),
  );

  vi.stubGlobal('fetch', fetchMock);

  return fetchMock;
}

// ============================================================
// 测试环境清理
// ============================================================

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

// ============================================================
// OllamaService 单元测试
// ============================================================

describe('OllamaService', () => {
  // ==========================================================
  // 第一组：正常模型调用
  // ==========================================================

  describe('正常模型调用', () => {
    it('应该正确发送 JSON 模式请求并返回结果', async () => {
      const content = '{"stage":"P1"}';

      const fetchMock = mockFetchResponse(
        successResponse(content),
      );

      const service = createService();

      const result = await service.generate(
        createRequest(),
      );

      expect(result).toEqual({
        content,
        model: TEST_MODEL,
      });

      expect(fetchMock).toHaveBeenCalledTimes(1);

      const [url, init] = fetchMock.mock.calls[0]!;

      expect(url).toBe(TEST_ENDPOINT);

      expect(init?.method).toBe('POST');

      expect(init?.headers).toMatchObject({
        'Content-Type': 'application/json',
        Accept: 'application/json',
      });

      expect(init?.signal).toBeInstanceOf(
        AbortSignal,
      );

      const body = JSON.parse(
        String(init?.body),
      );

      expect(body).toEqual({
        model: TEST_MODEL,
        messages: createRequest().messages,
        stream: false,
        format: 'json',
        options: {
          temperature: 0,
        },
      });
    });

    it('应该支持普通文本模式', async () => {
      const fetchMock = mockFetchResponse(
        successResponse('这是普通文本回答'),
      );

      const service = createService();

      const request: LlmGenerateRequest = {
        messages: [
          {
            role: 'user',
            content: '你好',
          },
        ],
        responseFormat: 'text',
      };

      const result = await service.generate(request);

      expect(result.content).toBe(
        '这是普通文本回答',
      );

      const [, init] = fetchMock.mock.calls[0]!;

      const body = JSON.parse(
        String(init?.body),
      );

      expect(body.stream).toBe(false);

      expect(body).not.toHaveProperty('format');

      expect(body).not.toHaveProperty('options');
    });

    it('未设置 Base URL 时应该使用默认地址', async () => {
      const fetchMock = mockFetchResponse(
        successResponse(),
      );

      const service = createService({
        OLLAMA_BASE_URL: undefined,
      });

      await service.generate(createRequest());

      expect(fetchMock).toHaveBeenCalledWith(
        TEST_ENDPOINT,
        expect.any(Object),
      );
    });

    it('应该原样返回模型文本，不提前解析 P1 JSON', async () => {
      const rawContent = 'not-valid-p1-json';

      mockFetchResponse(
        successResponse(rawContent),
      );

      const service = createService();

      const result = await service.generate(
        createRequest(),
      );

      expect(result.content).toBe(rawContent);
    });
  });

  // ==========================================================
  // 第二组：模型配置校验
  // ==========================================================

  describe('模型配置校验', () => {
    it('缺少模型名称时应该拒绝调用', async () => {
      const service = createService({
        OLLAMA_MODEL: undefined,
      });

      await expect(
        service.generate(createRequest()),
      ).rejects.toMatchObject({
        code: 'MODEL_NOT_CONFIGURED',
      });
    });

    it('无效 Base URL 应该触发配置错误', async () => {
      const service = createService({
        OLLAMA_BASE_URL: 'invalid-url',
      });

      await expect(
        service.generate(createRequest()),
      ).rejects.toMatchObject({
        code: 'INVALID_CONFIGURATION',
      });
    });

    it('包含账号密码的 Base URL 应该被拒绝', async () => {
      const service = createService({
        OLLAMA_BASE_URL:
          'http://user:password@localhost:11434',
      });

      await expect(
        service.generate(createRequest()),
      ).rejects.toMatchObject({
        code: 'INVALID_CONFIGURATION',
      });
    });
  });

  // ==========================================================
  // 第三组：请求参数校验
  // ==========================================================

  describe('请求参数校验', () => {
    it('应该拒绝空消息列表', async () => {
      const service = createService();

      const request: LlmGenerateRequest = {
        messages: [],
        responseFormat: 'json',
      };

      await expect(
        service.generate(request),
      ).rejects.toMatchObject({
        code: 'INVALID_REQUEST',
      });
    });

    it('应该拒绝非法消息角色', async () => {
      const service = createService();

      const request = {
        messages: [
          {
            role: 'unknown_role',
            content: '测试内容',
          },
        ],
        responseFormat: 'json',
      } as unknown as LlmGenerateRequest;

      await expect(
        service.generate(request),
      ).rejects.toMatchObject({
        code: 'INVALID_REQUEST',
      });
    });

    it('应该拒绝不支持的响应格式', async () => {
      const service = createService();

      const request = {
        ...createRequest(),
        responseFormat: 'xml',
      } as unknown as LlmGenerateRequest;

      await expect(
        service.generate(request),
      ).rejects.toMatchObject({
        code: 'INVALID_REQUEST',
      });
    });

    it('应该拒绝超出范围的 temperature', async () => {
      const service = createService();

      const request: LlmGenerateRequest = {
        ...createRequest(),
        temperature: 2.5,
      };

      await expect(
        service.generate(request),
      ).rejects.toMatchObject({
        code: 'INVALID_REQUEST',
      });
    });

    it('应该拒绝非法 timeoutMs', async () => {
      const service = createService();

      const request: LlmGenerateRequest = {
        ...createRequest(),
        timeoutMs: 0,
      };

      await expect(
        service.generate(request),
      ).rejects.toMatchObject({
        code: 'INVALID_REQUEST',
      });
    });
  });

  // ==========================================================
  // 第四组：HTTP 和模型响应异常
  // ==========================================================

  describe('HTTP 与响应异常', () => {
    it('HTTP 503 应该返回 MODEL_HTTP_ERROR', async () => {
      const fetchMock = mockFetchResponse(
        jsonResponse(
          { error: 'service unavailable' },
          503,
        ),
      );

      const service = createService();

      await expect(
        service.generate(createRequest()),
      ).rejects.toMatchObject({
        code: 'MODEL_HTTP_ERROR',
        statusCode: 503,
      });

      // 不进行隐藏的自动重试
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it('网络异常应该返回 MODEL_NETWORK_ERROR', async () => {
      const fetchMock = vi.fn<typeof fetch>(
        async () => {
          throw new TypeError('connection refused');
        },
      );

      vi.stubGlobal('fetch', fetchMock);

      const service = createService();

      await expect(
        service.generate(createRequest()),
      ).rejects.toMatchObject({
        code: 'MODEL_NETWORK_ERROR',
      });
    });

    it('HTTP 响应不是合法 JSON 时应该拒绝', async () => {
      mockFetchResponse(
        new Response('this-is-not-json', {
          status: 200,
        }),
      );

      const service = createService();

      await expect(
        service.generate(createRequest()),
      ).rejects.toMatchObject({
        code: 'MODEL_RESPONSE_INVALID',
      });
    });

    it('缺少 done=true 时应该拒绝响应', async () => {
      mockFetchResponse(
        jsonResponse({
          model: TEST_MODEL,
          message: {
            role: 'assistant',
            content: 'hello',
          },
          done: false,
        }),
      );

      const service = createService();

      await expect(
        service.generate(createRequest()),
      ).rejects.toMatchObject({
        code: 'MODEL_RESPONSE_INVALID',
      });
    });

    it('模型返回空内容时应该拒绝响应', async () => {
      mockFetchResponse(
        successResponse('   '),
      );

      const service = createService();

      await expect(
        service.generate(createRequest()),
      ).rejects.toMatchObject({
        code: 'MODEL_RESPONSE_INVALID',
      });
    });

    it('模型响应缺少模型名称时应该拒绝', async () => {
      mockFetchResponse(
        jsonResponse({
          model: '',
          message: {
            role: 'assistant',
            content: 'hello',
          },
          done: true,
        }),
      );

      const service = createService();

      await expect(
        service.generate(createRequest()),
      ).rejects.toMatchObject({
        code: 'MODEL_RESPONSE_INVALID',
      });
    });
  });

  // ==========================================================
  // 第五组：请求超时与取消
  // ==========================================================

  describe('请求超时与取消', () => {
    it('超过 timeoutMs 后应该取消请求', async () => {
      vi.useFakeTimers();

      const fetchMock = mockAbortableFetch();

      const service = createService();

      const request: LlmGenerateRequest = {
        ...createRequest(),
        timeoutMs: 100,
      };

      const pending = service.generate(request);

      // 先注册 rejection 断言，
      // 再推进模拟时间，避免未处理的拒绝。
      const assertion = expect(
        pending,
      ).rejects.toMatchObject({
        code: 'MODEL_TIMEOUT',
      });

      await vi.advanceTimersByTimeAsync(101);

      await assertion;

      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it('外部 AbortSignal 应该取消模型请求', async () => {
      const fetchMock = mockAbortableFetch();

      const service = createService();

      const controller = new AbortController();

      const request: LlmGenerateRequest = {
        ...createRequest(),
        signal: controller.signal,
      };

      const pending = service.generate(request);

      const assertion = expect(
        pending,
      ).rejects.toMatchObject({
        code: 'MODEL_CANCELLED',
      });

      controller.abort();

      await assertion;

      expect(fetchMock).toHaveBeenCalledTimes(1);
    });
  });
});
