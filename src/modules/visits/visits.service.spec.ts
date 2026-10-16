import {
  BadRequestException,
  ConflictException,
  NotFoundException,
} from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';

import type { PrismaService } from '../../database/prisma/prisma.service.js';
import { Prisma } from '../../generated/prisma/client.js';

import { CreateVisitDto } from './dto/create-visit.dto.js';
import { UpdateVisitDto } from './dto/update-visit.dto.js';
import { VisitsService } from './visits.service.js';

const USER_ID = '00000000-0000-4000-8000-000000000001';
const VISIT_ID = '33333333-3333-4333-8333-333333333333';
const ROOT_ID = '11111111-1111-4111-8111-111111111111';
const FOLLOWUP_B_ID = '22222222-2222-4222-8222-222222222222';
const MEDICINE_ID = '44444444-4444-4444-8444-444444444444';
const CATEGORY_ID = '55555555-5555-4555-8555-555555555555';
const LINE_ID = '66666666-6666-4666-8666-666666666666';
const LINE_ID_2 = '77777777-7777-4777-8777-777777777777';

function createDetailRecord(overrides: Record<string, unknown> = {}) {
  return {
    id: VISIT_ID,
    visit_date: new Date('2026-10-15T00:00:00.000Z'),
    initial_visit_id: null,
    hospital_name: null,
    department: null,
    doctor_name: null,
    symptom_tags: [],
    symptom_note: null,
    diagnosis: null,
    prescription: null,
    advice: null,
    photo_keys: [],
    version: 1,
    created_at: new Date('2026-10-15T01:00:00.000Z'),
    updated_at: new Date('2026-10-15T01:00:00.000Z'),
    visit_medicines: [],
    ...overrides,
  };
}

function createPrismaMock() {
  const tx = {
    $queryRaw: vi.fn().mockResolvedValue([]),
    visit_records: {
      create: vi.fn(),
      findFirst: vi.fn(),
      findMany: vi.fn(),
      update: vi.fn(),
      updateMany: vi.fn(),
      deleteMany: vi.fn(),
    },
    visit_medicines: {
      findMany: vi.fn().mockResolvedValue([]),
      findFirst: vi.fn().mockResolvedValue(null),
      create: vi.fn(),
      createMany: vi.fn(),
      update: vi.fn(),
      deleteMany: vi.fn(),
    },
    medicine_items: {
      findMany: vi.fn().mockResolvedValue([]),
      create: vi.fn(),
    },
    medicine_categories: {
      findUnique: vi.fn(),
    },
  };

  return {
    tx,
    $queryRaw: vi.fn(),
    $transaction: vi.fn(async (callback: (client: typeof tx) => unknown) =>
      callback(tx),
    ),
    visit_records: {
      findFirst: vi.fn(),
      findMany: vi.fn(),
    },
  };
}

describe('VisitsService', () => {
  let prisma: ReturnType<typeof createPrismaMock>;
  let service: VisitsService;

  beforeEach(() => {
    prisma = createPrismaMock();
    const config = { getOrThrow: vi.fn().mockReturnValue(USER_ID) };
    service = new VisitsService(
      prisma as unknown as PrismaService,
      config as unknown as ConfigService,
    );
  });

  describe('findOne', () => {
    it('不存在时返回 404', async () => {
      prisma.visit_records.findFirst.mockResolvedValue(null);

      await expect(service.findOne(VISIT_ID)).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });

    it('复诊根已删时 initialVisit 为 null，保留 initialVisitId', async () => {
      prisma.visit_records.findFirst
        .mockResolvedValueOnce(
          createDetailRecord({ initial_visit_id: ROOT_ID }),
        )
        .mockResolvedValueOnce(null);

      const result = await service.findOne(VISIT_ID);

      expect(result.initialVisitId).toBe(ROOT_ID);
      expect(result.initialVisit).toBeNull();
      expect(result.photos).toEqual([]);
    });
  });

  describe('create', () => {
    const baseDto: CreateVisitDto = {
      id: VISIT_ID,
      visitDate: '2026-10-15',
      initialVisitId: null,
      symptomTags: [],
      medicines: [],
    };

    it('主键冲突返回 409', async () => {
      prisma.tx.visit_records.create.mockRejectedValue(
        new Prisma.PrismaClientKnownRequestError('Unique constraint', {
          code: 'P2002',
          clientVersion: '7.0.0',
          meta: { target: ['visit_records_pkey'] },
        }),
      );

      await expect(service.create(baseDto)).rejects.toBeInstanceOf(
        ConflictException,
      );
    });

    it('关联组内复诊 B 时写入 B.initial_visit_id 而不是 B.id', async () => {
      prisma.tx.visit_records.create.mockResolvedValue({});
      prisma.tx.visit_records.findFirst
        // selected B
        .mockResolvedValueOnce({
          id: FOLLOWUP_B_ID,
          initial_visit_id: ROOT_ID,
          visit_date: new Date('2026-10-10T00:00:00.000Z'),
        })
        // root R
        .mockResolvedValueOnce({
          id: ROOT_ID,
          user_id: USER_ID,
          initial_visit_id: null,
          visit_date: new Date('2026-09-01T00:00:00.000Z'),
        })
        // loadDetail
        .mockResolvedValueOnce(
          createDetailRecord({ initial_visit_id: ROOT_ID }),
        )
        .mockResolvedValueOnce(
          createDetailRecord({
            id: ROOT_ID,
            visit_date: new Date('2026-09-01T00:00:00.000Z'),
          }),
        );

      prisma.tx.visit_records.update.mockResolvedValue({});

      const result = await service.create(
        Object.assign(new CreateVisitDto(), baseDto, {
          initialVisitId: FOLLOWUP_B_ID,
        }),
      );

      expect(prisma.tx.visit_records.update).toHaveBeenCalledWith({
        where: { id: VISIT_ID },
        data: { initial_visit_id: ROOT_ID },
      });
      expect(result.initialVisitId).toBe(ROOT_ID);
    });

    it('根已删除时仍允许写入 stored UUID', async () => {
      prisma.tx.visit_records.create.mockResolvedValue({});
      prisma.tx.visit_records.findFirst
        .mockResolvedValueOnce({
          id: FOLLOWUP_B_ID,
          initial_visit_id: ROOT_ID,
          visit_date: new Date('2026-10-10T00:00:00.000Z'),
        })
        // root missing
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce(
          createDetailRecord({ initial_visit_id: ROOT_ID }),
        )
        .mockResolvedValueOnce(null);

      prisma.tx.visit_records.update.mockResolvedValue({});

      const result = await service.create(
        Object.assign(new CreateVisitDto(), baseDto, {
          initialVisitId: FOLLOWUP_B_ID,
        }),
      );

      expect(prisma.tx.visit_records.update).toHaveBeenCalledWith({
        where: { id: VISIT_ID },
        data: { initial_visit_id: ROOT_ID },
      });
      expect(result.initialVisit).toBeNull();
    });

    it('三条用药路径：引用药箱 / 仅快照 / 入箱新建', async () => {
      prisma.tx.visit_records.create.mockResolvedValue({});
      prisma.tx.medicine_items.findMany.mockResolvedValue([{ id: MEDICINE_ID }]);
      prisma.tx.medicine_categories.findUnique.mockResolvedValue({
        id: CATEGORY_ID,
      });
      prisma.tx.medicine_items.create.mockResolvedValue({
        id: '88888888-8888-4888-8888-888888888888',
      });
      prisma.tx.visit_medicines.createMany.mockResolvedValue({ count: 3 });
      prisma.tx.visit_records.findFirst.mockResolvedValue(
        createDetailRecord({
          visit_medicines: [],
        }),
      );

      await service.create(
        Object.assign(new CreateVisitDto(), baseDto, {
          medicines: [
            {
              id: LINE_ID,
              medicineId: MEDICINE_ID,
              name: '药箱中的药',
              unit: '粒',
              dosePerTime: 1,
              timesPerDay: 2,
              medicationTimings: ['after-meal'],
            },
            {
              id: LINE_ID_2,
              medicineId: null,
              name: '仅快照',
              unit: '片',
            },
            {
              id: '99999999-9999-4999-8999-999999999999',
              medicineId: null,
              name: '新开的药',
              unit: '支',
              dosePerTime: 1,
              timesPerDay: 3,
              medicationTimings: [],
              cabinet: {
                categoryId: CATEGORY_ID,
                quantity: 12,
                expirationDate: '2027-08-01',
                efficacyTags: ['止咳'],
                locationId: 'living',
                note: '本次门诊购入',
              },
            },
          ],
        }),
      );

      expect(prisma.tx.medicine_items.create).toHaveBeenCalledTimes(1);
      expect(prisma.tx.visit_medicines.createMany).toHaveBeenCalledWith({
        data: expect.arrayContaining([
          expect.objectContaining({
            id: LINE_ID,
            medicine_id: MEDICINE_ID,
          }),
          expect.objectContaining({
            id: LINE_ID_2,
            medicine_id: null,
          }),
          expect.objectContaining({
            medicine_id: '88888888-8888-4888-8888-888888888888',
          }),
        ]),
      });
    });

    it('新增明细引用不存在的药箱记录返回 400', async () => {
      prisma.tx.visit_records.create.mockResolvedValue({});
      prisma.tx.medicine_items.findMany.mockResolvedValue([]);

      await expect(
        service.create(
          Object.assign(new CreateVisitDto(), baseDto, {
            medicines: [
              {
                id: LINE_ID,
                medicineId: MEDICINE_ID,
                name: '药',
                unit: '粒',
              },
            ],
          }),
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
    });
  });

  describe('update', () => {
    it('只有 expectedVersion 时返回 400', async () => {
      await expect(
        service.update(VISIT_ID, { expectedVersion: 1 } as UpdateVisitDto),
      ).rejects.toMatchObject({
        response: expect.objectContaining({ message: '没有需要修改的内容' }),
      });
    });

    it('版本冲突返回 409', async () => {
      prisma.tx.visit_records.findFirst.mockResolvedValue({
        id: VISIT_ID,
        version: 2,
        visit_date: new Date('2026-10-15T00:00:00.000Z'),
        initial_visit_id: null,
      });

      await expect(
        service.update(VISIT_ID, {
          expectedVersion: 1,
          advice: '补充',
        }),
      ).rejects.toBeInstanceOf(ConflictException);
    });

    it('按明细 id 增改删并重写 sort_order', async () => {
      prisma.tx.visit_records.findFirst
        .mockResolvedValueOnce({
          id: VISIT_ID,
          version: 1,
          visit_date: new Date('2026-10-15T00:00:00.000Z'),
          initial_visit_id: null,
        })
        .mockResolvedValueOnce(createDetailRecord({ version: 2 }));

      prisma.tx.visit_records.updateMany.mockResolvedValue({ count: 1 });
      prisma.tx.visit_medicines.findMany
        .mockResolvedValueOnce([
          { id: LINE_ID, visit_id: VISIT_ID, medicine_id: null },
          { id: LINE_ID_2, visit_id: VISIT_ID, medicine_id: null },
        ])
        .mockResolvedValueOnce([]);
      prisma.tx.medicine_items.findMany.mockResolvedValue([]);

      await service.update(VISIT_ID, {
        expectedVersion: 1,
        medicines: [
          {
            id: LINE_ID,
            medicineId: null,
            name: '保留并更新',
            unit: '粒',
          },
          {
            id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
            medicineId: null,
            name: '新增',
            unit: '袋',
          },
        ],
      });

      expect(prisma.tx.visit_medicines.deleteMany).toHaveBeenCalledWith({
        where: { id: { in: [LINE_ID_2] }, visit_id: VISIT_ID },
      });
      expect(prisma.tx.visit_medicines.update).toHaveBeenCalledWith({
        where: { id: LINE_ID },
        data: expect.objectContaining({ sort_order: 0, name: '保留并更新' }),
      });
      expect(prisma.tx.visit_medicines.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
          sort_order: 1,
        }),
      });
    });

    it('已有明细引用已删药箱时 medicine_id 写 null 不报错', async () => {
      prisma.tx.visit_records.findFirst
        .mockResolvedValueOnce({
          id: VISIT_ID,
          version: 1,
          visit_date: new Date('2026-10-15T00:00:00.000Z'),
          initial_visit_id: null,
        })
        .mockResolvedValueOnce(createDetailRecord({ version: 2 }));
      prisma.tx.visit_records.updateMany.mockResolvedValue({ count: 1 });
      prisma.tx.visit_medicines.findMany
        .mockResolvedValueOnce([
          { id: LINE_ID, visit_id: VISIT_ID, medicine_id: MEDICINE_ID },
        ])
        .mockResolvedValueOnce([]);
      prisma.tx.medicine_items.findMany.mockResolvedValue([]);

      await service.update(VISIT_ID, {
        expectedVersion: 1,
        medicines: [
          {
            id: LINE_ID,
            medicineId: MEDICINE_ID,
            name: '仍保留快照',
            unit: '粒',
          },
        ],
      });

      expect(prisma.tx.visit_medicines.update).toHaveBeenCalledWith({
        where: { id: LINE_ID },
        data: expect.objectContaining({ medicine_id: null }),
      });
    });
  });

  describe('remove', () => {
    it('不存在返回 404', async () => {
      prisma.tx.visit_records.findFirst.mockResolvedValue(null);

      await expect(service.remove(VISIT_ID, 1)).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });

    it('版本不一致返回 409', async () => {
      prisma.tx.visit_records.findFirst.mockResolvedValue({
        id: VISIT_ID,
        version: 2,
      });

      await expect(service.remove(VISIT_ID, 1)).rejects.toBeInstanceOf(
        ConflictException,
      );
    });

    it('成功删除', async () => {
      prisma.tx.visit_records.findFirst.mockResolvedValue({
        id: VISIT_ID,
        version: 1,
      });
      prisma.tx.visit_records.deleteMany.mockResolvedValue({ count: 1 });

      await expect(service.remove(VISIT_ID, 1)).resolves.toBeUndefined();
    });
  });

  describe('findAll', () => {
    it('按 ID 顺序回填 items，total 独立计数', async () => {
      prisma.$queryRaw
        .mockResolvedValueOnce([{ total: 2n }])
        .mockResolvedValueOnce([{ id: VISIT_ID }, { id: ROOT_ID }]);

      prisma.visit_records.findMany.mockResolvedValue([
        createDetailRecord({ id: ROOT_ID }),
        createDetailRecord({ id: VISIT_ID }),
      ]);

      const result = await service.findAll({ page: 1, pageSize: 20 });

      expect(result.total).toBe(2);
      expect(result.items.map((item) => item.id)).toEqual([VISIT_ID, ROOT_ID]);
    });
  });
});
