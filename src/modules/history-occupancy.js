/** 历史看板：按实际采样间隔过滤热水器，仅缺失或异常读数重置判断。 */
import { UP_RUN, FLAT_RUN } from './occupancy.js';

// 上游约 182 秒更新一次；历史中常见间隔为 181/182、363、545 秒。
export const HISTORY_BASE_SECONDS = 182;
export const HISTORY_BASE_STEP = 0.1;
export const HEATING_QUIET_SECONDS = 900;
export const HEATING_MAX_SECONDS = 1200;
export const HISTORY_FLAT_SECONDS = 900;
export const HISTORY_BRIDGE_SECONDS = 1200;
export const HEATING_LONG_MAX_SECONDS = 2400;
export const HEATING_LONG_MIN_WATTS = 600;
export const HEATING_MIN_KWH = 0.2;
export const HISTORY_CONTEXT_SECONDS = HEATING_QUIET_SECONDS + HEATING_LONG_MAX_SECONDS;

// 安静背景允许一个最小读数单位的变化，但必须有完整的前后证据。
function quietAround(points, index, direction) {
  let end = index;
  while (end + direction >= 0 && end + direction < points.length) {
    const next = end + direction;
    if (points[direction > 0 ? next : end].break_before) return false;
    end = next;
    if (Math.abs(points[end].k - points[index].k) > 0.010001) return false;
    if (Math.abs(points[end].t - points[index].t) >= HEATING_QUIET_SECONDS) return true;
  }
  return false;
}

function steadyHeating(points, first, last, total, duration) {
  if (duration <= HEATING_MAX_SECONDS || duration > HEATING_LONG_MAX_SECONDS
    || total * 3600000 / duration < HEATING_LONG_MIN_WATTS || last - first < 3) return false;
  // 首尾可能只覆盖部分加热；检查中间至少两个完整间隔的功率是否稳定。
  const core = points.slice(first + 1, last);
  const mean = core.reduce((sum, p) => sum + p.d, 0) * 3600000
    / core.reduce((sum, p) => sum + p.gap, 0);
  return core.every(p => Math.abs(p.d * 3600000 / p.gap - mean) <= mean * 0.25);
}

export function historyHeaterStep(gap) {
  // 电表读数精度为 0.01 度，阈值也保留两位，避免 363 秒时误排除恰好 0.2 度。
  return Number((HISTORY_BASE_STEP * Math.max(gap, HISTORY_BASE_SECONDS) / HISTORY_BASE_SECONDS).toFixed(2));
}

/** 历史可看前后数据：前后安静、短时集中上涨的孤立段按疑似热水器过滤。 */
function markIsolatedHeating(points) {
  for (let i = 1; i < points.length; i++) {
    if (points[i].break_before || !(points[i].d > 0)) continue;
    const first = i;
    let last = i;
    let total = points[i].d;
    while (last + 1 < points.length && !points[last + 1].break_before && points[last + 1].d > 0) {
      total += points[++last].d;
    }
    i = last;
    const duration = points[last].t - points[first - 1].t;
    const shortHeating = duration <= HEATING_MAX_SECONDS;
    const longHeating = steadyHeating(points, first, last, total, duration);
    if ((!shortHeating && !longHeating) || total < HEATING_MIN_KWH - 1e-9
      || !quietAround(points, first - 1, -1) || !quietAround(points, last, 1)) continue;
    for (let j = first; j <= last; j++) {
      points[j].kind = 'heater_burst';
      points[j].burst_kwh = Number(total.toFixed(3));
      points[j].burst_seconds = duration;
    }
  }
}

/** 输入完整时间线，返回同样数量的点；采样间隔长短本身不构成断点。 */
export function analyzeHistory(rows) {
  const points = rows.map((row, i) => {
    const prev = rows[i - 1];
    const gap = prev ? row.ts - prev.ts : null;
    const validPair = prev && Number.isFinite(row.kwh) && Number.isFinite(prev.kwh);
    const delta = validPair ? Number((row.kwh - prev.kwh).toFixed(3)) : null;
    const broken = !prev || !validPair || gap <= 0 || delta < 0;
    const point = { t: row.ts, k: row.kwh, b: row.balance, d: delta != null && delta >= 0 ? delta : null,
      gap, heater_step: gap == null ? null : historyHeaterStep(gap), break_before: broken,
      kind: 'unknown', occ: null, w: null };
    if (!broken) point.kind = delta > point.heater_step ? 'heater' : delta > 0 ? 'up' : 'flat';
    return point;
  });
  markIsolatedHeating(points);
  let state = null;
  let runKind = null;
  let runLength = 0;
  let flatSince = null;
  for (const point of points) {
    if (point.break_before) {
      state = null;
      runKind = null;
      runLength = 0;
      flatSince = null;
      continue;
    }
    if (point.kind === 'up' || point.kind === 'flat') {
      if (point.kind === 'flat') flatSince ??= point.t - point.gap;
      else flatSince = null;
      runLength = point.kind === runKind ? runLength + 1 : 1;
      runKind = point.kind;
      if (runKind === 'up' && runLength >= UP_RUN) state = 1;
      if (runKind === 'flat' && runLength >= FLAT_RUN
        && point.t - flatSince >= HISTORY_FLAT_SECONDS) state = 0;
    } else {
      // 加热期间并非读数持平，不能把两侧安静时间累计为连续持平。
      flatSince = null;
      if (runKind === 'flat') {
        runKind = null;
        runLength = 0;
      }
    }
    point.occ = state;
  }
  bridgeBriefIdle(points);
  return points;
}

/** 历史回看：已确认有人，短暂停顿后再次连续上涨时，连接中间持平段。 */
function bridgeBriefIdle(points) {
  for (let first = 1; first < points.length; first++) {
    if (points[first].kind !== 'flat' || points[first].break_before || points[first - 1].occ !== 1) continue;
    let last = first;
    while (last + 1 < points.length && points[last + 1].kind === 'flat' && !points[last + 1].break_before) last++;
    const up = points[last + 1];
    const confirm = points[last + 2];
    if (up?.kind === 'up' && confirm?.kind === 'up' && !up.break_before && !confirm.break_before
      && up.t - points[first - 1].t <= HISTORY_BRIDGE_SECONDS
      && confirm.t - up.t <= HISTORY_BASE_SECONDS * 2) {
      for (let j = first; j <= last + 1; j++) {
        points[j].occ = 1;
        points[j].bridged_idle = true;
      }
    }
    first = last;
  }
}

/** 相邻采样之间的区间，只合并首尾相接且状态相同的区间，不跨未知片段。 */
export function historyIntervals(points, occupied) {
  const spans = [];
  for (let i = 1; i < points.length; i++) {
    const p = points[i];
    const state = p.break_before ? null : p.occ;
    if (state !== occupied) continue;
    const start = points[i - 1].t;
    const end = p.t;
    const last = spans.at(-1);
    if (last && last[1] === start) last[1] = end;
    else spans.push([start, end]);
  }
  return spans;
}
