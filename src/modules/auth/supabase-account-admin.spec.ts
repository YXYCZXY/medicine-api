import { ConfigService } from '@nestjs/config';
import { SupabaseAccountAdmin } from './supabase-account-admin.js';
const id = '00000000-0000-4000-8000-000000000001';
const config = new ConfigService({
  SUPABASE_URL: 'https://auth.example.test',
  SUPABASE_PUBLISHABLE_KEY: 'sb_publishable_test',
  SUPABASE_SERVICE_ROLE_KEY: 'sb_secret_test',
});
const originalFetch = global.fetch;
afterEach(() => {
  global.fetch = originalFetch;
});
it('missing server-only key fails before sending SMS', async () => {
  const fetcher = vi.fn();
  global.fetch = fetcher;
  const admin = new SupabaseAccountAdmin(
    new ConfigService({
      SUPABASE_URL: 'https://auth.example.test',
      SUPABASE_PUBLISHABLE_KEY: 'public',
    }),
  );
  await expect(admin.sendCode('+8613800000001')).rejects.toMatchObject({
    status: 503,
    response: { code: 'DELETION_UNAVAILABLE' },
  });
  expect(fetcher).not.toHaveBeenCalled();
});
it('scans exact Storage ownership through the restricted RPC, deletes only those objects, then hard-deletes Auth', async () => {
  let scans = 0;
  const calls: { url: string; method: string; body: unknown }[] = [];
  global.fetch = vi.fn(async (input, init) => {
    const url = String(input),
      method = init?.method ?? 'GET';
    calls.push({
      url,
      method,
      body: typeof init?.body === 'string' ? JSON.parse(init.body) : null,
    });
    if (url.endsWith('/storage/v1/bucket'))
      return new Response(JSON.stringify([{ id: 'photos', name: 'photos' }]));
    if (url.includes('/rpc/account_deletion_owned_objects'))
      return new Response(
        JSON.stringify(
          scans++ === 0
            ? [
                {
                  bucket_id: 'photos',
                  name: 'nested/non-user-prefix/photo.jpg',
                },
              ]
            : [],
        ),
      );
    if (url.endsWith('/storage/v1/object/photos') && method === 'DELETE')
      return new Response('[]');
    if (url.includes('/admin/users/') && method === 'GET')
      return new Response(JSON.stringify({ id, phone: '8613800000001' }));
    if (url.includes('/admin/users/') && method === 'DELETE')
      return new Response('{}');
    throw new Error('Unexpected URL');
  });
  const admin = new SupabaseAccountAdmin(config);
  await admin.removeStorage(id);
  await admin.deleteIdentity(id);
  expect(calls.find((call) => call.url.includes('/rpc/'))?.body).toEqual({
    p_user_id: id,
  });
  expect(
    calls.find((call) => call.url.endsWith('/object/photos'))?.body,
  ).toEqual({ prefixes: ['nested/non-user-prefix/photo.jpg'] });
  expect(calls.at(-1)?.body).toEqual({ should_soft_delete: false });
  expect(calls.at(-1)?.method).toBe('DELETE');
});
it('Storage ownership lookup failure blocks identity deletion rather than guessing by folder name', async () => {
  const calls: string[] = [];
  global.fetch = vi.fn(async (input) => {
    const url = String(input);
    calls.push(url);
    return url.endsWith('/bucket')
      ? new Response('[{"id":"photos"}]')
      : new Response(
          JSON.stringify({ code: 'PGRST202', message: 'RPC missing' }),
          { status: 404 },
        );
  });
  const admin = new SupabaseAccountAdmin(config);
  await expect(admin.removeStorage(id)).rejects.toThrow(
    'STORAGE_OWNERSHIP_LOOKUP_UNAVAILABLE',
  );
  expect(calls.some((url) => url.includes('/admin/'))).toBe(false);
});
it('an absent Auth identity is idempotent but temporary errors cannot prove deletion', async () => {
  global.fetch = vi
    .fn()
    .mockImplementation(
      async () =>
        new Response(
          JSON.stringify({ code: 'user_not_found', msg: 'not found' }),
          { status: 404 },
        ),
    );
  const admin = new SupabaseAccountAdmin(config);
  expect(await admin.exists(id)).toBe(false);
  await expect(admin.deleteIdentity(id)).resolves.toBeUndefined();
  global.fetch = vi
    .fn()
    .mockResolvedValue(
      new Response(JSON.stringify({ code: 'forbidden', msg: 'forbidden' }), {
        status: 403,
      }),
    );
  await expect(admin.exists(id)).rejects.toMatchObject({ status: 503 });
});
it('OTP uses the bound phone, refuses signup, and rejects verification for a different subject', async () => {
  const calls: { url: string; body: unknown }[] = [];
  global.fetch = vi.fn(async (input, init) => {
    const url = String(input);
    calls.push({
      url,
      body: typeof init?.body === 'string' ? JSON.parse(init.body) : null,
    });
    if (url.includes('/otp')) return new Response('{}');
    if (url.includes('/verify'))
      return new Response(
        JSON.stringify({
          access_token: 'verification-session',
          refresh_token: 'verification-refresh',
          expires_in: 3600,
          token_type: 'bearer',
          user: {
            id: '99999999-9999-4999-8999-999999999999',
            phone: '8613800000001',
            phone_confirmed_at: '2026-11-01',
          },
        }),
      );
    if (url.includes('/logout')) return new Response(null, { status: 204 });
    if (url.endsWith('/user'))
      return new Response(JSON.stringify({ id, phone: '8613800000001' }));
    throw new Error('Unexpected URL');
  });
  const admin = new SupabaseAccountAdmin(config);
  await admin.sendCode('+8613800000001');
  expect(calls[0].body).toMatchObject({
    phone: '+8613800000001',
    create_user: false,
    channel: 'sms',
  });
  await expect(
    admin.verifyCode(id, '+8613800000001', '123456'),
  ).rejects.toMatchObject({
    status: 400,
    response: { code: 'OTP_IDENTITY_MISMATCH' },
  });
  expect(calls.some((call) => call.url.includes('scope=local'))).toBe(true);
});
