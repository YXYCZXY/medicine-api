import 'dotenv/config';
import { spawnSync } from 'node:child_process';
// Reuses the existing disposable test database, exclusively in a fresh UUID schema.
// Never prints connection credentials or talks to the configured Supabase project.
const target = new URL(process.env.DATABASE_URL);
if (!['localhost', '127.0.0.1', '[::1]'].includes(target.hostname))
  throw new Error('Local test runner requires a local PostgreSQL URL');
target.pathname = '/medicine_dictionary_review_test';
const result = spawnSync(
  process.execPath,
  [
    'node_modules/vitest/vitest.mjs',
    'run',
    '--config',
    'vitest.config.e2e.ts',
    'test/account-deletion.postgres.e2e-spec.ts',
  ],
  {
    stdio: 'inherit',
    env: {
      ...process.env,
      ACCOUNT_DELETION_TEST_DATABASE_URL: target.href,
      SUPABASE_SERVICE_ROLE_KEY: '',
    },
  },
);
process.exitCode = result.status ?? 1;
