import { randomUUID } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import {
  BadRequestException,
  ConflictException,
  NotFoundException,
} from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import { PrismaPg } from '@prisma/adapter-pg';
import pg from 'pg';
import { PrismaClient } from '../src/generated/prisma/client.js';
import type { PrismaService } from '../src/database/prisma/prisma.service.js';
import { RemindersService } from '../src/modules/reminders/reminders.service.js';
import {
  formatDateOnly,
  toDateOnlyUtc,
  todayInBusinessTz,
} from '../src/modules/visits/visit-date.js';

const testUrl = process.env.REMINDERS_TEST_DATABASE_URL;
const USER = '00000000-0000-4000-8000-000000000001';
const OTHER_USER = '00000000-0000-4000-8000-000000000002';

/** 显式指定以 _test 结尾的测试库；随机 schema 隔离，绝不读取业务 DATABASE_URL。 */
describe.skipIf(!testUrl)('健康提醒 PostgreSQL 迁移、事务与并发', () => {
  let pool: pg.Pool;
  let client: PrismaClient;
  let service: RemindersService;
  let otherService: RemindersService;
  let categoryId: string;
  const schema = `reminders_test_${randomUUID().replaceAll('-', '')}`;
  const today = todayInBusinessTz();

  beforeAll(async () => {
    if (!new URL(testUrl!).pathname.endsWith('_test'))
      throw new Error('仅允许在以 _test 结尾的独立测试数据库运行');
    pool = new pg.Pool({
      connectionString: testUrl,
      options: `-c search_path=${schema},public`,
      connectionTimeoutMillis: 5000,
    });
    await pool.query(`CREATE SCHEMA "${schema}"`);
    const migrations = (await readdir('prisma/migrations'))
      .filter((name) => name !== 'migration_lock.toml')
      .sort();
    for (const name of migrations) {
      await pool.query(
        await readFile(`prisma/migrations/${name}/migration.sql`, 'utf8'),
      );
    }
    client = new PrismaClient({ adapter: new PrismaPg(pool, { schema }) });
    await client.$connect();
    categoryId = (await client.medicine_categories.findFirstOrThrow()).id;
    service = new RemindersService(
      client as PrismaService,
      { getOrThrow: () => USER } as unknown as ConfigService,
    );
    otherService = new RemindersService(
      client as PrismaService,
      { getOrThrow: () => OTHER_USER } as unknown as ConfigService,
    );
  });

  beforeEach(async () => {
    await pool.query(
      'TRUNCATE health_reminders, medicine_items, blood_pressure_records CASCADE',
    );
  });

  afterAll(async () => {
    await client?.$disconnect();
    if (pool) {
      try {
        await pool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
      } finally {
        await pool.end();
      }
    }
  });

  it('迁移建立字段组合和有效数值约束', async () => {
    await expect(
      pool.query(
        `INSERT INTO health_reminders (id,user_id,type,title,frequency,starts_on) VALUES ($1,$2,'daily','提醒','daily',CURRENT_DATE)`,
        [randomUUID(), USER],
      ),
    ).rejects.toMatchObject({ code: '23514' });
    await expect(
      pool.query(
        `INSERT INTO blood_pressure_records (user_id,systolic,diastolic,pulse,slot,measured_at) VALUES ($1,0,80,72,'morning',NOW())`,
        [USER],
      ),
    ).rejects.toMatchObject({ code: '23514' });
  });

  it('入箱后快照写入失败时，药箱与提醒均回滚', async () => {
    await pool.query(
      "ALTER TABLE health_reminder_medicines ADD CONSTRAINT test_snapshot_failure CHECK (name <> 'rollback-test')",
    );
    const id = randomUUID();
    try {
      await expect(
        service.create({
          id,
          type: 'med',
          title: '吃药',
          frequency: 'daily',
          time: '08:00',
          medicine: {
            medicineId: null,
            name: 'rollback-test',
            unit: '粒',
            cabinet: { categoryId, quantity: 2 },
          },
        }),
      ).rejects.toThrow();
      expect(await client.medicine_items.count()).toBe(0);
      expect(await client.health_reminders.count()).toBe(0);
    } finally {
      await pool.query(
        'ALTER TABLE health_reminder_medicines DROP CONSTRAINT test_snapshot_failure',
      );
    }
  });

  it('同一 ID 重复创建不会重复入箱', async () => {
    const dto = {
      id: randomUUID(),
      type: 'med' as const,
      title: '吃药',
      frequency: 'daily' as const,
      time: '08:00',
      medicine: {
        medicineId: null,
        name: '药品',
        unit: '粒',
        cabinet: { categoryId, quantity: 2 },
      },
    };
    await service.create(dto);
    await expect(service.create(dto)).rejects.toBeInstanceOf(ConflictException);
    expect(await client.medicine_items.count()).toBe(1);
    expect(await client.health_reminders.count()).toBe(1);
  });

  it('药箱修改不覆盖快照；删除药品仅置空关联', async () => {
    const reminder = await service.create({
      id: randomUUID(),
      type: 'med',
      title: '吃药',
      frequency: 'daily',
      time: '08:00',
      medicine: {
        medicineId: null,
        name: '旧药名',
        unit: '粒',
        dosePerTime: 0.5,
        cabinet: { categoryId, quantity: 2 },
      },
    });
    await client.medicine_items.update({
      where: { id: reminder.medicine!.medicineId! },
      data: { name: '新药名', dose_per_time: 2 },
    });
    expect((await service.findOne(reminder.id)).medicine).toMatchObject({
      name: '旧药名',
      dosePerTime: 0.5,
    });
    await client.medicine_items.delete({
      where: { id: reminder.medicine!.medicineId! },
    });
    expect((await service.findOne(reminder.id)).medicine).toMatchObject({
      medicineId: null,
      name: '旧药名',
      dosePerTime: 0.5,
    });
  });

  it('并发血压打卡仅一次成功；取消与删除提醒保留测量', async () => {
    const reminder = await service.create({
      id: randomUUID(),
      type: 'daily',
      title: '测血压',
      frequency: 'daily',
      time: '08:00',
      recordBloodPressure: true,
    });
    const dto = {
      expectedReminderVersion: 1,
      expectedVersion: 0,
      completed: true,
      bloodPressure: {
        systolic: 122,
        diastolic: 80,
        pulse: 72,
        slot: 'morning' as const,
        measuredAt: new Date(Date.now() - 60000).toISOString(),
      },
    };
    const results = await Promise.allSettled([
      service.updateCheckin(reminder.id, today, dto),
      service.updateCheckin(reminder.id, today, dto),
    ]);
    expect(
      results.filter((result) => result.status === 'fulfilled'),
    ).toHaveLength(1);
    expect(
      results.find((result) => result.status === 'rejected'),
    ).toMatchObject({ reason: expect.any(ConflictException) });
    expect(await client.blood_pressure_records.count()).toBe(1);
    const undone = await service.updateCheckin(reminder.id, today, {
      expectedReminderVersion: 1,
      expectedVersion: 1,
      completed: false,
    });
    expect(undone).toMatchObject({
      done: false,
      checkin: { bloodPressure: { systolic: 122 } },
    });
    await service.updateCheckin(reminder.id, today, {
      ...dto,
      expectedVersion: 2,
    });
    expect(await client.blood_pressure_records.count()).toBe(1);
    await service.remove(reminder.id, 1);
    expect(await client.health_reminder_checkins.count()).toBe(0);
    expect((await service.findBloodPressure({})).items[0]).toMatchObject({
      reminderId: null,
      checkinId: null,
      systolic: 122,
    });
  });

  it('测量写入失败时，打卡状态回滚', async () => {
    const reminder = await service.create({
      id: randomUUID(),
      type: 'daily',
      title: '测血压',
      frequency: 'daily',
      time: '08:00',
      recordBloodPressure: true,
    });
    await expect(
      service.updateCheckin(reminder.id, today, {
        expectedReminderVersion: 1,
        expectedVersion: 0,
        completed: true,
        bloodPressure: {
          systolic: 0,
          diastolic: 80,
          pulse: 72,
          slot: 'morning',
          measuredAt: new Date(Date.now() - 1000).toISOString(),
        },
      }),
    ).rejects.toThrow();
    expect(await client.health_reminder_checkins.count()).toBe(0);
    expect(await client.blood_pressure_records.count()).toBe(0);
  });

  it('同版本并发编辑只有一个成功', async () => {
    const reminder = await service.create({
      id: randomUUID(),
      type: 'visit',
      title: '复查',
      date: today,
    });
    const results = await Promise.allSettled([
      service.update(reminder.id, { expectedVersion: 1, title: '复查一' }),
      service.update(reminder.id, { expectedVersion: 1, title: '复查二' }),
    ]);
    expect(
      results.filter((result) => result.status === 'fulfilled'),
    ).toHaveLength(1);
    expect((await service.findOne(reminder.id)).version).toBe(2);
  });

  it('临期阈值包含当天且不含第16天，忽略状态不污染新有效期', async () => {
    const dates = [-1, 0, 14, 15].map((days) => {
      const date = toDateOnlyUtc(today);
      date.setUTCDate(date.getUTCDate() + days);
      return date;
    });
    for (const expiration_date of dates) {
      await client.medicine_items.create({
        data: {
          user_id: USER,
          category_id: categoryId,
          name: '药品',
          unit: '粒',
          quantity: 1,
          expiration_date,
        },
      });
    }
    await client.medicine_items.create({
      data: {
        user_id: USER,
        category_id: categoryId,
        name: '空药品',
        unit: '粒',
        quantity: 0,
        expiration_date: dates[0],
      },
    });
    expect((await service.findAll()).summary.expiryCount).toBe(3);
    const medicine = await client.medicine_items.findFirstOrThrow({
      where: { expiration_date: dates[2] },
    });
    await service.updateExpiry(medicine.id, {
      expirationDate: formatDateOnly(dates[2]),
      expectedVersion: 0,
      status: 'dismissed',
    });
    expect((await service.findAll()).summary.expiryCount).toBe(2);
    await client.medicine_items.update({
      where: { id: medicine.id },
      data: { expiration_date: dates[1] },
    });
    expect(await service.findExpiry(medicine.id, today)).toMatchObject({
      status: 'pending',
      version: 0,
      expired: false,
    });
    await expect(
      service.updateExpiry(medicine.id, {
        expirationDate: formatDateOnly(dates[2]),
        expectedVersion: 1,
        status: 'handled',
      }),
    ).rejects.toBeInstanceOf(ConflictException);
    await client.medicine_items.delete({ where: { id: medicine.id } });
    expect(await client.medicine_expiry_states.count()).toBe(0);
  });

  it('用户隔离覆盖提醒、药箱关联、临期和血压', async () => {
    const reminder = await service.create({
      id: randomUUID(),
      type: 'visit',
      title: '复查',
      date: today,
    });
    await expect(otherService.findOne(reminder.id)).rejects.toBeInstanceOf(
      NotFoundException,
    );
    await expect(otherService.remove(reminder.id, 1)).rejects.toBeInstanceOf(
      NotFoundException,
    );
    const medicine = await client.medicine_items.create({
      data: {
        user_id: USER,
        category_id: categoryId,
        name: '药品',
        unit: '粒',
        quantity: 1,
        expiration_date: toDateOnlyUtc(today),
      },
    });
    await expect(
      otherService.create({
        id: randomUUID(),
        type: 'med',
        title: '用药',
        frequency: 'daily',
        time: '08:00',
        medicine: { medicineId: medicine.id, name: '药品', unit: '粒' },
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
    await expect(
      otherService.updateExpiry(medicine.id, {
        expirationDate: today,
        expectedVersion: 0,
        status: 'handled',
      }),
    ).rejects.toBeInstanceOf(NotFoundException);
    await client.blood_pressure_records.create({
      data: {
        user_id: USER,
        systolic: 122,
        diastolic: 80,
        pulse: 72,
        slot: 'morning',
        measured_at: new Date(),
      },
    });
    expect((await otherService.findAll()).items).toHaveLength(0);
    expect((await otherService.findBloodPressure({})).total).toBe(0);
  });
});
