/** 实时通知与历史看板共用的有人/无人状态机及近 7 天基线寻优。 */

export const DEFAULT_BASE_LINE = '12w/15m';
export const BASE_SECONDS = 182;
export const HEATER_BASE_STEP = 0.09;
// 允许约 15 分钟采样的网络/时钟抖动，避免 5 × 182 秒被误判为断档。
export const MAX_GAP_SECONDS = 915;
export const ACTIVE_CONFIRM_SECONDS = 300;
export const HIGH_BASE_CONFIRM_SECONDS = 540;
const MAX_QUIET_GAP_SECONDS = 2700;
const SHORT_SEGMENT_SECONDS = 2700;
const HEATER_CONFIRM_SECONDS = 720;
const FAST_WAKE_SPAN_SECONDS = 915;
const HEATER_EDGE_WATTS = 1200;
const HEATER_EDGE_QUIET_SECONDS = 900;
const HEATER_OBSERVE_SECONDS = 900;

/** 解析 "Ww/Mm" 格式基线；缺失或格式不合法时回退默认 "12w/15m"。 */
export function parseBaseline(baseLine) {
  const m = /^(\d+)w\/(\d+)m$/i.exec(String(baseLine || '').trim());
  const baseW = m ? Math.max(1, Number(m[1])) : 12;
  const winMin = m ? Math.max(1, Number(m[2])) : 15;
  const winSec = winMin * 60;
  return {
    baseW,
    winMin,
    winSec,
    maxTickSpan: Math.min(36000 / baseW, winSec),
    baseLine: `${baseW}w/${winMin}m`,
  };
}

/** 按实际采样间隔计算单步疑似热水器阈值（kWh）。 */
export function heaterStep(gap) {
  return Number((HEATER_BASE_STEP * Math.max(gap ?? BASE_SECONDS, BASE_SECONDS) / BASE_SECONDS).toFixed(2));
}

/**
 * 单步状态机，delta 只保存等级 0–7，duration 只保存当前阶段的秒数。
 * 0–5 沿用原等级，6 = 疑似加热前沿，7 = 加热后观察。
 * 有人时累计静默；无人时按等级分别累计跳字等待、活动确认或连续加热。
 * mode 对外合并为 0 = 静默/基线内，1 = 活动，2 = 加热。
 */
export function stepOccupancy(previous, step = {}) {
  return stepWithBaseline(previous, step, parseBaseline(previous?.base_line));
}

function stepWithBaseline(previous, { d, gap }, { baseW, winSec, maxTickSpan, baseLine }) {
  const occupied = previous?.occupied === 1 ? 1 : 0;
  const validPhase = Number.isInteger(previous?.delta) && previous.delta >= 0 && previous.delta <= 7;
  const level = validPhase ? previous.delta : 0;
  const timer = validPhase && Number.isFinite(previous?.duration) && previous.duration >= 0
    ? Math.round(previous.duration) : 0;
  const highBase = baseW > 40;
  const warming = !occupied && (level === 1 || level === 5);
  const result = (occ, delta, duration, effW, broken = false) => ({
    occupied: occ, delta, duration: Math.round(duration),
    mode: delta === 2 || delta === 3 || delta === 6 ? 2 : delta === 1 || delta === 5 ? 1 : 0,
    base_line: baseLine, effW: effW == null ? null : Math.round(effW), broken,
  });
  if (!Number.isFinite(gap) || gap <= 0 || gap > MAX_QUIET_GAP_SECONDS || !Number.isFinite(d) || d < 0) {
    return result(occupied, 0, occupied ? 0 : winSec, null, true);
  }
  const avgW = d * 3600000 / gap;
  const moderateGap = gap > MAX_GAP_SECONDS && avgW <= baseW;
  if (gap > MAX_GAP_SECONDS && !moderateGap) {
    return result(occupied, 0, occupied ? 0 : winSec, null, true);
  }

  if (!occupied && !moderateGap) {
    // 6: 疑似加热前沿；7: 加热后观察。均为独立等级，duration 仍是秒数。
    if (level === 6) {
      if (avgW >= HEATER_EDGE_WATTS) {
        const heating = timer + gap;
        const confirmed = heating >= HEATER_CONFIRM_SECONDS;
        const nextLevel = d >= heaterStep(gap) ? 2 : 6;
        return result(confirmed ? 1 : 0, nextLevel, confirmed ? 0 : heating, avgW);
      }
      // 前沿后的下降步仍可能是同一次加热的尾沿，不把加热时长当作活动确认。
      return d > 0 ? result(0, 3, Math.max(timer, winSec), avgW)
        : result(0, gap < HEATER_OBSERVE_SECONDS ? 7 : 0, gap, 0);
    }
    if ((level === 2 || level === 3 || level === 7) && d === 0) {
      const age = level === 7 ? timer + gap : gap;
      return result(0, age < HEATER_OBSERVE_SECONDS ? 7 : 0, Math.min(86400, age), 0);
    }
    // 常规低底噪采样保护刚跳字后的脉冲；活动待确认后的高功率步
    // 也先按加热前沿观察，覆盖稀疏采样拆开的保温脉冲，不继承活动计时。
    const regularGap = gap <= BASE_SECONDS * 1.5;
    const idleEdge = level === 0 && ((!highBase && regularGap) || timer >= HEATER_EDGE_QUIET_SECONDS);
    const pendingEdge = level === 1 || level === 5;
    if ((idleEdge || pendingEdge)
        && avgW >= HEATER_EDGE_WATTS && d < heaterStep(gap)) {
      return result(0, 6, Math.min(gap, BASE_SECONDS), avgW);
    }
  }

  // 无人时按当前阶段计时；有人时始终保留静默倒计时。
  const quiet = occupied ? timer : 0;
  if (!moderateGap && d > 0 && d >= heaterStep(gap)) {
    if (!occupied) {
      const heating = level === 2 ? timer + gap : Math.min(gap, BASE_SECONDS);
      const confirmed = heating >= HEATER_CONFIRM_SECONDS;
      return result(confirmed ? 1 : 0, 2, confirmed ? 0 : heating, avgW);
    }
    return result(1, 2, level === 2 ? quiet : Math.max(0, quiet - BASE_SECONDS * 2), avgW);
  }
  if (!moderateGap && d > 0 && level === 2) {
    return result(occupied, 3, occupied ? quiet : Math.max(timer, winSec), avgW);
  }

  // 用当前阶段计时近似跳字跨度，不额外保存独立计数器。
  let age = 0;
  if (level === 0 || level === 7) age = timer;
  else if (level === 5) age = highBase ? BASE_SECONDS : Math.max(BASE_SECONDS, timer - BASE_SECONDS);
  else if (level === 2 || level === 3) age = occupied ? quiet : timer;
  // 尾步后又有至少两格普通增量，按新活动计时；不携带加热时长，
  // 也不让尾步保存的保守等待时间稀释新的活动证据。
  const afterTailActivity = !occupied && level === 3 && d >= 0.02;
  const span = level === 1 || level === 4 || afterTailActivity ? gap : (age || BASE_SECONDS) + gap;
  const effW = moderateGap ? avgW : d * 3600000 / span;
  const wakeW = highBase ? baseW : Math.max(baseW * 1.4, 20);
  if (d > 0 && effW > baseW) {
    if (occupied) return result(1, 1, 0, effW);
    if (effW > wakeW) {
      const instant = !highBase && d === 0.01 && level !== 4 && level !== 3 && level !== 7
        && span <= FAST_WAKE_SPAN_SECONDS && span < maxTickSpan;
      const active = warming ? timer + gap : Math.min(gap, BASE_SECONDS);
      if (instant || active >= (highBase ? HIGH_BASE_CONFIRM_SECONDS : ACTIVE_CONFIRM_SECONDS)) return result(1, 1, 0, effW);
      return result(0, 1, active, effW);
    }
  }
  const maxWarmSpan = highBase ? 36000 / baseW : 36000 / wakeW;
  // 高基线要求连续活动采样，零增量结束确认，避免缺少独立计时器而无限保留。
  if (warming && !highBase && !moderateGap && d === 0 && age + gap < maxWarmSpan) {
    return result(0, 5, timer + gap, 0);
  }
  if (occupied) {
    const nextQuiet = quiet + gap;
    return nextQuiet < winSec ? result(1, d > 0 ? 4 : 0, nextQuiet, effW)
      : result(0, d > 0 ? 4 : 0, d > 0 ? 0 : age + gap, effW);
  }
  return result(0, d > 0 ? 4 : 0, d > 0 ? 0 : Math.min(86400, age + gap), effW);
}

/**
 * 从近 7 天采样序列（{ts, kwh}[]）计算最优 base_line（"Ww/Mm"）。
 * 根据回放得分选择基线，样本不足时沿用已有基线。
 */
export function computeOptimalBaseline(rows, currentBaseLine = DEFAULT_BASE_LINE) {
  const fallback = parseBaseline(currentBaseLine).baseLine;
  if (!Array.isArray(rows) || rows.length < 20) return fallback;

  const steps = [];
  const simSteps = [];
  let prevHeater = false;
  for (let i = 1; i < rows.length; i++) {
    const prev = rows[i - 1];
    const cur = rows[i];
    const gap = cur.ts - prev.ts;
    const valid = Number.isFinite(cur.kwh) && Number.isFinite(prev.kwh);
    const d = valid ? Number((cur.kwh - prev.kwh).toFixed(3)) : null;
    simSteps.push({ d, gap });
    if (gap > 0 && gap <= MAX_GAP_SECONDS && Number.isFinite(d) && d >= 0) {
      const primary = d >= heaterStep(gap);
      const isHeater = primary || (d > 0 && prevHeater);
      prevHeater = primary;
      steps.push({ ts: cur.ts, gap, d: isHeater ? 0 : d });
    } else {
      prevHeater = false;
    }
  }

  if (steps.length < 20) return fallback;

  // 统计 2 小时滑窗（步长 30 分钟）的非热水器平均功率，提取 P15 作为无人底噪基准
  const winWatts = [];
  let winStart = 0;
  let winEnd = 0;
  let winDur = 0;
  let winKwh = 0;
  for (let s = steps[0].ts; s + 7200 <= steps.at(-1).ts; s += 1800) {
    while (winEnd < steps.length && steps[winEnd].ts <= s + 7200) {
      winDur += steps[winEnd].gap;
      winKwh += steps[winEnd].d;
      winEnd++;
    }
    while (winStart < winEnd && steps[winStart].ts <= s) {
      winDur -= steps[winStart].gap;
      winKwh -= steps[winStart].d;
      winStart++;
    }
    if (winDur >= 5400) winWatts.push((winKwh * 3600000) / winDur);
  }
  if (!winWatts.length) return fallback;
  winWatts.sort((a, b) => a - b);
  const p15W = winWatts[Math.floor(winWatts.length * 0.15)];
  const minBaseW = Math.max(12, Math.ceil(p15W * 1.25));

  // 阈值略高于整数个采样间隔的量化功率，给正常采样抖动留余量。
  const candidates = new Set([minBaseW]);
  for (let k = 2; k <= 16; k++) {
    const tickW = 36000 / (k * BASE_SECONDS);
    const baseW = Math.ceil(36000 / (k * (BASE_SECONDS - 2)));
    if (baseW >= minBaseW) candidates.add(baseW);
    if (minBaseW >= Math.floor(tickW) && minBaseW < baseW) candidates.delete(minBaseW);
  }

  const current = parseBaseline(fallback);
  const gridCandidates = new Set(candidates);
  // 当前配置也参与同一评分，包含非网格配置；低于底噪下界时不保留。
  if (current.baseW >= minBaseW) candidates.add(current.baseW);
  let best = null;
  for (const baseW of candidates) {
    const windows = gridCandidates.has(baseW) ? new Set([5, 9, 15, 23, 33]) : new Set();
    if (baseW === current.baseW) windows.add(current.winMin);
    for (const winMin of windows) {
      const candidate = `${baseW}w/${winMin}m`;
      const baseline = parseBaseline(candidate);

      const initial = { occupied: 0, delta: 0, duration: baseline.winSec, base_line: candidate };
      let state = initial;
      let runSeconds = 0;
      let runStartedWithFlip = false;
      let flips = 0;
      let shortSegs = 0;
      let avoidableGapSec = 0;
      for (const s of simSteps) {
        const next = stepWithBaseline(state, s, baseline);
        if (next.broken) {
          if (Number.isFinite(s.d) && s.d >= 0 && s.gap > MAX_GAP_SECONDS && s.gap <= MAX_QUIET_GAP_SECONDS) {
            avoidableGapSec += s.gap;
          }
          // 断档后重置为无人侧初始计时（winSec），避免原有人态的 duration=0 带入回放导致单步提前唤醒。
          state = initial;
          runSeconds = 0;
          runStartedWithFlip = false;
          continue;
        }
        if (next.occupied !== state.occupied) {
          if (runStartedWithFlip && runSeconds < SHORT_SEGMENT_SECONDS) shortSegs++;
          runSeconds = 0;
          runStartedWithFlip = true;
          flips++;
        }
        state = next;
        runSeconds += s.gap;
      }

      // 短片段和来回切换优先；兼顾窗口响应速度，避免离开通知拖慢。
      // 中等断档也计入代价，避免靠切断连续区间取得更低的切换次数。
      const score = shortSegs * 10 + (flips + avoidableGapSec / BASE_SECONDS) * 1.2
        + winMin * 0.35 + (baseW - minBaseW) * 0.1;
      if (!best || score < best.score) {
        best = { score, baseLine: candidate };
      }
    }
  }

  return best?.baseLine ?? fallback;
}
