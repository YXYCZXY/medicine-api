import { BadRequestException, NotFoundException } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';

import type { PrismaService } from '../../database/prisma/prisma.service.js';
import { Prisma } from '../../generated/prisma/client.js';

import { UpdateMedicineDto } from './dto/update-medicine.dto.js';
import { MEDICINE_SELECT, type MedicineRecord } from './medicine-response.mapper.js';
import { MedicinesService } from './medicines.service.js';

const USER_ID = '00000000-0000-4000-8000-000000000001';
const MEDICINE_ID = '11111111-1111-4111-8111-111111111111';
const CATEGORY_ID = '22222222-2222-4222-8222-222222222222';

function createRecord(overrides: Partial<MedicineRecord> = {}): MedicineRecord {
  return {
    id: MEDICINE_ID,
    name: '布洛芬缓释胶囊',
    quantity: 12,
    unit: '粒',
    expiration_date: null,
    efficacy: [],
    dose_per_time: null,
    times_per_day: null,
    medication_timings: [],
    location: null,
    note: null,
    created_at: new Date('2026-10-01T00:00:00.000Z'),
    updated_at: new Date('2026-10-01T00:00:00.000Z'),
    medicine_categories: { id: CATEGORY_ID, name: '止痛' },
    ...overrides,
  };
}

function createPrismaMock() {
  return {
    medicine_categories: {
      findMany: vi.fn(),
      findUnique: vi.fn(),
    },
    medicine_items: {
      findMany: vi.fn(),
      findFirst: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
      deleteMany: vi.fn(),
    },
  };
}

describe('MedicinesService', () => {
  let prisma: ReturnType<typeof createPrismaMock>;
  let service: MedicinesService;

  beforeEach(() => {
    prisma = createPrismaMock();
    const config = { getOrThrow: vi.fn().mockReturnValue(USER_ID) };

    service = new MedicinesService(
      prisma as unknown as PrismaService,
      config as unknown as ConfigService,
    );
  });

  describe('findCategories', () => {
    it('按 sort_order 排序并输出 sortOrder', async () => {
      prisma.medicine_categories.findMany.mockResolvedValue([
        { id: CATEGORY_ID, name: '止痛', sort_order: 2 },
      ]);

      await expect(service.findCategories()).resolves.toEqual([
        { id: CATEGORY_ID, name: '止痛', sortOrder: 2 },
      ]);

      expect(prisma.medicine_categories.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          orderBy: [{ sort_order: 'asc' }, { name: 'asc' }],
        }),
      );
    });
  });

  describe('findAll', () => {
    it('只查询当前用户的数据并映射为响应格式', async () => {
      prisma.medicine_items.findMany.mockResolvedValue([createRecord()]);

      const result = await service.findAll();

      expect(prisma.medicine_items.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { user_id: USER_ID },
          select: MEDICINE_SELECT,
        }),
      );
      expect(result).toHaveLength(1);
      expect(result[0]).toMatchObject({
        id: MEDICINE_ID,
        category: { id: CATEGORY_ID, name: '止痛' },
      });
      expect(result[0]).not.toHaveProperty('user_id');
    });
  });

  describe('create', () => {
    it('分类不存在时返回 400', async () => {
      prisma.medicine_categories.findUnique.mockResolvedValue(null);

      await expect(
        service.create({
          name: '布洛芬',
          categoryId: CATEGORY_ID,
          quantity: 1,
          unit: '粒',
        }),
      ).rejects.toBeInstanceOf(BadRequestException);

      expect(prisma.medicine_items.create).not.toHaveBeenCalled();
    });

    it('写入全部字段，非预设数值原样保存', async () => {
      prisma.medicine_categories.findUnique.mockResolvedValue({
        id: CATEGORY_ID,
      });
      prisma.medicine_items.create.mockResolvedValue(
        createRecord({
          dose_per_time: new Prisma.Decimal('1.5'),
          times_per_day: 4,
        }),
      );

      const result = await service.create({
        name: '布洛芬',
        categoryId: CATEGORY_ID,
        quantity: 12,
        unit: '支',
        expirationDate: '2027-03-01',
        dosePerTime: 1.5,
        timesPerDay: 4,
        efficacyTags: ['止痛'],
        medicationTimings: ['after-meal'],
        locationId: 'fridge',
        note: '冷藏',
      });

      expect(prisma.medicine_items.create).toHaveBeenCalledWith({
        data: {
          user_id: USER_ID,
          category_id: CATEGORY_ID,
          name: '布洛芬',
          quantity: 12,
          unit: '支',
          expiration_date: new Date('2027-03-01T00:00:00.000Z'),
          efficacy: ['止痛'],
          dose_per_time: 1.5,
          times_per_day: 4,
          medication_timings: ['after-meal'],
          location: 'fridge',
          note: '冷藏',
        },
        select: MEDICINE_SELECT,
      });
      expect(result.dosePerTime).toBe(1.5);
      expect(result.timesPerDay).toBe(4);
    });

    it('可选字段未传时写入默认值', async () => {
      prisma.medicine_categories.findUnique.mockResolvedValue({
        id: CATEGORY_ID,
      });
      prisma.medicine_items.create.mockResolvedValue(createRecord());

      await service.create({
        name: '布洛芬',
        categoryId: CATEGORY_ID,
        quantity: 0,
        unit: '粒',
      });

      expect(prisma.medicine_items.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            expiration_date: null,
            efficacy: [],
            dose_per_time: null,
            times_per_day: null,
            medication_timings: [],
            location: null,
            note: null,
          }),
        }),
      );
    });
  });

  describe('update', () => {
    it('空请求返回 400', async () => {
      await expect(service.update(MEDICINE_ID, {})).rejects.toBeInstanceOf(
        BadRequestException,
      );
    });

    it('DTO 实例字段全为 undefined 时也视为空请求', async () => {
      await expect(
        service.update(MEDICINE_ID, new UpdateMedicineDto()),
      ).rejects.toBeInstanceOf(BadRequestException);

      expect(prisma.medicine_items.findFirst).not.toHaveBeenCalled();
    });

    it('药品不存在或不属于当前用户时返回 404', async () => {
      prisma.medicine_items.findFirst.mockResolvedValue(null);

      await expect(
        service.update(MEDICINE_ID, { quantity: 3 }),
      ).rejects.toBeInstanceOf(NotFoundException);

      expect(prisma.medicine_items.findFirst).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: MEDICINE_ID, user_id: USER_ID },
        }),
      );
      expect(prisma.medicine_items.update).not.toHaveBeenCalled();
    });

    it('分类不存在时返回 400', async () => {
      prisma.medicine_items.findFirst.mockResolvedValue({ id: MEDICINE_ID });
      prisma.medicine_categories.findUnique.mockResolvedValue(null);

      await expect(
        service.update(MEDICINE_ID, { categoryId: CATEGORY_ID }),
      ).rejects.toBeInstanceOf(BadRequestException);

      expect(prisma.medicine_items.update).not.toHaveBeenCalled();
    });

    it('只更新传入的字段，null 用于清空', async () => {
      prisma.medicine_items.findFirst.mockResolvedValue({ id: MEDICINE_ID });
      prisma.medicine_items.update.mockResolvedValue(createRecord());

      await service.update(MEDICINE_ID, {
        quantity: 3,
        dosePerTime: null,
        timesPerDay: null,
        expirationDate: null,
        locationId: null,
      });

      expect(prisma.medicine_items.update).toHaveBeenCalledWith({
        where: { id: MEDICINE_ID, user_id: USER_ID },
        data: {
          quantity: 3,
          dose_per_time: null,
          times_per_day: null,
          expiration_date: null,
          location: null,
        },
        select: MEDICINE_SELECT,
      });
    });
  });

  describe('remove', () => {
    it('药品不存在时返回 404', async () => {
      prisma.medicine_items.deleteMany.mockResolvedValue({ count: 0 });

      await expect(service.remove(MEDICINE_ID)).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });

    it('只删除当前用户的药品', async () => {
      prisma.medicine_items.deleteMany.mockResolvedValue({ count: 1 });

      await expect(service.remove(MEDICINE_ID)).resolves.toBeUndefined();

      expect(prisma.medicine_items.deleteMany).toHaveBeenCalledWith({
        where: { id: MEDICINE_ID, user_id: USER_ID },
      });
    });
  });
});
