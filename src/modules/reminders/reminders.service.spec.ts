import {
  BadRequestException,
  ConflictException,
  NotFoundException,
} from '@nestjs/common';
import type { UserContextService } from '../auth/user-context.service.js';
import type { PrismaService } from '../../database/prisma/prisma.service.js';
import { Prisma } from '../../generated/prisma/client.js';
import { RemindersService } from './reminders.service.js';
import type {
  ReminderRecord,
  CheckinRecord,
  ExpiryRecord,
} from './reminder-response.mapper.js';

const USER = '00000000-0000-4000-8000-000000000001';
const ID = '11111111-1111-4111-8111-111111111111';
const MED = '22222222-2222-4222-8222-222222222222';
const NOW = new Date('2026-10-23T02:00:00Z');

function createRow(): ReminderRecord {
  return {
    id: ID,
    user_id: USER,
    type: 'daily',
    title: '测血压',
    note: null,
    frequency: 'daily',
    remind_date: null,
    remind_time: '08:00',
    starts_on: new Date('2026-10-20T00:00:00Z'),
    record_blood_pressure: true,
    version: 1,
    created_at: NOW,
    updated_at: NOW,
    medicine: null,
  };
}

function createMock() {
  const tx = {
    $queryRaw: vi.fn().mockResolvedValue([{ id: ID }]),
    health_reminders: {
      findFirst: vi.fn().mockResolvedValue(createRow()),
      findMany: vi.fn().mockResolvedValue([]),
      create: vi.fn(),
      update: vi.fn(),
      delete: vi.fn(),
    },
    health_reminder_medicines: { upsert: vi.fn() },
    health_reminder_checkins: {
      findUnique: vi.fn().mockResolvedValue(null),
      findMany: vi.fn().mockResolvedValue([]),
      upsert: vi.fn().mockResolvedValue({ id: 'checkin' }),
    },
    blood_pressure_records: {
      upsert: vi.fn(),
      findMany: vi.fn().mockResolvedValue([]),
      count: vi.fn().mockResolvedValue(0),
    },
    medicine_items: {
      findMany: vi.fn().mockResolvedValue([]),
      findFirst: vi.fn().mockResolvedValue(null),
      findFirstOrThrow: vi.fn(),
      create: vi.fn().mockResolvedValue({ id: MED }),
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
    },
    medicine_expiry_states: { upsert: vi.fn() },
  };
  return {
    tx,
    $transaction: vi.fn(async (callback: (tx: unknown) => unknown) =>
      callback(tx),
    ),
  };
}

describe('RemindersService', () => {
  let prisma: ReturnType<typeof createMock>;
  let service: RemindersService;
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    prisma = createMock();
    service = new RemindersService(
      prisma as unknown as PrismaService,
      { getUserId: () => USER } as unknown as UserContextService,
    );
  });
  afterEach(() => vi.useRealTimers());

  function medication() {
    const row = {
      ...createRow(),
      type: 'med',
      record_blood_pressure: false,
      medicine: {
        reminder_id: ID,
        medicine_id: MED,
        name: '测试药',
        unit: '粒',
        dose_per_time: new Prisma.Decimal('0.5'),
        times_per_day: 3,
        medication_timings: [],
        created_at: NOW,
        updated_at: NOW,
      },
    };
    prisma.tx.health_reminders.findFirst.mockResolvedValue(row);
    return row;
  }

  const complete = {
    expectedReminderVersion: 1,
    expectedVersion: 0,
    completed: true,
  };

  it('打卡只扣一次单次剂量，支持半粒，不乘一日次数', async () => {
    medication();
    await service.updateCheckin(ID, '2026-10-23', complete);
    expect(prisma.tx.medicine_items.updateMany).toHaveBeenCalledWith({
      where: {
        id: MED,
        user_id: USER,
        unit: '粒',
        quantity: { gte: new Prisma.Decimal('0.5') },
      },
      data: { quantity: { decrement: new Prisma.Decimal('0.5') } },
    });
    expect(prisma.tx.health_reminder_checkins.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        create: expect.objectContaining({
          stock_medicine_id: MED,
          stock_quantity: new Prisma.Decimal('0.5'),
          stock_unit: '粒',
        }),
      }),
    );
    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
  });

  it('库存不足或单位不一致时不保存完成状态', async () => {
    medication();
    prisma.tx.medicine_items.updateMany.mockResolvedValue({ count: 0 });
    await expect(
      service.updateCheckin(ID, '2026-10-23', complete),
    ).rejects.toThrow('药品库存不足');
    expect(prisma.tx.health_reminder_checkins.upsert).not.toHaveBeenCalled();
  });

  it('没有关联药箱的提醒独立打卡，不猜测库存或剂量', async () => {
    const row = medication();
    prisma.tx.health_reminders.findFirst.mockResolvedValue({
      ...row,
      medicine: { ...row.medicine, medicine_id: null },
    });
    await service.updateCheckin(ID, '2026-10-23', complete);
    expect(prisma.tx.medicine_items.updateMany).not.toHaveBeenCalled();
    expect(prisma.tx.health_reminder_checkins.upsert).toHaveBeenCalled();
  });

  it('已关联药箱但没有剂量时要求先补充剂量', async () => {
    const row = medication();
    prisma.tx.health_reminders.findFirst.mockResolvedValue({
      ...row,
      medicine: { ...row.medicine, dose_per_time: null },
    });
    await expect(
      service.updateCheckin(ID, '2026-10-23', complete),
    ).rejects.toThrow('单次剂量');
    expect(prisma.tx.medicine_items.updateMany).not.toHaveBeenCalled();
  });

  it('相同完成状态不再次扣库存，也不重写打卡', async () => {
    medication();
    prisma.tx.health_reminder_checkins.findUnique.mockResolvedValue({
      completed_at: NOW,
      version: 2,
    });
    await service.updateCheckin(ID, '2026-10-23', {
      ...complete,
      expectedVersion: 2,
    });
    expect(prisma.tx.medicine_items.updateMany).not.toHaveBeenCalled();
    expect(prisma.tx.health_reminder_checkins.upsert).not.toHaveBeenCalled();
  });

  it('改药或改剂量后取消仍恢复原药原数量', async () => {
    medication();
    prisma.tx.health_reminder_checkins.findUnique.mockResolvedValue({
      completed_at: NOW,
      version: 1,
      stock_medicine_id: 'original-medicine',
      stock_quantity: new Prisma.Decimal('1.25'),
      stock_unit: '袋',
    });
    await service.updateCheckin(ID, '2026-10-23', {
      ...complete,
      expectedVersion: 1,
      completed: false,
    });
    expect(prisma.tx.medicine_items.updateMany).toHaveBeenCalledWith({
      where: { id: 'original-medicine', user_id: USER, unit: '袋' },
      data: { quantity: { increment: new Prisma.Decimal('1.25') } },
    });
    expect(prisma.tx.health_reminder_checkins.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        update: expect.objectContaining({
          stock_medicine_id: null,
          stock_quantity: null,
          stock_unit: null,
        }),
      }),
    );
  });

  it('上线前的历史打卡取消不凭空增加库存', async () => {
    medication();
    prisma.tx.health_reminder_checkins.findUnique.mockResolvedValue({
      completed_at: NOW,
      version: 1,
    });
    await service.updateCheckin(ID, '2026-10-23', {
      ...complete,
      expectedVersion: 1,
      completed: false,
    });
    expect(prisma.tx.medicine_items.updateMany).not.toHaveBeenCalled();
  });

  it('原药已删除时允许取消，原药仅换单位时拒绝错误恢复', async () => {
    medication();
    prisma.tx.health_reminder_checkins.findUnique.mockResolvedValue({
      completed_at: NOW,
      version: 1,
      stock_medicine_id: MED,
      stock_quantity: new Prisma.Decimal(1),
      stock_unit: '粒',
    });
    prisma.tx.medicine_items.updateMany.mockResolvedValue({ count: 0 });
    await service.updateCheckin(ID, '2026-10-23', {
      ...complete,
      expectedVersion: 1,
      completed: false,
    });
    prisma.tx.health_reminder_checkins.upsert.mockClear();
    prisma.tx.medicine_items.findFirst.mockResolvedValue({ id: MED });
    await expect(
      service.updateCheckin(ID, '2026-10-23', {
        ...complete,
        expectedVersion: 1,
        completed: false,
      }),
    ).rejects.toThrow('药品单位已变化');
    expect(prisma.tx.health_reminder_checkins.upsert).not.toHaveBeenCalled();
  });

  it('查询不存在或其他用户的提醒返回 404', async () => {
    prisma.tx.health_reminders.findFirst.mockResolvedValue(null);
    await expect(service.findOne(ID)).rejects.toBeInstanceOf(NotFoundException);
    expect(prisma.tx.health_reminders.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: ID, user_id: USER } }),
    );
  });

  it('复查就医默认仅此一次，不擅自补提醒时刻', async () => {
    await service.create({
      id: ID,
      type: 'visit',
      title: '复查',
      date: '2026-10-24',
    });
    expect(prisma.tx.health_reminders.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        frequency: 'once',
        remind_time: null,
        user_id: USER,
      }),
    });
  });

  it.each([
    { type: 'daily', title: '', frequency: 'daily', time: '08:00' },
    { type: 'daily', title: '提醒', time: '08:00' },
    { type: 'visit', title: '复查', date: '2026-10-24', time: '08:00' },
    { type: 'med', title: '吃药', frequency: 'daily', time: '08:00' },
    {
      type: 'daily',
      title: '提醒',
      frequency: 'once',
      date: '2026-10-22',
      time: '08:00',
    },
    {
      type: 'daily',
      title: '提醒',
      frequency: 'daily',
      date: '2026-10-24',
      time: '08:00',
    },
  ])('创建时拒绝非法组合 %j', async (fields) => {
    await expect(
      service.create({ id: ID, ...fields } as Parameters<
        RemindersService['create']
      >[0]),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(prisma.tx.health_reminders.create).not.toHaveBeenCalled();
  });

  it('药品入箱与快照使用同一个事务并保存大类文本', async () => {
    await service.create({
      id: ID,
      type: 'med',
      title: '吃药',
      frequency: 'daily',
      time: '08:00',
      medicine: {
        medicineId: null,
        name: '药品',
        unit: '粒',
        dosePerTime: 0.5,
        cabinet: { category: '止痛', quantity: 3 },
      },
    });
    expect(prisma.tx.medicine_items.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ user_id: USER, category: '止痛', dose_per_time: 0.5 }),
      }),
    );
    expect(prisma.tx.health_reminder_medicines.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        create: expect.objectContaining({ medicine_id: MED, reminder_id: ID }),
      }),
    );
    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
  });

  it('选中其他用户或已删除药品时拒绝保存', async () => {
    prisma.tx.$queryRaw.mockResolvedValue([]);
    await expect(
      service.create({
        id: ID,
        type: 'med',
        title: '吃药',
        frequency: 'daily',
        time: '08:00',
        medicine: { medicineId: MED, name: '药品', unit: '粒' },
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(prisma.tx.health_reminder_medicines.upsert).not.toHaveBeenCalled();
  });

  it('重复 ID 转为 409，不再次创建药品', async () => {
    prisma.tx.health_reminders.create.mockRejectedValue(
      new Prisma.PrismaClientKnownRequestError('Unique', {
        code: 'P2002',
        clientVersion: '7',
      }),
    );
    await expect(
      service.create({
        id: ID,
        type: 'visit',
        title: '复查',
        date: '2026-10-24',
      }),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(prisma.tx.medicine_items.create).not.toHaveBeenCalled();
  });

  it('编辑要求完整时间组合，版本过期拒绝修改', async () => {
    await expect(
      service.update(ID, { expectedVersion: 1, time: '10:00' }),
    ).rejects.toBeInstanceOf(BadRequestException);
    await expect(
      service.update(ID, { expectedVersion: 2, title: '新标题' }),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(prisma.tx.health_reminders.update).not.toHaveBeenCalled();
  });

  it('编辑与删除不主动删除测量或药箱记录', async () => {
    await service.update(ID, { expectedVersion: 1, note: null });
    await service.remove(ID, 1);
    expect(prisma.tx.health_reminders.delete).toHaveBeenCalledWith({
      where: { id: ID },
    });
    expect(prisma.tx.blood_pressure_records.upsert).not.toHaveBeenCalled();
    expect(prisma.tx.medicine_items.create).not.toHaveBeenCalled();
  });

  it.each(['2026-10-22', '2026-10-24'])(
    '禁止重复提醒在 %s 补打或提前打卡',
    async (date) => {
      await expect(
        service.updateCheckin(ID, date, {
          expectedReminderVersion: 1,
          expectedVersion: 0,
          completed: false,
        }),
      ).rejects.toBeInstanceOf(BadRequestException);
    },
  );

  it('血压模式必须提交测量，未来测量时间不能保存', async () => {
    const dto = {
      expectedReminderVersion: 1,
      expectedVersion: 0,
      completed: true,
    };
    await expect(
      service.updateCheckin(ID, '2026-10-23', dto),
    ).rejects.toBeInstanceOf(BadRequestException);
    await expect(
      service.updateCheckin(ID, '2026-10-23', {
        ...dto,
        bloodPressure: {
          systolic: 120,
          diastolic: 80,
          pulse: 72,
          slot: 'morning',
          measuredAt: '2026-10-23T03:00:00Z',
        },
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(prisma.tx.health_reminder_checkins.upsert).not.toHaveBeenCalled();
  });

  it('保存测量后才返回完成结果，测量失败向事务传播错误', async () => {
    prisma.tx.blood_pressure_records.upsert.mockRejectedValue(
      new Error('write failed'),
    );
    await expect(
      service.updateCheckin(ID, '2026-10-23', {
        expectedReminderVersion: 1,
        expectedVersion: 0,
        completed: true,
        bloodPressure: {
          systolic: 120,
          diastolic: 80,
          pulse: 72,
          slot: 'morning',
          measuredAt: '2026-10-23T01:00:00Z',
        },
      }),
    ).rejects.toThrow('write failed');
    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
  });

  it('取消打卡保留血压，不再写入或删除测量', async () => {
    prisma.tx.health_reminder_checkins.findUnique.mockResolvedValue({
      id: 'checkin',
      version: 1,
      completed_at: NOW,
    });
    await service.updateCheckin(ID, '2026-10-23', {
      expectedReminderVersion: 1,
      expectedVersion: 1,
      completed: false,
    });
    expect(prisma.tx.health_reminder_checkins.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        update: { completed_at: null, version: { increment: 1 } },
      }),
    );
    expect(prisma.tx.blood_pressure_records.upsert).not.toHaveBeenCalled();
  });

  it('同一次打卡使用独立版本，拒绝旧版本重试', async () => {
    prisma.tx.health_reminder_checkins.findUnique.mockResolvedValue({
      version: 1,
    });
    await expect(
      service.updateCheckin(ID, '2026-10-23', {
        expectedReminderVersion: 1,
        expectedVersion: 0,
        completed: false,
      }),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it('今日数量排除未来、逾期、周末和临期，并按业务日切换', async () => {
    const todayRow = createRow();
    const futureRow = {
      ...todayRow,
      id: 'future',
      frequency: 'once',
      remind_date: new Date('2026-10-24T00:00:00Z'),
    };
    const oldRow = {
      ...futureRow,
      id: 'old',
      remind_date: new Date('2026-10-22T00:00:00Z'),
    };
    const doneRow = { ...todayRow, id: 'done' };
    prisma.tx.health_reminders.findMany.mockResolvedValue([
      todayRow,
      futureRow,
      oldRow,
      doneRow,
    ]);
    prisma.tx.health_reminder_checkins.findMany.mockResolvedValue([
      { reminder_id: 'done', completed_at: NOW, version: 1 } as CheckinRecord,
    ]);
    const result = await service.findAll();
    expect(result.summary).toEqual({
      pendingCount: 1,
      doneCount: 1,
      expiryCount: 0,
    });
    expect(result.items).toHaveLength(4);
    expect(result.watchCount).toBe(1);
    vi.setSystemTime(new Date('2026-10-23T16:01:00Z'));
    prisma.tx.health_reminder_checkins.findMany.mockResolvedValue([]);
    expect((await service.findAll()).date).toBe('2026-10-24');
  });

  it('临期查询只取有库存且有效期在今天加 6 天内的药品', async () => {
    await service.findAll();
    expect(prisma.tx.medicine_items.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          user_id: USER,
          quantity: { gt: 0 },
          expiration_date: { lte: new Date('2026-10-29T00:00:00Z') },
        },
      }),
    );
  });

  it('药箱有效期变化时返回 409，不写入新有效期状态', async () => {
    prisma.tx.medicine_items.findFirstOrThrow.mockResolvedValue({
      id: MED,
      expiration_date: new Date('2026-11-01T00:00:00Z'),
    });
    await expect(
      service.updateExpiry(MED, {
        expirationDate: '2026-10-29',
        expectedVersion: 0,
        status: 'handled',
      }),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(prisma.tx.medicine_expiry_states.upsert).not.toHaveBeenCalled();
  });

  it('临期详情直接按药品、所属用户和有效期查询', async () => {
    prisma.tx.medicine_items.findFirst.mockResolvedValue({
      id: MED,
      name: '药品',
      quantity: 1,
      unit: '粒',
      expiration_date: new Date('2026-10-29T00:00:00Z'),
      medicine_expiry_states: [],
    });
    expect(await service.findExpiry(MED, '2026-10-29')).toMatchObject({
      medicineId: MED,
      status: 'pending',
    });
    expect(prisma.tx.medicine_items.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          id: MED,
          user_id: USER,
          quantity: { gt: 0 },
          expiration_date: {
            equals: new Date('2026-10-29T00:00:00Z'),
            lte: new Date('2026-10-29T00:00:00Z'),
          },
        },
      }),
    );
    prisma.tx.medicine_items.findFirst.mockResolvedValue(null);
    await expect(service.findExpiry(MED, '2026-10-29')).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it('没有修改内容和非用药提醒关联药品时拒绝编辑', async () => {
    await expect(
      service.update(ID, { expectedVersion: 1 }),
    ).rejects.toBeInstanceOf(BadRequestException);
    await expect(
      service.update(ID, {
        expectedVersion: 1,
        medicine: { medicineId: null, name: '药品', unit: '粒' },
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('逾期一次性提醒可以完成，重复提醒周末不能打卡', async () => {
    prisma.tx.health_reminders.findFirst.mockResolvedValue({
      ...createRow(),
      frequency: 'once',
      remind_date: new Date('2026-10-22T00:00:00Z'),
      record_blood_pressure: false,
    });
    await service.updateCheckin(ID, '2026-10-22', {
      expectedReminderVersion: 1,
      expectedVersion: 0,
      completed: true,
    });
    expect(prisma.tx.health_reminder_checkins.upsert).toHaveBeenCalled();
    prisma.tx.health_reminders.findFirst.mockResolvedValue({
      ...createRow(),
      frequency: 'weekdays',
    });
    vi.setSystemTime(new Date('2026-10-24T02:00:00Z'));
    await expect(
      service.updateCheckin(ID, '2026-10-24', {
        expectedReminderVersion: 1,
        expectedVersion: 0,
        completed: false,
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('普通提醒和取消操作均不能夹带血压数据', async () => {
    const bloodPressure = {
      systolic: 122,
      diastolic: 80,
      pulse: 72,
      slot: 'morning' as const,
      measuredAt: '2026-10-23T01:00:00Z',
    };
    const dto = {
      expectedReminderVersion: 1,
      expectedVersion: 0,
      completed: false,
      bloodPressure,
    };
    await expect(
      service.updateCheckin(ID, '2026-10-23', dto),
    ).rejects.toBeInstanceOf(BadRequestException);
    prisma.tx.health_reminders.findFirst.mockResolvedValue({
      ...createRow(),
      record_blood_pressure: false,
    });
    await expect(
      service.updateCheckin(ID, '2026-10-23', { ...dto, completed: true }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('临期数量不含已处理和已忽略，关注数量与前两条分开展示', async () => {
    const base = {
      id: MED,
      name: '药品',
      quantity: 1,
      unit: '粒',
      expiration_date: new Date('2026-10-29T00:00:00Z'),
      medicine_expiry_states: [],
    };
    prisma.tx.medicine_items.findMany.mockResolvedValue([
      base,
      { ...base, id: 'pending-2' },
      { ...base, id: 'pending-3' },
      {
        ...base,
        id: 'handled',
        medicine_expiry_states: [
          {
            expiration_date: base.expiration_date,
            handled_at: NOW,
            dismissed_at: null,
            version: 1,
          },
        ],
      },
      {
        ...base,
        id: 'dismissed',
        medicine_expiry_states: [
          {
            expiration_date: base.expiration_date,
            handled_at: null,
            dismissed_at: NOW,
            version: 1,
          },
        ],
      },
    ]);
    const result = await service.findAll();
    expect(result.summary).toEqual({
      pendingCount: 0,
      doneCount: 0,
      expiryCount: 3,
    });
    expect(result.items).toHaveLength(4);
    expect(result.watchCount).toBe(3);
    expect(result.watchItems).toHaveLength(2);
  });

  it('忽略状态写入当前有效期，不影响库存', async () => {
    const medicine = {
      id: MED,
      name: '药品',
      quantity: 1,
      unit: '粒',
      expiration_date: new Date('2026-10-29T00:00:00Z'),
      medicine_expiry_states: [],
    } as unknown as ExpiryRecord;
    prisma.tx.medicine_items.findFirstOrThrow.mockResolvedValue(medicine);
    prisma.tx.medicine_expiry_states.upsert.mockResolvedValue({
      medicine_id: MED,
      expiration_date: medicine.expiration_date,
      handled_at: null,
      dismissed_at: NOW,
      version: 1,
    });
    expect(
      await service.updateExpiry(MED, {
        expirationDate: '2026-10-29',
        expectedVersion: 0,
        status: 'dismissed',
      }),
    ).toMatchObject({ status: 'dismissed', version: 1 });
  });

  it('血压查询按新加坡自然日边界和用户隔离', async () => {
    await service.findBloodPressure({
      fromDate: '2026-10-23',
      toDate: '2026-10-23',
    });
    expect(prisma.tx.blood_pressure_records.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          user_id: USER,
          measured_at: {
            gte: new Date('2026-10-22T16:00:00Z'),
            lt: new Date('2026-10-23T16:00:00Z'),
          },
        },
        skip: 0,
        take: 20,
      }),
    );
    await expect(
      service.findBloodPressure({
        fromDate: '2026-10-24',
        toDate: '2026-10-23',
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });
});
