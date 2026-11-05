import { randomUUID } from 'node:crypto';

import {
  FastifyAdapter,
  type NestFastifyApplication,
} from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';

import { AppModule } from '../src/app.module.js';
import { AuthGuard } from '../src/modules/auth/auth.guard.js';
import { UserContextService } from '../src/modules/auth/user-context.service.js';
import { PrismaService } from '../src/database/prisma/prisma.service.js';
import { Prisma } from '../src/generated/prisma/client.js';

const OTHER_USER_ID = '99999999-9999-4999-8999-999999999999';
const MISSING_ID = '33333333-3333-4333-8333-333333333333';

type Row = Record<string, unknown> & { id: string; user_id: string };

/**
 * 内存版 Prisma，只实现药品模块用到的查询
 */
function createPrismaFake() {
  const rows = new Map<string, Row>();

  const toDecimal = (value: unknown) =>
    value === null || value === undefined
      ? null
      : new Prisma.Decimal(value as number);

  return {
    rows,
    medicine_items: {
      findMany: vi.fn(async ({ where }: { where: { user_id: string } }) =>
        [...rows.values()]
          .filter((row) => row.user_id === where.user_id),
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
        return row;
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
          return row;
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
    category: '止痛',
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
      .overrideProvider(AuthGuard)
      .useValue({ canActivate: () => true })
      .overrideProvider(UserContextService)
      .useValue({ run: (next: () => void) => next(), getUserId: () => '00000000-0000-4000-8000-000000000001' })
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

  it('分类目录接口已移除', async () => {
    const response = await app.inject({ method: 'GET', url: '/medicines/categories' });
    expect(response.statusCode).toBe(404);
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
      category: '止痛',
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
    [{ category: '   ' }, '药品分类不能为空'],
    [{ category: 'a'.repeat(51) }, '药品分类长度超出限制'],
    [{ category: null }, '药品分类不能为空'],
    [{ category: ['止痛'] }, '药品分类必须是文本'],
    [{ categoryId: '11111111-1111-4111-8111-111111111111' }, '不支持的字段：categoryId'],
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

  it('POST 缺少大类时返回 400', async () => {
    const { category: _omit, ...withoutCategory } = validPayload;
    const response = await app.inject({
      method: 'POST',
      url: '/medicines',
      payload: withoutCategory,
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({
      statusCode: 400,
      message: '药品分类不能为空',
    });
    expect(prisma.medicine_items.create).not.toHaveBeenCalled();
  });

  it('创建时去除大类首尾空格，局部更新不传大类时保持原值', async () => {
    const created = await app.inject({
      method: 'POST',
      url: '/medicines',
      payload: { ...validPayload, category: '  解热镇痛  ' },
    });

    expect(created.statusCode).toBe(201);
    expect(created.json().category).toBe('解热镇痛');

    const updated = await app.inject({
      method: 'PATCH',
      url: `/medicines/${created.json().id}`,
      payload: { quantity: 10 },
    });

    expect(updated.statusCode).toBe(200);
    expect(updated.json()).toMatchObject({
      quantity: 10,
      category: '解热镇痛',
    });
    expect(prisma.medicine_items.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: { quantity: 10 },
      }),
    );
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
