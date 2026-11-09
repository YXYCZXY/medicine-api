import { randomUUID } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import pg from 'pg';
import { PrismaPg } from '@prisma/adapter-pg';
import { BadRequestException, ForbiddenException } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import {
  FastifyAdapter,
  type NestFastifyApplication,
} from '@nestjs/platform-fastify';
import { PrismaClient } from '../src/generated/prisma/client.js';
import { PrismaService } from '../src/database/prisma/prisma.service.js';
import { AppModule } from '../src/app.module.js';
import { AccountDeletionService } from '../src/modules/auth/account-deletion.service.js';
import { SupabaseAccountAdmin } from '../src/modules/auth/supabase-account-admin.js';
import {
  SUPABASE_JWKS,
  SupabaseIdentityService,
} from '../src/modules/auth/supabase-auth.js';
import { lockActiveAccount } from '../src/modules/auth/account-write-lock.js';
import { lockUserWrites } from '../src/modules/user-dictionaries/dictionary-actions.js';
import { SyncService } from '../src/modules/sync/sync.service.js';
import type { UserContextService } from '../src/modules/auth/user-context.service.js';
import { createAuthFixture } from './supabase-fixture.js';

const url = process.env.ACCOUNT_DELETION_TEST_DATABASE_URL;
const A = '00000000-0000-4000-8000-000000000001';
const B = '00000000-0000-4000-8000-000000000002';
const tables = [
  'users',
  'user_dictionaries',
  'medicine_items',
  'visit_records',
  'visit_medicines',
  'health_reminders',
  'health_reminder_medicines',
  'health_reminder_checkins',
  'blood_pressure_records',
  'medicine_expiry_states',
  'sync_attachments',
  'sync_tombstones',
  'sync_command_receipts',
  'sync_reminder_revisions',
];
describe.skipIf(!url)('永久删除账号 · 隔离 PostgreSQL 与 HTTP 验收', () => {
  let pool: pg.Pool,
    db: PrismaClient,
    app: NestFastifyApplication,
    service: AccountDeletionService;
  let fixture: Awaited<ReturnType<typeof createAuthFixture>>;
  let token: string;
  let runWorker: () => Promise<void>;
  const deleted = new Set<string>();
  const schema = 'account_deletion_test_' + randomUUID().replaceAll('-', '');
  const admin = {
    configured: false,
    assertConfigured: vi.fn(),
    sendCode: vi.fn(),
    verifyCode: vi.fn(),
    removeStorage: vi.fn(),
    deleteIdentity: vi.fn(async (id: string) => {
      deleted.add(id);
    }),
    exists: vi.fn(async (id: string) => !deleted.has(id)),
  };
  const headers = () => ({ authorization: `Bearer ${token}` });
  const operation = () => ({
    operationId: randomUUID(),
    receiptSecret: 'a'.repeat(64),
    code: '123456',
    confirmation: 'DELETE_ALL_DATA',
  });
  const send = () =>
    app.inject({
      method: 'POST',
      url: '/users/me/deletion-code',
      headers: headers(),
    });
  const submit = (body = operation()) =>
    app.inject({
      method: 'DELETE',
      url: '/users/me',
      headers: headers(),
      payload: body,
    });
  const status = (
    body: ReturnType<typeof operation>,
    secret = body.receiptSecret,
  ) =>
    app.inject({
      method: 'GET',
      url: `/account-deletions/${body.operationId}`,
      headers: { authorization: `Bearer ${secret}` },
    });
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
    db = new PrismaClient({ adapter: new PrismaPg(pool, { schema }) });
    await db.$connect();
    fixture = await createAuthFixture();
    fixture.identities.getVerifiedUser.mockImplementation(
      async (_token, identity) => {
        if (deleted.has(identity.userId))
          throw new ForbiddenException({
            code: 'ACCOUNT_DELETED',
            message: '账号已删除',
          });
        return {
          phone: identity.phone,
          nickname: '测试用户',
          confirmedAt: new Date('2026-11-01'),
        };
      },
    );
    const module = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(PrismaService)
      .useValue(db)
      .overrideProvider(SUPABASE_JWKS)
      .useValue(fixture.jwks)
      .overrideProvider(SupabaseIdentityService)
      .useValue(fixture.identities)
      .overrideProvider(SupabaseAccountAdmin)
      .useValue(admin)
      .compile();
    app = module.createNestApplication<NestFastifyApplication>(
      new FastifyAdapter(),
    );
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
    service = app.get(AccountDeletionService);
    runWorker = service.drain.bind(service);
    vi.spyOn(service, 'drain').mockResolvedValue(); // tests drive each worker tick explicitly
  });
  afterAll(async () => {
    await app?.close();
    await db?.$disconnect();
    if (pool) {
      try {
        await pool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
      } finally {
        await pool.end();
      }
    }
  });
  beforeEach(async () => {
    vi.clearAllMocks();
    deleted.clear();
    admin.assertConfigured.mockImplementation(() => undefined);
    admin.verifyCode.mockResolvedValue(undefined);
    admin.sendCode.mockResolvedValue(undefined);
    admin.removeStorage.mockResolvedValue(undefined);
    admin.deleteIdentity.mockImplementation(async (id) => {
      deleted.add(id);
    });
    await pool.query(
      `TRUNCATE ${[...tables, 'account_deletion_tasks', 'account_deletion_challenges', 'account_deletion_receipts'].join(',')} CASCADE`,
    );
    token = await fixture.issue(A, { phone: '+8613800000001' });
    for (const [index, userId] of [A, B].entries()) {
      await db.users.create({
        data: {
          id: userId,
          nickname: '私人昵称',
          phone: `+861380000000${index + 1}`,
        },
      });
      await db.user_dictionaries.create({
        data: { user_id: userId, categories: ['私人标签'] },
      });
      const med = await db.medicine_items.create({
        data: {
          user_id: userId,
          category: '常用药',
          name: '私人药品',
          unit: '片',
          quantity: 10,
          expiration_date: new Date('2027-01-01'),
        },
      });
      const visit = await db.visit_records.create({
        data: {
          id: randomUUID(),
          user_id: userId,
          visit_date: new Date('2026-11-01'),
          symptom_tags: ['私人症状'],
          photo_keys: [randomUUID()],
        },
      });
      await db.visit_medicines.create({
        data: {
          id: randomUUID(),
          visit_id: visit.id,
          medicine_id: med.id,
          name: med.name,
          unit: med.unit,
          sort_order: 0,
        },
      });
      const reminder = await db.health_reminders.create({
        data: {
          id: randomUUID(),
          user_id: userId,
          type: 'med',
          title: '私人提醒',
          frequency: 'daily',
          remind_time: '08:00',
          starts_on: new Date('2026-11-01'),
        },
      });
      await db.health_reminder_medicines.create({
        data: {
          reminder_id: reminder.id,
          medicine_id: med.id,
          name: med.name,
          unit: med.unit,
        },
      });
      const checkin = await db.health_reminder_checkins.create({
        data: {
          reminder_id: reminder.id,
          occurrence_date: new Date('2026-11-01'),
          completed_at: new Date(),
        },
      });
      await db.blood_pressure_records.create({
        data: {
          user_id: userId,
          checkin_id: checkin.id,
          systolic: 120,
          diastolic: 80,
          pulse: 70,
          slot: 'morning',
          measured_at: new Date(),
        },
      });
      await db.medicine_expiry_states.create({
        data: { medicine_id: med.id, expiration_date: new Date('2027-01-01') },
      });
      await db.sync_attachments.create({
        data: {
          user_id: userId,
          id: randomUUID(),
          digest: 'private-photo',
          content: Buffer.from('private-content'),
        },
      });
      await db.sync_tombstones.create({
        data: { user_id: userId, kind: 'medicine', entity_id: randomUUID() },
      });
      await db.sync_reminder_revisions.create({
        data: {
          user_id: userId,
          reminder_id: reminder.id,
          version: 1,
          record: { private: 'old-rule' },
        },
      });
      await db.sync_command_receipts.create({
        data: {
          user_id: userId,
          op_id: randomUUID(),
          device_id: 'device',
          sequence: 1,
          entity_id: med.id,
          type: 'medicine.create',
          digest: 'private-digest',
          status: 'accepted',
          result: { private: 'original-input' },
        },
      });
    }
  });
  it('只向当前账号发码，60 秒服务端冷却，错误验证码不会创建任务或改变数据', async () => {
    expect((await send()).statusCode).toBe(200);
    expect(admin.sendCode).toHaveBeenCalledWith('+8613800000001');
    expect((await send()).statusCode).toBe(429);
    admin.verifyCode.mockRejectedValue(
      new BadRequestException({ code: 'OTP_INVALID', message: '验证码错误' }),
    );
    for (let i = 0; i < 5; i++) expect((await submit()).statusCode).toBe(400);
    expect((await submit()).statusCode).toBe(429);
    expect(admin.verifyCode).toHaveBeenCalledTimes(5);
    expect(await db.account_deletion_tasks.count()).toBe(0);
    expect((await db.users.findUnique({ where: { id: A } }))?.status).toBe(
      'active',
    );
    expect(await db.medicine_items.count()).toBe(2);
  });
  it('过期/未发送验证码、缺少最终确认和篡改身份字段均不受理', async () => {
    expect((await submit()).statusCode).toBe(400);
    await send();
    await db.account_deletion_challenges.update({
      where: { user_id: A },
      data: { expires_at: new Date(0) },
    });
    expect((await submit()).statusCode).toBe(400);
    expect(
      (await submit({ ...operation(), confirmation: '' })).statusCode,
    ).toBe(400);
    const forged = await app.inject({
      method: 'DELETE',
      url: '/users/me',
      headers: headers(),
      payload: { ...operation(), userId: B },
    });
    expect(forged.statusCode).toBe(400);
    expect(admin.verifyCode).not.toHaveBeenCalled();
  });
  it('完整清理全部业务表、关联表、照片与同步历史，保留另一账号，并删除 Supabase 身份', async () => {
    await send();
    const op = operation();
    expect((await submit(op)).statusCode).toBe(202);
    expect((await status(op, 'b'.repeat(64))).statusCode).toBe(404);
    expect(
      (
        await app.inject({
          method: 'GET',
          url: '/users/me',
          headers: headers(),
        })
      ).json(),
    ).toMatchObject({ code: 'ACCOUNT_DELETING' });
    await runWorker();
    expect((await status(op)).json()).toMatchObject({ status: 'completed' });
    for (const table of tables)
      expect(
        (await pool.query(`SELECT count(*)::int AS count FROM ${table}`))
          .rows[0].count,
        table,
      ).toBe(1);
    expect(await db.account_deletion_tasks.count()).toBe(0);
    expect(await db.account_deletion_challenges.count()).toBe(0);
    const receipt = await db.account_deletion_receipts.findUniqueOrThrow({
      where: { id: op.operationId },
    });
    expect(receipt).not.toHaveProperty('user_id');
    expect(JSON.stringify(receipt)).not.toContain('+8613800000001');
    expect(admin.removeStorage).toHaveBeenCalledWith(A);
    expect(admin.deleteIdentity).toHaveBeenCalledWith(A);
    expect(
      (
        await app.inject({
          method: 'GET',
          url: '/users/me',
          headers: headers(),
        })
      ).json(),
    ).toMatchObject({ code: 'ACCOUNT_DELETED' });
    expect(await db.users.findUnique({ where: { id: A } })).toBeNull();
    await runWorker();
    expect(await db.medicine_items.count()).toBe(1);
  });
  it('数据库失败会回滚完整业务清理，后续 worker 可恢复', async () => {
    await send();
    const op = operation();
    await submit(op);
    await pool.query(
      `CREATE FUNCTION reject_deletion() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'test rollback'; END $$`,
    );
    await pool.query(
      'CREATE TRIGGER reject_deletion BEFORE DELETE ON medicine_items FOR EACH ROW EXECUTE FUNCTION reject_deletion()',
    );
    await runWorker();
    expect(await db.visit_records.count()).toBe(2);
    expect(await db.health_reminders.count()).toBe(2);
    expect(admin.deleteIdentity).not.toHaveBeenCalled();
    expect((await status(op)).json()).toMatchObject({ status: 'processing' });
    await pool.query('DROP TRIGGER reject_deletion ON medicine_items');
    await pool.query('DROP FUNCTION reject_deletion()');
    await db.account_deletion_tasks.updateMany({
      data: { next_attempt_at: new Date(0) },
    });
    await runWorker();
    expect((await status(op)).json()).toMatchObject({ status: 'completed' });
  });
  it('Supabase 超时不会误报成功；Auth 已删除但响应丢失后可幂等完成', async () => {
    await send();
    const op = operation();
    await submit(op);
    admin.deleteIdentity.mockImplementationOnce(async (id) => {
      deleted.add(id);
      throw new Error('lost response');
    });
    await runWorker();
    expect((await status(op)).json()).toMatchObject({ status: 'processing' });
    expect((await db.users.findUnique({ where: { id: A } }))?.status).toBe(
      'deleting',
    );
    expect(await db.sync_attachments.count({ where: { user_id: A } })).toBe(0);
    await db.account_deletion_tasks.updateMany({
      data: { next_attempt_at: new Date(0) },
    });
    await runWorker();
    expect((await status(op)).json()).toMatchObject({ status: 'completed' });
    expect(await db.users.findUnique({ where: { id: A } })).toBeNull();
  });
  it('取消未受理提交后，迟到的 DELETE 无法再提交；已受理任务不可取消', async () => {
    const cancelled = operation();
    expect(
      (
        await app.inject({
          method: 'POST',
          url: `/account-deletions/${cancelled.operationId}/cancel`,
          headers: { authorization: `Bearer ${cancelled.receiptSecret}` },
        })
      ).statusCode,
    ).toBe(200);
    await send();
    expect((await submit(cancelled)).statusCode).toBe(409);
    expect(admin.verifyCode).not.toHaveBeenCalled();
    const accepted = operation();
    expect((await submit(accepted)).statusCode).toBe(202);
    expect(
      (
        await app.inject({
          method: 'POST',
          url: `/account-deletions/${accepted.operationId}/cancel`,
          headers: { authorization: `Bearer ${accepted.receiptSecret}` },
        })
      ).statusCode,
    ).toBe(409);
    expect((await status(accepted)).json()).toMatchObject({
      status: 'processing',
    });
  });
  it('等待账号锁的迟到写入与附件上传均不能复活删除中的数据', async () => {
    let release!: () => void, locked!: () => void;
    const acquired = new Promise<void>((resolve) => {
      locked = resolve;
    });
    const hold = new Promise<void>((resolve) => {
      release = resolve;
    });
    const deleting = db.$transaction(
      async (tx) => {
        await lockUserWrites(tx, A);
        await tx.users.update({
          where: { id: A },
          data: { status: 'deleting' },
        });
        locked();
        await hold;
      },
      { timeout: 10000 },
    );
    await acquired;
    const writing = db.$transaction(async (tx) => {
      await lockActiveAccount(tx, A);
      return tx.sync_attachments.create({
        data: {
          user_id: A,
          id: randomUUID(),
          digest: 'late',
          content: Buffer.from('late'),
        },
      });
    });
    const rejection = expect(writing).rejects.toMatchObject({
      response: { code: 'ACCOUNT_DELETING' },
    });
    release();
    await deleting;
    await rejection;
    const sync = new SyncService(
      db as PrismaService,
      { getUserId: () => A } as UserContextService,
    );
    await expect(
      sync.uploadAttachment(
        randomUUID(),
        Buffer.from('late').toString('base64'),
      ),
    ).rejects.toMatchObject({ response: { code: 'ACCOUNT_DELETING' } });
    expect(await db.sync_attachments.count({ where: { user_id: A } })).toBe(1);
  });
  it('只有签名正确的历史凭据可确认删除，过期凭据仍不能访问业务接口', async () => {
    const { SignJWT } = await import('jose');
    const historical = await new SignJWT({
      role: 'authenticated',
      is_anonymous: false,
    })
      .setProtectedHeader({ alg: 'ES256', kid: fixture.key.kid })
      .setSubject(A)
      .setIssuer('https://auth.example.test/auth/v1')
      .setAudience('authenticated')
      .setIssuedAt(Math.floor(Date.now() / 1000) - 3600)
      .setExpirationTime(Math.floor(Date.now() / 1000) - 600)
      .sign(fixture.pair.privateKey);
    deleted.add(A);
    const response = await app.inject({
      method: 'GET',
      url: '/users/me/deletion-status',
      headers: { authorization: `Bearer ${historical}` },
    });
    expect(response.json()).toEqual({ status: 'deleted' });
    expect(
      (
        await app.inject({
          method: 'GET',
          url: '/medicines',
          headers: { authorization: `Bearer ${historical}` },
        })
      ).statusCode,
    ).toBe(401);
    expect(
      (
        await app.inject({
          method: 'GET',
          url: '/users/me/deletion-status',
          headers: { authorization: 'Bearer not-a-token' },
        })
      ).statusCode,
    ).toBe(401);
  });
});
