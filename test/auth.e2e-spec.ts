import { randomUUID } from 'node:crypto';
import { ForbiddenException } from '@nestjs/common';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import { SignJWT } from 'jose';
import { AppModule } from '../src/app.module.js';
import { PrismaService } from '../src/database/prisma/prisma.service.js';
import { UserContextService } from '../src/modules/auth/user-context.service.js';
import { MedicinesService } from '../src/modules/medicines/medicines.service.js';
import { SUPABASE_JWKS, SupabaseIdentityService } from '../src/modules/auth/supabase-auth.js';
import { createAuthFixture } from './supabase-fixture.js';

type User = { id: string; phone: string; nickname: string; status: string; avatar_url: null };
function fakeDatabase() {
  const users = new Map<string, User>();
  const dictionaries = new Map<string, { id: string; user_id: string; categories: string[]; efficacies: string[]; symptoms: string[] }>();
  let tail: Promise<unknown> = Promise.resolve();
  const fake = {
    users: {
      findUnique: vi.fn(async ({ where, include }: { where: { id: string }; include?: unknown }) => {
        const user = users.get(where.id);
        return user ? { ...user, ...(include ? { dictionary: dictionaries.get(user.id) } : {}) } : null;
      }),
      findUniqueOrThrow: vi.fn(async ({ where }: { where: { id: string } }) => users.get(where.id)!),
      create: vi.fn(async ({ data }: { data: User }) => {
        const user = { ...data, status: 'active', avatar_url: null };
        users.set(user.id, user); return user;
      }),
      update: vi.fn(async ({ where, data }: { where: { id: string }; data: Partial<User> }) => {
        const user = users.get(where.id)!; Object.assign(user, data); return user;
      }),
    },
    user_dictionaries: {
      upsert: vi.fn(async ({ where, create }: { where: { user_id: string }; create: Omit<ReturnType<typeof dictionaries.get> & object, 'id'> }) => {
        if (!dictionaries.has(where.user_id)) dictionaries.set(where.user_id, { ...create, id: randomUUID() } as NonNullable<ReturnType<typeof dictionaries.get>>);
        return dictionaries.get(where.user_id);
      }),
    },
    $queryRaw: vi.fn().mockResolvedValue([]),
  };
  return { ...fake, rows: users, dictionaries,
    $transaction: (work: (tx: typeof fake) => Promise<unknown>) => {
      const result = tail.then(async () => {
        const snapshot = new Map(users);
        const dicts = new Map(dictionaries);
        try { return await work(fake); }
        catch (error) {
          users.clear(); snapshot.forEach((v,k) => users.set(k,v));
          dictionaries.clear(); dicts.forEach((v,k) => dictionaries.set(k,v));
          throw error;
        }
      });
      tail = result.catch(() => undefined); return result;
    },
  };
}

describe('Supabase JWT and business bootstrap', () => {
  let app: NestFastifyApplication;
  let fixture: Awaited<ReturnType<typeof createAuthFixture>>;
  let db: ReturnType<typeof fakeDatabase>;
  beforeEach(async () => {
    fixture = await createAuthFixture(); db = fakeDatabase();
    let context: UserContextService;
    const module = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(PrismaService).useValue(db)
      .overrideProvider(SUPABASE_JWKS).useValue(fixture.jwks)
      .overrideProvider(SupabaseIdentityService).useValue(fixture.identities)
      .overrideProvider(MedicinesService).useValue({ findAll: async () => {
        await new Promise(resolve => setTimeout(resolve, 2)); return [{ ownerId: context.getUserId() }];
      } }).compile();
    app = module.createNestApplication<NestFastifyApplication>(new FastifyAdapter());
    context = app.get(UserContextService); await app.init(); await app.getHttpAdapter().getInstance().ready();
  });
  afterEach(async () => { await app.close(); });
  const headers = (token: string) => ({ authorization: `Bearer ${token}` });
  const me = (token: string) => app.inject({ method: 'GET', url: '/users/me', headers: headers(token) });

  it('requires JWT; former custom auth endpoints no longer exist', async () => {
    expect((await app.inject({ method: 'GET', url: '/users/me' })).statusCode).toBe(401);
    const token = await fixture.issue();
    for (const action of ['login','register','logout']) expect((await app.inject({ method: 'POST', url: `/auth/${action}`, headers: headers(token), payload: {} })).statusCode).toBe(404);
  });
  it('concurrent bootstrap is idempotent and user/dictionary defaults are never reset', async () => {
    const token = await fixture.issue();
    const responses = await Promise.all(Array.from({ length: 5 }, () => me(token)));
    expect(responses.map(r => r.statusCode)).toEqual([200,200,200,200,200]);
    const user = responses[0].json<User>();
    expect(db.rows.size).toBe(1); expect(db.dictionaries.size).toBe(1);
    expect(user).not.toHaveProperty('password_hash'); expect(user).not.toHaveProperty('account');
    db.dictionaries.get(user.id)!.categories = [];
    db.rows.get(user.id)!.nickname = '自定义';
    expect((await me(token)).json()).toMatchObject({ nickname: '自定义' });
    expect(db.dictionaries.get(user.id)!.categories).toEqual([]);
    db.dictionaries.delete(user.id);
    await me(token); expect(db.dictionaries.size).toBe(1);
  });
  it('bootstraps before direct business access, keeping concurrent identities isolated', async () => {
    const a = await fixture.issue(), b = await fixture.issue();
    const rows = await Promise.all([a,b].map(token => app.inject({ method: 'GET', url: '/medicines', headers: headers(token) })));
    expect(rows[0].statusCode).toBe(200); expect(rows[1].statusCode).toBe(200);
    expect(rows[0].json()[0].ownerId).not.toBe(rows[1].json()[0].ownerId);
    expect(db.rows.size).toBe(2); expect(db.dictionaries.size).toBe(2);
  });
  it('dictionary failure rolls back the user, then retry succeeds', async () => {
    const token = await fixture.issue();
    db.user_dictionaries.upsert.mockRejectedValueOnce(new Error('database unavailable'));
    expect((await me(token)).statusCode).toBe(500); expect(db.rows.size).toBe(0);
    expect((await me(token)).statusCode).toBe(200);
  });
  it.each(['password','otp'])('rejects an unverified phone with %s without creating records', async method => {
    fixture.identities.getVerifiedUser.mockRejectedValueOnce(new ForbiddenException({ code: 'PHONE_UNVERIFIED', message: '未验证' }));
    const token = await fixture.issue(undefined, { amr: [{method}] });
    expect((await me(token)).statusCode).toBe(403); expect(db.rows.size).toBe(0);
  });
  it.each([
    { role: 'service_role' }, { is_anonymous: true }, { session_id: 'invalid' }, { sub: 'invalid' },
  ])('rejects invalid identity claims %j', async (claims) => {
    const token = await fixture.issue(typeof claims.sub === 'string' ? claims.sub : randomUUID(), claims);
    expect((await me(token)).statusCode).toBe(401); expect(db.rows.size).toBe(0);
  });
  it.each([[{method:'recovery'}], [], ['token_refresh'], [{method:'oauth'}]].map(amr=>({amr})))('rejects a session without password or OTP AMR $amr', async ({amr}) => {
    const response = await me(await fixture.issue(undefined, { amr }));
    expect(response.statusCode).toBe(403);
    expect(response.json()).toMatchObject({ code: 'AUTH_METHOD_UNSUPPORTED' });
    expect(db.rows.size).toBe(0);
  });
  it.each(['password','otp'])('accepts a refreshed session retaining %s AMR', async method => {
    expect((await me(await fixture.issue(undefined, { amr: [{method}, {method:'token_refresh'}] }))).statusCode).toBe(200);
  });
  it('OTP and password sessions use the same business account and data scope', async () => {
    const userId = randomUUID();
    const phone = '+8613800000001';
    const password = await fixture.issue(userId, {phone});
    const otp = await fixture.issue(userId, { phone, amr: [{method:'otp'}] });
    const first = (await me(password)).json<User>();
    db.rows.get(first.id)!.nickname = '已存在的昵称';
    expect((await me(otp)).json()).toMatchObject({ id: userId, nickname: '已存在的昵称' });
    const response = await app.inject({method:'GET',url:'/medicines',headers:headers(otp)});
    expect(response.statusCode).toBe(200);expect(response.json()[0].ownerId).toBe(userId);
    expect(db.rows.size).toBe(1);expect(db.dictionaries.size).toBe(1);
  });
  it('rejects altered signatures, wrong issuer/audience, expiry, and algorithms', async () => {
    const jwt = (issuer: string, audience: string, expires: string) => new SignJWT({role:'authenticated',is_anonymous:false,phone:'+8613800000000',session_id:randomUUID(),amr:['password']})
      .setSubject(randomUUID()).setProtectedHeader({alg:'ES256',kid:'fixture-key'}).setIssuer(issuer).setAudience(audience).setIssuedAt().setExpirationTime(expires).sign(fixture.pair.privateKey);
    for (const token of [
      await jwt('https://other.test/auth/v1','authenticated','15m'),
      await jwt('https://auth.example.test/auth/v1','anon','15m'),
      await jwt('https://auth.example.test/auth/v1','authenticated','-1m'),
      'not-a-jwt',
      await new SignJWT({}).setProtectedHeader({alg:'HS256'}).sign(new Uint8Array(32)),
    ]) expect((await me(token)).statusCode).toBe(401);
    const valid = await fixture.issue();
    const parts = valid.split('.'); parts[2] = (parts[2][0] === 'A' ? 'B' : 'A') + parts[2].slice(1);
    expect((await me(parts.join('.'))).statusCode).toBe(401);
  });
  it('updates only nickname, rejects identity edits, and blocks disabled users', async () => {
    const token = await fixture.issue(); const user = (await me(token)).json<User>();
    const update = await app.inject({ method:'PATCH',url:'/users/me',headers:headers(token),payload:{nickname:' 新昵称 '} });
    expect(update.statusCode).toBe(200); expect(update.json().nickname).toBe('新昵称');
    expect((await app.inject({method:'PATCH',url:'/users/me',headers:headers(token),payload:{nickname:'ok',phone:'+8613900000000'}})).statusCode).toBe(400);
    db.rows.get(user.id)!.status = 'disabled';
    expect((await me(token)).json()).toMatchObject({statusCode:403,code:'ACCOUNT_DISABLED'});
    const otp = await fixture.issue(user.id,{phone:user.phone,amr:[{method:'otp'}]});
    expect((await me(otp)).json()).toMatchObject({statusCode:403,code:'ACCOUNT_DISABLED'});
  });
});
