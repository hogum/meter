/** 历史看板：复用统一状态机与 base_line 判定有人/无人区间。 */
import {
  BASE_SECONDS,
  DEFAULT_BASE_LINE,
  heaterStep,
  parseBaseline,
  stepOccupancy,
} from './occupancy.js';

export const HISTORY_CONTEXT_SECONDS = 3600;
export const TAIL_HOLD_SECONDS = 370;

/** 输入按 ts 升序的完整采样，返回同样数量的点；断档、回退和首点记为 break_before。 */
export function analyzeHistory(rows, baseLine = DEFAULT_BASE_LINE) {
  const { baseLine: normalizedBase, winSec } = parseBaseline(baseLine);
  const points = [];
  const initial = { occupied: 0, delta: 0, duration: null, base_line: normalizedBase };
  let state = initial;
  let awaitingConfirmation = true;
  let quietSeconds = 0;

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    const prev = i > 0 ? rows[i - 1] : null;
    const gap = prev ? row.ts - prev.ts : null;
    const validPair = prev && Number.isFinite(row.kwh) && Number.isFinite(prev.kwh);
    const delta = validPair ? Number((row.kwh - prev.kwh).toFixed(3)) : null;
    const hStep = gap != null && gap > 0 ? heaterStep(gap) : null;

    if (!prev) {
      points.push({
        t: row.ts,
        k: row.kwh,
        b: row.balance,
        d: null,
        gap: null,
        heater_step: null,
        break_before: true,
        delta_level: 0,
        kind: 'unknown',
        occ: null,
        w: null,
      });
      continue;
    }

    const next = stepOccupancy(state, { d: delta, gap });

    if (next.broken) {
      state = initial;
      awaitingConfirmation = true;
      quietSeconds = 0;
      points.push({
        t: row.ts,
        k: row.kwh,
        b: row.balance,
        d: delta != null && delta >= 0 ? delta : null,
        gap,
        heater_step: hStep,
        break_before: true,
        delta_level: 0,
        kind: 'unknown',
        occ: null,
        w: null,
      });
      continue;
    }

    state = next;
    if (awaitingConfirmation) {
      quietSeconds = state.mode === 0 ? quietSeconds + gap : 0;
      awaitingConfirmation = state.occupied !== 1 && quietSeconds < winSec;
    }

    points.push({
      t: row.ts,
      k: row.kwh,
      b: row.balance,
      d: delta >= 0 ? delta : null,
      gap,
      heater_step: hStep,
      break_before: false,
      delta_level: state.mode,
      kind: state.mode === 2 ? 'heater' : (state.mode === 1 && delta > 0) ? 'up' : 'flat',
      occ: awaitingConfirmation ? null : state.occupied,
      w: null,
    });
  }

  for (let i = 1; i < points.length; i++) {
    if (points[i].occ === 1 && points[i - 1].occ !== 1) {
      for (let j = i - 1; j >= 1 && !points[j].break_before && points[j].delta_level === 1 && points[j].occ !== 1; j--) {
        points[j].occ = 1;
      }
    } else if (points[i].occ === 0 && points[i - 1].occ === 1) {
      let lastActive = i - 1;
      while (
        lastActive >= 1 &&
        !points[lastActive].break_before &&
        points[lastActive].delta_level !== 1 &&
        points[lastActive].occ === 1
      ) {
        lastActive--;
      }
      const cutoffTs = points[lastActive]?.delta_level === 1
        ? points[lastActive].t + TAIL_HOLD_SECONDS
        : 0;
      for (let j = i - 1; j > lastActive && points[j].t > cutoffTs; j--) {
        points[j].occ = 0;
      }
    }
  }

  return points;
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
