// Explicit deployment verification; credentials stay outside the repository/image.
import 'dotenv/config';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { createClient } from '@supabase/supabase-js';

const mode = process.argv[2] ?? 'exercise';
if (!['exercise', 'verify'].includes(mode)) throw new Error('Use exercise or verify');
const base = process.env.AUTH_SMOKE_API_URL ?? 'https://api.uk-io.com';
const credentials = JSON.parse(await readFile('/private/tmp/qfj-phone-test.json', 'utf8'));
const statePath = '/private/tmp/medicine-deploy-smoke-state.json';
const client = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_PUBLISHABLE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  global: { fetch: (input, init) => fetch(input, { ...init, signal: AbortSignal.timeout(20000) }) },
});
const report = { base, mode, startedAt: new Date().toISOString(), checks: [] };
function pass(stage, details = {}) {
  const result = { stage, ok: true, ...details };
  report.checks.push(result);
  console.log(JSON.stringify(result));
}
let token;
async function request(path, { method = 'GET', body, authenticated = true, expected = 200 } = {}) {
  const response = await fetch(base + path, {
    method,
    headers: { ...(authenticated ? { authorization: `Bearer ${token}` } : {}), ...(body ? { 'content-type': 'application/json' } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
    signal: AbortSignal.timeout(30000),
  });
  assert.equal(response.status, expected, `${method} ${path}: unexpected HTTP status`);
  return response.status === 204 ? null : response.json();
}
try {
  assert.deepEqual(await request('/health', { authenticated: false }), { status: 'ok' });
  pass('public-database-health');
  await request('/users/me', { authenticated: false, expected: 401 });
  pass('unauthenticated-business-denied');
  const login = await client.auth.signInWithPassword({ phone: credentials.phone, password: credentials.password });
  if (login.error || !login.data.session) throw new Error(`Password login failed: ${login.error?.code ?? 'no-session'}`);
  token = login.data.session.access_token;
  pass('real-password-login', { expiresIn: login.data.session.expires_in });
  const user = await request('/users/me');
  assert.equal(user.id, login.data.user.id);
  const dictionary = await request('/user-dictionaries');
  for (const field of ['categories', 'efficacies', 'symptoms']) assert.ok(Array.isArray(dictionary[field]));
  pass('user-and-dictionary-bootstrap');

  if (mode === 'exercise') {
    const state = { userId: user.id, deviceId: randomUUID(), attachmentId: randomUUID() };
    await writeFile(statePath, JSON.stringify(state), { mode: 0o600 });
    const medicine = await request('/medicines', {
      method: 'POST', expected: 201,
      body: { name: '[部署验收] temporary', category: '其他', quantity: 2, unit: '片' },
    });
    state.medicineId = medicine.id;
    const updated = await request(`/medicines/${medicine.id}`, { method: 'PATCH', body: { quantity: 3 } });
    assert.equal(updated.quantity, 3);
    assert.ok((await request('/medicines')).some(row => row.id === medicine.id && row.quantity === 3));
    pass('medicine-create-read-update');
    const sync = {
      id: randomUUID(), user_id: user.id, device_id: state.deviceId,
      entity_id: randomUUID(), type: 'medicine.create', schema_version: 2,
      payload: JSON.stringify({ name: '[部署验收] sync', category: '其他', quantity: 1, unit: '片' }),
      base_version: null, base_op_id: null, depends_on: '[]',
      client_occurred_at: new Date().toISOString(), sequence: 1,
    };
    state.syncMedicineId = sync.entity_id;
    state.syncOpId = sync.id;
    await writeFile(statePath, JSON.stringify(state), { mode: 0o600 });
    const first = await request('/sync/commands', { method: 'POST', body: { commands: [sync] }, expected: 201 });
    assert.equal(first.results[0].status, 'accepted');
    const replay = await request('/sync/commands', { method: 'POST', body: { commands: [sync] }, expected: 201 });
    assert.equal(replay.results[0].status, 'accepted');
    const snapshot = await request(`/sync/snapshot?deviceId=${state.deviceId}`);
    assert.equal(snapshot.protocolVersion, 2);
    assert.equal(snapshot.medicines.filter(row => row.id === sync.entity_id).length, 1);
    pass('sync-v2-and-idempotent-command-replay');
    const content = Buffer.alloc(8 * 1024 * 1024, 0x5a).toString('base64');
    state.attachmentDigest = createHash('sha256').update(content).digest('hex');
    await writeFile(statePath, JSON.stringify(state), { mode: 0o600 });
    const attached = await request('/sync/attachments', {
      method: 'POST', expected: 201, body: { id: state.attachmentId, base64: content },
    });
    assert.equal(attached.digest, state.attachmentDigest);
    const downloaded = await request(`/sync/attachments/${state.attachmentId}`);
    assert.equal(downloaded.base64, content);
    pass('maximum-8mb-attachment-upload-download');

    const times = [];
    await Promise.all(Array.from({ length: 5 }, async () => {
      for (let i = 0; i < 10; i++) {
        const started = performance.now();
        const rows = await request(`/sync/snapshot?deviceId=${state.deviceId}`);
        assert.equal(rows.protocolVersion, 2);
        times.push(performance.now() - started);
      }
    }));
    times.sort((a, b) => a - b);
    pass('five-concurrent-clients', { requests: times.length, p95Ms: Math.round(times[Math.ceil(times.length * 0.95) - 1]), maxMs: Math.round(times.at(-1)) });
  } else {
    const state = JSON.parse(await readFile(statePath, 'utf8'));
    assert.equal(state.userId, user.id);
    const medicines = await request('/medicines');
    assert.ok(medicines.some(row => row.id === state.medicineId && row.quantity === 3));
    assert.ok(medicines.some(row => row.id === state.syncMedicineId));
    const attachment = await request(`/sync/attachments/${state.attachmentId}`);
    assert.equal(createHash('sha256').update(attachment.base64).digest('hex'), state.attachmentDigest);
    pass('records-and-attachment-survive-container-restart');
    for (const id of [state.medicineId, state.syncMedicineId]) await request(`/medicines/${id}`, { method: 'DELETE', expected: 204 });
    pass('temporary-medicines-cleaned');
  }
  const refreshed = await client.auth.refreshSession();
  if (refreshed.error || !refreshed.data.session) throw new Error('Session refresh failed');
  pass('session-refresh');
} catch (error) {
  console.error(JSON.stringify({ stage: 'deployment-smoke', ok: false, message: error.message }));
  process.exitCode = 1;
} finally {
  const { error } = await client.auth.signOut({ scope: 'local' });
  if (error) { console.error(JSON.stringify({ stage: 'local-session-logout', ok: false, code: error.code })); process.exitCode = 1; }
  report.finishedAt = new Date().toISOString();
  report.ok = !process.exitCode;
  await writeFile(`/private/tmp/medicine-deploy-smoke-${mode}.json`, JSON.stringify(report, null, 2), { mode: 0o600 });
}
