/** HS256 JWT，使用 Workers 原生 Web Crypto 签发与验签。 */

const enc = new TextEncoder();
const dec = new TextDecoder();

function b64url(bytes) {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function unb64url(str) {
  const pad = str.length % 4 === 0 ? '' : '='.repeat(4 - (str.length % 4));
  const raw = atob(str.replace(/-/g, '+').replace(/_/g, '/') + pad);
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

function encodeJson(obj) {
  return b64url(enc.encode(JSON.stringify(obj)));
}

async function importKey(secret) {
  return crypto.subtle.importKey(
    'raw',
    enc.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign', 'verify'],
  );
}

/** payload.exp 使用 Unix 秒。 */
export async function signJwt(payload, secret) {
  if (!secret) throw new Error('JWT_SECRET 未配置');
  const head = encodeJson({ alg: 'HS256', typ: 'JWT' });
  const body = encodeJson(payload);
  const data = `${head}.${body}`;
  const key = await importKey(secret);
  const sig = await crypto.subtle.sign('HMAC', key, enc.encode(data));
  return `${data}.${b64url(new Uint8Array(sig))}`;
}

/** 格式、签名或有效期校验失败时统一返回 null。 */
export async function verifyJwt(token, secret) {
  if (!token || !secret || typeof token !== 'string') return null;
  const parts = token.split('.');
  if (parts.length !== 3) return null;

  const [head, body, sig] = parts;
  let ok = false;
  try {
    const key = await importKey(secret);
    ok = await crypto.subtle.verify('HMAC', key, unb64url(sig), enc.encode(`${head}.${body}`));
  } catch {
    return null;
  }
  if (!ok) return null;

  let payload;
  try {
    payload = JSON.parse(dec.decode(unb64url(body)));
  } catch {
    return null;
  }

  // exp 以秒为单位；没有 exp 的 token 视为无效，避免出现永不过期的凭证
  if (typeof payload.exp !== 'number') return null;
  if (payload.exp * 1000 <= Date.now()) return null;

  return payload;
}
