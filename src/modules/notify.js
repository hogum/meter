/** 通知判断只依赖最新 status 和本轮采样，不保留历史窗口。 */
import { HEATER_STEP, MAX_GAP_SECONDS } from './occupancy.js';

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

/** delta 是紧邻上一采样间隔的有效增量；超阈值、回退和无效数据打断连续判断。 */
export function advanceStatus(previous, sample, previousBalance = null) {
  const state = {
    occupied: previous?.occupied ?? 0,
    low_balance: previous?.low_balance ?? 0,
    delta: previous?.delta ?? null,
    last_kwh: sample.kwh,
  };
  // 持久化增量可能来自旧阈值，超出当前阈值时重新建立连续依据。
  if (state.delta > HEATER_STEP) state.delta = null;
  const gap = previous
    ? sample.ts - Date.parse(previous.last_online_time.replace(' ', 'T') + '+08:00') / 1000 : null;
  if (previous) {
    if (gap <= 0 || gap > MAX_GAP_SECONDS || !Number.isFinite(sample.kwh) || !Number.isFinite(previous.last_kwh)) {
      // 无法组成有效相邻采样，重建基线，不凭空改变有人状态。
      state.delta = null;
    } else {
      const d = Number((sample.kwh - previous.last_kwh).toFixed(3));
      if (d >= 0 && d <= HEATER_STEP) {
        if (d === 0 && state.delta === 0) state.occupied = 0;
        if (d > 0 && state.delta > 0) state.occupied = 1;
        state.delta = d;
      } else {
        state.delta = null;
      }
    }
  }
  const events = [];
  if (sample.balance != null) {
    const rise = previousBalance == null ? 0 : sample.balance - previousBalance;
    if (rise > 1) {
      events.push(`【充值】余额增加${Math.round(rise)}元，当前余额${sample.balance.toFixed(2)}元`);
    }
    state.low_balance = sample.balance < LOW_BALANCE ? 1 : 0;
    if (state.low_balance && !previous?.low_balance) {
      events.push(`【预警】余额仅剩${sample.balance.toFixed(2)}元，请及时充值`);
    }
  }
  if (previous?.occupied != null && state.occupied !== previous.occupied) {
    if (state.occupied) {
      const minutes = Math.max(1, Math.round(gap / 60));
      const used = (sample.kwh - previous.last_kwh).toFixed(2);
      const balance = sample.balance == null ? '未知' : `${sample.balance.toFixed(2)}元`;
      events.push(`【有人】近${minutes}分钟用电${used}度，当前余额${balance}`);
    } else {
      const balance = sample.balance == null ? '未知' : `${sample.balance.toFixed(2)}元`;
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
