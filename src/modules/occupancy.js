/** 实时通知与历史看板共用的有人/无人状态机及近 7 天基线寻优。 */

export const DEFAULT_BASE_LINE = '12w/15m';
export const BASE_SECONDS = 182;
export const HEATER_BASE_STEP = 0.09;
export const MAX_GAP_SECONDS = 900;
export const ACTIVE_CONFIRM_SECONDS = 300;
export const HIGH_BASE_CONFIRM_SECONDS = 540;
const MAX_QUIET_GAP_SECONDS = 2700;
const SHORT_SEGMENT_SECONDS = 2700;
const HEATER_CONFIRM_STEPS = 4;
const HEATER_STREAK_RADIX = HEATER_CONFIRM_STEPS + 1;
const FAST_WAKE_SPAN_SECONDS = 915;

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

// 低三位保存等级，其余位保存热水器主步数及距上次普通增量的秒数。
function packDelta(level, tickAgeSec, heaterStreak) {
  const cappedAge = Math.min(Math.round(tickAgeSec), 86400);
  return 8 + level + 8 * (heaterStreak + HEATER_STREAK_RADIX * cappedAge);
}

/**
 * 推进单步状态（纯单步马尔可夫，不依赖前多步历史）。
 * mode（对外等级）：0 = 无人/基线内，1 = 有人活动，2 = 疑似热水器/大功率脉冲。
 * delta 等级：0 = 静默，1 = 活动，2 = 热水器主步，3 = 热水器尾步，4 = 基线内正增量，5 = 待确认短静默。
 * duration 有人时累计静默秒数，无人时累计待确认活动秒数。
 *
 * @param {{occupied?: number|null, delta?: number|null, duration?: number|null, base_line?: string|null}|null} previous
 * @param {{d: number|null, gap: number|null}} step
 */
export function stepOccupancy(previous, step = {}) {
  return stepWithBaseline(previous, step, parseBaseline(previous?.base_line));
}

function stepWithBaseline(previous, step, { baseW, winSec, maxTickSpan, baseLine }) {
  const { d, gap } = step;
  const highBase = baseW > 40;
  const occupied = previous?.occupied === 1 ? 1 : 0;
  const rawDelta = Number.isSafeInteger(previous?.delta) ? previous.delta : 0;
  const legacy = rawDelta < 8;
  const packed = legacy ? 0 : rawDelta - 8;
  const legacyLevel = rawDelta >= 0 && rawDelta <= 5 ? rawDelta : 0;
  const level = legacy ? legacyLevel : packed % 8;
  const prevHeaterStreak = !legacy
    ? Math.floor(packed / 8) % HEATER_STREAK_RADIX
    : level === 2 ? 1 : 0;
  const prevDuration = Number.isFinite(previous?.duration) && previous.duration >= 0
    ? Math.round(previous.duration) : null;
  const warming = occupied === 0 && (level === 1 || level === 5);
  const quietSec = occupied === 1 ? prevDuration ?? 0 : 0;

  // 旧静默行的 duration 可估计增量间隔；旧待确认段只知道至少有一个静默采样。
  let tickAgeSec = Math.floor(packed / (8 * HEATER_STREAK_RADIX));
  if (legacy) {
    if (level === 0) tickAgeSec = prevDuration ?? (occupied ? 0 : winSec);
    if (level === 2 || level === 3 || level === 5) tickAgeSec = BASE_SECONDS;
  }

  const avgW = (d * 3600000) / gap;
  const moderateGap = gap > MAX_GAP_SECONDS && avgW <= baseW;
  if (!Number.isFinite(gap) || gap <= 0 || gap > MAX_QUIET_GAP_SECONDS
    || !Number.isFinite(d) || d < 0 || (gap > MAX_GAP_SECONDS && !moderateGap)) {
    return { occupied, delta: packDelta(0, winSec, 0), mode: 0, duration: 0, base_line: baseLine, effW: null, broken: true };
  }

  const result = (nextOcc, nextLevel, mode, duration, effW, tickAge = 0, streak = 0) => ({
    occupied: nextOcc, delta: packDelta(nextLevel, tickAge, streak), mode, duration: Math.round(duration),
    base_line: baseLine, effW: Math.round(effW), broken: false,
  });

  const nextTickAge = tickAgeSec + gap;
  if (!moderateGap && d > 0 && d >= heaterStep(gap)) {
    const streak = Math.min(prevHeaterStreak + 1, HEATER_CONFIRM_STEPS);
    const confirmed = streak >= HEATER_CONFIRM_STEPS;
    const heldTickAge = occupied && !confirmed ? tickAgeSec : nextTickAge;
    // 短加热首步为有人态静默倒计时保留 6 分钟宽限，避免被加热吞掉的睡眠低功耗导致跨夜误断。
    const heldQuiet = confirmed ? 0 : (occupied && prevHeaterStreak === 0 ? Math.max(0, quietSec - BASE_SECONDS * 2) : quietSec);
    return result(confirmed ? 1 : occupied, 2, 2, heldQuiet, avgW, heldTickAge, streak);
  }
  if (!moderateGap && d > 0 && level === 2) {
    return result(occupied, 3, 2, quietSec, avgW, occupied ? tickAgeSec : nextTickAge);
  }

  const prevWasPositive = level === 1 || level === 4;
  const span = prevWasPositive ? gap : (tickAgeSec || BASE_SECONDS) + gap;
  const effW = moderateGap ? avgW : (d * 3600000) / span;
  const wakeW = highBase ? baseW : Math.max(baseW * 1.4, 20);

  if (d > 0 && effW > baseW) {
    if (occupied) return result(1, 1, 1, 0, effW);

    // 待机和热水器后的单个量化跳点只进入确认期；低底噪唤醒要求超过 wakeW 以过滤 17W 级白天待机。
    if (effW > wakeW) {
      const instantConfirm = !highBase && d === 0.01 && level !== 4 && level !== 3
        && span <= FAST_WAKE_SPAN_SECONDS && span < maxTickSpan;
      const activeSec = warming ? (prevDuration ?? 0) + gap : Math.min(gap, BASE_SECONDS);
      const confirmSec = highBase ? HIGH_BASE_CONFIRM_SECONDS : ACTIVE_CONFIRM_SECONDS;
      if (instantConfirm || activeSec >= confirmSec) return result(1, 1, 1, 0, effW);
      return result(0, 1, 1, activeSec, effW);
    }
  }

  // 确认期允许低功率负载跨过短静默，但不把高底噪零增量计入有效确认时长（防冰箱+热水器上升沿误触发）。
  const maxWarmSpan = highBase ? 36000 / baseW : 36000 / wakeW;
  if (warming && !moderateGap && d === 0 && nextTickAge < maxWarmSpan) {
    const heldDuration = highBase ? (prevDuration ?? 0) : (prevDuration ?? 0) + gap;
    return result(0, 5, 1, heldDuration, 0, nextTickAge);
  }

  const nextQuiet = occupied ? quietSec + gap : 0;
  const stillOccupied = occupied && nextQuiet < winSec ? 1 : 0;
  return result(stillOccupied, d > 0 ? 4 : 0, 0, stillOccupied ? nextQuiet : 0, effW, d > 0 ? 0 : nextTickAge);
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

  let best = null;
  for (const baseW of candidates) {
    for (const winMin of [5, 9, 15, 23, 33]) {
      const candidate = `${baseW}w/${winMin}m`;
      const baseline = parseBaseline(candidate);

      const initial = { occupied: 0, delta: 0, duration: null, base_line: candidate };
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
