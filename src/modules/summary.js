import { all, first } from '../db/index.js';
import { UP_RUN, FLAT_RUN } from './occupancy.js';
import { successfulCollectionSql, readCollectionError } from './collection-error.js';
import { analyzeHistory, historyIntervals, HISTORY_BASE_SECONDS, HISTORY_BASE_STEP,
  HISTORY_CONTEXT_SECONDS, HISTORY_FLAT_SECONDS, HISTORY_BRIDGE_SECONDS, HEATING_LONG_MAX_SECONDS,
  HEATING_LONG_MIN_WATTS, HEATING_QUIET_SECONDS, HEATING_MAX_SECONDS, HEATING_MIN_KWH } from './history-occupancy.js';

export const RANGE_SECONDS = {
  '6h': 6 * 3600,
  '12h': 12 * 3600,
  '24h': 24 * 3600,
  '3d': 3 * 86400,
  '7d': 7 * 86400,
  '30d': 30 * 86400,
};

export const DEFAULT_RANGE = '24h';

// 20 分钟窗口缓解电表量化噪声，仅平滑曲线，不参与有人判断。
const POWER_WINDOW_SECONDS = 1200;

/** 用电量累计有效相邻增量；有人区间不跨越未知片段，末态取选中范围末次采样。 */
export async function buildSummary(env, { serial, range = DEFAULT_RANGE, from, to } = {}) {
  const latestEntry = await first(
    env.DB,
    `SELECT ts, time, kwh, balance, ms, raw, room FROM data
      WHERE serial_no = ?1 ORDER BY ts DESC LIMIT 1`,
    [serial],
  );
  if (!latestEntry) return null;
  const latestStatus = await first(env.DB,
    `SELECT occupied FROM status WHERE serial_no = ?1 ORDER BY last_online_time DESC LIMIT 1`,
    [serial]);
  // 查询范围以最新采集为锚点；卡片在失败时保留上一次成功响应的数据。
  const latest = readCollectionError(latestEntry.raw, latestEntry.ms)
    ? await first(env.DB, `SELECT ts, time, kwh, balance, ms, raw, room FROM data
        WHERE serial_no = ?1 AND ${successfulCollectionSql()}
        ORDER BY ts DESC LIMIT 1`, [serial]) ?? latestEntry
    : latestEntry;

  // 阀门状态从最近一次成功厂商响应提取。
  const valveCode = (() => {
    const m = /"valveState":(\d+)/.exec(latest.raw || '');
    return m ? Number(m[1]) : null;
  })();
  const valveName = (() => {
    const m = /"valveStateName":"([^"]*)"/.exec(latest.raw || '');
    return m ? m[1] : null;
  })();

  // 区间：传了 from/to 就用自定义（Unix 秒），否则按预设范围从最新采样往回推。
  // 仅在截断后仍有有效区间时截到最新采样，避免导出把倒置或等长边界当成默认范围。
  const custom = Number.isFinite(from) && Number.isFinite(to) && to > from;
  const untilTs = custom
    ? (from < latestEntry.ts ? Math.min(to, latestEntry.ts) : to)
    : latestEntry.ts;
  const sinceTs = custom
    ? from
    : latestEntry.ts - (RANGE_SECONDS[range] || RANGE_SECONDS[DEFAULT_RANGE]);
  const span = Math.max(untilTs - sinceTs, 1);

  // 两端各取上下文：历史可用后续数据识别加热和短暂停顿，但展示不超出区间。
  const fetchFrom = sinceTs - HISTORY_CONTEXT_SECONDS;
  const fetchUntil = Math.min(latestEntry.ts, untilTs + HISTORY_CONTEXT_SECONDS);
  const rows = await all(
    env.DB,
    `SELECT ts, kwh, balance FROM data
      WHERE serial_no = ?1 AND ts >= ?2 AND ts <= ?3
        AND ${successfulCollectionSql()}
      ORDER BY ts`,
    [serial, fetchFrom, fetchUntil],
  );

  const recs = analyzeHistory(rows);

  // 曲线功率使用 20 分钟窗口；若相邻采样更稀疏，则直接计算该段平均功率。
  let pBase = 0;
  for (let i = 0; i < recs.length; i++) {
    if (recs[i].break_before) pBase = i;
    while (pBase < i && recs[i].t - recs[pBase].t > POWER_WINDOW_SECONDS) pBase++;
    if (pBase === i && !recs[i].break_before) pBase = i - 1;
    const pSpan = recs[i].t - recs[pBase].t;
    const pAcc = recs[i].k - recs[pBase].k;
    recs[i].w = pSpan > 0 && Number.isFinite(recs[i].k) && Number.isFinite(recs[pBase].k)
      ? Math.max(Math.round((pAcc / pSpan) * 3600 * 1000), 0) : null;
  }

  const clip = (spans) => spans
    .filter(([a, b]) => b > sinceTs && a < untilTs)
    .map(([a, b]) => [Math.max(a, sinceTs), Math.min(b, untilTs)]);
  const segments = historyIntervals(recs, 1);
  const inRange = clip(segments);
  const unknownShades = clip(historyIntervals(recs, null));
  const shades = inRange;
  const lastVisible = recs.findLast((r) => r.t <= untilTs);
  const lastState = lastVisible?.occ ?? null;
  const occupied = latestStatus?.occupied == null ? null : latestStatus.occupied === 1;
  const activeSeconds = inRange.reduce((sum, [a, b]) => sum + b - a, 0);
  const unknownSeconds = unknownShades.reduce((sum, [a, b]) => sum + b - a, 0);

  const points = recs
    .filter((r) => r.t >= sinceTs && r.t <= untilTs)
    .map((r) => ({ t: r.t, d: r.d, w: r.w, b: r.b, k: r.k, occ: r.occ, kind: r.kind,
      gap: r.gap, heater_step: r.heater_step, burst_kwh: r.burst_kwh, burst_seconds: r.burst_seconds,
      bridged_idle: r.bridged_idle ?? false }));
  // 首个点的增量始于查询范围之外，不计入区间用电。
  const windowKwh = points.slice(1).reduce((sum, point) => sum + (point.d ?? 0), 0);

  const rangeDays = Math.max(span / 86400, 1 / 24);
  const avgDailyKwh = points.length ? Number((windowKwh / rangeDays).toFixed(2)) : null;

  let windowCost = 0;
  let rechargeCount = 0;
  let rechargeAmount = 0;
  for (let i = 1; i < points.length; i++) {
    if (!Number.isFinite(points[i - 1].b) || !Number.isFinite(points[i].b)) continue;
    const drop = points[i - 1].b - points[i].b;
    if (drop > 0) windowCost += drop;
    const rise = points[i].b - points[i - 1].b;
    if (rise > 0.01) {
      rechargeCount += 1;
      // 按当前场景估算充值额：较大涨幅取整十元，抵消采样间消耗。
      rechargeAmount += rise >= 20 ? Math.round(rise / 10) * 10 : Math.round(rise);
    }
  }
  const avgDailyCost = points.length ? Number((windowCost / rangeDays).toFixed(2)) : null;

  // 保留两位小数，减少前端换算小时后的舍入误差。
  const daysLeft = (avgDailyCost && avgDailyCost > 0 && typeof latest.balance === 'number')
    ? Math.round((latest.balance / avgDailyCost) * 100) / 100
    : null;

  // 额外取一条前置采样，用于计算最近 20 条记录的首个增量。
  const rawRecent = await all(
    env.DB,
    `SELECT ts, kwh, balance, ms, raw FROM data
      WHERE serial_no = ?1 AND ts <= ?2 ORDER BY ts DESC LIMIT 21`,
    [serial, untilTs],
  );

  const asc = [...rawRecent].reverse();
  const recent = asc
    .map((r, i) => {
      const prev = i > 0 ? asc[i - 1] : null;
      const delta = (prev && typeof r.kwh === 'number' && typeof prev.kwh === 'number')
        ? Number((r.kwh - prev.kwh).toFixed(2))
        : null;
      return { ts: r.ts, kwh: r.kwh, balance: r.balance, ms: r.ms, delta,
        error: readCollectionError(r.raw, r.ms) };
    })
    // 先计算增量再裁剪，避免首条丢失区间外基线。
    .reverse()
    .filter((r) => r.ts >= sinceTs)
    .slice(0, 20);

  // 实际采样间隔可能不同于 Cron 周期，展示相邻间隔的中位数。
  const gaps = [];
  for (let i = 1; i < asc.length; i++) gaps.push(asc[i].ts - asc[i - 1].ts);
  gaps.sort((a, b) => a - b);
  const sampleInterval = gaps.length ? gaps[Math.floor(gaps.length / 2)] : null;

  return {
    meter: {
      serial_no: serial,
      room: latest.room || null,
      latest: {
        ts: latest.ts,
        time: latest.time,
        kwh: latest.kwh,
        balance: latest.balance,
        ms: latest.ms,
      },
      valve: valveName ? { code: valveCode, name: valveName }
        : latest.raw === 'manual' ? { code: null, name: '合闸未知' } : null,
    },
    status: {
      occupied,
      since: lastState === 1 && inRange.length ? inRange.at(-1)[0] : null,
      at: lastVisible?.t ?? null,
    },
    stats: {
      range: custom ? 'custom' : range,
      custom,
      window_kwh: Number(windowKwh.toFixed(2)),
      window_hours: Number((activeSeconds / 3600).toFixed(1)),
      unknown_hours: Number((unknownSeconds / 3600).toFixed(1)),
      avg_daily_kwh: avgDailyKwh,
      avg_daily_cost: avgDailyCost,
      days_left: daysLeft,
      window_cost: Number(windowCost.toFixed(2)),
      recharge_count: rechargeCount,
      recharge_amount: Math.round(rechargeAmount),
      sample_interval: sampleInterval,
      occupancy_rule: { mode: 'history', up_run: UP_RUN, flat_run: FLAT_RUN,
        flat_seconds: HISTORY_FLAT_SECONDS,
        bridge_seconds: HISTORY_BRIDGE_SECONDS, heating_long_max_seconds: HEATING_LONG_MAX_SECONDS,
        heating_long_min_watts: HEATING_LONG_MIN_WATTS,
        heater_step: HISTORY_BASE_STEP, base_seconds: HISTORY_BASE_SECONDS,
        heating_quiet_seconds: HEATING_QUIET_SECONDS, heating_max_seconds: HEATING_MAX_SECONDS, heating_min_kwh: HEATING_MIN_KWH },
      exhausted_at: (daysLeft && daysLeft > 0) ? latest.ts + Math.round(daysLeft * 86400) : null,
    },
    points,
    segments,
    shades,
    unknown_shades: unknownShades,
    recent,
    // 页面回填和导出共用这个区间。
    window: custom ? { from: sinceTs, to: untilTs } : null,
  };
}
