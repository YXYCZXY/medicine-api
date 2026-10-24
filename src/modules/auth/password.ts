import { randomBytes, scrypt as callbackScrypt, timingSafeEqual } from 'node:crypto';
const COST = 1 << 15;
const BLOCK_SIZE = 8;
const PARALLELISM = 1;
const KEY_LENGTH = 64;
const MAX_MEMORY = 64 * 1024 * 1024;

function derive(password: string, salt: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    callbackScrypt(password, salt, KEY_LENGTH, {
      N: COST, r: BLOCK_SIZE, p: PARALLELISM, maxmem: MAX_MEMORY,
    }, (error, key) => error ? reject(error) : resolve(key));
  });
}

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const key = await derive(password, salt);
  return `scrypt$${COST}$${BLOCK_SIZE}$${PARALLELISM}$${salt.toString('base64url')}$${key.toString('base64url')}`;
}

export async function verifyPassword(password: string, encoded: string): Promise<boolean> {
  const [algorithm, costText, blockText, parallelText, saltText, keyText, extra] = encoded.split('$');
  if (algorithm !== 'scrypt' || extra || !saltText || !keyText) return false;
  const [cost, blockSize, parallelism] = [costText, blockText, parallelText].map(Number);
  if (cost !== COST || blockSize !== BLOCK_SIZE || parallelism !== PARALLELISM) return false;
  const expected = Buffer.from(keyText, 'base64url');
  if (expected.length !== KEY_LENGTH) return false;
  const actual = await derive(password, Buffer.from(saltText, 'base64url'));
  return timingSafeEqual(actual, expected);
}
