import { randomUUID } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { PrismaPg } from '@prisma/adapter-pg';
import pg from 'pg';
import { PrismaClient } from '../src/generated/prisma/client.js';
import type { PrismaService } from '../src/database/prisma/prisma.service.js';
import type { UserContextService } from '../src/modules/auth/user-context.service.js';
import { SyncService } from '../src/modules/sync/sync.service.js';
import type { SyncCommandDto } from '../src/modules/sync/sync.dto.js';
import { todayInBusinessTz } from '../src/modules/visits/visit-date.js';
import { Test } from '@nestjs/testing';
import {
  FastifyAdapter,
  type NestFastifyApplication,
} from '@nestjs/platform-fastify';
import { AppModule } from '../src/app.module.js';
import { AuthGuard } from '../src/modules/auth/auth.guard.js';
import { UserContextService as RequestContext } from '../src/modules/auth/user-context.service.js';
import { PrismaService as DatabaseProvider } from '../src/database/prisma/prisma.service.js';

const url = process.env.SYNC_TEST_DATABASE_URL;
const USER = '00000000-0000-4000-8000-000000000001';
const OTHER = '00000000-0000-4000-8000-000000000002';
describe.skipIf(!url)('离线同步 PostgreSQL 原子性、幂等与恢复', () => {
  let pool: pg.Pool;
  let client: PrismaClient;
  let service: SyncService;
  let other: SyncService;
  let sequence = 0;
  const device = randomUUID();
  const schema = `sync_test_${randomUUID().replaceAll('-', '')}`;
  const medicine = {
    name: '离线药',
    categoryId: '31000000-0000-4000-8000-000000000001',
    quantity: 4,
    unit: '粒',
    expirationDate: null,
    efficacyTags: [],
    dosePerTime: 0.5,
    timesPerDay: 1,
    medicationTimings: [],
    locationId: null,
    note: null,
  };
  function command(
    type: string,
    id: string,
    payload: object = {},
    version: number | null = null,
    previous?: SyncCommandDto,
  ): SyncCommandDto {
    return {
      id: randomUUID(),
      user_id: USER,
      device_id: device,
      entity_id: id,
      type,
      schema_version: 2,
      payload: JSON.stringify(payload),
      base_version: version,
      base_op_id: previous?.id ?? null,
      depends_on: JSON.stringify(previous ? [previous.id] : []),
      client_occurred_at: new Date().toISOString(),
      sequence: ++sequence,
    };
  }
  beforeAll(async () => {
    if (!new URL(url!).pathname.endsWith('_test'))
      throw new Error('仅允许独立 _test 数据库');
    pool = new pg.Pool({
      connectionString: url,
      options: `-c search_path=${schema},public`,
      connectionTimeoutMillis: 5000,
    });
    await pool.query(`CREATE SCHEMA "${schema}"`);
    for (const migration of (await readdir('prisma/migrations'))
      .filter((name) => name !== 'migration_lock.toml')
      .sort())
      await pool.query(
        await readFile(`prisma/migrations/${migration}/migration.sql`, 'utf8'),
      );
    client = new PrismaClient({ adapter: new PrismaPg(pool, { schema }) });
    await client.$connect();
    await client.users.createMany({
      data: [USER, OTHER].map((id, i) => ({
        id,
        account: `sync-${i}`,
        nickname: '测试',
        password_hash: 'test-only',
      })),
    });
    service = new SyncService(
      client as PrismaService,
      { getUserId: () => USER } as UserContextService,
    );
    other = new SyncService(
      client as PrismaService,
      { getUserId: () => OTHER } as UserContextService,
    );
  });
  beforeEach(async () => {
    sequence = 0;
    await pool.query(
      'TRUNCATE health_reminders,visit_records,medicine_items,blood_pressure_records,sync_command_receipts,sync_reminder_revisions,sync_tombstones,sync_attachments CASCADE',
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

  it('首次离线分类别名可用，重复创建/响应丢失重试只有一条药品', async () => {
    const id = randomUUID();
    const create = command('medicine.create', id, medicine);
    const first = await service.commands([create]);
    const retried = await service.commands([create]);
    expect(first.results[0].status).toBe('accepted');
    expect(retried.results).toEqual(first.results);
    expect(retried.medicines).toHaveLength(1);
    expect(retried.medicines[0]).toMatchObject({ id, version: 1 });
    expect((await other.snapshot(device)).medicines).toEqual([]);
  });
  it('真实 HTTP 接口通过鉴权上下文和 DTO 校验后才能提交命令', async () => {
    let requestContext: RequestContext;
    const module = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(DatabaseProvider)
      .useValue(client)
      .overrideProvider(AuthGuard)
      .useValue({
        canActivate: () => {
          requestContext.set(USER, randomUUID());
          return true;
        },
      })
      .compile();
    requestContext = module.get(RequestContext);
    const app = module.createNestApplication<NestFastifyApplication>(
      new FastifyAdapter(),
    );
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
    try {
      const create = command('medicine.create', randomUUID(), medicine);
      const response = await app.inject({
        method: 'POST',
        url: '/sync/commands',
        payload: { commands: [create] },
      });
      expect(response.statusCode).toBe(201);
      expect(response.json().results[0].status).toBe('accepted');
      const invalid = await app.inject({
        method: 'POST',
        url: '/sync/commands',
        payload: { commands: [{ id: 'invalid' }] },
      });
      expect(invalid.statusCode).toBe(400);
      expect(await client.sync_command_receipts.count()).toBe(1);
      const pull = await app.inject({
        method: 'GET',
        url: `/sync/snapshot?deviceId=${device}`,
      });
      expect(pull.statusCode).toBe(200);
      expect(pull.json().medicines[0].id).toBe(create.entity_id);
    } finally {
      await app.close();
    }
  });
  it('连续修改通过前序回执解析版本，删除留 tombstone 且不会复活', async () => {
    const id = randomUUID();
    const create = command('medicine.create', id, medicine);
    const edit = command(
      'medicine.update',
      id,
      { ...medicine, name: '已编辑' },
      null,
      create,
    );
    const remove = command('medicine.delete', id, {}, null, edit);
    const saved = await service.commands([create, edit, remove]);
    expect(saved.results.map((row) => row.status)).toEqual([
      'accepted',
      'accepted',
      'accepted',
    ]);
    expect(saved.medicines).toEqual([]);
    const revive = await service.commands([
      command('medicine.create', id, medicine),
    ]);
    expect(revive.results.at(-1)?.status).toBe('rejected');
    expect(revive.medicines).toEqual([]);
  });
  it('一条聚合中后续写入失败时，药品、就诊和接受回执共同回滚', async () => {
    const aggregate = command('visit.create', randomUUID(), {
      visitDate: todayInBusinessTz(),
      initialVisitId: null,
      symptomTags: [],
      medicines: [
        {
          id: randomUUID(),
          medicineId: null,
          name: '药品',
          unit: '粒',
          cabinet: {
            id: randomUUID(),
            categoryId: medicine.categoryId,
            quantity: 1,
          },
        },
        {
          id: randomUUID(),
          medicineId: randomUUID(),
          name: '不存在的药',
          unit: '粒',
        },
      ],
    });
    const saved = await service.commands([aggregate]);
    expect(saved.results[0].status).toBe('rejected');
    expect(saved.medicines).toEqual([]);
    expect(saved.visits).toEqual([]);
    expect(await client.sync_command_receipts.count()).toBe(1);
  });
  it('未知版本拒绝但保留回执，独立命令仍能继续且 AI 不误判就绪', async () => {
    const id = randomUUID();
    const create = command('medicine.create', id, medicine);
    await service.commands([create]);
    const bad = command('medicine.update', id, {
      ...medicine,
      name: '错误覆盖',
    });
    const independent = command('medicine.create', randomUUID(), {
      ...medicine,
      name: '独立药品',
    });
    const saved = await service.commands([bad, independent]);
    expect(saved.results.map((row) => row.status)).toEqual([
      'accepted',
      'rejected',
      'accepted',
    ]);
    expect(saved.medicines.find((row) => row.id === id)?.name).toBe('离线药');
    expect(await service.readiness(device, 3)).toMatchObject({
      ready: false,
      rejected: [2],
    });
  });
  it('同 opId 改内容拒绝，两个并发重试只提交一次', async () => {
    const create = command('medicine.create', randomUUID(), medicine);
    await Promise.all([service.commands([create]), service.commands([create])]);
    expect(await client.medicine_items.count()).toBe(1);
    await expect(
      service.commands([
        Object.assign({}, create, {
          payload: JSON.stringify({ ...medicine, name: '篡改' }),
        }),
      ]),
    ).rejects.toThrow('内容不一致');
  });
  it('跨天补传提醒与打卡，重试不重复扣减，取消按原快照返还', async () => {
    const id = randomUUID();
    const medId = randomUUID();
    const yesterday = new Date(Date.now() - 86400000).toISOString();
    const date = todayInBusinessTz(new Date(yesterday));
    const create = command('reminder.create', id, {
      type: 'med',
      title: '用药',
      frequency: 'daily',
      date: null,
      time: '08:00',
      recordBloodPressure: false,
      medicine: {
        medicineId: null,
        name: '离线药',
        unit: '粒',
        dosePerTime: 0.5,
        timesPerDay: 1,
        medicationTimings: [],
        cabinet: { id: medId, categoryId: medicine.categoryId, quantity: 2 },
      },
    });
    create.client_occurred_at = yesterday;
    const checkin = command(
      'checkin.set',
      id,
      {
        reminderId: id,
        occurrenceDate: date,
        expectedReminderVersion: 1,
        expectedVersion: 0,
        completed: true,
        checkinId: randomUUID(),
      },
      0,
    );
    checkin.depends_on = JSON.stringify([create.id]);
    checkin.client_occurred_at = yesterday;
    const saved = await service.commands([create, checkin]);
    expect(saved.results.map((row) => row.status)).toEqual([
      'accepted',
      'accepted',
    ]);
    expect(saved.medicines[0].quantity).toBe(1.5);
    expect(saved.checkins[0].completedAt).toBe(yesterday);
    expect((await service.commands([checkin])).medicines[0].quantity).toBe(1.5);
    const cancel = command(
      'checkin.set',
      id,
      {
        reminderId: id,
        occurrenceDate: date,
        expectedReminderVersion: 1,
        expectedVersion: 1,
        completed: false,
      },
      1,
      checkin,
    );
    const canceled = await service.commands([cancel]);
    expect(canceled.results.at(-1)?.status).toBe('accepted');
    expect(canceled.medicines[0].quantity).toBe(2);
  });
  it('前序打卡的回执包含药品版本，后续离线编辑不会错用打卡版本', async () => {
    const id = randomUUID();
    const drugId = randomUUID();
    const med = command('medicine.create', drugId, medicine);
    const rule = command('reminder.create', id, {
      type: 'med',
      title: '用药',
      frequency: 'daily',
      date: null,
      time: '08:00',
      recordBloodPressure: false,
      medicine: {
        medicineId: drugId,
        name: medicine.name,
        unit: '粒',
        dosePerTime: 0.5,
        timesPerDay: 1,
        medicationTimings: [],
      },
    });
    rule.depends_on = JSON.stringify([med.id]);
    const checkin = command(
      'checkin.set',
      id,
      {
        reminderId: id,
        occurrenceDate: todayInBusinessTz(),
        expectedReminderVersion: 1,
        expectedVersion: 0,
        completed: true,
      },
      0,
    );
    checkin.depends_on = JSON.stringify([rule.id]);
    const edit = command(
      'medicine.update',
      drugId,
      { ...medicine, quantity: 3.5, name: '服药后编辑' },
      1,
      checkin,
    );
    const saved = await service.commands([med, rule, checkin, edit]);
    expect(saved.results.map((row) => row.status)).toEqual([
      'accepted',
      'accepted',
      'accepted',
      'accepted',
    ]);
    expect(saved.medicines[0]).toMatchObject({
      quantity: 3.5,
      name: '服药后编辑',
      version: 3,
    });
  });
  it('用户明确处理拒绝后 AI 水位可以就绪，但未上传的空洞仍阻止就绪', async () => {
    const id = randomUUID();
    const first = command('medicine.create', id, medicine);
    await service.commands([first]);
    const rejected = command('medicine.update', id, {
      ...medicine,
      name: '未提供版本',
    });
    await service.commands([rejected]);
    expect((await service.readiness(device, 2)).ready).toBe(false);
    expect((await service.readiness(device, 2, [rejected.id])).ready).toBe(
      true,
    );
    expect((await service.readiness(device, 3, [rejected.id])).ready).toBe(
      false,
    );
  });
  it('照片本地不可读的操作留下明确拒绝，不阻塞其他独立操作', async () => {
    const failed = command('visit.create', randomUUID(), {
      visitDate: todayInBusinessTz(),
      initialVisitId: null,
      symptomTags: [],
      medicines: [],
    });
    const independent = command('medicine.create', randomUUID(), medicine);
    const saved = await service.commands([failed, independent], [failed.id]);
    expect(saved.results.map((row) => row.status)).toEqual([
      'rejected',
      'accepted',
    ]);
    expect(saved.medicines).toHaveLength(1);
  });
  it('照片幂等且按账号隔离，未上传附件的就诊不被误报成功', async () => {
    const id = randomUUID();
    const content = Buffer.from('isolated test attachment').toString('base64');
    expect(await service.uploadAttachment(id, content)).toEqual(
      await service.uploadAttachment(id, content),
    );
    expect((await service.downloadAttachment(id)).base64).toBe(content);
    await expect(other.downloadAttachment(id)).rejects.toThrow('不可访问');
    const visit = command('visit.create', randomUUID(), {
      visitDate: todayInBusinessTz(),
      initialVisitId: null,
      symptomTags: [],
      medicines: [],
      photos: [{ id, uri: 'file://local-only' }],
    });
    const saved = await service.commands([visit]);
    expect(saved.results[0].status).toBe('accepted');
    expect(saved.visits[0].photos).toEqual([{ id, uri: `attachment:${id}` }]);
  });
});
