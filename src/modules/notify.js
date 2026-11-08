/** 通知判断复用统一状态机，余额回查仅在配置了群机器人时按需执行。 */
import { BASE_SECONDS, DEFAULT_BASE_LINE, stepOccupancy } from './occupancy.js';
import { toEpoch } from './collector.js';

export const LOW_BALANCE = 2;

/** 企业微信群机器人 text 消息。url 为空则跳过。返回是否成功。 */
export async function sendWxHook(env, content, url) {
  if (!url) {
    console.error('webhook 地址未配置，跳过推送:', content);
    return false;
  }
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ msgtype: 'text', text: { content } }),
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const body = await res.json().catch(() => ({}));
    if (body.errcode !== 0) throw new Error(`errcode=${body.errcode} ${body.errmsg || ''}`);
    return true;
  } catch (e) {
    console.error('webhook 推送失败:', e.message);
    return false;
  }
}

/**
 * 根据上一状态（含 last_kwh）和本轮采样推进状态并生成通知事件。
 *
 * @param {{last_online_time: string, occupied?: number|null, broke?: number|null, base_line?: string|null, last_kwh?: number|null, delta?: number|null, duration?: number|null}|null} previous
 * @param {{ts: number, kwh: number|null, balance: number|null}} sample
 * @param {number|null} previousBalance 最近一次有效余额
 */
export function advanceStatus(previous, sample, previousBalance = null) {
  const prevTs = previous ? toEpoch(previous.last_online_time) : null;
  const gap = prevTs != null ? sample.ts - prevTs : null;
  const d = (previous && Number.isFinite(sample.kwh) && Number.isFinite(previous.last_kwh))
    ? Number((sample.kwh - previous.last_kwh).toFixed(3))
    : null;

  const next = stepOccupancy(previous, { d, gap });
  const state = {
    occupied: next.occupied,
    broke: previous?.broke ?? 0,
    base_line: next.base_line || previous?.base_line || DEFAULT_BASE_LINE,
    last_kwh: sample.kwh,
    delta: next.delta,
    duration: next.duration,
  };

  const events = [];
  if (sample.balance != null) {
    const rise = previousBalance == null ? 0 : sample.balance - previousBalance;
    if (rise > 1) {
      events.push(`【充值】余额增加${Math.round(rise)}元，当前余额${sample.balance.toFixed(2)}元`);
    }
    state.broke = sample.balance < LOW_BALANCE ? 1 : 0;
    if (state.broke && !previous?.broke) {
      events.push(`【预警】余额仅剩${sample.balance.toFixed(2)}元，请及时充值`);
    }
  }
  if (previous?.occupied != null && state.occupied !== previous.occupied) {
    const balance = sample.balance == null ? '未知' : `${sample.balance.toFixed(2)}元`;
    if (state.occupied) {
      const minutes = Math.max(1, Math.round((gap ?? BASE_SECONDS) / 60));
      const used = d != null && d >= 0 ? d.toFixed(2) : '0.01';
      events.push(`【有人】近${minutes}分钟用电${used}度，当前余额${balance}`);
    } else {
      events.push(`【无人】当前余额${balance}`);
    }
  }
  return { state, events };
}

/** 状态已随采样事务提交；推送失败不回滚，避免重复补发。 */
export async function checkNotifications(env, serial, room, events) {
  const url = env[`WH_${room}`];
  if (!url || events.length === 0) return { events, pushed: false };
  return { events, pushed: await sendWxHook(env, events.join('；'), url) };
}
