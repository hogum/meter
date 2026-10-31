/** 单列密码格式：算法$迭代次数$随机盐(hex)$哈希(hex)。 */
const ITERATIONS = 100000;
const encoder = new TextEncoder();
const FORMAT = /^pbkdf2-sha256\$100000\$[0-9a-f]{32}\$[0-9a-f]{64}$/;

const hex = (bytes) => Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
const unhex = (text) => Uint8Array.from(text.match(/../g), (pair) => parseInt(pair, 16));

async function derive(password, salt) {
  const key = await crypto.subtle.importKey('raw', encoder.encode(password), 'PBKDF2', false, ['deriveBits']);
  return new Uint8Array(await crypto.subtle.deriveBits(
    { name: 'PBKDF2', hash: 'SHA-256', salt, iterations: ITERATIONS }, key, 256));
}

export function isPasswordHash(value) {
  return typeof value === 'string' && FORMAT.test(value);
}

export async function hashPassword(password) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  return `pbkdf2-sha256$${ITERATIONS}$${hex(salt)}$${hex(await derive(password, salt))}`;
}

export async function verifyPassword(password, stored) {
  if (!isPasswordHash(stored)) return false;
  const [, , salt, hash] = stored.split('$');
  const actual = await derive(password, unhex(salt));
  const expected = unhex(hash);
  let difference = 0;
  for (let i = 0; i < expected.length; i++) difference |= actual[i] ^ expected[i];
  return difference === 0;
}
