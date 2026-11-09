import { Inject, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHash, createHmac, randomUUID } from 'node:crypto';

export const SMS_FETCH = Symbol('SMS_FETCH');
export const SMS_TIMEOUT_MS = 3500;
export class SmsDeliveryError extends Error {
  constructor(
    readonly code: string,
    readonly requestId?: string,
  ) {
    super('SMS delivery failed');
  }
}

function safeIdentifier(value: unknown): string | undefined {
  return typeof value === 'string' && /^[A-Za-z0-9_.-]{1,100}$/.test(value)
    ? value
    : undefined;
}

@Injectable()
export class AliyunSmsSender {
  constructor(
    @Inject(ConfigService) private readonly config: ConfigService,
    @Inject(SMS_FETCH) private readonly fetcher: typeof fetch,
  ) {}

  async send(phone: string, otp: string): Promise<string | undefined> {
    const host = 'dypnsapi.aliyuncs.com';
    const hash = (value: string) =>
      createHash('sha256').update(value).digest('hex');
    const body = new URLSearchParams({
      CountryCode: '86',
      PhoneNumber: phone.slice(3),
      SignName: this.config.getOrThrow<string>('ALIYUN_SMS_SIGN_NAME'),
      TemplateCode: this.config.getOrThrow<string>('ALIYUN_SMS_TEMPLATE_CODE'),
      TemplateParam: JSON.stringify({ code: otp, min: '5' }),
      ValidTime: '300',
      Interval: '60',
    }).toString();
    const bodyHash = hash(body);
    const headers: Record<string, string> = {
      'content-type': 'application/x-www-form-urlencoded',
      host,
      'x-acs-action': 'SendSmsVerifyCode',
      'x-acs-content-sha256': bodyHash,
      'x-acs-date': new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'),
      'x-acs-signature-nonce': randomUUID(),
      'x-acs-version': '2017-05-25',
    };
    const names = Object.keys(headers).sort();
    const signedHeaders = names.join(';');
    const canonicalHeaders = names
      .map((name) => `${name}:${headers[name].trim()}\n`)
      .join('');
    const canonicalRequest = [
      'POST',
      '/',
      '',
      canonicalHeaders,
      signedHeaders,
      bodyHash,
    ].join('\n');
    const algorithm = 'ACS3-HMAC-SHA256';
    const signature = createHmac(
      'sha256',
      this.config.getOrThrow<string>('ALIYUN_ACCESS_KEY_SECRET'),
    )
      .update(`${algorithm}\n${hash(canonicalRequest)}`)
      .digest('hex');
    headers.authorization = `${algorithm} Credential=${this.config.getOrThrow<string>('ALIYUN_ACCESS_KEY_ID')},SignedHeaders=${signedHeaders},Signature=${signature}`;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), SMS_TIMEOUT_MS);
    try {
      const response = await this.fetcher(`https://${host}/`, {
        method: 'POST',
        headers,
        body,
        signal: controller.signal,
      });
      // Keep the same deadline through response body consumption.
      const result: unknown = await response.json();
      if (!result || typeof result !== 'object')
        throw new SmsDeliveryError('INVALID_RESPONSE');
      const data = result as Record<string, unknown>;
      const requestId = safeIdentifier(data.RequestId);
      if (!response.ok || data.Code !== 'OK' || data.Success !== true)
        throw new SmsDeliveryError(
          safeIdentifier(data.Code) ?? `HTTP_${response.status}`,
          requestId,
        );
      return requestId;
    } catch (error) {
      if (controller.signal.aborted) throw new SmsDeliveryError('TIMEOUT');
      if (error instanceof SmsDeliveryError) throw error;
      // Never log fetch/JSON errors: providers may include phone numbers or secrets.
      throw new SmsDeliveryError('NETWORK_OR_INVALID_RESPONSE');
    } finally {
      clearTimeout(timer);
    }
  }
}
