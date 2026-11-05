import { randomUUID } from 'node:crypto';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import { AppModule } from '../src/app.module.js';
import { PrismaService } from '../src/database/prisma/prisma.service.js';
import { Prisma } from '../src/generated/prisma/client.js';
import { UserContextService } from '../src/modules/auth/user-context.service.js';
import { MedicinesService } from '../src/modules/medicines/medicines.service.js';

type User = {
  id: string; account: string; password_hash: string; nickname: string;
  phone: null; avatar_url: null; status: string;
};
type Session = {
  id: string; user_id: string; token_hash: string;
  expires_at: Date; revoked_at: Date | null;
};

function createPrismaFake() {
  const users = new Map<string, User>();
  const sessions = new Map<string, Session>();
  const fake = {
    $transaction: async (callback: (tx: unknown) => Promise<unknown>) => callback(fake),
    users: {
      create: vi.fn(async ({ data }: { data: Pick<User, 'account' | 'password_hash' | 'nickname'> }) => {
        if (users.has(data.account)) throw new Prisma.PrismaClientKnownRequestError('duplicate', { code: 'P2002', clientVersion: '7.10.1' });
        const user: User = { ...data, id: randomUUID(), phone: null, avatar_url: null, status: 'active' };
        users.set(user.account, user);
        return user;
      }),
      findUnique: vi.fn(async ({ where }: { where: { account?: string; id?: string } }) =>
        where.account ? users.get(where.account) ?? null : [...users.values()].find((user) => user.id === where.id) ?? null),
      update: vi.fn(async ({ where }: { where: { id: string } }) => [...users.values()].find((user) => user.id === where.id)),
    },
    user_dictionaries: {
      create: vi.fn(async ({ data }: { data: { user_id: string; categories: string[]; efficacies: string[]; symptoms: string[] } }) => ({
        id: randomUUID(),
        ...data,
      })),
    },
    user_sessions: {
      create: vi.fn(async ({ data }: { data: Pick<Session, 'user_id' | 'token_hash' | 'expires_at'> }) => {
        const session: Session = { ...data, id: randomUUID(), revoked_at: null };
        sessions.set(data.token_hash, session);
        return session;
      }),
      findUnique: vi.fn(async ({ where }: { where: { token_hash: string } }) => {
        const session = sessions.get(where.token_hash);
        return session ? { ...session, user: [...users.values()].find((user) => user.id === session.user_id) } : null;
      }),
      updateMany: vi.fn(async ({ where, data }: { where: { id: string }; data: { revoked_at: Date } }) => {
        let count = 0;
        for (const session of sessions.values()) if (session.id === where.id) { session.revoked_at = data.revoked_at; count++; }
        return { count };
      }),
    },
  };
  return fake;
}

describe('注册、登录和用户隔离', () => {
  let app: NestFastifyApplication;
  let context: UserContextService;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(PrismaService)
      .useValue(createPrismaFake())
      .overrideProvider(MedicinesService)
      .useValue({ findAll: async () => {
        await new Promise((resolve) => setTimeout(resolve, 5));
        return [{ ownerId: context.getUserId() }];
      } })
      .compile();
    app = moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter());
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
    context = app.get(UserContextService);
  });

  afterAll(async () => { await app.close(); });

  it('注册后自动登录，账号间隔离，退出后令牌失效', async () => {
    expect((await app.inject({ method: 'GET', url: '/medicines' })).statusCode).toBe(401);

    const first = await app.inject({ method: 'POST', url: '/auth/register', payload: {
      account: 'Alice_01', password: 'secure-pass-123', nickname: '小艾',
    } });
    expect(first.statusCode).toBe(201);
    const firstSession = first.json<{ token: string; user: { id: string; account: string } }>();
    expect(firstSession.user.account).toBe('alice_01');

    const second = await app.inject({ method: 'POST', url: '/auth/register', payload: {
      account: 'bob_02', password: 'another-pass-123', nickname: '小博',
    } });
    expect(second.statusCode).toBe(201);
    const secondSession = second.json<{ token: string; user: { id: string } }>();
    expect(secondSession.user.id).not.toBe(firstSession.user.id);

    const duplicate = await app.inject({ method: 'POST', url: '/auth/register', payload: {
      account: 'ALICE_01', password: 'secure-pass-123', nickname: '重复',
    } });
    expect(duplicate.statusCode).toBe(409);

    const wrong = await app.inject({ method: 'POST', url: '/auth/login', payload: {
      account: 'alice_01', password: 'wrong-password',
    } });
    expect(wrong.statusCode).toBe(401);

    const login = await app.inject({ method: 'POST', url: '/auth/login', payload: {
      account: 'ALICE_01', password: 'secure-pass-123',
    } });
    expect(login.statusCode).toBe(200);

    const firstHeaders = { authorization: `Bearer ${firstSession.token}` };
    const secondHeaders = { authorization: `Bearer ${secondSession.token}` };
    const [firstRows, secondRows] = await Promise.all([
      app.inject({ method: 'GET', url: '/medicines', headers: firstHeaders }),
      app.inject({ method: 'GET', url: '/medicines', headers: secondHeaders }),
    ]);
    expect(firstRows.json()).toEqual([{ ownerId: firstSession.user.id }]);
    expect(secondRows.json()).toEqual([{ ownerId: secondSession.user.id }]);

    const me = await app.inject({ method: 'GET', url: '/users/me', headers: firstHeaders });
    expect(me.json()).toMatchObject({ account: 'alice_01', nickname: '小艾' });
    expect(me.json()).not.toHaveProperty('password_hash');

    const logout = await app.inject({ method: 'POST', url: '/auth/logout', headers: firstHeaders });
    expect(logout.statusCode).toBe(204);
    expect((await app.inject({ method: 'GET', url: '/users/me', headers: firstHeaders })).statusCode).toBe(401);
    expect((await app.inject({ method: 'GET', url: '/users/me', headers: secondHeaders })).statusCode).toBe(200);
  });
});
