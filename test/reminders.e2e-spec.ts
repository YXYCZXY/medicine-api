import {
  FastifyAdapter,
  type NestFastifyApplication,
} from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import { AppModule } from '../src/app.module.js';
import { PrismaService } from '../src/database/prisma/prisma.service.js';
import { RemindersService } from '../src/modules/reminders/reminders.service.js';

const ID = '11111111-1111-4111-8111-111111111111';
const MED = '22222222-2222-4222-8222-222222222222';

describe('Reminders API 参数与路由', () => {
  let app: NestFastifyApplication;
  const service = {
    findAll: vi.fn().mockResolvedValue({ items: [] }),
    findOne: vi.fn().mockResolvedValue({ id: ID }),
    create: vi.fn().mockResolvedValue({ id: ID }),
    update: vi.fn().mockResolvedValue({ id: ID }),
    remove: vi.fn(),
    updateCheckin: vi.fn().mockResolvedValue({ done: true }),
    findExpiry: vi.fn().mockResolvedValue({ type: 'expiry' }),
    updateExpiry: vi.fn().mockResolvedValue({ status: 'handled' }),
    findBloodPressure: vi.fn().mockResolvedValue({ items: [], total: 0 }),
  };
  const payload = {
    id: ID,
    type: 'daily',
    title: '提醒',
    frequency: 'daily',
    time: '08:00',
  };

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(PrismaService)
      .useValue({})
      .overrideProvider(RemindersService)
      .useValue(service)
      .compile();
    app = moduleRef.createNestApplication<NestFastifyApplication>(
      new FastifyAdapter(),
    );
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
  });
  beforeEach(() => vi.clearAllMocks());
  afterAll(async () => {
    await app?.close();
  });

  it('创建时转换和清理字段，并返回 201', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/reminders',
      payload: { ...payload, title: '  提醒  ', note: ' ' },
    });
    expect(response.statusCode).toBe(201);
    expect(service.create).toHaveBeenCalledWith(
      expect.objectContaining({ title: '提醒', note: null }),
    );
  });

  it.each([
    { type: 'expiry' },
    { type: null },
    { id: 'bad-id' },
    { time: '24:00' },
    { time: '8:00' },
    { frequency: '每周' },
    { recordBloodPressure: null },
    { recordBloodPressure: 'true' },
    { date: '2026-02-30', frequency: 'once' },
    { date: '2026-10-23T00:00:00Z' },
    { medicine: null },
    { userId: ID },
    { title: null },
    { note: 42 },
  ])('非法创建字段返回 400：%j', async (patch) => {
    const response = await app.inject({
      method: 'POST',
      url: '/reminders',
      payload: { ...payload, ...patch },
    });
    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({
      statusCode: 400,
      message: expect.any(String),
    });
    expect(service.create).not.toHaveBeenCalled();
  });

  it.each([
    { medicineId: null, name: '药品', unit: '粒', dosePerTime: 0 },
    { medicineId: null, name: '药品', unit: '粒', timesPerDay: 1.5 },
    { name: '药品', unit: '粒' },
    { medicineId: MED, name: '药品', unit: '粒', cabinet: null },
    {
      medicineId: null,
      name: '药品',
      unit: '粒',
      cabinet: { categoryId: MED, quantity: -1 },
    },
    { medicineId: null, name: '药品', unit: '粒', medicationTimings: null },
  ])('药品嵌套校验不被绕过：%j', async (medicine) => {
    const response = await app.inject({
      method: 'POST',
      url: '/reminders',
      payload: { ...payload, type: 'med', medicine },
    });
    expect(response.statusCode).toBe(400);
  });

  it('打卡路由校验完整日期参数并传递两个版本', async () => {
    const dto = {
      expectedReminderVersion: 2,
      expectedVersion: 0,
      completed: true,
    };
    const response = await app.inject({
      method: 'PATCH',
      url: `/reminders/${ID}/checkins/2026-10-23`,
      payload: dto,
    });
    expect(response.statusCode).toBe(200);
    expect(service.updateCheckin).toHaveBeenCalledWith(
      ID,
      '2026-10-23',
      expect.objectContaining(dto),
    );
    expect(
      (
        await app.inject({
          method: 'PATCH',
          url: `/reminders/${ID}/checkins/2026-02-30`,
          payload: dto,
        })
      ).statusCode,
    ).toBe(400);
  });

  it.each([
    { expectedVersion: -1 },
    { expectedReminderVersion: 0 },
    { completed: 'false' },
    { bloodPressure: null },
    {
      bloodPressure: {
        systolic: '120',
        diastolic: 80,
        pulse: 72,
        slot: 'morning',
        measuredAt: '2026-10-23T08:00:00+08:00',
      },
    },
    {
      bloodPressure: {
        systolic: 120,
        diastolic: 80,
        pulse: 72,
        slot: 'morning',
        measuredAt: '2026-10-23T08:00:00',
      },
    },
  ])('非法打卡请求返回 400：%j', async (patch) => {
    const response = await app.inject({
      method: 'PATCH',
      url: `/reminders/${ID}/checkins/2026-10-23`,
      payload: {
        expectedReminderVersion: 1,
        expectedVersion: 0,
        completed: true,
        ...patch,
      },
    });
    expect(response.statusCode).toBe(400);
    expect(service.updateCheckin).not.toHaveBeenCalled();
  });

  it('临期静态路由不被普通详情 UUID 路由吞掉', async () => {
    const response = await app.inject({
      method: 'GET',
      url: `/reminders/expiry/${MED}?expirationDate=2026-10-30`,
    });
    expect(response.statusCode).toBe(200);
    expect(service.findExpiry).toHaveBeenCalledWith(MED, '2026-10-30');
    expect(service.findOne).not.toHaveBeenCalled();
  });

  it('临期状态支持零版本，拒绝缺失日期与未知状态', async () => {
    const dto = {
      expirationDate: '2026-10-30',
      expectedVersion: 0,
      status: 'handled',
    };
    expect(
      (
        await app.inject({
          method: 'PATCH',
          url: `/reminders/expiry/${MED}`,
          payload: dto,
        })
      ).statusCode,
    ).toBe(200);
    expect(
      (
        await app.inject({
          method: 'PATCH',
          url: `/reminders/expiry/${MED}`,
          payload: { ...dto, status: 'deleted' },
        })
      ).statusCode,
    ).toBe(400);
    expect(
      (await app.inject({ method: 'GET', url: `/reminders/expiry/${MED}` }))
        .statusCode,
    ).toBe(400);
  });

  it('删除要求版本，成功返回空的 204', async () => {
    expect(
      (await app.inject({ method: 'DELETE', url: `/reminders/${ID}` }))
        .statusCode,
    ).toBe(400);
    const response = await app.inject({
      method: 'DELETE',
      url: `/reminders/${ID}?expectedVersion=1`,
    });
    expect(response.statusCode).toBe(204);
    expect(response.body).toBe('');
    expect(service.remove).toHaveBeenCalledWith(ID, 1);
  });

  it('编辑拒绝变更类型、未知字段和非法版本', async () => {
    for (const patch of [
      { type: 'visit' },
      { userId: ID },
      { expectedVersion: 0 },
    ]) {
      expect(
        (
          await app.inject({
            method: 'PATCH',
            url: `/reminders/${ID}`,
            payload: { expectedVersion: 1, title: '新提醒', ...patch },
          })
        ).statusCode,
      ).toBe(400);
    }
  });

  it('血压列表分页转换为数字，拒绝过大的页容量和非法日期', async () => {
    expect(
      (
        await app.inject({
          method: 'GET',
          url: '/blood-pressure-records?page=2&pageSize=10&fromDate=2026-10-01',
        })
      ).statusCode,
    ).toBe(200);
    expect(service.findBloodPressure).toHaveBeenCalledWith(
      expect.objectContaining({ page: 2, pageSize: 10 }),
    );
    for (const query of [
      'pageSize=101',
      'page=9007199254740992',
      'page=-1',
      'fromDate=2026-02-30',
      'userId=other',
    ]) {
      expect(
        (
          await app.inject({
            method: 'GET',
            url: `/blood-pressure-records?${query}`,
          })
        ).statusCode,
      ).toBe(400);
    }
  });
});
