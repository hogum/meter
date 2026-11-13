const DEMO_SERIAL = 'demo';

export const DEMO_SAMPLE_SECONDS = 180;

const DAY_SECONDS = 86400;
export const DEMO_HISTORY_SECONDS = 30 * DAY_SECONDS;
const LOCAL_OFFSET = 8 * 3600;
// 东八区周一零点（day % 7: 0=周一 .. 4=周五, 5=周六, 6=周日）。
const EPOCH = Date.parse('2024-01-01T00:00:00+08:00') / 1000;
const PROFILE_DAYS = 42;
const STEPS_PER_HOUR = 3600 / DEMO_SAMPLE_SECONDS;
const STEPS_PER_DAY = DAY_SECONDS / DEMO_SAMPLE_SECONDS;
const PROFILE_STEPS = PROFILE_DAYS * STEPS_PER_DAY;

// 模拟真实租客在低余额（3.6~13.8 元）时的交费习惯，避免固定卡死同一余额与单一递增额。
const RECHARGE_PLAN = [
  { amount: 5000, floor: 1120 },
  { amount: 3000, floor: 440 },
  { amount: 1500, floor: 680 },
  { amount: 5000, floor: 520 },
  { amount: 3000, floor: 1380 },
  { amount: 3000, floor: 360 },
];
const RECHARGE_SEGMENTS = (() => {
  const segs = [];
  let acc = 0;
  for (let i = 0; i < RECHARGE_PLAN.length; i++) {
    const cur = RECHARGE_PLAN[i];
    const next = RECHARGE_PLAN[(i + 1) % RECHARGE_PLAN.length];
    const startBal = cur.floor + cur.amount;
    const spend = startBal - next.floor;
    segs.push({ from: acc, to: acc + spend, startBal });
    acc += spend;
  }
  return { segs, cycleCents: acc };
})();

function wrapSlot(slot) {
  return ((slot % PROFILE_STEPS) + PROFILE_STEPS) % PROFILE_STEPS;
}

function addConstantLoad(watts, fromHourAbs, toHourAbs, power) {
  const start = Math.round(fromHourAbs * STEPS_PER_HOUR);
  const end = Math.round(toHourAbs * STEPS_PER_HOUR);
  for (let slot = start; slot < end; slot++) {
    watts[wrapSlot(slot)] += power;
  }
}

function addAcCooling(watts, fromHourAbs, toHourAbs, peakW, steadyW, tauHours, phase) {
  const start = Math.round(fromHourAbs * STEPS_PER_HOUR);
  const end = Math.round(toHourAbs * STEPS_PER_HOUR);
  for (let slot = start; slot < end; slot++) {
    const elapsed = (slot - start) / STEPS_PER_HOUR;
    const base = steadyW + (peakW - steadyW) * Math.exp(-elapsed / tauHours);
    const wave = Math.sin(elapsed * 4.8 + phase) * 22 + Math.cos(elapsed * 2.1 + phase) * 12;
    watts[wrapSlot(slot)] += Math.max(120, base + wave);
  }
}

function addAwakeActivity(watts, fromHourAbs, toHourAbs, random, baseMin = 115, baseSpan = 65) {
  if (toHourAbs <= fromHourAbs) return;
  const start = Math.round(fromHourAbs * STEPS_PER_HOUR);
  const end = Math.round(toHourAbs * STEPS_PER_HOUR);
  const baseW = baseMin + random() * baseSpan;
  const phase = random() * Math.PI * 2;
  for (let slot = start; slot < end; slot++) {
    const elapsed = (slot - start) / STEPS_PER_HOUR;
    const drift = Math.sin(elapsed * 2.9 + phase) * 26 + (random() - 0.5) * 24;
    watts[wrapSlot(slot)] += Math.max(75, baseW + drift);
  }
}

// 参照 D703 空调季特征生成跨天连续、且区分工作日/周末不同节奏的 42 天负载曲线。
function buildLoadProfile() {
  let seed = 73041;
  const random = () => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return seed / 0x100000000;
  };

  const schedule = [];
  for (let day = 0; day < PROFILE_DAYS; day++) {
    const dow = day % 7;
    const weather = 0.84 + 0.24 * Math.sin((day / 6.2) + 0.7) + (random() - 0.5) * 0.14;

    if (dow < 5) {
      // 工作日：多数为早出晚归，偶发午休回家、晚归加班/聚餐或居家半天，避免千篇一律。
      const wake = 7.15 + random() * 0.9;
      const lateMorning = random() < 0.14;
      const leave = lateMorning ? 11.2 + random() * 2.3 : wake + 0.55 + random() * 0.65;
      const middayReturn = !lateMorning && random() < 0.16
        ? { from: 12.2 + random() * 0.6, to: 13.7 + random() * 0.7 }
        : null;
      const style = random();
      const returnHome = style < 0.62
        ? 18.15 + random() * 1.4
        : style < 0.86
          ? 20.15 + random() * 1.75
          : 16.45 + random() * 1.25;
      const bedtime = (dow === 4 ? 24.1 : 23.3) + random() * 1.35;
      schedule.push({ dow, wake, leave, middayReturn, returnHome, bedtime, weather, morningAc: lateMorning });
    } else if (dow === 5) {
      // 周六：晚起，上午/午间居家开空调或厨电，下午至晚间外出聚会，深夜归来。
      const wake = 9.1 + random() * 1.35;
      const afternoonOut = random() < 0.65;
      const leave = afternoonOut ? 12.7 + random() * 2.1 : 10.8 + random() * 1.1;
      const returnHome = afternoonOut ? 20.6 + random() * 2.1 : 17.5 + random() * 1.9;
      const bedtime = 24.15 + random() * 1.4;
      schedule.push({ dow, wake, leave, middayReturn: null, returnHome, bedtime, weather, morningAc: true });
    } else {
      // 周日：晚起，约半数全天居家午休空调+傍晚散步，半数白天外出傍晚回家早睡准备周一。
      const wake = 8.9 + random() * 1.35;
      const lazySunday = random() < 0.55;
      const leave = lazySunday ? 17.2 + random() * 1.4 : 11.5 + random() * 1.8;
      const returnHome = lazySunday ? leave + 2.3 + random() * 1.6 : 17.3 + random() * 1.8;
      const bedtime = 23.15 + random() * 1.1;
      schedule.push({ dow, wake, leave, middayReturn: null, returnHome, bedtime, weather, morningAc: true });
    }
  }

  const watts = new Float64Array(PROFILE_STEPS);
  // 底层待机（路由器/网关/待机插座）：9~14 W 极轻微波动，外出时图面干净清爽。
  for (let slot = 0; slot < PROFILE_STEPS; slot++) {
    watts[slot] = 9 + Math.sin(slot * 0.17) * 1.8 + random() * 3.5;
  }

  for (let day = 0; day < PROFILE_DAYS; day++) {
    const today = schedule[day];
    const next = schedule[(day + 1) % PROFILE_DAYS];
    const dayBase = day * 24;
    const returnAbs = dayBase + today.returnHome;
    const bedAbs = dayBase + today.bedtime;
    const wakeAbs = dayBase + 24 + next.wake;
    const leaveAbs = dayBase + 24 + next.leave;

    const showerInMorning = random() < 0.16 && (leaveAbs - wakeAbs) >= 0.75;

    // 1. 傍晚/晚间回家至睡前：活动负荷 + 变频空调降温 + 错峰晚间洗澡。
    addAwakeActivity(watts, returnAbs, bedAbs, random, 125, 65);
    if (bedAbs - returnAbs > 1.8 && random() < 0.45) {
      const mealAt = returnAbs + 0.25 + random() * Math.min(1.5, bedAbs - returnAbs - 1.0);
      addConstantLoad(watts, mealAt, mealAt + (3 + Math.floor(random() * 4)) / STEPS_PER_HOUR, 650 + random() * 450);
    }

    const acStart = returnAbs + 0.08 + random() * 0.2;
    const peakW = (490 + random() * 200) * today.weather;
    const steadyDayW = (245 + random() * 90) * today.weather;
    const sleepSteadyW = (175 + random() * 75) * today.weather;
    addAcCooling(watts, acStart, bedAbs, peakW, steadyDayW, 0.65 + random() * 0.3, random() * 6);
    addAcCooling(watts, bedAbs, wakeAbs - 0.15, steadyDayW * 0.9, sleepSteadyW, 0.55, random() * 6);
    addConstantLoad(watts, bedAbs, wakeAbs, 20 + random() * 14);

    if (!showerInMorning && random() < 0.88) {
      const span = Math.max(0.5, bedAbs - returnAbs - 0.65);
      const bathStart = returnAbs + 0.25 + random() * span;
      const bathDur = (6 + Math.floor(random() * 5)) / STEPS_PER_HOUR;
      addConstantLoad(watts, bathStart, Math.min(bedAbs - 0.1, bathStart + bathDur), 1950 + random() * 260);
    }

    // 凌晨偶发一次储水式热水器 3~6 分钟自动保温脉冲。
    if (random() < 0.35) {
      const pulseH = dayBase + 24 + 1.4 + random() * 4.0;
      const pulseSlots = random() < 0.5 ? 1 : 2;
      addConstantLoad(watts, pulseH, pulseH + pulseSlots / STEPS_PER_HOUR, 2050 + random() * 260);
    }

    // 2. 次日起床至出门：区分工作日急促洗漱与周末/居家上午空调+厨电。
    addAwakeActivity(watts, wakeAbs, leaveAbs, random, 105, 55);
    if (next.morningAc && leaveAbs - wakeAbs >= 1.2) {
      addAcCooling(
        watts,
        wakeAbs + 0.15,
        leaveAbs - 0.1,
        (360 + random() * 150) * next.weather,
        (240 + random() * 85) * next.weather,
        0.55,
        random() * 6,
      );
    }
    if (showerInMorning) {
      const bathStart = wakeAbs + 0.12 + random() * Math.max(0.1, leaveAbs - wakeAbs - 0.5);
      const bathDur = (5 + Math.floor(random() * 4)) / STEPS_PER_HOUR;
      addConstantLoad(watts, bathStart, Math.min(leaveAbs - 0.05, bathStart + bathDur), 1950 + random() * 250);
    } else if (random() < 0.5) {
      const rushStart = wakeAbs + 0.1 + random() * Math.max(0.1, leaveAbs - wakeAbs - 0.25);
      const rushSlots = random() < 0.65 ? 1 : 2;
      addConstantLoad(watts, rushStart, Math.min(leaveAbs, rushStart + rushSlots / STEPS_PER_HOUR), 1500 + random() * 450);
    }
    if (next.dow >= 5 && leaveAbs - wakeAbs > 2.5 && random() < 0.7) {
      const brunchAt = wakeAbs + 0.8 + random() * (leaveAbs - wakeAbs - 1.5);
      addConstantLoad(watts, brunchAt, brunchAt + (4 + Math.floor(random() * 4)) / STEPS_PER_HOUR, 700 + random() * 480);
    }

    // 3. 工作日偶发午休回家（开空调 + 简餐），进一步打破工作日“全同模版感”。
    if (today.middayReturn) {
      const mStart = dayBase + today.middayReturn.from;
      const mEnd = dayBase + today.middayReturn.to;
      addAwakeActivity(watts, mStart, mEnd, random, 120, 50);
      addAcCooling(watts, mStart + 0.05, mEnd - 0.05, 480 * today.weather, 280 * today.weather, 0.45, random() * 6);
      if (random() < 0.6) {
        addConstantLoad(watts, mStart + 0.15, mStart + 0.35, 800 + random() * 400);
      }
    }

    // 4. 白天外出静默段：偶发 1 次 3~6 分钟热水器保温脉冲，展现系统过滤误报的能力。
    const awayStart = dayBase + (today.middayReturn ? today.middayReturn.to : today.leave);
    const awayEnd = returnAbs;
    if (awayEnd - awayStart > 2.8 && random() < 0.65) {
      const keepStart = awayStart + 1.0 + random() * (awayEnd - awayStart - 1.6);
      const keepSlots = random() < 0.45 ? 1 : 2;
      addConstantLoad(watts, keepStart, keepStart + keepSlots / STEPS_PER_HOUR, 2050 + random() * 250);
    }
  }

  // 控制单槽上限在 2800 W 内，使 20 分钟平滑峰值保持在 3000 W 档（与 D703 纵轴刻度一致）。
  const cumulative = new Uint32Array(PROFILE_STEPS + 1);
  for (let slot = 0; slot < PROFILE_STEPS; slot++) {
    cumulative[slot + 1] = cumulative[slot] + Math.min(Math.round(watts[slot]), 2800);
  }
  return cumulative;
}

let loadProfile;

function computeBalanceCents(billedCents) {
  const spent = ((billedCents % RECHARGE_SEGMENTS.cycleCents) + RECHARGE_SEGMENTS.cycleCents) % RECHARGE_SEGMENTS.cycleCents;
  const seg = RECHARGE_SEGMENTS.segs.find(s => spent < s.to) ?? RECHARGE_SEGMENTS.segs[0];
  return seg.startBal - (spent - seg.from);
}

function computeSampleLatencyMs(step) {
  const h = Math.imul((step ^ 0x9e3779b9) >>> 0, 0x85ebca6b) >>> 0;
  const u = (h ^ (h >>> 13)) >>> 0;
  if (u % 37 === 0) return 1080 + (u % 750);
  return 340 + (u % 520);
}

function makeSample(ts) {
  loadProfile ??= buildLoadProfile();
  const step = Math.round((ts - EPOCH) / DEMO_SAMPLE_SECONDS);
  const cycle = Math.floor(step / PROFILE_STEPS);
  const index = step - cycle * PROFILE_STEPS;
  const load = cycle * loadProfile[PROFILE_STEPS] + loadProfile[index];
  // 表盘以 0.01 kWh 跳字，余额按 1.20 元/kWh 折算并保留分。
  const ticks = Math.floor((load * DEMO_SAMPLE_SECONDS) / 36000);
  const billed = Math.round(ticks * 1.2);
  return {
    ts,
    time: new Date((ts + LOCAL_OFFSET) * 1000).toISOString().slice(0, 19).replace('T', ' '),
    serial_no: DEMO_SERIAL,
    room: '演示房间',
    kwh: (124873 + ticks) / 100,
    balance: computeBalanceCents(billed) / 100,
    ms: computeSampleLatencyMs(step),
    raw: 'manual',
  };
}

export function getDemoLatest() {
  const step = Math.floor(Date.now() / (DEMO_SAMPLE_SECONDS * 1000));
  return makeSample(step * DEMO_SAMPLE_SECONDS);
}

export function getDemoSamples(from, to, latestTs) {
  const start = Math.max(from, latestTs - DEMO_HISTORY_SECONDS);
  const end = Math.min(to, latestTs);
  const rows = [];
  for (let ts = Math.ceil(start / DEMO_SAMPLE_SECONDS) * DEMO_SAMPLE_SECONDS;
    ts <= end; ts += DEMO_SAMPLE_SECONDS) {
    rows.push(makeSample(ts));
  }
  return rows;
}
