import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';

import { UserContextService } from '../auth/user-context.service.js';

import { PrismaService } from '../../database/prisma/prisma.service.js';
import {
  applyDictionaryActionsInTx,
  type DictionaryAction,
} from '../user-dictionaries/dictionary-actions.js';
import { normalizeDictionaryActions } from '../user-dictionaries/dto/dictionary-action.dto.js';

import { CreateMedicineDto } from './dto/create-medicine.dto.js';
import { UpdateMedicineDto } from './dto/update-medicine.dto.js';
import {
  MEDICINE_SELECT,
  toMedicineResponse,
  type MedicineResponse,
} from './medicine-response.mapper.js';

/**
 * 有效期统一按 UTC 零点保存
 */
function toExpirationDate(value: string | null | undefined): Date | null {
  return value ? new Date(`${value}T00:00:00.000Z`) : null;
}

function actionsFromDto(
  dto: CreateMedicineDto | UpdateMedicineDto,
): DictionaryAction[] | undefined {
  return normalizeDictionaryActions(dto.dictionaryActions);
}

@Injectable()
export class MedicinesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly context: UserContextService,
  ) {}

  private getUserId(): string {
    return this.context.getUserId();
  }

  /**
   * 获取当前用户的所有药品
   * GET /medicines
   *
   * 返回药品及其大类文本
   */
  async findAll(): Promise<MedicineResponse[]> {
    const items = await this.prisma.medicine_items.findMany({
      where: {
        user_id: this.getUserId(),
      },
      select: MEDICINE_SELECT,
      orderBy: {
        created_at: 'desc',
      },
    });

    return items.map(toMedicineResponse);
  }

  /**
   * 新增药品
   * POST /medicines
   */
  async create(dto: CreateMedicineDto, id?: string): Promise<MedicineResponse> {
    const userId = this.getUserId();
    const actions = actionsFromDto(dto);

    const medicine = await this.prisma.$transaction(async (tx) => {
      const created = await tx.medicine_items.create({
        data: {
          ...(id ? { id } : {}),
          user_id: userId,
          category: dto.category,
          name: dto.name,
          quantity: dto.quantity,
          unit: dto.unit,
          expiration_date: toExpirationDate(dto.expirationDate),
          efficacy: dto.efficacyTags ?? [],
          dose_per_time: dto.dosePerTime ?? null,
          times_per_day: dto.timesPerDay ?? null,
          medication_timings: dto.medicationTimings ?? [],
          location: dto.locationId ?? null,
          note: dto.note ?? null,
        },
        select: MEDICINE_SELECT,
      });
      await applyDictionaryActionsInTx(tx, userId, actions);
      return created;
    });

    return toMedicineResponse(medicine);
  }

  /**
   * 修改药品
   * PATCH /medicines/:id
   *
   * 支持局部更新
   */
  async update(
    id: string,
    dto: UpdateMedicineDto,
  ): Promise<MedicineResponse> {
    const userId = this.getUserId();
    const actions = actionsFromDto(dto);

    // 不允许空请求；DTO 类字段会被初始化为 undefined，不能只看 key 数量
    if (
      Object.entries(dto).every(
        ([key, value]) =>
          key === 'dictionaryActions'
            ? !actions?.length
            : value === undefined,
      )
    ) {
      throw new BadRequestException(
        '请至少提供一个需要修改的字段',
      );
    }

    const medicine = await this.prisma.$transaction(async (tx) => {
      const existing = await tx.medicine_items.findFirst({
        where: {
          id,
          user_id: userId,
        },
        select: {
          id: true,
        },
      });

      if (!existing) {
        throw new NotFoundException('药品不存在');
      }

      const updated = await tx.medicine_items.update({
        where: {
          id,
          user_id: userId,
        },
        data: {
          ...(dto.name !== undefined
            ? { name: dto.name }
            : {}),

          ...(dto.category !== undefined
            ? { category: dto.category }
            : {}),

          ...(dto.quantity !== undefined
            ? { quantity: dto.quantity }
            : {}),

          ...(dto.unit !== undefined
            ? { unit: dto.unit }
            : {}),

          ...(dto.expirationDate !== undefined
            ? { expiration_date: toExpirationDate(dto.expirationDate) }
            : {}),

          ...(dto.dosePerTime !== undefined
            ? { dose_per_time: dto.dosePerTime }
            : {}),

          ...(dto.timesPerDay !== undefined
            ? { times_per_day: dto.timesPerDay }
            : {}),

          ...(dto.efficacyTags !== undefined
            ? { efficacy: dto.efficacyTags }
            : {}),

          ...(dto.medicationTimings !== undefined
            ? { medication_timings: dto.medicationTimings }
            : {}),

          ...(dto.locationId !== undefined
            ? { location: dto.locationId }
            : {}),

          ...(dto.note !== undefined
            ? { note: dto.note }
            : {}),
        },
        select: MEDICINE_SELECT,
      });
      await applyDictionaryActionsInTx(tx, userId, actions);
      return updated;
    });

    return toMedicineResponse(medicine);
  }

  /**
   * 删除药品
   * DELETE /medicines/:id
   *
   * 只删除当前用户的药品记录
   */
  async remove(id: string): Promise<void> {
    const userId = this.getUserId();

    const result = await this.prisma.medicine_items.deleteMany({
      where: {
        id,
        user_id: userId,
      },
    });

    if (result.count === 0) {
      throw new NotFoundException('药品不存在');
    }
  }
}
