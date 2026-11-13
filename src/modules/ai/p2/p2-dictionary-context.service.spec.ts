import { describe, expect, it, vi } from 'vitest';

import type { UserDictionariesService } from '../../user-dictionaries/user-dictionaries.service.js';
import { P2DictionaryContextService } from './p2-dictionary-context.service.js';

/**
 * 只模拟现有业务服务的 findAll()，不连接数据库、认证服务或 NestJS 容器。
 * 真实业务服务的身份校验由 UserDictionariesService 自己负责。
 */
function createFixture() {
  const findAll = vi.fn();
  const userDictionaries = {
    findAll,
  } as unknown as UserDictionariesService;

  return {
    findAll,
    service: new P2DictionaryContextService(userDictionaries),
  };
}

function dictionaryResponse(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    id: 'dict_1',
    categories: ['感冒药', '退烧药', '肠胃药'],
    efficacies: ['退热', '止痛'],
    symptoms: ['发热', '头痛'],
    createdAt: '2026-11-01T00:00:00.000Z',
    updatedAt: '2026-11-02T00:00:00.000Z',
    ...overrides,
  };
}

describe('P2DictionaryContextService', () => {
  it('完整保留三个维度中的全部标签，不执行 Top 1 筛选、排序或语义匹配', async () => {
    const { findAll, service } = createFixture();
    findAll.mockResolvedValue(dictionaryResponse());

    await expect(service.load()).resolves.toEqual({
      status: 'available',
      values: {
        categories: ['感冒药', '退烧药', '肠胃药'],
        efficacies: ['退热', '止痛'],
        symptoms: ['发热', '头痛'],
      },
    });
    expect(findAll).toHaveBeenCalledTimes(1);
    expect(findAll).toHaveBeenCalledWith();
  });

  it('只向 P2 暴露三个标签数组，不暴露字典 ID 和时间字段', async () => {
    const { findAll, service } = createFixture();
    findAll.mockResolvedValue(dictionaryResponse());

    const result = await service.load();
    expect(result.status).toBe('available');
    expect(result).not.toHaveProperty('id');
    expect(result).not.toHaveProperty('createdAt');
    expect(result).not.toHaveProperty('updatedAt');
    if (result.status === 'available') {
      expect(Object.keys(result.values).sort()).toEqual([
        'categories',
        'efficacies',
        'symptoms',
      ]);
    }
  });

  it('返回独立数组，后续修改 P2 数组不会修改业务层返回的数据', async () => {
    const { findAll, service } = createFixture();
    const response = dictionaryResponse();
    findAll.mockResolvedValue(response);

    const result = await service.load();
    expect(result.status).toBe('available');
    if (result.status !== 'available') {
      throw new Error('预期用户字典可用');
    }

    expect(result.values.categories).not.toBe(response.categories);
    expect(result.values.efficacies).not.toBe(response.efficacies);
    expect(result.values.symptoms).not.toBe(response.symptoms);
    result.values.categories.push('新增标签');
    expect(response.categories).toEqual(['感冒药', '退烧药', '肠胃药']);
  });

  it('只有三个维度全部为空时才返回 empty，并保留三个空数组', async () => {
    const { findAll, service } = createFixture();
    findAll.mockResolvedValue(
      dictionaryResponse({ categories: [], efficacies: [], symptoms: [] }),
    );

    await expect(service.load()).resolves.toEqual({
      status: 'empty',
      values: { categories: [], efficacies: [], symptoms: [] },
    });
  });

  it('只有一个维度非空时仍返回 available', async () => {
    const { findAll, service } = createFixture();
    findAll.mockResolvedValue(
      dictionaryResponse({
        categories: [],
        efficacies: [],
        symptoms: ['发热'],
      }),
    );

    await expect(service.load()).resolves.toEqual({
      status: 'available',
      values: { categories: [], efficacies: [], symptoms: ['发热'] },
    });
  });

  it('业务读取失败时返回 unavailable/read_failed，而不是 empty', async () => {
    const { findAll, service } = createFixture();
    findAll.mockRejectedValue(new Error('数据库暂时不可用'));

    await expect(service.load()).resolves.toEqual({
      status: 'unavailable',
      reason: 'read_failed',
    });
  });

  it('字典记录不存在导致业务服务抛错时，同样返回 read_failed', async () => {
    const { findAll, service } = createFixture();
    findAll.mockRejectedValue(new Error('用户字典不存在'));

    await expect(service.load()).resolves.toEqual({
      status: 'unavailable',
      reason: 'read_failed',
    });
  });

  it.each([null, undefined, [], 'invalid', 123])(
    '响应根结构为 %s 时返回 invalid_shape',
    async (invalid) => {
      const { findAll, service } = createFixture();
      findAll.mockResolvedValue(invalid);

      await expect(service.load()).resolves.toEqual({
        status: 'unavailable',
        reason: 'invalid_shape',
      });
    },
  );

  it.each(['categories', 'efficacies', 'symptoms'])(
    '%s 缺失时返回 invalid_shape，不将缺失字段当成空字典',
    async (field) => {
      const { findAll, service } = createFixture();
      const response = dictionaryResponse();
      delete response[field];
      findAll.mockResolvedValue(response);

      await expect(service.load()).resolves.toEqual({
        status: 'unavailable',
        reason: 'invalid_shape',
      });
    },
  );

  it.each(['categories', 'efficacies', 'symptoms'])(
    '%s 不是数组时返回 invalid_shape',
    async (field) => {
      const { findAll, service } = createFixture();
      findAll.mockResolvedValue(dictionaryResponse({ [field]: '退热' }));

      await expect(service.load()).resolves.toEqual({
        status: 'unavailable',
        reason: 'invalid_shape',
      });
    },
  );

  it.each([null, 42, {}, '', '   '])(
    '数组含非法元素 %s 时返回 invalid_shape',
    async (invalid) => {
      const { findAll, service } = createFixture();
      findAll.mockResolvedValue(
        dictionaryResponse({ categories: ['感冒药', invalid] }),
      );

      await expect(service.load()).resolves.toEqual({
        status: 'unavailable',
        reason: 'invalid_shape',
      });
    },
  );

  it('读取额外字段不影响标签适配，且不会将额外字段带入结果', async () => {
    const { findAll, service } = createFixture();
    findAll.mockResolvedValue(dictionaryResponse({ extra: 'internal-only' }));

    const result = await service.load();
    expect(result.status).toBe('available');
    expect(result).not.toHaveProperty('extra');
    if (result.status === 'available') {
      expect(result.values).not.toHaveProperty('extra');
    }
  });
});
