import 'dotenv/config';
import { spawnSync } from 'node:child_process';

const explicit = process.env.DICTIONARY_TEST_DATABASE_URL;
const url = new URL(explicit ?? process.env.DATABASE_URL);
if (!['localhost', '127.0.0.1'].includes(url.hostname)) {
  throw new Error('审核脚本仅允许连接本机 PostgreSQL');
}
if (!explicit) url.pathname = '/medicine_dictionary_review_test';
if (!url.pathname.endsWith('_test'))
  throw new Error('必须使用独立 _test 数据库');
const result = spawnSync(
  'npm',
  [
    'run',
    'test:e2e',
    '--',
    'test/user-dictionaries.postgres-review.e2e-spec.ts',
  ],
  {
    stdio: 'inherit',
    env: { ...process.env, DICTIONARY_TEST_DATABASE_URL: url.href },
  },
);
process.exit(result.status ?? 1);
