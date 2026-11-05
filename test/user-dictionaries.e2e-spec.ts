import { randomUUID } from 'node:crypto';

import {
  FastifyAdapter,
  type NestFastifyApplication,
} from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';

import { AppModule } from '../src/app.module.js';
import { PrismaService } from '../src/database/prisma/prisma.service.js';
import { AuthGuard } from '../src/modules/auth/auth.guard.js';
import { DEFAULT_USER_DICTIONARY } from '../src/modules/auth/default-user-dictionary.js';
import { UserContextService } from '../src/modules/auth/user-context.service.js';

const USER_ID = '00000000-0000-4000-8000-000000000001';
const OTHER_USER_ID = '99999999-9999-4999-8999-999999999999';

type DictionaryRow = {
  id: string;
  user_id: string;
  categories: string[];
  efficacies: string[];
  symptoms: string[];
  created_at: Date;
  updated_at: Date;
};

function createPrismaFake() {
  const rows = new Map<string, DictionaryRow>();

  return {
    rows,
    seed(userId = USER_ID, overrides: Partial<DictionaryRow> = {}) {
      const now = new Date();
      const row: DictionaryRow = {
        id: randomUUID(),
        user_id: userId,
        categories: [...DEFAULT_USER_DICTIONARY.categories],
        efficacies: [...DEFAULT_USER_DICTIONARY.efficacies],
        symptoms: [...DEFAULT_USER_DICTIONARY.symptoms],
        created_at: now,
        updated_at: now,
        ...overrides,
      };
      rows.set(userId, row);
      return row;
    },
    user_dictionaries: {
      findUnique: vi.fn(
        async ({
          where,
          select,
        }: {
          where: { user_id: string };
          select?: Record<string, boolean>;
        }) => {
          const row = rows.get(where.user_id);
          if (!row) return null;
          if (!select) return row;
          const picked: Record<string, unknown> = {};
          for (const [key, enabled] of Object.entries(select)) {
            if (enabled) picked[key] = row[key as keyof DictionaryRow];
          }
          return picked;
        },
      ),
      update: vi.fn(
        async ({
          where,
          data,
          select,
        }: {
          where: { user_id: string };
          data: Partial<DictionaryRow>;
          select?: Record<string, boolean>;
        }) => {
          const row = rows.get(where.user_id);
          if (!row) throw new Error('missing dictionary');
          Object.assign(row, data, { updated_at: new Date() });
          if (!select) return row;
          const picked: Record<string, unknown> = {};
          for (const [key, enabled] of Object.entries(select)) {
            if (enabled) picked[key] = row[key as keyof DictionaryRow];
          }
          return picked;
        },
      ),
    },
  };
}

describe('UserDictionaries API (e2e)', () => {
  let app: NestFastifyApplication;
  let prisma: ReturnType<typeof createPrismaFake>;

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
      .useValue({
        run: (next: () => void) => next(),
        getUserId: () => USER_ID,
      })
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

  it('可查询全部与单个属性，并完成标签增删改', async () => {
    prisma.seed();

    const all = await app.inject({ method: 'GET', url: '/user-dictionaries' });
    expect(all.statusCode).toBe(200);
    expect(all.json()).toMatchObject({
      categories: [...DEFAULT_USER_DICTIONARY.categories],
      efficacies: [...DEFAULT_USER_DICTIONARY.efficacies],
      symptoms: [...DEFAULT_USER_DICTIONARY.symptoms],
    });

    const field = await app.inject({
      method: 'GET',
      url: '/user-dictionaries/categories',
    });
    expect(field.statusCode).toBe(200);
    expect(field.json()).toEqual({
      categories: [...DEFAULT_USER_DICTIONARY.categories],
    });

    const added = await app.inject({
      method: 'POST',
      url: '/user-dictionaries/categories',
      payload: { values: [' 儿童用药 ', '儿童用药', '家庭常备'] },
    });
    expect(added.statusCode).toBe(201);
    expect(added.json().categories).toEqual([
      ...DEFAULT_USER_DICTIONARY.categories,
      '儿童用药',
      '家庭常备',
    ]);

    const removed = await app.inject({
      method: 'DELETE',
      url: '/user-dictionaries/categories',
      payload: { values: ['家庭常备', '不存在的标签'] },
    });
    expect(removed.statusCode).toBe(200);
    expect(removed.json().categories).toEqual([
      ...DEFAULT_USER_DICTIONARY.categories,
      '儿童用药',
    ]);

    const renamed = await app.inject({
      method: 'PATCH',
      url: '/user-dictionaries/efficacies',
      payload: { from: ' 退烧 ', to: ' 退热 ' },
    });
    expect(renamed.statusCode).toBe(200);
    expect(renamed.json().efficacies).toContain('退热');
    expect(renamed.json().efficacies).not.toContain('退烧');
  });

  it('非法字段与缺失字典返回错误，重命名冲突返回 409', async () => {
    const missing = await app.inject({ method: 'GET', url: '/user-dictionaries' });
    expect(missing.statusCode).toBe(404);
    expect(missing.json().message).toBe('用户字典不存在');

    prisma.seed();
    prisma.seed(OTHER_USER_ID, {
      categories: ['别人的分类'],
      efficacies: [],
      symptoms: [],
    });

    const badField = await app.inject({
      method: 'GET',
      url: '/user-dictionaries/unknown',
    });
    expect(badField.statusCode).toBe(400);
    expect(badField.json().message).toBe('字典字段不正确');

    const renameMissing = await app.inject({
      method: 'PATCH',
      url: '/user-dictionaries/symptoms',
      payload: { from: '不存在', to: '新症状' },
    });
    expect(renameMissing.statusCode).toBe(404);
    expect(renameMissing.json().message).toBe('标签不存在');

    const renameConflict = await app.inject({
      method: 'PATCH',
      url: '/user-dictionaries/symptoms',
      payload: { from: '发热咳嗽', to: '其他' },
    });
    expect(renameConflict.statusCode).toBe(409);
    expect(renameConflict.json().message).toBe('目标标签已存在');

    const sameName = await app.inject({
      method: 'PATCH',
      url: '/user-dictionaries/symptoms',
      payload: { from: '其他', to: '其他' },
    });
    expect(sameName.statusCode).toBe(400);
    expect(sameName.json().message).toBe('新旧标签不能相同');
  });
});
