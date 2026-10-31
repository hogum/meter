import { getMeters } from '../config.js';
import { persistCollections } from '../modules/collect.js';

const headers = { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' };
const reply = (status, body) => new Response(JSON.stringify(body), { status, headers });

/** 厂商端轻量上报。参数校验不访问数据库，不保存无效上报。 */
export async function upload(request, env) {
  const startedAt = Date.now();
  const params = new URL(request.url).searchParams;
  if (!env.UPLOAD_TOKEN || params.get('tk') !== env.UPLOAD_TOKEN) {
    return reply(401, { success: false, error: '上报凭证无效' });
  }
  if (params.get('act') !== 'up') return reply(400, { success: false, error: '不支持的操作' });
  let meters;
  try {
    meters = getMeters(env);
  } catch {
    return reply(503, { success: false, error: '电表映射配置无效' });
  }
  const meter = meters.find(m => m.serial === params.get('no'));
  if (!meter) return reply(400, { success: false, error: '未知电表' });
  const room = params.get('room');
  if (room && room !== meter.room) return reply(400, { success: false, error: '房间号与电表不匹配' });
  const number = key => {
    const value = params.get(key);
    return value != null && /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)$/.test(value)
      ? Number(value) : NaN;
  };
  const kwh = number('kwh');
  const balance = number('balance');
  if (!Number.isFinite(kwh) || kwh < 0 || !Number.isFinite(balance)) {
    return reply(400, { success: false, error: 'kwh须为非负数，balance须为有效数字' });
  }
  const time = new Date(startedAt + 28800000).toISOString().slice(0, 19).replace('T', ' ');
  let result;
  try {
    result = await persistCollections(env, [{
      ok: true, manual: true, serial: meter.serial, room: meter.room, raw: 'manual', durationMs: null,
      payload: { serialNo: meter.serial, houseName: meter.room, lastOnlineTime: time,
        readNumber: kwh, residualAmount: balance },
    }], { startedAt });
  } catch {
    return reply(500, { success: false, error: '数据库访问失败' });
  }
  if (result.insert_error) return reply(500, { success: false, error: '数据库写入失败' });
  return reply(200, { success: true, result: result.inserted ? 'inserted' : 'skipped', time });
}
