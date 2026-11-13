import { verifyJwt } from './jwt.js';

export const COOKIE_NAME = 'meter_token';

export const MAX_AGE_SECONDS = 7 * 24 * 3600;
const DEMO_USER = 'demo';

export function readCookie(request, name) {
  const raw = request.headers.get('cookie') || '';
  for (const part of raw.split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    if (part.slice(0, i).trim() !== name) continue;
    try {
      return decodeURIComponent(part.slice(i + 1).trim());
    } catch {
      return null;
    }
  }
  return null;
}

/**
 * 返回 { user, serial, exp, demo }，令牌无效或解析异常时返回 null。
 */
export async function getSession(request, env) {
  try {
    const token = readCookie(request, COOKIE_NAME);
    if (!token) return null;
    const payload = await verifyJwt(token, env.JWT_SECRET);
    if (!payload || !payload.sub || !payload.sid) return null;
    // demo 账号也由 users 表认证；账号名只负责选择演示数据源。
    const demo = payload.sub.toLowerCase() === DEMO_USER;
    return { user: payload.sub, serial: payload.sid, exp: payload.exp, demo };
  } catch {
    return null;
  }
}

/** 生成 Set-Cookie 值。线上是 https 才加 Secure，本地 http 加了会导致 cookie 不生效 */
export function buildCookie(value, { maxAge = MAX_AGE_SECONDS, secure = false } = {}) {
  const bits = [
    `${COOKIE_NAME}=${encodeURIComponent(value)}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    `Max-Age=${maxAge}`,
  ];
  if (secure) bits.push('Secure');
  return bits.join('; ');
}

export function clearCookie({ secure = false } = {}) {
  return buildCookie('', { maxAge: 0, secure });
}

export function isSecure(request) {
  try {
    return new URL(request.url).protocol === 'https:';
  } catch {
    return false;
  }
}
