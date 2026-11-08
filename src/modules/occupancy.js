/** 实时通知与历史看板共用的有人/无人状态机及近 7 天基线寻优。 */

export const DEFAULT_BASE_LINE = '12w/15m';
export const BASE_SECONDS = 182;
export const HEATER_BASE_STEP = 0.09;
export const MAX_GAP_SECONDS = 900;
export const ACTIVE_CONFIRM_SECONDS = 300;
export const HIGH_BASE_CONFIRM_SECONDS = 540;
const SHORT_SEGMENT_SECONDS = 2700;

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

function validGap(gap) {
  return Number.isFinite(gap) && gap > 0 && gap <= MAX_GAP_SECONDS;
}

/**
 * 推进单步状态（纯单步马尔可夫，不依赖前多步历史）。
 * mode（对外等级）：0 = 无人/基线内，1 = 有人活动，2 = 疑似热水器/大功率脉冲。
 * delta（持久化内部状态）：0 = 静默，1 = 活动，2 = 热水器主步，3 = 热水器尾步，4 = 基线内正增量，5 = 待确认短静默。
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
  let occupied = previous?.occupied === 1 ? 1 : 0;
  const rawDelta = (previous?.delta >= 0 && previous?.delta <= 5) ? previous.delta : 0;
  const prevWasPositive = rawDelta === 1 || rawDelta === 2 || rawDelta === 3 || rawDelta === 4;
  let delta = (rawDelta === 1 || rawDelta === 5) ? 1 : (rawDelta === 2 || rawDelta === 3) ? 2 : 0;
  let duration = Number.isFinite(previous?.duration) && previous.duration >= 0
    ? Math.round(previous.duration)
    : (occupied === 0 ? winSec : 0);

  if (!validGap(gap) || !Number.isFinite(d) || d < 0) {
    return { occupied, delta: 0, mode: 0, duration: occupied === 0 ? winSec : 0, base_line: baseLine, effW: null, broken: true };
  }

  if (d >= heaterStep(gap)) {
    return {
      occupied,
      delta: 2,
      mode: 2,
      duration: occupied === 0 ? winSec : 0,
      base_line: baseLine,
      effW: Math.round((d * 3600000) / gap),
      broken: false,
    };
  }
  if (d > 0 && rawDelta === 2) {
    return {
      occupied,
      delta: 3,
      mode: 2,
      duration: occupied === 0 ? winSec : 0,
      base_line: baseLine,
      effW: Math.round((d * 3600000) / gap),
      broken: false,
    };
  }

  const estimatedSpan = delta === 1 ? duration : duration + gap;
  const span = prevWasPositive
    ? gap
    : (estimatedSpan > gap ? estimatedSpan : BASE_SECONDS + gap);

  if (d > 0) {
    const effW = (d * 3600000) / span;
    if (occupied === 1 && effW > baseW) {
      return {
        occupied: 1,
        delta: 1,
        mode: 1,
        duration: 0,
        base_line: baseLine,
        effW: Math.round(effW),
        broken: false,
      };
    }
    const wakeActive = occupied === 0 && effW > baseW && (highBase || d >= 0.02 || span <= 915);
    if (wakeActive) {
      const instantConfirm = !highBase && d === 0.01 && span <= 915 && span < maxTickSpan;
      if (instantConfirm) {
        return {
          occupied: 1,
          delta: 1,
          mode: 1,
          duration: 0,
          base_line: baseLine,
          effW: Math.round(effW),
          broken: false,
        };
      }
      const confirmSec = highBase ? HIGH_BASE_CONFIRM_SECONDS : ACTIVE_CONFIRM_SECONDS;
      if (delta === 1) {
        duration += Math.min(d >= 0.02 ? span * 2 : span, winSec);
        if (duration >= confirmSec) {
          return {
            occupied: 1,
            delta: 1,
            mode: 1,
            duration: 0,
            base_line: baseLine,
            effW: Math.round(effW),
            broken: false,
          };
        }
      } else {
        delta = 1;
        duration = Math.min(gap, BASE_SECONDS);
      }
      return {
        occupied: 0,
        delta: 1,
        mode: 1,
        duration: Math.round(duration),
        base_line: baseLine,
        effW: Math.round(effW),
        broken: false,
      };
    }
  }

  // d === 0 或 effW <= baseW
  if (delta === 1 && occupied === 0 && d === 0 && duration + gap < maxTickSpan) {
    duration += gap;
    return { occupied: 0, delta: 5, mode: 1, duration: Math.round(duration), base_line: baseLine, effW: 0, broken: false };
  }

  if (occupied === 0) {
    duration = d > 0 ? 0 : duration + gap;
  } else {
    duration = (delta === 0 ? duration : 0) + gap;
    if (duration >= winSec) {
      occupied = 0;
      duration = d > 0 ? 0 : duration;
    }
  }

  const nextDelta = d > 0 ? 4 : 0;
  const effW = d > 0 ? Math.round((d * 3600000) / span) : 0;
  return { occupied, delta: nextDelta, mode: 0, duration: Math.round(duration), base_line: baseLine, effW, broken: false };
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
    if (validGap(gap) && Number.isFinite(d) && d >= 0) {
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
  const maxK = Math.min(16, Math.max(2, Math.floor(36000 / (minBaseW * 181))));

  const candidates = new Map();
  for (let k = Math.min(5, maxK); k <= maxK; k++) {
    const baseW = Math.ceil(36000 / (k * 181));
    if (baseW >= minBaseW) candidates.set(baseW, k);
  }
  if (!candidates.has(minBaseW)) candidates.set(minBaseW, maxK);

  let best = null;
  for (const [baseW, k] of candidates) {
    const winCandidates = [...new Set([
      Math.max(15, k * 3),
      Math.max(21, k * 3),
      Math.max(24, k * 3),
      Math.max(30, k * 3),
    ])];

    for (const winMin of winCandidates) {
      const candidate = `${baseW}w/${winMin}m`;
      const baseline = parseBaseline(candidate);

      const initial = { occupied: 0, delta: 0, duration: null, base_line: candidate };
      let state = initial;
      let runSeconds = 0;
      let runStartedWithFlip = false;
      let flips = 0;
      let shortSegs = 0;
      for (const s of simSteps) {
        const next = stepWithBaseline(state, s, baseline);
        if (next.broken) {
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

      const score = shortSegs * 10 + flips * 0.5 + winMin * 0.4;
      if (!best || score < best.score) {
        best = { score, baseLine: candidate };
      }
    }
  }

  return best?.baseLine ?? fallback;
}
