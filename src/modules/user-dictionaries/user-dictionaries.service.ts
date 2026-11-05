import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';

import { PrismaService } from '../../database/prisma/prisma.service.js';
import { UserContextService } from '../auth/user-context.service.js';
import {
  applyDictionaryActions,
  type DictionaryAction,
} from './dictionary-actions.js';
import type { DictionaryField } from './dto/dictionary-field.js';
import type { MutateDictionaryValuesDto } from './dto/mutate-dictionary-values.dto.js';
import type { RenameDictionaryValueDto } from './dto/rename-dictionary-value.dto.js';
import {
  toUserDictionaryFieldResponse,
  toUserDictionaryResponse,
  USER_DICTIONARY_SELECT,
  type UserDictionaryFieldResponse,
  type UserDictionaryRecord,
  type UserDictionaryResponse,
} from './user-dictionary-response.mapper.js';

const MAX_FIELD_VALUES = 50;

@Injectable()
export class UserDictionariesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly context: UserContextService,
  ) {}

  private getUserId(): string {
    return this.context.getUserId();
  }

  private async findForUser(): Promise<UserDictionaryRecord> {
    const item = await this.prisma.user_dictionaries.findUnique({
      where: { user_id: this.getUserId() },
      select: USER_DICTIONARY_SELECT,
    });
    if (!item) throw new NotFoundException('用户字典不存在');
    return item;
  }

  private fieldValues(
    item: UserDictionaryRecord,
    field: DictionaryField,
  ): string[] {
    return item[field];
  }

  private async saveField(
    field: DictionaryField,
    values: string[],
  ): Promise<UserDictionaryResponse> {
    const updated = await this.prisma.user_dictionaries.update({
      where: { user_id: this.getUserId() },
      data: { [field]: values },
      select: USER_DICTIONARY_SELECT,
    });
    return toUserDictionaryResponse(updated);
  }

  async findAll(): Promise<UserDictionaryResponse> {
    return toUserDictionaryResponse(await this.findForUser());
  }

  async findField(
    field: DictionaryField,
  ): Promise<UserDictionaryFieldResponse> {
    const item = await this.findForUser();
    return toUserDictionaryFieldResponse(field, this.fieldValues(item, field));
  }

  async addValues(
    field: DictionaryField,
    dto: MutateDictionaryValuesDto,
  ): Promise<UserDictionaryResponse> {
    const item = await this.findForUser();
    const current = this.fieldValues(item, field);
    const existing = new Set(current);
    const merged = [...current];
    for (const value of dto.values) {
      if (!existing.has(value)) {
        existing.add(value);
        merged.push(value);
      }
    }
    if (merged.length > MAX_FIELD_VALUES) {
      throw new BadRequestException(`每个字典属性最多 ${MAX_FIELD_VALUES} 个标签`);
    }
    return this.saveField(field, merged);
  }

  async removeValues(
    field: DictionaryField,
    dto: MutateDictionaryValuesDto,
  ): Promise<UserDictionaryResponse> {
    const item = await this.findForUser();
    const remove = new Set(dto.values);
    const next = this.fieldValues(item, field).filter((value) => !remove.has(value));
    return this.saveField(field, next);
  }

  async renameValue(
    field: DictionaryField,
    dto: RenameDictionaryValueDto,
  ): Promise<UserDictionaryResponse> {
    if (dto.from === dto.to) {
      throw new BadRequestException('新旧标签不能相同');
    }
    const item = await this.findForUser();
    const current = this.fieldValues(item, field);
    const fromIndex = current.indexOf(dto.from);
    if (fromIndex < 0) {
      throw new NotFoundException('标签不存在');
    }
    if (current.includes(dto.to)) {
      throw new ConflictException('目标标签已存在');
    }
    const next = [...current];
    next[fromIndex] = dto.to;
    return this.saveField(field, next);
  }

  /** 按顺序重放药品或就诊保存附带的字典行为。 */
  async applyActions(
    actions: DictionaryAction[],
  ): Promise<UserDictionaryResponse> {
    const item = await this.findForUser();
    const next = applyDictionaryActions(
      {
        categories: item.categories,
        efficacies: item.efficacies,
        symptoms: item.symptoms,
      },
      actions,
    );
    const updated = await this.prisma.user_dictionaries.update({
      where: { user_id: this.getUserId() },
      data: {
        categories: next.categories,
        efficacies: next.efficacies,
        symptoms: next.symptoms,
      },
      select: USER_DICTIONARY_SELECT,
    });
    return toUserDictionaryResponse(updated);
  }
}
