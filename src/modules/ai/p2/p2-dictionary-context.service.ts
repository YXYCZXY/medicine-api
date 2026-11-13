
import { Injectable } from '@nestjs/common';

import { UserDictionariesService } from '../../user-dictionaries/user-dictionaries.service.js';
import type {
  P2DictionaryContext,
  P2DictionaryValues,
} from './schemas/p2.schema.js';

/**
 * 将当前登录用户的字典转换为 P2 字典上下文。
 *
 * 只复用现有业务服务，不直接操作 Prisma。
 * 字典标签仅用于候选匹配，不代表真实业务记录。
 */
@Injectable()
export class P2DictionaryContextService {
  constructor(
    private readonly userDictionaries: UserDictionariesService,
  ) {}

  async load(): Promise<P2DictionaryContext> {
    let response: unknown;

    try {
      response = await this.userDictionaries.findAll();
    } catch {
      // 读取失败不能被解释为用户字典为空。
      return {
        status: 'unavailable',
        reason: 'read_failed',
      };
    }

    if (!this.isRecord(response)) {
      return {
        status: 'unavailable',
        reason: 'invalid_shape',
      };
    }

    const { categories, efficacies, symptoms } = response;

    if (
      !this.isValidDictionaryArray(categories) ||
      !this.isValidDictionaryArray(efficacies) ||
      !this.isValidDictionaryArray(symptoms)
    ) {
      return {
        status: 'unavailable',
        reason: 'invalid_shape',
      };
    }

    // 复制数组，避免后续操作修改业务层数据。
    const values: P2DictionaryValues = {
      categories: [...categories],
      efficacies: [...efficacies],
      symptoms: [...symptoms],
    };

    const isEmpty =
      values.categories.length === 0 &&
      values.efficacies.length === 0 &&
      values.symptoms.length === 0;

    return {
      status: isEmpty ? 'empty' : 'available',
      values,
    };
  }

  private isRecord(
    value: unknown,
  ): value is Record<string, unknown> {
    return (
      typeof value === 'object' &&
      value !== null &&
      !Array.isArray(value)
    );
  }

  private isValidDictionaryArray(
    value: unknown,
  ): value is string[] {
    return (
      Array.isArray(value) &&
      value.every(
        (item) =>
          typeof item === 'string' &&
          item.trim().length > 0,
      )
    );
  }
}
