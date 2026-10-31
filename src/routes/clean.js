import { getSession } from '../lib/auth.js';
import { run } from '../db/index.js';

const RETENTION_SECONDS = 90 * 86400;
const headers = { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' };
const reply = (status, body) => new Response(JSON.stringify(body), { status, headers });

/** 仅手动GET触发，保留status供通知及剩余数据的原文还原使用。 */
export async function clean(request, env) {
  const session = await getSession(request, env);
  if (!session) return reply(401, { success: false, error: '请先登录' });
  const origin = request.headers.get('origin');
  const site = request.headers.get('sec-fetch-site');
  if ((origin && origin !== new URL(request.url).origin)
      || (site && site !== 'same-origin' && site !== 'none')) {
    return reply(403, { success: false, error: '请求来源无效' });
  }
  const before = Math.floor(Date.now() / 1000) - RETENTION_SECONDS;
  try {
    const result = await run(env.DB,
      'DELETE FROM data WHERE serial_no = ?1 AND ts < ?2', [session.serial, before]);
    return reply(200, { success: true, deleted: result.meta?.changes ?? 0, before });
  } catch {
    return reply(500, { success: false, error: '清理失败' });
  }
}
