import {
  BadRequestException,
  HttpException,
  Injectable,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';

@Injectable()
export class SupabaseAccountAdmin {
  private readonly admin: SupabaseClient | null;
  constructor(private readonly config: ConfigService) {
    const secret = config.get<string>('SUPABASE_SERVICE_ROLE_KEY');
    this.admin = secret ? this.makeClient(secret) : null;
  }
  private makeClient(key: string) {
    return createClient(this.config.getOrThrow<string>('SUPABASE_URL'), key, {
      auth: {
        persistSession: false,
        autoRefreshToken: false,
        detectSessionInUrl: false,
      },
      global: {
        fetch: (input, init) =>
          fetch(input, { ...init, signal: AbortSignal.timeout(8000) }),
      },
    });
  }
  assertConfigured(): SupabaseClient {
    if (!this.admin)
      throw new ServiceUnavailableException({
        code: 'DELETION_UNAVAILABLE',
        message: '账号删除服务暂未配置，请稍后重试',
      });
    return this.admin;
  }
  get configured() {
    return this.admin !== null;
  }
  private otpError(error: { status?: number; code?: string }) {
    if (error.status === 429)
      throw new HttpException(
        { code: 'OTP_RATE_LIMITED', message: '验证码请求过于频繁，请稍后重试' },
        429,
      );
    if (
      error.code === 'otp_expired' ||
      error.code === 'otp_disabled' ||
      error.status === 400 ||
      error.status === 403
    )
      throw new BadRequestException({
        code: 'OTP_INVALID',
        message: '验证码错误或已过期，请核对或重新获取',
      });
    throw new ServiceUnavailableException({
      code: 'SMS_UNAVAILABLE',
      message: '短信服务暂不可用，请稍后重试',
    });
  }
  async sendCode(phone: string) {
    this.assertConfigured();
    const client = this.makeClient(
      this.config.getOrThrow<string>('SUPABASE_PUBLISHABLE_KEY'),
    );
    const { error } = await client.auth.signInWithOtp({
      phone,
      options: { shouldCreateUser: false, channel: 'sms' },
    });
    if (error) this.otpError(error);
  }
  async verifyCode(userId: string, phone: string, code: string) {
    this.assertConfigured();
    // A fresh in-memory client prevents OTP sessions from replacing any other request's identity.
    const client = this.makeClient(
      this.config.getOrThrow<string>('SUPABASE_PUBLISHABLE_KEY'),
    );
    const { data, error } = await client.auth.verifyOtp({
      phone,
      token: code,
      type: 'sms',
    });
    if (error) this.otpError(error);
    try {
      if (
        data.user?.id !== userId ||
        data.user.phone?.replace(/^\+/, '') !== phone.replace(/^\+/, '') ||
        !data.user.phone_confirmed_at
      ) {
        throw new BadRequestException({
          code: 'OTP_IDENTITY_MISMATCH',
          message: '验证身份与当前账号不一致，请重新登录',
        });
      }
    } finally {
      // Revoke only the short-lived verification session, never the user's other sessions.
      await client.auth.signOut({ scope: 'local' }).catch(() => undefined);
    }
  }
  async exists(userId: string): Promise<boolean> {
    const { data, error } =
      await this.assertConfigured().auth.admin.getUserById(userId);
    if (error) {
      if (error.code === 'user_not_found' || error.status === 404) return false;
      throw new ServiceUnavailableException({
        code: 'AUTH_UNAVAILABLE',
        message: '暂时无法确认账号状态，请稍后重试',
      });
    }
    if (!data.user)
      throw new ServiceUnavailableException('认证服务返回了无效响应');
    return true;
  }
  async removeStorage(userId: string) {
    const client = this.assertConfigured();
    const { data: buckets, error: bucketError } =
      await client.storage.listBuckets();
    if (bucketError || !buckets) throw new Error('STORAGE_BUCKETS_UNAVAILABLE');
    if (!buckets.length) return;
    // Storage list()/listV2() omit owner ids. A restricted server-only RPC selects
    // exact ownership, including objects outside user-id-prefixed directories.
    for (;;) {
      const { data, error } = await client.rpc(
        'account_deletion_owned_objects',
        { p_user_id: userId },
      );
      if (error || !Array.isArray(data))
        throw new Error('STORAGE_OWNERSHIP_LOOKUP_UNAVAILABLE');
      const rows = data as { bucket_id: string; name: string }[];
      if (!rows.length) return;
      const groups = new Map<string, string[]>();
      for (const row of rows) {
        if (typeof row.bucket_id !== 'string' || typeof row.name !== 'string')
          throw new Error('STORAGE_OWNERSHIP_LOOKUP_INVALID');
        groups.set(row.bucket_id, [
          ...(groups.get(row.bucket_id) ?? []),
          row.name,
        ]);
      }
      for (const [bucket, objects] of groups) {
        const { error: removalError } = await client.storage
          .from(bucket)
          .remove(objects);
        if (removalError) throw new Error('STORAGE_REMOVAL_UNAVAILABLE');
      }
    }
  }
  async deleteIdentity(userId: string) {
    const { error } = await this.assertConfigured().auth.admin.deleteUser(
      userId,
      false,
    );
    if (error && error.code !== 'user_not_found' && error.status !== 404)
      throw new Error('AUTH_DELETION_UNAVAILABLE');
  }
}
