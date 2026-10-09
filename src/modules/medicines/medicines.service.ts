import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';

import { ConfigService } from '@nestjs/config';

import { PrismaService } from '../../database/prisma/prisma.service.js';

import { CreateMedicineDto } from './dto/create-medicine.dto.js';
import { UpdateMedicineDto } from './dto/update-medicine.dto.js';

@Injectable()
export class MedicinesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
  ) {}

  /**
   * 当前开发测试用户 ID
   *
   * 正式接入登录系统后，
   * 应从认证信息中获取用户 ID。
   */
  private getUserId(): string {
    return this.config.getOrThrow<string>('DEV_USER_ID');
  }

  /**
   * 获取所有药品分类
   * GET /medicines/categories
   */
  async findCategories() {
    return this.prisma.medicine_categories.findMany({
      select: {
        id: true,
        name: true,
        sort_order: true,
      },
      orderBy: [
        { sort_order: 'asc' },
        { name: 'asc' },
      ],
    });
  }

  /**
   * 获取当前用户的所有药品
   * GET /medicines
   *
   * 返回药品及其关联分类
   */
  async findAll() {
    const userId = this.getUserId();

    const items = await this.prisma.medicine_items.findMany({
      where: {
        user_id: userId,
      },
      orderBy: {
        created_at: 'desc',
      },
    });

    if (items.length === 0) {
      return [];
    }

    // 查询药品分类关联
    const relations =
      await this.prisma.medicine_category_relations.findMany({
        where: {
          medicine_item_id: {
            in: items.map((item) => item.id),
          },
        },
        select: {
          medicine_item_id: true,
          category_id: true,
        },
      });

    // 提取分类 ID
    const categoryIds = [
      ...new Set(
        relations.map((relation) => relation.category_id),
      ),
    ];

    // 查询分类详细信息
    const categories =
      await this.prisma.medicine_categories.findMany({
        where: {
          id: {
            in: categoryIds,
          },
        },
        select: {
          id: true,
          name: true,
        },
        orderBy: [
          { sort_order: 'asc' },
          { name: 'asc' },
        ],
      });

    // 药品 ID -> 分类 ID 集合
    const itemCategoryMap = new Map<string, Set<string>>();

    for (const relation of relations) {
      if (!itemCategoryMap.has(relation.medicine_item_id)) {
        itemCategoryMap.set(
          relation.medicine_item_id,
          new Set<string>(),
        );
      }

      itemCategoryMap
        .get(relation.medicine_item_id)!
        .add(relation.category_id);
    }

    // 组装最终响应
    return items.map((item) => {
      const ids = itemCategoryMap.get(item.id);

      return {
        ...item,
        categories: categories.filter(
          (category) => ids?.has(category.id) ?? false,
        ),
      };
    });
  }

  /**
   * 新增药品
   * POST /medicines
   */
  async create(dto: CreateMedicineDto) {
    const userId = this.getUserId();

    const categoryIds = dto.categoryIds ?? [];

    return this.prisma.$transaction(async (tx) => {
      // 验证分类是否存在
      const categories = categoryIds.length
        ? await tx.medicine_categories.findMany({
            where: {
              id: {
                in: categoryIds,
              },
            },
            select: {
              id: true,
              name: true,
            },
          })
        : [];

      if (categories.length !== categoryIds.length) {
        throw new BadRequestException('部分药品分类不存在');
      }

      // 创建药品
      const medicine = await tx.medicine_items.create({
        data: {
          user_id: userId,
          name: dto.name,
          quantity: dto.quantity,
          unit: dto.unit,
          specification: dto.specification,
          expiration_date: dto.expirationDate
            ? new Date(`${dto.expirationDate}T00:00:00.000Z`)
            : null,
          efficacy: dto.efficacy,
          location: dto.location,
          note: dto.note,
        },
      });

      // 建立分类关联
      if (categoryIds.length > 0) {
        await tx.medicine_category_relations.createMany({
          data: categoryIds.map((categoryId) => ({
            medicine_item_id: medicine.id,
            category_id: categoryId,
          })),
        });
      }

      return {
        ...medicine,
        categories,
      };
    });
  }

  /**
   * 修改药品
   * PATCH /medicines/:id
   *
   * 支持局部更新
   * 支持替换全部分类
   */
  async update(id: string, dto: UpdateMedicineDto) {
    const userId = this.getUserId();

    // 不允许空请求
    if (Object.keys(dto).length === 0) {
      throw new BadRequestException(
        '请至少提供一个需要修改的字段',
      );
    }

    return this.prisma.$transaction(async (tx) => {
      // 1. 查找当前用户拥有的药品
      let medicine = await tx.medicine_items.findFirst({
        where: {
          id,
          user_id: userId,
        },
      });

      if (!medicine) {
        throw new NotFoundException('药品不存在');
      }

      // 2. 如果需要修改分类，先验证分类 ID
      if (dto.categoryIds !== undefined) {
        const categories =
          await tx.medicine_categories.findMany({
            where: {
              id: {
                in: dto.categoryIds,
              },
            },
            select: {
              id: true,
            },
          });

        if (categories.length !== dto.categoryIds.length) {
          throw new BadRequestException(
            '部分药品分类不存在',
          );
        }
      }

      // 3. 判断是否需要修改药品主表
      const hasMedicineChanges =
        dto.name !== undefined ||
        dto.quantity !== undefined ||
        dto.unit !== undefined ||
        dto.specification !== undefined ||
        dto.expirationDate !== undefined ||
        dto.efficacy !== undefined ||
        dto.location !== undefined ||
        dto.note !== undefined;

      // 4. 更新主表
      if (hasMedicineChanges) {
        medicine = await tx.medicine_items.update({
          where: {
            id,
            user_id: userId,
          },
          data: {
            ...(dto.name !== undefined
              ? { name: dto.name }
              : {}),

            ...(dto.quantity !== undefined
              ? { quantity: dto.quantity }
              : {}),

            ...(dto.unit !== undefined
              ? { unit: dto.unit }
              : {}),

            ...(dto.specification !== undefined
              ? { specification: dto.specification }
              : {}),

            ...(dto.expirationDate !== undefined
              ? {
                  expiration_date:
                    dto.expirationDate === null
                      ? null
                      : new Date(
                          `${dto.expirationDate}T00:00:00.000Z`,
                        ),
                }
              : {}),

            ...(dto.efficacy !== undefined
              ? { efficacy: dto.efficacy }
              : {}),

            ...(dto.location !== undefined
              ? { location: dto.location }
              : {}),

            ...(dto.note !== undefined
              ? { note: dto.note }
              : {}),
          },
        });
      }

      // 5. 如果传入 categoryIds，替换分类关联
      if (dto.categoryIds !== undefined) {
        // 删除原有分类关联
        await tx.medicine_category_relations.deleteMany({
          where: {
            medicine_item_id: id,
          },
        });

        // 建立新分类关联
        if (dto.categoryIds.length > 0) {
          await tx.medicine_category_relations.createMany({
            data: dto.categoryIds.map((categoryId) => ({
              medicine_item_id: id,
              category_id: categoryId,
            })),
          });
        }
      }

      // 6. 读取修改后的分类关联
      const relations =
        await tx.medicine_category_relations.findMany({
          where: {
            medicine_item_id: id,
          },
          select: {
            category_id: true,
          },
        });

      // 7. 获取分类详细信息
      const categories =
        await tx.medicine_categories.findMany({
          where: {
            id: {
              in: relations.map((relation) => relation.category_id),
            },
          },
          select: {
            id: true,
            name: true,
          },
          orderBy: [
            { sort_order: 'asc' },
            { name: 'asc' },
          ],
        });

      // 8. 返回修改后的药品
      return {
        ...medicine,
        categories,
      };
    });
  }

  /**
   * 删除药品
   * DELETE /medicines/:id
   *
   * 数据库外键使用 ON DELETE CASCADE
   * 分类关联会自动删除
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