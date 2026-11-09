import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';

const file = process.argv[2];
if (!file) throw new Error('Pass the downloaded PostgreSQL custom-format backup');
const database = `medicine_restore_${Date.now()}_test`;
const expectedMigrations = (await readdir(new URL('../prisma/migrations/', import.meta.url), { withFileTypes: true }))
  .filter(entry => entry.isDirectory()).length;
function docker(args, input) {
  const result = spawnSync('docker', args, { input, encoding: 'utf8', maxBuffer: 2 * 1024 * 1024 });
  if (result.status !== 0) throw new Error(`Backup verification command failed: ${result.stderr}`);
  return result.stdout.trim();
}
function sql(databaseName, statement) {
  return docker(['exec', 'medicine-api-postgres', 'psql', '-X', '-v', 'ON_ERROR_STOP=1', '-U', 'postgres', '-d', databaseName, '-Atc', statement]);
}
let created = false;
try {
  sql('postgres', `CREATE DATABASE ${database}`);
  created = true;
  docker(['exec', '-i', 'medicine-api-postgres', 'pg_restore', '--exit-on-error', '--no-owner', '--no-privileges', '-U', 'postgres', '-d', database], await readFile(file));
  const counts = JSON.parse(sql(database, `SELECT json_build_object(
    'migrations', (SELECT count(*) FROM _prisma_migrations WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL),
    'users', (SELECT count(*) FROM users),
    'medicines', (SELECT count(*) FROM medicine_items),
    'attachments', (SELECT count(*) FROM sync_attachments),
    'largestAttachmentBytes', (SELECT coalesce(max(octet_length(content)),0) FROM sync_attachments)
  )`));
  assert.equal(counts.migrations, expectedMigrations);
  assert.ok(counts.users >= 1);
  assert.ok(counts.medicines >= 2);
  assert.ok(counts.attachments >= 1);
  assert.equal(counts.largestAttachmentBytes, 8 * 1024 * 1024);
  console.log(JSON.stringify({ stage: 'full-backup-restored-in-isolated-local-test-database', ok: true, ...counts }));
} finally {
  if (created) sql('postgres', `DROP DATABASE ${database}`);
}
