import { randomUUID } from 'node:crypto';
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT, type JWTPayload } from 'jose';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import type { VerifiedIdentity } from '../src/modules/auth/supabase-auth.js';

export async function createAuthFixture() {
  const pair = await generateKeyPair('ES256');
  const key = { ...await exportJWK(pair.publicKey), kid: 'fixture-key', alg: 'ES256', use: 'sig' };
  let sequence = 0;
  const identities = {
    getVerifiedUser: vi.fn(async (_token: string, identity: VerifiedIdentity) => ({
      phone: identity.phone, confirmedAt: new Date('2026-11-01T00:00:00Z'), nickname: '测试用户',
    })),
  };
  const issue = async (userId: string = randomUUID(), overrides: JWTPayload = {}) => new SignJWT({
    role: 'authenticated', is_anonymous: false, phone: `+86138${String(++sequence).padStart(8, '0')}`,
    session_id: randomUUID(), amr: [{ method: 'password', timestamp: Math.floor(Date.now() / 1000) }],
    ...overrides,
  }).setProtectedHeader({ alg: 'ES256', kid: key.kid }).setSubject(userId)
    .setIssuer('https://auth.example.test/auth/v1').setAudience('authenticated').setIssuedAt().setExpirationTime('15m')
    .sign(pair.privateKey);
  return {
    pair, key, jwks: createLocalJWKSet({ keys: [key] }), identities, issue,
    async register(app: NestFastifyApplication) {
      const token = await issue();
      const response = await app.inject({ method: 'GET', url: '/users/me', headers: { authorization: `Bearer ${token}` } });
      if (response.statusCode !== 200) throw new Error(`Fixture bootstrap failed: ${response.body}`);
      return { statusCode: 200, json: () => ({ token, user: response.json<{ id: string; phone: string }>() }) };
    },
  };
}
