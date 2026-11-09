import { ConfigService } from '@nestjs/config';
import { Logger } from '@nestjs/common';
import { createHmac } from 'node:crypto';
import {
  SmsHookError,
  SmsHookService,
  SMS_CACHE_TTL_MS,
  SMS_CACHE_LIMIT,
} from './sms-hook.service.js';
import { AliyunSmsSender, SmsDeliveryError } from './aliyun-sms.sender.js';
import { smsConfigErrors } from '../../config/sms-hook.config.js';

vi.mock('node:crypto', async (importOriginal) => ({
  ...(await importOriginal<typeof import('node:crypto')>()),
  randomUUID: () => '00000000-0000-4000-8000-000000000001',
}));

const key = Buffer.alloc(32, 7);
const secret = `v1,whsec_${key.toString('base64')}`;
const settings = {
  SMS_HOOK_ENABLED: 'true',
  SEND_SMS_HOOK_SECRET: secret,
  ALIYUN_ACCESS_KEY_ID: 'test-access-id',
  ALIYUN_ACCESS_KEY_SECRET: 'test-access-secret',
  ALIYUN_SMS_SIGN_NAME: '测试签名',
  ALIYUN_SMS_TEMPLATE_CODE: '100001',
};
const body = JSON.stringify({
  user: { phone: '8615655095090' },
  sms: { otp: '654321' },
});
function headers(payload = body, id = 'msg_test', date = Date.now()) {
  const timestamp = String(Math.floor(date / 1000));
  return {
    'webhook-id': id,
    'webhook-timestamp': timestamp,
    'webhook-signature': `v1,${createHmac('sha256', key).update(`${id}.${timestamp}.${payload}`).digest('base64')}`,
  };
}

describe('SMS hook verification and duplicate delivery', () => {
  const send = vi.fn();
  let service: SmsHookService;
  let log: ReturnType<typeof vi.spyOn>;
  let warn: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    send.mockReset().mockResolvedValue('request-id');
    service = new SmsHookService(new ConfigService(settings), {
      send,
    } as unknown as AliyunSmsSender);
    log = vi.spyOn(Logger.prototype, 'log').mockImplementation(() => {});
    warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => {});
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it('sends the exact Supabase OTP after verifying the original whitespace and UTF8 bytes', async () => {
    const raw =
      ' { "user": {"phone": "+8615655095090", "nickname": "中文"}, "sms": {"otp":"654321"} } ';
    await service.handle(Buffer.from(raw), headers(raw));
    expect(send).toHaveBeenCalledExactlyOnceWith('+8615655095090', '654321');
  });
  it.each([
    'missing',
    'tampered',
    'expired',
    'future',
    'wrong-secret',
    'array',
  ])('rejects %s signatures without sending', async (kind) => {
    const h: Record<string, string | string[]> = headers();
    let raw = body;
    if (kind === 'missing') delete h['webhook-signature'];
    if (kind === 'tampered') raw += ' ';
    if (kind === 'expired')
      Object.assign(h, headers(body, 'msg_test', Date.now() - 301_000));
    if (kind === 'future')
      Object.assign(h, headers(body, 'msg_test', Date.now() + 301_000));
    if (kind === 'wrong-secret')
      h['webhook-signature'] = 'v1,' + Buffer.alloc(32).toString('base64');
    if (kind === 'array')
      h['webhook-signature'] = [String(h['webhook-signature'])];
    await expect(service.handle(Buffer.from(raw), h)).rejects.toMatchObject({
      status: 401,
    });
    expect(send).not.toHaveBeenCalled();
  });
  it.each([
    null,
    {},
    { user: { phone: '+12025550123' }, sms: { otp: '654321' } },
    { user: { phone: '8615655095090' }, sms: { otp: 654321 } },
  ])('rejects invalid signed payload %j', async (payload) => {
    const raw = JSON.stringify(payload);
    await expect(
      service.handle(Buffer.from(raw), headers(raw)),
    ).rejects.toMatchObject({ status: 400 });
    expect(send).not.toHaveBeenCalled();
  });
  it('does not send when disabled or raw bytes are absent', async () => {
    const disabled = new SmsHookService(new ConfigService({}), {
      send,
    } as unknown as AliyunSmsSender);
    await expect(
      disabled.handle(Buffer.from(body), headers()),
    ).rejects.toMatchObject({ status: 503 });
    await expect(service.handle(undefined, headers())).rejects.toMatchObject({
      status: 401,
    });
    expect(send).not.toHaveBeenCalled();
  });
  it('merges in-flight and completed duplicates, but not different ids', async () => {
    let complete!: () => void;
    send.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          complete = resolve;
        }),
    );
    const first = service.handle(Buffer.from(body), headers());
    const duplicate = service.handle(Buffer.from(body), headers());
    await Promise.resolve();
    expect(send).toHaveBeenCalledTimes(1);
    complete();
    await Promise.all([first, duplicate]);
    await service.handle(Buffer.from(body), headers());
    expect(send).toHaveBeenCalledTimes(1);
    await service.handle(Buffer.from(body), headers(body, 'msg_other'));
    expect(send).toHaveBeenCalledTimes(2);
  });
  it('rejects conflicting content for an accepted webhook id', async () => {
    await service.handle(Buffer.from(body), headers());
    const other = body.replace('654321', '123456');
    await expect(
      service.handle(Buffer.from(other), headers(other)),
    ).rejects.toMatchObject({ status: 400 });
    expect(send).toHaveBeenCalledTimes(1);
  });
  it('expires accepted entries after five minutes', async () => {
    vi.useFakeTimers();
    await service.handle(Buffer.from(body), headers());
    vi.advanceTimersByTime(SMS_CACHE_TTL_MS + 1);
    await service.handle(Buffer.from(body), headers());
    expect(send).toHaveBeenCalledTimes(2);
  });
  it('does not cache a failure or leak upstream errors into logs', async () => {
    send.mockRejectedValueOnce(new Error('secret 15655095090 654321'));
    await expect(
      service.handle(Buffer.from(body), headers()),
    ).rejects.toBeInstanceOf(SmsHookError);
    await service.handle(Buffer.from(body), headers());
    expect(send).toHaveBeenCalledTimes(2);
    const output = JSON.stringify([...log.mock.calls, ...warn.mock.calls]);
    for (const value of ['15655095090', '654321', 'secret'])
      expect(output).not.toContain(value);
  });
  it('bounds in-flight requests without evicting work and evicts completed entries at capacity', async () => {
    const completions: Array<() => void> = [];
    send.mockImplementation(
      () => new Promise<void>((resolve) => completions.push(resolve)),
    );
    const requests = Array.from({ length: SMS_CACHE_LIMIT }, (_, index) =>
      service.handle(Buffer.from(body), headers(body, `msg_capacity_${index}`)),
    );
    await Promise.resolve();
    await expect(
      service.handle(Buffer.from(body), headers(body, 'msg_overflow')),
    ).rejects.toMatchObject({ status: 503 });
    expect(send).toHaveBeenCalledTimes(SMS_CACHE_LIMIT);
    completions.forEach((complete) => complete());
    await Promise.all(requests);
    send.mockResolvedValue('accepted');
    await service.handle(Buffer.from(body), headers(body, 'msg_overflow'));
    // The oldest completed entry has been evicted, so its retry is a new send.
    await service.handle(Buffer.from(body), headers(body, 'msg_capacity_0'));
    expect(send).toHaveBeenCalledTimes(SMS_CACHE_LIMIT + 2);
  });
});

describe('Aliyun transport', () => {
  const fetcher = vi.fn<typeof fetch>();
  const sender = new AliyunSmsSender(new ConfigService(settings), fetcher);
  beforeEach(() => {
    fetcher.mockReset();
  });
  afterEach(() => {
    vi.useRealTimers();
  });
  it('matches a fixed ACS3 signature fixture independently calculated with Python hashlib/hmac', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-11-07T13:00:00Z'));
    fetcher.mockResolvedValue(Response.json({ Code: 'OK', Success: true }));
    await sender.send('+8615655095090', '654321');
    const requestHeaders = fetcher.mock.calls[0][1]!.headers as Record<
      string,
      string
    >;
    expect(requestHeaders.authorization).toContain(
      'Signature=cb03d0a091429b4d5152a0b7391f5f6b0a6b07b41098c1f8d850ce2254ce8495',
    );
  });
  it('sends a signed POST with the supplied code, not provider-generated code', async () => {
    fetcher.mockResolvedValue(
      Response.json({ Code: 'OK', Success: true, RequestId: 'request-123' }),
    );
    await expect(sender.send('+8615655095090', '654321')).resolves.toBe(
      'request-123',
    );
    const [url, init] = fetcher.mock.calls[0];
    expect(url).toBe('https://dypnsapi.aliyuncs.com/');
    expect(init?.method).toBe('POST');
    expect(typeof init?.body).toBe('string');
    const params = new URLSearchParams(init!.body as string);
    expect(params.get('PhoneNumber')).toBe('15655095090');
    expect(JSON.parse(params.get('TemplateParam')!)).toEqual({
      code: '654321',
      min: '5',
    });
    expect((init!.headers as Record<string, string>).authorization).toMatch(
      /^ACS3-HMAC-SHA256 Credential=test-access-id,SignedHeaders=/,
    );
  });
  it.each([
    [{ Code: 'OK', Success: false }, 200],
    [
      {
        Code: 'InvalidAccessKeyId.NotFound',
        Success: false,
        Message: 'sensitive-message',
      },
      200,
    ],
    [{ Code: 'OK', Success: true }, 500],
    [null, 200],
  ] as const)('rejects non-success without retry', async (result, status) => {
    fetcher.mockResolvedValue(Response.json(result, { status }));
    await expect(
      sender.send('+8615655095090', '654321'),
    ).rejects.toBeInstanceOf(SmsDeliveryError);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it.each(['headers', 'body'])(
    'aborts after 3.5s while waiting for %s',
    async (stage) => {
      vi.useFakeTimers();
      fetcher.mockImplementation(async (_url, init) => {
        const waiting = () =>
          new Promise<never>((_resolve, reject) =>
            init!.signal!.addEventListener(
              'abort',
              () => reject(new Error('aborted')),
              { once: true },
            ),
          );
        if (stage === 'headers') return waiting();
        return { ok: true, status: 200, json: waiting } as unknown as Response;
      });
      const outcome = expect(
        sender.send('+8615655095090', '654321'),
      ).rejects.toMatchObject({ code: 'TIMEOUT' });
      await vi.advanceTimersByTimeAsync(3500);
      await outcome;
      expect(fetcher).toHaveBeenCalledTimes(1);
      expect(vi.getTimerCount()).toBe(0);
    },
  );
  it('sanitizes network exceptions and malformed upstream identifiers', async () => {
    fetcher.mockRejectedValueOnce(new Error('15655095090 secret 654321'));
    await expect(sender.send('+8615655095090', '654321')).rejects.toMatchObject(
      { code: 'NETWORK_OR_INVALID_RESPONSE', message: 'SMS delivery failed' },
    );
    fetcher.mockResolvedValueOnce(
      Response.json({
        Code: 'secret with spaces',
        RequestId: 'phone:15655095090',
        Message: 'sensitive',
      }),
    );
    await expect(sender.send('+8615655095090', '654321')).rejects.toMatchObject(
      { code: 'HTTP_200', requestId: undefined },
    );
  });
});

describe('SMS configuration', () => {
  it('defaults to disabled without making the existing API depend on SMS credentials', () => {
    expect(smsConfigErrors({})).toEqual([]);
    expect(smsConfigErrors({ SMS_HOOK_ENABLED: 'false' })).toEqual([]);
  });
  it('validates enabled settings without echoing their values', () => {
    expect(smsConfigErrors(settings)).toEqual([]);
    expect(smsConfigErrors({ SMS_HOOK_ENABLED: 'true' })).toHaveLength(5);
    const errors = smsConfigErrors({
      ...settings,
      SEND_SMS_HOOK_SECRET: 'sensitive-invalid',
      ALIYUN_ACCESS_KEY_SECRET: 'trailing-secret ',
    });
    expect(errors).toHaveLength(2);
    expect(JSON.stringify(errors)).not.toContain('sensitive-invalid');
    expect(JSON.stringify(errors)).not.toContain('trailing-secret');
    expect(smsConfigErrors({ SMS_HOOK_ENABLED: 'yes' })).toHaveLength(1);
  });
});
