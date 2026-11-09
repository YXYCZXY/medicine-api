import { Test } from '@nestjs/testing';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { AppModule } from '../src/app.module.js';
import { PrismaService } from '../src/database/prisma/prisma.service.js';

describe('deployment readiness', () => {
  let app: NestFastifyApplication;
  const query = vi.fn();

  beforeAll(async () => {
    const module = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(PrismaService).useValue({ $queryRaw: query }).compile();
    app = module.createNestApplication<NestFastifyApplication>(new FastifyAdapter());
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
  });
  afterAll(async () => { await app.close(); });

  it('allows unauthenticated database readiness without bootstrapping a user', async () => {
    query.mockResolvedValueOnce([{ '?column?': 1 }]);
    const response = await app.inject({ method: 'GET', url: '/health' });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ status: 'ok' });
  });

  it('returns 503 without leaking database connection details', async () => {
    query.mockRejectedValueOnce(new Error('postgresql://secret@internal-db:5432/medicine'));
    const response = await app.inject({ method: 'GET', url: '/health' });
    expect(response.statusCode).toBe(503);
    expect(response.json()).toMatchObject({ status: 'unavailable' });
    expect(response.body).not.toContain('secret');
    expect(response.body).not.toContain('internal-db');
    expect((await app.inject({ method: 'GET', url: '/users/me' })).statusCode).toBe(401);
  });
});
