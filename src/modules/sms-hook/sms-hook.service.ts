import { Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHash, randomUUID } from 'node:crypto';
import { Webhook } from 'standardwebhooks';
import { AliyunSmsSender, SmsDeliveryError } from './aliyun-sms.sender.js';

export class SmsHookError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}
type CacheEntry = {
  digest: string;
  promise: Promise<void>;
  expiresAt: number | null;
};
export const SMS_CACHE_LIMIT = 1000;
export const SMS_CACHE_TTL_MS = 5 * 60 * 1000;

@Injectable()
export class SmsHookService {
  private readonly logger = new Logger(SmsHookService.name);
  private readonly cache = new Map<string, CacheEntry>();
  constructor(
    @Inject(ConfigService) private readonly config: ConfigService,
    @Inject(AliyunSmsSender) private readonly sender: AliyunSmsSender,
  ) {}

  async handle(
    rawBody: Buffer | undefined,
    headers: Record<string, string | string[] | undefined>,
  ): Promise<void> {
    if (this.config.get<string>('SMS_HOOK_ENABLED') !== 'true')
      throw new SmsHookError(503, 'SMS service unavailable');
    if (!rawBody) throw new SmsHookError(401, 'Invalid signature');
    if (rawBody.length > 16 * 1024)
      throw new SmsHookError(413, 'Payload too large');
    const signedHeaders: Record<string, string> = {};
    for (const name of [
      'webhook-id',
      'webhook-timestamp',
      'webhook-signature',
    ]) {
      const value = headers[name];
      if (typeof value !== 'string' || !value || value.length > 2048)
        throw new SmsHookError(401, 'Invalid signature');
      signedHeaders[name] = value;
    }
    let event: unknown;
    try {
      const secret = this.config
        .getOrThrow<string>('SEND_SMS_HOOK_SECRET')
        .replace(/^v1,/, '');
      event = new Webhook(secret).verify(
        rawBody.toString('utf8'),
        signedHeaders,
      );
    } catch {
      throw new SmsHookError(401, 'Invalid signature');
    }
    const payload = event as {
      user?: { phone?: unknown };
      sms?: { otp?: unknown };
    } | null;
    const inputPhone = payload?.user?.phone;
    const otp = payload?.sms?.otp;
    const phone =
      typeof inputPhone === 'string'
        ? inputPhone.startsWith('+')
          ? inputPhone
          : `+${inputPhone}`
        : '';
    if (
      !/^\+861[3-9]\d{9}$/.test(phone) ||
      typeof otp !== 'string' ||
      !/^\d{6}$/.test(otp)
    )
      throw new SmsHookError(400, 'Invalid OTP data');

    const id = signedHeaders['webhook-id'];
    const digest = createHash('sha256').update(rawBody).digest('hex');
    const now = Date.now();
    for (const [key, value] of this.cache)
      if (value.expiresAt !== null && value.expiresAt <= now)
        this.cache.delete(key);
    const existing = this.cache.get(id);
    if (existing) {
      if (existing.digest !== digest)
        throw new SmsHookError(400, 'Conflicting webhook payload');
      return existing.promise;
    }
    // Evict completed entries only; never allow concurrent requests to evict in-flight work.
    if (this.cache.size >= SMS_CACHE_LIMIT) {
      const completed = [...this.cache].find(
        ([, entry]) => entry.expiresAt !== null,
      );
      if (completed) this.cache.delete(completed[0]);
      else throw new SmsHookError(503, 'SMS service busy');
    }
    const traceId = randomUUID();
    const started = performance.now();
    const entry: CacheEntry = {
      digest,
      promise: Promise.resolve(),
      expiresAt: null,
    };
    entry.promise = Promise.resolve().then(async () => {
      try {
        const requestId = await this.sender.send(phone, otp);
        entry.expiresAt = Date.now() + SMS_CACHE_TTL_MS;
        this.logger.log({
          event: 'sms_accepted',
          traceId,
          requestId,
          elapsedMs: Math.round(performance.now() - started),
        });
      } catch (error) {
        this.cache.delete(id);
        this.logger.warn({
          event: 'sms_failed',
          traceId,
          code: error instanceof SmsDeliveryError ? error.code : 'INTERNAL',
          requestId:
            error instanceof SmsDeliveryError ? error.requestId : undefined,
          elapsedMs: Math.round(performance.now() - started),
        });
        throw new SmsHookError(502, 'SMS delivery failed');
      }
    });
    this.cache.set(id, entry);
    return entry.promise;
  }
}
