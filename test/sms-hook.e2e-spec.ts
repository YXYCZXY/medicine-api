import { Test } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import {
  FastifyAdapter,
  type NestFastifyApplication,
} from '@nestjs/platform-fastify';
import { createHmac } from 'node:crypto';
import { AppModule } from '../src/app.module.js';
import { PrismaService } from '../src/database/prisma/prisma.service.js';
import { SMS_FETCH } from '../src/modules/sms-hook/aliyun-sms.sender.js';

describe('public signed SMS hook with existing API guards', () => {
  let app: NestFastifyApplication;
  const fetcher = vi.fn<typeof fetch>();
  const key = Buffer.alloc(32, 8);
  const path = '/hooks/supabase/send-sms';
  const payload =
    '{ "user": {"phone":"8615655095090"}, "sms":{"otp":"654321"} }';
  let sequence = 0;
  function signed(raw = payload) {
    const id = `msg_e2e_${sequence++}`;
    const timestamp = String(Math.floor(Date.now() / 1000));
    return {
      'content-type': 'application/json',
      'webhook-id': id,
      'webhook-timestamp': timestamp,
      'webhook-signature': `v1,${createHmac('sha256', key).update(`${id}.${timestamp}.${raw}`).digest('base64')}`,
    };
  }
  beforeAll(async () => {
    const module = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(PrismaService)
      .useValue({ $queryRaw: vi.fn().mockResolvedValue([{ ok: 1 }]) })
      .overrideProvider(SMS_FETCH)
      .useValue(fetcher)
      .compile();
    const config = module.get(ConfigService);
    for (const [name, value] of Object.entries({
      SMS_HOOK_ENABLED: 'true',
      SEND_SMS_HOOK_SECRET: `v1,whsec_${key.toString('base64')}`,
      ALIYUN_ACCESS_KEY_ID: 'test-id',
      ALIYUN_ACCESS_KEY_SECRET: 'test-secret',
      ALIYUN_SMS_SIGN_NAME: '测试签名',
      ALIYUN_SMS_TEMPLATE_CODE: '100001',
    }))
      config.set(name, value);
    app = module.createNestApplication<NestFastifyApplication>(
      new FastifyAdapter(),
      { rawBody: true, logger: false },
    );
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
  });
  beforeEach(() => {
    fetcher
      .mockReset()
      .mockResolvedValue(
        Response.json({ Code: 'OK', Success: true, RequestId: 'e2e-request' }),
      );
  });
  afterAll(async () => {
    await app.close();
  });

  it('verifies original request bytes and returns 200 instead of the POST default 201', async () => {
    const response = await app.inject({
      method: 'POST',
      url: path,
      headers: signed(),
      payload,
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({});
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it('rejects unsigned requests even with a bearer header, with the hook envelope', async () => {
    const response = await app.inject({
      method: 'POST',
      url: path,
      headers: {
        'content-type': 'application/json',
        authorization: 'Bearer unrelated',
      },
      payload,
    });
    expect(response.statusCode).toBe(401);
    expect(response.json()).toEqual({
      error: { http_code: 401, message: 'Invalid signature' },
    });
    expect(fetcher).not.toHaveBeenCalled();
  });
  it('rejects changed request content before sending', async () => {
    const response = await app.inject({
      method: 'POST',
      url: path,
      headers: signed(),
      payload: payload.replace('654321', '123456'),
    });
    expect(response.statusCode).toBe(401);
    expect(fetcher).not.toHaveBeenCalled();
  });
  it('returns the hook error envelope without the business exception filter rewriting it', async () => {
    fetcher.mockResolvedValueOnce(
      Response.json({
        Code: 'InvalidAccessKeyId.NotFound',
        Message: 'secret 654321',
      }),
    );
    const response = await app.inject({
      method: 'POST',
      url: path,
      headers: signed(),
      payload,
    });
    expect(response.statusCode).toBe(502);
    expect(response.json()).toEqual({
      error: { http_code: 502, message: 'SMS delivery failed' },
    });
    expect(response.body).not.toContain('654321');
  });
  it('keeps health public and business routes protected', async () => {
    expect(
      (await app.inject({ method: 'GET', url: '/health' })).statusCode,
    ).toBe(200);
    expect(
      (await app.inject({ method: 'GET', url: '/users/me' })).statusCode,
    ).toBe(401);
  });
  it('can keep the existing API healthy while SMS is disabled', async () => {
    app.get(ConfigService).set('SMS_HOOK_ENABLED', 'false');
    try {
      const response = await app.inject({
        method: 'POST',
        url: path,
        headers: signed(),
        payload,
      });
      expect(response.statusCode).toBe(503);
      expect(fetcher).not.toHaveBeenCalled();
      expect(
        (await app.inject({ method: 'GET', url: '/health' })).statusCode,
      ).toBe(200);
    } finally {
      app.get(ConfigService).set('SMS_HOOK_ENABLED', 'true');
    }
  });
});
