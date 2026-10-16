import {
  FastifyAdapter,
  type NestFastifyApplication,
} from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';

import { AppModule } from '../src/app.module.js';
import { PrismaService } from '../src/database/prisma/prisma.service.js';
import { Prisma } from '../src/generated/prisma/client.js';

const USER_ID = '00000000-0000-4000-8000-000000000001';
const CATEGORY_ID = '55555555-5555-4555-8555-555555555555';
const VISIT_ID = '33333333-3333-4333-8333-333333333333';
const LINE_ID = '66666666-6666-4666-8666-666666666666';

type VisitRow = Record<string, unknown> & {
  id: string;
  user_id: string;
  version: number;
  visit_date: Date;
  initial_visit_id: string | null;
  photo_keys: string[];
  symptom_tags: string[];
};

type MedRow = Record<string, unknown> & {
  id: string;
  visit_id: string;
  medicine_id: string | null;
  sort_order: number;
};

type ItemRow = Record<string, unknown> & {
  id: string;
  user_id: string;
};

/**
 * 内存版 Prisma，覆盖就诊 e2e 用到的读写
 */
function createPrismaFake() {
  const visits = new Map<string, VisitRow>();
  const meds = new Map<string, MedRow>();
  const items = new Map<string, ItemRow>();

  const withMedicines = (row: VisitRow) => ({
    ...row,
    visit_medicines: [...meds.values()]
      .filter((med) => med.visit_id === row.id)
      .sort((a, b) => a.sort_order - b.sort_order)
      .map((med) => ({
        ...med,
        dose_per_time:
          med.dose_per_time === null || med.dose_per_time === undefined
            ? null
            : new Prisma.Decimal(med.dose_per_time as number),
        medicine_items: med.medicine_id
          ? (items.get(med.medicine_id) ?? null)
          : null,
      })),
  });

  const tx = {
    $queryRaw: vi.fn(async () => []),
    visit_records: {
      create: vi.fn(async ({ data }: { data: VisitRow }) => {
        if (visits.has(data.id)) {
          throw new Prisma.PrismaClientKnownRequestError('Unique', {
            code: 'P2002',
            clientVersion: '7.0.0',
            meta: { target: ['visit_records_pkey'] },
          });
        }
        const now = new Date();
        const row: VisitRow = {
          ...data,
          created_at: now,
          updated_at: now,
          photo_keys: data.photo_keys ?? [],
          symptom_tags: data.symptom_tags ?? [],
        };
        visits.set(row.id, row);
        return row;
      }),
      findFirst: vi.fn(
        async ({
          where,
        }: {
          where: { id: string; user_id?: string };
        }) => {
          const row = visits.get(where.id);
          if (!row) return null;
          if (where.user_id && row.user_id !== where.user_id) return null;
          return withMedicines(row);
        },
      ),
      findMany: vi.fn(async () => []),
      update: vi.fn(
        async ({
          where,
          data,
        }: {
          where: { id: string };
          data: Record<string, unknown>;
        }) => {
          const row = visits.get(where.id)!;
          Object.assign(row, data, { updated_at: new Date() });
          return row;
        },
      ),
      updateMany: vi.fn(
        async ({
          where,
          data,
        }: {
          where: { id: string; user_id: string; version: number };
          data: Record<string, unknown>;
        }) => {
          const row = visits.get(where.id);
          if (
            !row ||
            row.user_id !== where.user_id ||
            row.version !== where.version
          ) {
            return { count: 0 };
          }
          const next = { ...data };
          if (
            next.version &&
            typeof next.version === 'object' &&
            'increment' in (next.version as object)
          ) {
            row.version += (next.version as { increment: number }).increment;
            delete next.version;
          }
          Object.assign(row, next, { updated_at: new Date() });
          return { count: 1 };
        },
      ),
      deleteMany: vi.fn(
        async ({
          where,
        }: {
          where: { id: string; user_id: string; version: number };
        }) => {
          const row = visits.get(where.id);
          if (
            !row ||
            row.user_id !== where.user_id ||
            row.version !== where.version
          ) {
            return { count: 0 };
          }
          for (const [id, med] of meds.entries()) {
            if (med.visit_id === where.id) meds.delete(id);
          }
          visits.delete(where.id);
          return { count: 1 };
        },
      ),
    },
    visit_medicines: {
      findMany: vi.fn(
        async ({
          where,
        }: {
          where: {
            visit_id?: string | { not: string };
            id?: { in: string[] };
          };
        }) => {
          return [...meds.values()].filter((med) => {
            if (typeof where.visit_id === 'string' && med.visit_id !== where.visit_id) {
              return false;
            }
            if (where.id && 'in' in where.id && !where.id.in.includes(med.id)) {
              return false;
            }
            if (
              where.visit_id &&
              typeof where.visit_id === 'object' &&
              'not' in where.visit_id &&
              med.visit_id === where.visit_id.not
            ) {
              return false;
            }
            return true;
          });
        },
      ),
      findFirst: vi.fn(async () => null),
      createMany: vi.fn(
        async ({ data }: { data: MedRow[] }) => {
          for (const item of data) {
            meds.set(item.id, {
              ...item,
              medication_timings: item.medication_timings ?? [],
            });
          }
          return { count: data.length };
        },
      ),
      create: vi.fn(async ({ data }: { data: MedRow }) => {
        meds.set(data.id, {
          ...data,
          medication_timings: data.medication_timings ?? [],
        });
        return data;
      }),
      update: vi.fn(
        async ({
          where,
          data,
        }: {
          where: { id: string };
          data: Record<string, unknown>;
        }) => {
          const row = meds.get(where.id)!;
          Object.assign(row, data);
          return row;
        },
      ),
      deleteMany: vi.fn(
        async ({ where }: { where: { id?: { in: string[] }; visit_id?: string } }) => {
          let count = 0;
          for (const [id, med] of meds.entries()) {
            if (where.visit_id && med.visit_id !== where.visit_id) continue;
            if (where.id?.in && !where.id.in.includes(id)) continue;
            meds.delete(id);
            count += 1;
          }
          return { count };
        },
      ),
    },
    medicine_items: {
      findMany: vi.fn(
        async ({ where }: { where: { id?: { in: string[] }; user_id?: string } }) =>
          [...items.values()].filter((item) => {
            if (where.user_id && item.user_id !== where.user_id) return false;
            if (where.id?.in && !where.id.in.includes(item.id)) return false;
            return true;
          }),
      ),
      create: vi.fn(async ({ data }: { data: ItemRow }) => {
        const id = data.id ?? crypto.randomUUID();
        const row = { ...data, id };
        items.set(id, row);
        return { id };
      }),
    },
    medicine_categories: {
      findUnique: vi.fn(async ({ where }: { where: { id: string } }) =>
        where.id === CATEGORY_ID ? { id: CATEGORY_ID } : null,
      ),
    },
  };

  return {
    visits,
    meds,
    items,
    $queryRaw: vi.fn(async (query: TemplateStringsArray) => {
      const sql = String(query);
      if (sql.includes('COUNT')) {
        return [{ total: BigInt(visits.size) }];
      }
      return [...visits.values()]
        .filter((row) => row.user_id === USER_ID)
        .sort((a, b) => {
          const dateDiff = b.visit_date.getTime() - a.visit_date.getTime();
          if (dateDiff !== 0) return dateDiff;
          return b.id.localeCompare(a.id);
        })
        .map((row) => ({ id: row.id }));
    }),
    $transaction: vi.fn(async (callback: (client: typeof tx) => unknown) =>
      callback(tx),
    ),
    visit_records: {
      findFirst: tx.visit_records.findFirst,
      findMany: vi.fn(async ({ where }: { where: { id: { in: string[] } } }) =>
        where.id.in
          .map((id) => visits.get(id))
          .filter((row): row is VisitRow => !!row)
          .map(withMedicines),
      ),
    },
    ...tx,
  };
}

describe('Visits API (e2e)', () => {
  let app: NestFastifyApplication;
  let prisma: ReturnType<typeof createPrismaFake>;

  const validPayload = {
    id: VISIT_ID,
    visitDate: '2026-10-15',
    initialVisitId: null,
    hospitalName: '市第一人民医院',
    department: '呼吸内科',
    doctorName: '刘主任',
    symptomTags: ['咳嗽'],
    symptomNote: '干咳两天',
    diagnosis: '上呼吸道感染',
    prescription: '以原处方单为准',
    advice: '按医生要求复查',
    medicines: [],
  };

  beforeEach(async () => {
    prisma = createPrismaFake();

    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    })
      .overrideProvider(PrismaService)
      .useValue(prisma)
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

  it('POST /visits 创建初诊返回 201 与 VisitDetail', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/visits',
      payload: validPayload,
    });

    expect(response.statusCode).toBe(201);
    const body = response.json();
    expect(body.id).toBe(VISIT_ID);
    expect(body.version).toBe(1);
    expect(body.photos).toEqual([]);
    expect(body.initialVisitId).toBeNull();
    expect(body.symptomTags).toEqual(['咳嗽']);
  });

  it('请求带 photoKeys 返回 400', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/visits',
      payload: { ...validPayload, photoKeys: [] },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json().message).toContain('photoKeys');
  });

  it('非法 UUID 路径返回 400', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/visits/not-a-uuid',
    });

    expect(response.statusCode).toBe(400);
  });

  it('未来就诊日期返回 400', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/visits',
      payload: { ...validPayload, visitDate: '2099-01-01' },
    });

    expect(response.statusCode).toBe(400);
  });

  it('initialOnly 与 initialVisitId 互斥返回 400', async () => {
    const response = await app.inject({
      method: 'GET',
      url: `/visits?initialOnly=true&initialVisitId=${VISIT_ID}`,
    });

    expect(response.statusCode).toBe(400);
  });

  it('PATCH 传 null medicines 返回 400', async () => {
    await app.inject({
      method: 'POST',
      url: '/visits',
      payload: validPayload,
    });

    const response = await app.inject({
      method: 'PATCH',
      url: `/visits/${VISIT_ID}`,
      payload: { expectedVersion: 1, medicines: null },
    });

    expect(response.statusCode).toBe(400);
  });

  it('PATCH 只有 expectedVersion 返回 400', async () => {
    await app.inject({
      method: 'POST',
      url: '/visits',
      payload: validPayload,
    });

    const response = await app.inject({
      method: 'PATCH',
      url: `/visits/${VISIT_ID}`,
      payload: { expectedVersion: 1 },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json().message).toBe('没有需要修改的内容');
  });

  it('DELETE 缺 expectedVersion 返回 400', async () => {
    const response = await app.inject({
      method: 'DELETE',
      url: `/visits/${VISIT_ID}`,
    });

    expect(response.statusCode).toBe(400);
  });

  it('DELETE 成功返回 204，重复删除返回 404', async () => {
    await app.inject({
      method: 'POST',
      url: '/visits',
      payload: validPayload,
    });

    const deleted = await app.inject({
      method: 'DELETE',
      url: `/visits/${VISIT_ID}?expectedVersion=1`,
    });
    expect(deleted.statusCode).toBe(204);

    const again = await app.inject({
      method: 'DELETE',
      url: `/visits/${VISIT_ID}?expectedVersion=1`,
    });
    expect(again.statusCode).toBe(404);
  });

  it('GET /visits/:id 不存在返回 404', async () => {
    const response = await app.inject({
      method: 'GET',
      url: `/visits/${VISIT_ID}`,
    });

    expect(response.statusCode).toBe(404);
  });

  it('同 ID 重复 POST 返回 409', async () => {
    await app.inject({
      method: 'POST',
      url: '/visits',
      payload: validPayload,
    });

    const response = await app.inject({
      method: 'POST',
      url: '/visits',
      payload: validPayload,
    });

    expect(response.statusCode).toBe(409);
  });

  it('用药入箱路径可创建药箱记录', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/visits',
      payload: {
        ...validPayload,
        medicines: [
          {
            id: LINE_ID,
            medicineId: null,
            name: '新开的药',
            unit: '支',
            dosePerTime: 1,
            timesPerDay: 3,
            medicationTimings: [],
            cabinet: {
              categoryId: CATEGORY_ID,
              quantity: 12,
              expirationDate: '2027-08-01',
              efficacyTags: ['止咳'],
              locationId: 'living',
              note: '本次门诊购入',
            },
          },
        ],
      },
    });

    expect(response.statusCode).toBe(201);
    expect(prisma.items.size).toBe(1);
    expect(response.json().medicines[0].medicineId).toBeTruthy();
  });
});
