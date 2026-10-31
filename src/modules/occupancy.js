/** 固定阈值参考状态机；实时通知使用 notify.js，历史看板使用 history-occupancy.js。 */

export const HEATER_STEP = 0.1;

export const UP_RUN = 2;

export const FLAT_RUN = 2;

/** 采样间隔超过此秒数时，连续计数清零。 */
export const MAX_GAP_SECONDS = 900;

/**
 * 按增量序列推出每一时刻的有人/无人状态。
 *
 * @param {{d: number|null, gap?: number|null}[]} steps
 *        每项是一次相邻采样：d = 读数增量（null 表示无效），gap = 与上条的间隔秒数
 * @returns {number[]} 每个位置的状态：1 = 有人，0 = 无人
 */
export function judgeOccupancy(steps) {
  const states = [];
  let state = 0;
  let upRun = 0;
  let flatRun = 0;
  for (const step of steps) {
    const d = step?.d ?? null;
    const gap = step?.gap ?? null;

    if (gap != null && gap > MAX_GAP_SECONDS) {
      // 数据断档：连续计数清零，但状态本身保持（不凭空翻转）
      upRun = 0;
      flatRun = 0;
      states.push(state);
      continue;
    }
    if (d == null || d < 0) {          // 读数回退/换表：忽略，状态不动
      states.push(state);
      continue;
    }
    if (d > HEATER_STEP) {            // 热水器：状态不动
      states.push(state);
      continue;
    }
    if (d > 0) {
      upRun += 1;
      flatRun = 0;
      if (upRun >= UP_RUN) state = 1;
    } else {
      flatRun += 1;
      upRun = 0;
      if (flatRun >= FLAT_RUN) state = 0;
    }
    states.push(state);
  }
  return states;
}

