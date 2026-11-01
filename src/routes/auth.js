import { first, run } from '../db/index.js';
import { signJwt } from '../lib/jwt.js';
import { hashPassword, isPasswordHash, verifyPassword } from '../lib/password.js';
import { buildCookie, clearCookie, isSecure, MAX_AGE_SECONDS } from '../lib/auth.js';

const JSON_HEADERS = {
  'content-type': 'application/json; charset=utf-8',
  'cache-control': 'no-store',
};

function reply(body, status, extra) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...JSON_HEADERS, ...(extra || {}) },
  });
}

/** 登录成功后签发 JWT，并写入 HttpOnly Cookie。 */
export async function login(request, env) {
  let body;
  try {
    body = await request.json();
  } catch {
    return reply({ success: false, error: '请求格式不对' }, 400);
  }

  const user = String(body?.user ?? '').replace(/\s+/g, '');
  const pw = String(body?.pw || '');

  if (!user || !pw) {
    return reply({ success: false, error: '请输入账号和密码' }, 400);
  }

  const row = await first(
    env.DB,
    `SELECT user, pw, serial_no FROM users WHERE user = ?1 COLLATE NOCASE`,
    [user],
  );

  const stored = row?.pw;
  const hashed = isPasswordHash(stored);
  const valid = hashed
    ? await verifyPassword(pw, stored)
    : pw === stored && !pw.startsWith('pbkdf2-sha256$');
  if (!valid) {
    return reply({ success: false, error: '账号或密码不对' }, 401);
  }

  if (!hashed) {
    const updated = await run(env.DB,
      'UPDATE users SET pw = ?1 WHERE user = ?2 AND pw = ?3 AND serial_no = ?4',
      [await hashPassword(pw), row.user, stored, row.serial_no],
    );
    if (updated.meta.changes === 0) {
      return reply({ success: false, error: '账号刚刚更新，请重试登录' }, 409);
    }
  }

  const now = Math.floor(Date.now() / 1000);
  const token = await signJwt(
    { sub: row.user, sid: row.serial_no, iat: now, exp: now + MAX_AGE_SECONDS },
    env.JWT_SECRET,
  );

  return reply(
    { success: true, user: row.user },
    200,
    { 'set-cookie': buildCookie(token, { secure: isSecure(request) }) },
  );
}

export async function logout(request) {
  return reply(
    { success: true },
    200,
    { 'set-cookie': clearCookie({ secure: isSecure(request) }) },
  );
}
