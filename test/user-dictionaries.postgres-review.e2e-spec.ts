import { createAuthFixture } from './supabase-fixture.js';
import { SUPABASE_JWKS, SupabaseIdentityService } from '../src/modules/auth/supabase-auth.js';
import { todayInBusinessTz } from '../src/modules/visits/visit-date.js';
import { randomUUID } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { Test } from '@nestjs/testing';
import {
  FastifyAdapter,
  type NestFastifyApplication,
} from '@nestjs/platform-fastify';
import { PrismaPg } from '@prisma/adapter-pg';
import pg from 'pg';
import { PrismaClient } from '../src/generated/prisma/client.js';
import { PrismaService } from '../src/database/prisma/prisma.service.js';
import { AppModule } from '../src/app.module.js';
import { DEFAULT_USER_DICTIONARY } from '../src/modules/auth/default-user-dictionary.js';
import { UserDictionariesService } from '../src/modules/user-dictionaries/user-dictionaries.service.js';
import { MedicinesService } from '../src/modules/medicines/medicines.service.js';
import type { UserContextService } from '../src/modules/auth/user-context.service.js';

const url = process.env.DICTIONARY_TEST_DATABASE_URL;
const medicine = {
  name: '验证药',
  category: '感冒咳嗽',
  quantity: 1,
  unit: '粒',
};

describe.skipIf(!url)('字典审核：真实 PostgreSQL、真实鉴权和事务', () => {
  const schema = `dictionary_review_${randomUUID().replaceAll('-', '')}`;
  let pool: pg.Pool;
  let client: PrismaClient;
  let app: NestFastifyApplication;
  let token: string;
  let userId: string;
  let testAuth: Awaited<ReturnType<typeof createAuthFixture>>;

  beforeAll(async () => {
    const parsed = new URL(url!);
    if (
      !['127.0.0.1', 'localhost'].includes(parsed.hostname) ||
      !parsed.pathname.endsWith('_test')
    ) {
      throw new Error('仅允许本机独立 _test 数据库');
    }
    pool = new pg.Pool({
      connectionString: url,
      options: `-c search_path=${schema},public`,
      connectionTimeoutMillis: 5000,
    });
    await pool.query(`CREATE SCHEMA "${schema}"`);
    for (const name of (await readdir('prisma/migrations'))
      .filter((n) => n !== 'migration_lock.toml')
      .sort()) {
      await pool.query(
        await readFile(`prisma/migrations/${name}/migration.sql`, 'utf8'),
      );
    }
    expect(
      Number((await pool.query('SELECT count(*) FROM users')).rows[0].count),
    ).toBe(0);
    expect(
      Number(
        (await pool.query('SELECT count(*) FROM medicine_items')).rows[0].count,
      ),
    ).toBe(0);
    client = new PrismaClient({ adapter: new PrismaPg(pool, { schema }) });
    testAuth = await createAuthFixture();
    const module = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(PrismaService)
      .useValue(client)
      .overrideProvider(SUPABASE_JWKS).useValue(testAuth.jwks)
      .overrideProvider(SupabaseIdentityService).useValue(testAuth.identities)
      .compile();
    app = module.createNestApplication<NestFastifyApplication>(
      new FastifyAdapter(),
    );
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
  });
  beforeEach(async () => {
    const registered = await testAuth.register(app);
    expect(registered.statusCode).toBe(200);
    token = registered.json().token;
    userId = registered.json().user.id;
  });
  afterAll(async () => {
    await app?.close();
    await client?.$disconnect();
    if (pool) {
      try {
        await pool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
      } finally {
        await pool.end();
      }
    }
  });
  const auth = () => ({ authorization: `Bearer ${token}` });
  const dictionary = () =>
    app.inject({ method: 'GET', url: '/user-dictionaries', headers: auth() });

  it('并发首次业务请求原子创建唯一用户和字典', async () => {
    const id = randomUUID(); const jwt = await testAuth.issue(id);
    const results = await Promise.all(Array.from({ length: 8 }, () => app.inject({ method: 'GET', url: '/users/me', headers: { authorization: `Bearer ${jwt}` } })));
    expect(results.map(result => result.statusCode)).toEqual(Array(8).fill(200));
    expect(await client.users.count({ where: { id } })).toBe(1);
    expect(await client.user_dictionaries.count({ where: { user_id: id } })).toBe(1);
  });

  it('真实字典插入失败会回滚业务用户，恢复后可重试', async () => {
    const id = randomUUID(); const jwt = await testAuth.issue(id);
    await pool.query(`ALTER TABLE user_dictionaries ADD CONSTRAINT bootstrap_failure_probe CHECK (user_id <> '${id}'::uuid) NOT VALID`);
    try {
      expect((await app.inject({ method: 'GET', url: '/users/me', headers: { authorization: `Bearer ${jwt}` } })).statusCode).toBeGreaterThanOrEqual(400);
      expect(await client.users.count({ where: { id } })).toBe(0);
    } finally { await pool.query('ALTER TABLE user_dictionaries DROP CONSTRAINT bootstrap_failure_probe'); }
    expect((await app.inject({ method: 'GET', url: '/users/me', headers: { authorization: `Bearer ${jwt}` } })).statusCode).toBe(200);
    expect(await client.user_dictionaries.count({ where: { user_id: id } })).toBe(1);
  });

  it('全新库初始化得到当前字典和文本大类结构', async () => {
    const columns = await pool.query(
      'SELECT column_name FROM information_schema.columns WHERE table_schema=$1 AND table_name=$2',
      [schema, 'medicine_items'],
    );
    const names = columns.rows.map((row) => row.column_name);
    expect(names).toContain('category');
    expect(names).not.toContain('category_id');
    expect(
      await client.user_dictionaries.count({ where: { user_id: userId } }),
    ).toBe(1);
    expect(
      await client.medicine_items.count({ where: { user_id: userId } }),
    ).toBe(0);
  });

  it('真实注册初始化默认字典，未登录 401，修改只影响当前账号', async () => {
    expect((await dictionary()).json()).toMatchObject(DEFAULT_USER_DICTIONARY);
    expect(
      (await app.inject({ method: 'GET', url: '/user-dictionaries' }))
        .statusCode,
    ).toBe(401);
    const second = await testAuth.register(app);
    const response = await app.inject({
      method: 'POST',
      url: '/user-dictionaries/categories',
      headers: auth(),
      payload: { values: [' 本机自定义 ', '本机自定义'] },
    });
    expect(response.statusCode).toBe(201);
    expect(
      response.json().categories.filter((v: string) => v === '本机自定义'),
    ).toHaveLength(1);
    const other = await app.inject({
      method: 'GET',
      url: '/user-dictionaries',
      headers: { authorization: `Bearer ${second.json().token}` },
    });
    expect(other.json().categories).not.toContain('本机自定义');
  });

  it('只带字典动作的 PATCH /medicines 实际可用，且不回写已有药品原文', async () => {
    const created = await app.inject({
      method: 'POST',
      url: '/medicines',
      headers: auth(),
      payload: medicine,
    });
    expect(created.statusCode).toBe(201);
    const patched = await app.inject({
      method: 'PATCH',
      url: `/medicines/${created.json().id}`,
      headers: auth(),
      payload: {
        dictionaryActions: [
          { field: 'categories', op: 'rename', from: '感冒咳嗽', to: '家庭药' },
        ],
      },
    });
    expect(patched.statusCode).toBe(200);
    expect(patched.json().category).toBe('感冒咳嗽');
    expect((await dictionary()).json().categories).toContain('家庭药');
  });

  it('字典冲突时业务写入整单回滚', async () => {
    const before = await client.medicine_items.count({
      where: { user_id: userId },
    });
    const response = await app.inject({
      method: 'POST',
      url: '/medicines',
      headers: auth(),
      payload: {
        ...medicine,
        dictionaryActions: [
          { field: 'efficacies', op: 'add', value: '应回滚' },
          { field: 'categories', op: 'rename', from: '感冒咳嗽', to: '保健品' },
        ],
      },
    });
    expect(response.statusCode).toBe(409);
    expect(
      await client.medicine_items.count({ where: { user_id: userId } }),
    ).toBe(before);
    expect((await dictionary()).json().efficacies).not.toContain('应回滚');
  });

  it('带动作离线命令重试只执行一次，快照包含字典与回执', async () => {
    const command = {
      id: randomUUID(),
      user_id: userId,
      device_id: randomUUID(),
      entity_id: randomUUID(),
      type: 'medicine.create',
      schema_version: 2,
      payload: JSON.stringify({
        ...medicine,
        dictionaryActions: [
          { field: 'categories', op: 'add', value: '离线类' },
        ],
      }),
      base_version: null,
      base_op_id: null,
      depends_on: '[]',
      client_occurred_at: new Date().toISOString(),
      sequence: 1,
    };
    for (let i = 0; i < 2; i++) {
      const response = await app.inject({
        method: 'POST',
        url: '/sync/commands',
        headers: auth(),
        payload: { commands: [command] },
      });
      expect(response.statusCode).toBe(201);
      expect(response.json().results[0].status).toBe('accepted');
      expect(
        response
          .json()
          .dictionary.categories.filter((v: string) => v === '离线类'),
      ).toHaveLength(1);
      expect(response.json().medicines).toHaveLength(1);
    }
  });

  async function withHeldUserLock(work: () => Promise<unknown[]>) {
    const blocker = await pool.connect();
    let pending: Promise<unknown[]> | undefined;
    try {
      await blocker.query('BEGIN');
      await blocker.query(
        'SELECT pg_advisory_xact_lock(hashtextextended($1, 0))',
        [userId],
      );
      const pid = (await blocker.query('SELECT pg_backend_pid() AS pid'))
        .rows[0].pid;
      pending = work();
      void pending.catch(() => undefined);
      let waiting = 0;
      for (let attempt = 0; attempt < 200; attempt++) {
        const locks = await pool.query(
          `SELECT count(*)::int AS n FROM pg_locks w JOIN pg_locks h
          ON w.locktype=h.locktype AND w.classid=h.classid AND w.objid=h.objid AND w.objsubid=h.objsubid
          WHERE h.pid=$1 AND h.granted AND NOT w.granted AND w.locktype='advisory'`,
          [pid],
        );
        waiting = locks.rows[0].n;
        if (waiting >= 2) break;
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      expect(waiting).toBeGreaterThanOrEqual(2);
    } finally {
      await blocker.query('ROLLBACK');
      blocker.release();
      await pending;
    }
  }

  it.each(['REST 字典新增', '药品事务附带字典动作'])(
    '%s 并发应保留双方新增',
    async (kind) => {
      const context = { getUserId: () => userId } as UserContextService;
      await withHeldUserLock(() => {
        if (kind === 'REST 字典新增') {
          const service = new UserDictionariesService(
            client as PrismaService,
            context,
          );
          return Promise.all(
            ['并发A', '并发B'].map((value) =>
              service.addValues('categories', { values: [value] }),
            ),
          );
        }
        const service = new MedicinesService(client as PrismaService, context);
        return Promise.all(
          ['并发A', '并发B'].map((value) =>
            service.create({
              ...medicine,
              dictionaryActions: [{ field: 'categories', op: 'add', value }],
            }),
          ),
        );
      });
      if (kind !== 'REST 字典新增')
        expect(
          await client.medicine_items.count({ where: { user_id: userId } }),
        ).toBe(2);
      expect((await dictionary()).json().categories).toEqual(
        expect.arrayContaining(['并发A', '并发B']),
      );
    },
  );

  it('REST 与同步混用遵守同一用户锁，不丢任一字典动作', async () => {
    await withHeldUserLock(() =>
      Promise.all([
        app
          .inject({
            method: 'POST',
            url: '/user-dictionaries/categories',
            headers: auth(),
            payload: { values: ['REST标签'] },
          })
          .then((response) => expect(response.statusCode).toBe(201)),
        app
          .inject({
            method: 'POST',
            url: '/sync/commands',
            headers: auth(),
            payload: {
              commands: [
                {
                  id: randomUUID(),
                  user_id: userId,
                  device_id: randomUUID(),
                  entity_id: randomUUID(),
                  type: 'medicine.create',
                  schema_version: 2,
                  payload: JSON.stringify({
                    ...medicine,
                    dictionaryActions: [
                      { field: 'categories', op: 'add', value: '同步标签' },
                    ],
                  }),
                  base_version: null,
                  base_op_id: null,
                  depends_on: '[]',
                  client_occurred_at: new Date().toISOString(),
                  sequence: 1,
                },
              ],
            },
          })
          .then((response) => {
            expect(response.statusCode).toBe(201);
            expect(response.json().results[0].status).toBe('accepted');
          }),
      ]),
    );
    expect((await dictionary()).json().categories).toEqual(
      expect.arrayContaining(['REST标签', '同步标签']),
    );
  });

  it.each(['就诊症状', '就诊入箱', '提醒入箱'])(
    '%s 写入也先取得统一用户锁',
    async (kind) => {
      const field = kind === '就诊症状' ? 'symptoms' : 'categories';
      const value = `${kind}标签`;
      const cabinetMed = {
        medicineId: null,
        name: '入箱药',
        unit: '粒',
        cabinet: {
          category: value,
          quantity: 1,
          dictionaryActions: [{ field: 'categories', op: 'add', value }],
        },
      };
      const payload =
        kind === '提醒入箱'
          ? {
              id: randomUUID(),
              type: 'med',
              title: '用药',
              frequency: 'daily',
              date: null,
              time: '08:00',
              recordBloodPressure: false,
              medicine: cabinetMed,
            }
          : {
              id: randomUUID(),
              visitDate: todayInBusinessTz(),
              initialVisitId: null,
              symptomTags: [],
              medicines:
                kind === '就诊入箱'
                  ? [{ ...cabinetMed, id: randomUUID() }]
                  : [],
              ...(kind === '就诊症状'
                ? { dictionaryActions: [{ field, op: 'add', value }] }
                : {}),
            };
      await withHeldUserLock(() =>
        Promise.all([
          app
            .inject({
              method: 'POST',
              url: kind === '提醒入箱' ? '/reminders' : '/visits',
              headers: auth(),
              payload,
            })
            .then((response) => expect(response.statusCode).toBe(201)),
          app
            .inject({
              method: 'POST',
              url: `/user-dictionaries/${field}`,
              headers: auth(),
              payload: { values: ['并行REST'] },
            })
            .then((response) => expect(response.statusCode).toBe(201)),
        ]),
      );
      expect((await dictionary()).json()[field]).toEqual(
        expect.arrayContaining([value, '并行REST']),
      );
    },
  );

  it('一个用户持锁不会阻塞另一个用户字典写入', async () => {
    const other = await testAuth.register(app);
    const blocker = await pool.connect();
    try {
      await blocker.query('BEGIN');
      await blocker.query(
        'SELECT pg_advisory_xact_lock(hashtextextended($1, 0))',
        [userId],
      );
      const response = await app.inject({
        method: 'POST',
        url: '/user-dictionaries/categories',
        headers: { authorization: `Bearer ${other.json().token}` },
        payload: { values: ['其他账号标签'] },
      });
      expect(response.statusCode).toBe(201);
      expect((await dictionary()).json().categories).not.toContain(
        '其他账号标签',
      );
    } finally {
      await blocker.query('ROLLBACK');
      blocker.release();
    }
  });

  it('药品、就诊及入箱字段越界返回 400，不改变业务和字典', async () => {
    const badSymptoms = [{ field: 'symptoms', op: 'add', value: '越界症状' }];
    const badCategory = [{ field: 'categories', op: 'add', value: '越界大类' }];
    const visit = {
      id: randomUUID(),
      visitDate: todayInBusinessTz(),
      initialVisitId: null,
      symptomTags: [],
      medicines: [],
    };
    const badMedicine = await app.inject({
      method: 'POST',
      url: '/medicines',
      headers: auth(),
      payload: { ...medicine, dictionaryActions: badSymptoms },
    });
    expect(badMedicine.statusCode).toBe(400);
    const badVisit = await app.inject({
      method: 'POST',
      url: '/visits',
      headers: auth(),
      payload: { ...visit, dictionaryActions: badCategory },
    });
    expect(badVisit.statusCode).toBe(400);
    const cabinetMed = {
      medicineId: null,
      name: '药',
      unit: '粒',
      cabinet: {
        category: '感冒咳嗽',
        quantity: 1,
        dictionaryActions: badSymptoms,
      },
    };
    const badCabinetVisit = await app.inject({
      method: 'POST',
      url: '/visits',
      headers: auth(),
      payload: { ...visit, medicines: [{ ...cabinetMed, id: randomUUID() }] },
    });
    expect(badCabinetVisit.statusCode).toBe(400);
    const badReminder = await app.inject({
      method: 'POST',
      url: '/reminders',
      headers: auth(),
      payload: {
        id: randomUUID(),
        type: 'med',
        title: '药',
        frequency: 'daily',
        date: null,
        time: '08:00',
        recordBloodPressure: false,
        medicine: cabinetMed,
      },
    });
    expect(badReminder.statusCode).toBe(400);
    expect(
      await client.medicine_items.count({ where: { user_id: userId } }),
    ).toBe(0);
    expect(
      await client.visit_records.count({ where: { user_id: userId } }),
    ).toBe(0);
    expect(
      await client.health_reminders.count({ where: { user_id: userId } }),
    ).toBe(0);
    const created = await app.inject({
      method: 'POST',
      url: '/medicines',
      headers: auth(),
      payload: medicine,
    });
    expect(
      (
        await app.inject({
          method: 'PATCH',
          url: `/medicines/${created.json().id}`,
          headers: auth(),
          payload: { dictionaryActions: badSymptoms },
        })
      ).statusCode,
    ).toBe(400);
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/visits',
          headers: auth(),
          payload: visit,
        })
      ).statusCode,
    ).toBe(201);
    expect(
      (
        await app.inject({
          method: 'PATCH',
          url: `/visits/${visit.id}`,
          headers: auth(),
          payload: { expectedVersion: 1, dictionaryActions: badCategory },
        })
      ).statusCode,
    ).toBe(400);
    expect((await dictionary()).json()).toMatchObject(DEFAULT_USER_DICTIONARY);
  });
});
