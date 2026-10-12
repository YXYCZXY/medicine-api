import { randomUUID } from 'node:crypto';

import {
  FastifyAdapter,
  type NestFastifyApplication,
} from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';

import { AppModule } from '../src/app.module.js';
import { PrismaService } from '../src/database/prisma/prisma.service.js';
import { Prisma } from '../src/generated/prisma/client.js';

const OTHER_USER_ID = '99999999-9999-4999-8999-999999999999';
const CATEGORY_ID = '22222222-2222-4222-8222-222222222222';
const MISSING_ID = '33333333-3333-4333-8333-333333333333';

const CATEGORIES = [
  { id: '44444444-4444-4444-8444-444444444444', name: '其他', sort_order: 8 },
  { id: CATEGORY_ID, name: '止痛', sort_order: 2 },
];

type Row = Record<string, unknown> & { id: string; user_id: string };

/**
 * 内存版 Prisma，只实现药品模块用到的查询
 */
function createPrismaFake() {
  const rows = new Map<string, Row>();

  const withCategory = (row: Row) => ({
    ...row,
    medicine_categories:
      CATEGORIES.find((category) => category.id === row.category_id) ?? null,
  });

  const toDecimal = (value: unknown) =>
    value === null || value === undefined
      ? null
      : new Prisma.Decimal(value as number);

  return {
    rows,
    medicine_categories: {
      findMany: vi.fn(async () =>
        [...CATEGORIES].sort((a, b) => a.sort_order - b.sort_order),
      ),
      findUnique: vi.fn(
        async ({ where }: { where: { id: string } }) =>
          CATEGORIES.find((category) => category.id === where.id) ?? null,
      ),
    },
    medicine_items: {
      findMany: vi.fn(async ({ where }: { where: { user_id: string } }) =>
        [...rows.values()]
          .filter((row) => row.user_id === where.user_id)
          .map(withCategory),
      ),
      findFirst: vi.fn(
        async ({ where }: { where: { id: string; user_id: string } }) => {
          const row = rows.get(where.id);
          return row && row.user_id === where.user_id ? row : null;
        },
      ),
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        const now = new Date();
        const row: Row = {
          ...(data as Row),
          id: randomUUID(),
          dose_per_time: toDecimal(data.dose_per_time),
          created_at: now,
          updated_at: now,
        };
        rows.set(row.id, row);
        return withCategory(row);
      }),
      update: vi.fn(
        async ({
          where,
          data,
        }: {
          where: { id: string };
          data: Record<string, unknown>;
        }) => {
          const row = rows.get(where.id)!;
          Object.assign(row, data, { updated_at: new Date() });
          if ('dose_per_time' in data) {
            row.dose_per_time = toDecimal(data.dose_per_time);
          }
          return withCategory(row);
        },
      ),
      deleteMany: vi.fn(
        async ({ where }: { where: { id: string; user_id: string } }) => {
          const row = rows.get(where.id);
          if (!row || row.user_id !== where.user_id) {
            return { count: 0 };
          }
          rows.delete(where.id);
          return { count: 1 };
        },
      ),
    },
  };
}

describe('Medicines API (e2e)', () => {
  let app: NestFastifyApplication;
  let prisma: ReturnType<typeof createPrismaFake>;

  const validPayload = {
    name: '  布洛芬缓释胶囊  ',
    categoryId: CATEGORY_ID,
    quantity: 12,
    unit: '支',
    expirationDate: '2027-03-01',
    dosePerTime: 1.5,
    timesPerDay: 4,
    efficacyTags: [' 止痛 ', '退烧', '止痛'],
    medicationTimings: ['after-meal', 'bedtime'],
    locationId: 'fridge',
    note: null,
  };

  beforeEach(async () => {
    prisma = createPrismaFake();

    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    })
      .overrideProvider(PrismaService)
      .useValue(prisma)
      .compile();

    app = moduleRef.createNestApplication<NestFastifyApplication>(
      new FastifyAdapter(),
    );
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
  });

  afterEach(async () => {
    await app.close();
  });

  it('GET /medicines/categories 按 sortOrder 返回 camelCase 分类', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/medicines/categories',
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual([
      { id: CATEGORY_ID, name: '止痛', sortOrder: 2 },
      { id: CATEGORIES[0].id, name: '其他', sortOrder: 8 },
    ]);
  });

  it('完成一次新增、查询、修改、删除流程', async () => {
    const created = await app.inject({
      method: 'POST',
      url: '/medicines',
      payload: validPayload,
    });

    expect(created.statusCode).toBe(201);
    const medicine = created.json();
    expect(medicine).toMatchObject({
      name: '布洛芬缓释胶囊',
      quantity: 12,
      unit: '支',
      expirationDate: '2027-03-01',
      dosePerTime: 1.5,
      timesPerDay: 4,
      efficacyTags: ['止痛', '退烧'],
      medicationTimings: ['after-meal', 'bedtime'],
      locationId: 'fridge',
      note: null,
      category: { id: CATEGORY_ID, name: '止痛' },
    });
    expect(medicine).not.toHaveProperty('user_id');
    expect(medicine).not.toHaveProperty('dose_per_time');

    const list = await app.inject({ method: 'GET', url: '/medicines' });
    expect(list.statusCode).toBe(200);
    expect(list.json()).toHaveLength(1);

    const updated = await app.inject({
      method: 'PATCH',
      url: `/medicines/${medicine.id}`,
      payload: { dosePerTime: null, timesPerDay: null, quantity: 0 },
    });
    expect(updated.statusCode).toBe(200);
    expect(updated.json()).toMatchObject({
      quantity: 0,
      dosePerTime: null,
      timesPerDay: null,
    });

    const removed = await app.inject({
      method: 'DELETE',
      url: `/medicines/${medicine.id}`,
    });
    expect(removed.statusCode).toBe(204);
    expect(removed.body).toBe('');

    const after = await app.inject({ method: 'GET', url: '/medicines' });
    expect(after.json()).toEqual([]);
  });

  it.each([
    [{ dosePerTime: 1.234 }, '单次剂量必须是数字，且最多保留 2 位小数'],
    [{ dosePerTime: 0 }, '单次剂量必须大于 0'],
    [{ timesPerDay: 1.5 }, '每日次数必须是整数'],
    [{ timesPerDay: 0 }, '每日次数超出允许范围'],
    [{ name: '   ' }, '药品名称不能为空'],
    [{ note: 'a'.repeat(501) }, '备注长度超出限制'],
    [{ specification: '0.3g × 24粒' }, '不支持的字段：specification'],
  ])('POST 参数非法时返回 400：%j', async (patch, message) => {
    const response = await app.inject({
      method: 'POST',
      url: '/medicines',
      payload: { ...validPayload, ...patch },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({ statusCode: 400, message });
    expect(prisma.medicine_items.create).not.toHaveBeenCalled();
  });

  it('分类不存在时返回 400', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/medicines',
      payload: { ...validPayload, categoryId: MISSING_ID },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({
      statusCode: 400,
      message: '药品分类不存在',
    });
  });

  it('PATCH 空请求返回 400', async () => {
    const response = await app.inject({
      method: 'PATCH',
      url: `/medicines/${MISSING_ID}`,
      payload: {},
    });

    expect(response.statusCode).toBe(400);
    expect(response.json().message).toBe('请至少提供一个需要修改的字段');
  });

  it('药品 ID 不是 UUID 时返回 400', async () => {
    const response = await app.inject({
      method: 'DELETE',
      url: '/medicines/not-a-uuid',
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({
      statusCode: 400,
      message: '药品 ID 格式不正确',
    });
  });

  it('其他用户的药品 PATCH / DELETE 返回 404', async () => {
    prisma.rows.set(MISSING_ID, { id: MISSING_ID, user_id: OTHER_USER_ID });

    const patched = await app.inject({
      method: 'PATCH',
      url: `/medicines/${MISSING_ID}`,
      payload: { quantity: 1 },
    });
    const removed = await app.inject({
      method: 'DELETE',
      url: `/medicines/${MISSING_ID}`,
    });

    expect(patched.statusCode).toBe(404);
    expect(removed.statusCode).toBe(404);
    expect(prisma.rows.has(MISSING_ID)).toBe(true);
  });

  it.each([
    ['P2025', 404],
    ['P2003', 400],
  ])('Prisma 错误 %s 映射为 %i', async (code, statusCode) => {
    prisma.medicine_items.findMany.mockRejectedValueOnce(
      new Prisma.PrismaClientKnownRequestError('mock', {
        code,
        clientVersion: 'test',
      }),
    );

    const response = await app.inject({ method: 'GET', url: '/medicines' });

    expect(response.statusCode).toBe(statusCode);
    expect(response.json().statusCode).toBe(statusCode);
  });

  it('数据库 CHECK 约束失败映射为 400', async () => {
    prisma.medicine_items.findMany.mockRejectedValueOnce(
      new Prisma.PrismaClientKnownRequestError(
        'Database error. Code: `23514`. Message: `violates check constraint`',
        { code: 'P2039', clientVersion: 'test' },
      ),
    );

    const response = await app.inject({ method: 'GET', url: '/medicines' });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({
      statusCode: 400,
      message: '数据不符合取值要求',
    });
  });
});
