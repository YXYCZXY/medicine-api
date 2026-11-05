import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import type { Prisma } from '../../generated/prisma/client.js';
import { PrismaService } from '../../database/prisma/prisma.service.js';
import { UserContextService } from '../auth/user-context.service.js';
import {
  applyDictionaryActions,
  lockUserWrites,
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

@Injectable()
export class UserDictionariesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly context: UserContextService,
  ) {}

  private async findForUser(
    db: Pick<Prisma.TransactionClient, 'user_dictionaries'> = this.prisma,
  ): Promise<UserDictionaryRecord> {
    const item = await db.user_dictionaries.findUnique({
      where: { user_id: this.context.getUserId() },
      select: USER_DICTIONARY_SELECT,
    });
    if (!item) throw new NotFoundException('用户字典不存在');
    return item;
  }

  private mutate(
    change: (item: UserDictionaryRecord) => Prisma.user_dictionariesUpdateInput,
  ): Promise<UserDictionaryResponse> {
    const userId = this.context.getUserId();
    return this.prisma.$transaction(async (tx) => {
      await lockUserWrites(tx, userId);
      const item = await this.findForUser(tx);
      const updated = await tx.user_dictionaries.update({
        where: { user_id: userId },
        data: change(item),
        select: USER_DICTIONARY_SELECT,
      });
      return toUserDictionaryResponse(updated);
    });
  }

  async findAll(): Promise<UserDictionaryResponse> {
    return toUserDictionaryResponse(await this.findForUser());
  }

  async findField(
    field: DictionaryField,
  ): Promise<UserDictionaryFieldResponse> {
    return toUserDictionaryFieldResponse(
      field,
      (await this.findForUser())[field],
    );
  }

  addValues(
    field: DictionaryField,
    dto: MutateDictionaryValuesDto,
  ): Promise<UserDictionaryResponse> {
    return this.mutate((item) => {
      const values = [...new Set([...item[field], ...dto.values])];
      if (values.length > 50)
        throw new BadRequestException('每个字典属性最多 50 个标签');
      return { [field]: values };
    });
  }

  removeValues(
    field: DictionaryField,
    dto: MutateDictionaryValuesDto,
  ): Promise<UserDictionaryResponse> {
    return this.mutate((item) => ({
      [field]: item[field].filter((value) => !dto.values.includes(value)),
    }));
  }

  renameValue(
    field: DictionaryField,
    dto: RenameDictionaryValueDto,
  ): Promise<UserDictionaryResponse> {
    if (dto.from === dto.to) throw new BadRequestException('新旧标签不能相同');
    return this.mutate((item) => {
      const values = [...item[field]];
      const index = values.indexOf(dto.from);
      if (index < 0) throw new NotFoundException('标签不存在');
      if (values.includes(dto.to))
        throw new ConflictException('目标标签已存在');
      values[index] = dto.to;
      return { [field]: values };
    });
  }

  applyActions(actions: DictionaryAction[]): Promise<UserDictionaryResponse> {
    return this.mutate((item) => applyDictionaryActions(item, actions));
  }
}
