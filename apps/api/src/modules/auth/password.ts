import { randomBytes, scrypt, timingSafeEqual, type ScryptOptions } from 'node:crypto';

/**
 * Password hashing with scrypt from node:crypto (no extra dependency). Format:
 *   scrypt$N$r$p$<salt b64>$<hash b64>
 * The parameters are stored with each hash so they can be raised later without locking anyone out.
 */
const N = 2 ** 15;
const R = 8;
const P = 1;
const KEYLEN = 64;
const SALT_LEN = 16;
// scrypt needs 128 · N · r bytes; allow headroom above the 32 MB default limit for N = 2^15.
const MAXMEM = 128 * N * R * 2;

const derive = (password: string, salt: Buffer, n: number, r: number, p: number, keylen: number) =>
  new Promise<Buffer>((resolve, reject) => {
    const opts: ScryptOptions = { N: n, r, p, maxmem: Math.max(MAXMEM, 128 * n * r * 2) };
    scrypt(password.normalize('NFKC'), salt, keylen, opts, (err, key) => (err ? reject(err) : resolve(key)));
  });

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(SALT_LEN);
  const key = await derive(password, salt, N, R, P, KEYLEN);
  return ['scrypt', N, R, P, salt.toString('base64'), key.toString('base64')].join('$');
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [scheme, n, r, p, salt, hash] = stored.split('$');
  if (scheme !== 'scrypt' || !n || !r || !p || !salt || !hash) return false;
  const expected = Buffer.from(hash, 'base64');
  try {
    const actual = await derive(password, Buffer.from(salt, 'base64'), Number(n), Number(r), Number(p), expected.length);
    return actual.length === expected.length && timingSafeEqual(actual, expected);
  } catch {
    return false;
  }
}

/** A valid-looking hash of a random password, used to spend the same time when the email is unknown (no timing oracle). */
let decoy: Promise<string> | undefined;
export const decoyHash = () => (decoy ??= hashPassword(randomBytes(16).toString('hex')));
