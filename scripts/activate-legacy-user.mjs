import 'dotenv/config';
import { randomBytes, scrypt as callbackScrypt } from 'node:crypto';
import pg from 'pg';

const { DATABASE_URL, DEV_USER_ID, LOGIN_ACCOUNT, LOGIN_PASSWORD } = process.env;
const account = LOGIN_ACCOUNT?.trim().toLowerCase();
if (!DATABASE_URL || !DEV_USER_ID || !account || !LOGIN_PASSWORD) {
  throw new Error('需要 DATABASE_URL、DEV_USER_ID、LOGIN_ACCOUNT 和 LOGIN_PASSWORD');
}
if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(DEV_USER_ID)) {
  throw new Error('DEV_USER_ID 格式不正确');
}
if (!/^[a-z0-9_-]{3,64}$/.test(account) || LOGIN_PASSWORD.length < 8 || LOGIN_PASSWORD.length > 128) {
  throw new Error('原账号或密码不符合新注册规则，请先调整本地环境变量');
}

const salt = randomBytes(16);
const key = await new Promise((resolve, reject) => callbackScrypt(LOGIN_PASSWORD, salt, 64,
  { N: 1 << 15, r: 8, p: 1, maxmem: 64 * 1024 * 1024 },
  (error, result) => error ? reject(error) : resolve(result)));
const passwordHash = `scrypt$32768$8$1$${salt.toString('base64url')}$${key.toString('base64url')}`;

const client = new pg.Client({ connectionString: DATABASE_URL });
await client.connect();
try {
  await client.query('BEGIN');
  const existing = await client.query('SELECT password_hash FROM users WHERE id = $1 FOR UPDATE', [DEV_USER_ID]);
  if (existing.rows.length && existing.rows[0].password_hash !== '!legacy!') {
    throw new Error('该用户已激活，脚本不会覆盖已有密码');
  }
  if (existing.rows.length) {
    await client.query(`UPDATE users SET account=$1, password_hash=$2, nickname=$3, status='active' WHERE id=$4`,
      [account, passwordHash, account, DEV_USER_ID]);
  } else {
    await client.query(`INSERT INTO users (id,account,password_hash,nickname,status) VALUES ($1,$2,$3,$4,'active')`,
      [DEV_USER_ID, account, passwordHash, account]);
  }
  await client.query('COMMIT');
  process.stdout.write('原账号已激活，历史记录归属未改变。\n');
} catch (error) {
  await client.query('ROLLBACK');
  throw error;
} finally {
  await client.end();
}
