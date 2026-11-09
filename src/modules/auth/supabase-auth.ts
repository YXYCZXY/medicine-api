import { Inject, Injectable, ForbiddenException, ServiceUnavailableException, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { compactVerify, createRemoteJWKSet, errors, jwtVerify } from 'jose';

export const SUPABASE_JWKS = Symbol('SUPABASE_JWKS');
export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export function normalizePhone(value: string): string | null {
  const number = value.replace(/^\+/, '');
  return /^861[3-9]\d{9}$/.test(number) ? `+${number}` : null;
}
export type VerifiedIdentity = { userId: string; sessionId: string; phone: string };
export function createProjectJwks(config: ConfigService) {
  return createRemoteJWKSet(new URL(`${config.getOrThrow<string>('SUPABASE_URL').replace(/\/+$/, '')}/auth/v1/.well-known/jwks.json`), {
    timeoutDuration: 5000, cooldownDuration: 30000, cacheMaxAge: 600000,
  });
}

@Injectable()
export class SupabaseJwtVerifier {
  constructor(private readonly config: ConfigService, @Inject(SUPABASE_JWKS) private readonly jwks: ReturnType<typeof createRemoteJWKSet>) {}
  async verifyDeletionStatusToken(token: string): Promise<string> {
    try {
      const verified = await compactVerify(token, this.jwks, { algorithms: ['ES256'] });
      const claims = JSON.parse(new TextDecoder().decode(verified.payload)) as Record<string, unknown>;
      const audience = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
      if (claims.iss !== `${this.config.getOrThrow<string>('SUPABASE_URL').replace(/\/+$/, '')}/auth/v1` || !audience.includes('authenticated') || claims.role !== 'authenticated' || claims.is_anonymous !== false || typeof claims.sub !== 'string' || !UUID.test(claims.sub) || typeof claims.iat !== 'number' || claims.iat > Date.now()/1000 + 5 || typeof claims.exp !== 'number') throw new Error();
      return claims.sub;
    } catch {
      throw new UnauthorizedException({ code: 'STATUS_TOKEN_INVALID', message: '暂时无法验证账号状态，已保留本机数据' });
    }
  }
  async verify(token: string): Promise<VerifiedIdentity> {
    let claims;
    try {
      ({ payload: claims } = await jwtVerify(token, this.jwks, {
        issuer: `${this.config.getOrThrow<string>('SUPABASE_URL').replace(/\/+$/, '')}/auth/v1`,
        audience: 'authenticated', algorithms: ['ES256'], clockTolerance: 5,
        requiredClaims: ['sub', 'exp', 'iat', 'session_id', 'role'],
      }));
    } catch (error) {
      if (!(error instanceof errors.JOSEError) || error.code === 'ERR_JOSE_GENERIC' || error instanceof errors.JWKSTimeout || error instanceof errors.JWKSInvalid) {
        throw new ServiceUnavailableException({ code: 'AUTH_UNAVAILABLE', message: '认证服务暂不可用，请稍后重试' });
      }
      throw new UnauthorizedException({ code: 'TOKEN_INVALID', message: '登录凭据无效或已过期' });
    }
    if (!claims.sub || !UUID.test(claims.sub) || typeof claims.session_id !== 'string' || !UUID.test(claims.session_id) ||
      claims.role !== 'authenticated' || claims.is_anonymous !== false) {
      throw new UnauthorizedException({ code: 'TOKEN_INVALID', message: '登录凭据无效' });
    }
    const methods: unknown[] = Array.isArray(claims.amr) ? claims.amr : [];
    if (!methods.some((entry) => {
      const method = typeof entry === 'object' && entry !== null && 'method' in entry ? entry.method : entry;
      return method === 'password' || method === 'otp';
    })) {
      throw new ForbiddenException({ code: 'AUTH_METHOD_UNSUPPORTED', message: '请使用密码或短信验证码重新登录' });
    }
    const phone = typeof claims.phone === 'string' ? normalizePhone(claims.phone) : null;
    if (!phone) throw new ForbiddenException({ code: 'PHONE_REQUIRED', message: '请使用已验证的中国大陆手机号注册' });
    return { userId: claims.sub, sessionId: claims.session_id, phone };
  }
}

@Injectable()
export class SupabaseIdentityService {
  private readonly client: SupabaseClient;
  constructor(config: ConfigService) {
    this.client = createClient(config.getOrThrow<string>('SUPABASE_URL'), config.getOrThrow<string>('SUPABASE_PUBLISHABLE_KEY'), {
      auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
      global: { fetch: (input, init) => fetch(input, { ...init, signal: AbortSignal.timeout(5000) }) },
    });
  }
  async getVerifiedUser(token: string, identity: VerifiedIdentity) {
    let result;
    try { result = await this.client.auth.getUser(token); }
    catch { throw new ServiceUnavailableException({ code: 'AUTH_UNAVAILABLE', message: '认证服务暂不可用，请重试初始化' }); }
    const { data, error } = result;
    if (error) {
      if (error.code === 'user_not_found') throw new ForbiddenException({ code: 'ACCOUNT_DELETED', message: '账号已删除' });
      if (error.status === 401 || error.status === 403 || error.code === 'bad_jwt' || error.code === 'session_not_found') throw new UnauthorizedException({ code: 'TOKEN_INVALID', message: '请重新登录' });
      throw new ServiceUnavailableException({ code: 'AUTH_UNAVAILABLE', message: '认证服务暂不可用，请重试初始化' });
    }
    const user = data.user;
    const phone = user?.phone ? normalizePhone(user.phone) : null;
    if (!user || user.id !== identity.userId || !phone || phone !== identity.phone || !user.phone_confirmed_at || !Number.isFinite(Date.parse(user.phone_confirmed_at))) {
      throw new ForbiddenException({ code: 'PHONE_UNVERIFIED', message: '请先完成手机号验证' });
    }
    const nickname = typeof user.user_metadata.nickname === 'string' ? user.user_metadata.nickname.trim().slice(0, 50) : '';
    return { phone, confirmedAt: new Date(user.phone_confirmed_at), nickname: nickname || `用户${phone.slice(-4)}` };
  }
}
