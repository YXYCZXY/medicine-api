import { BadRequestException, ConflictException } from '@nestjs/common';

import { applyDictionaryActions } from './dictionary-actions.js';

describe('applyDictionaryActions', () => {
  const base = {
    categories: ['感冒咳嗽', '退烧止痛'],
    efficacies: ['退烧', '止痛'],
    symptoms: ['发热咳嗽', '鼻塞流涕'],
  };

  it('按顺序新增、删除、重命名，缺失项忽略', () => {
    expect(
      applyDictionaryActions(base, [
        { field: 'categories', op: 'add', value: '保健品' },
        { field: 'categories', op: 'add', value: '保健品' },
        { field: 'categories', op: 'remove', value: '感冒咳嗽' },
        { field: 'categories', op: 'remove', value: '不存在' },
        { field: 'efficacies', op: 'rename', from: '退烧', to: '解热' },
        { field: 'efficacies', op: 'rename', from: '缺失', to: '其它' },
        { field: 'symptoms', op: 'add', value: '喉咙痛' },
        { field: 'symptoms', op: 'remove', value: '鼻塞流涕' },
        { field: 'symptoms', op: 'rename', from: '发热咳嗽', to: '发烧咳嗽' },
      ]),
    ).toEqual({
      categories: ['退烧止痛', '保健品'],
      efficacies: ['解热', '止痛'],
      symptoms: ['发烧咳嗽', '喉咙痛'],
    });
  });

  it('重命名目标已存在时冲突', () => {
    expect(() =>
      applyDictionaryActions(base, [
        { field: 'categories', op: 'rename', from: '感冒咳嗽', to: '退烧止痛' },
      ]),
    ).toThrow(ConflictException);
    expect(() =>
      applyDictionaryActions(base, [
        { field: 'symptoms', op: 'rename', from: '发热咳嗽', to: '鼻塞流涕' },
      ]),
    ).toThrow(ConflictException);
  });

  it('超出上限时报错', () => {
    const categories = Array.from({ length: 50 }, (_, index) => `类${index}`);
    expect(() =>
      applyDictionaryActions(
        { categories, efficacies: [], symptoms: [] },
        [{ field: 'categories', op: 'add', value: '新类' }],
      ),
    ).toThrow(BadRequestException);
    const symptoms = Array.from({ length: 50 }, (_, index) => `症${index}`);
    expect(() =>
      applyDictionaryActions(
        { categories: [], efficacies: [], symptoms },
        [{ field: 'symptoms', op: 'add', value: '新症' }],
      ),
    ).toThrow(BadRequestException);
  });
});
