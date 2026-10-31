import { getMeters } from '../config.js';
import { fetchDevice, toEpoch } from './collector.js';
export { toEpoch } from './collector.js';
import { advanceStatus, checkNotifications } from './notify.js';
import { first } from '../db/index.js';
import { successfulCollectionSql } from './collection-error.js';

const INSERT_DATA = `
  INSERT INTO data (ts, serial_no, room, time, kwh, balance, ms, raw)
  VALUES (?,?,?,?,?,?,?,?)
  ON CONFLICT (serial_no, ts) DO UPDATE SET
    room=excluded.room, time=excluded.time, kwh=excluded.kwh, balance=excluded.balance,
    ms=excluded.ms, raw=excluded.raw
  WHERE NOT (${successfulCollectionSql('data')})
`;
const INSERT_FAILURE = `
  INSERT INTO data (ts, serial_no, room, time, kwh, balance, ms, raw)
  VALUES (?,?,?,?,?,?,?,?) ON CONFLICT (serial_no, ts) DO NOTHING
`;

// 必须紧跟 INSERT_DATA 执行：重复采样 changes() = 0，不更新状态。
const INSERT_STATUS = `
  INSERT INTO status (serial_no, last_online_time, occupied, low_balance, delta, last_kwh, tail)
  SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?7 WHERE changes() > 0
`;
const UPDATE_STATUS = `
  UPDATE status SET last_online_time = ?2, occupied = ?3, low_balance = ?4,
                    delta = ?5, last_kwh = ?6
   WHERE serial_no = ?1 AND last_online_time = ?7 AND changes() > 0
`;

/**
 * 从areaId前的逗号开始截取后半段，保留原文字节及外层响应结尾。
 */
export function extractEnd(raw) {
  if (!raw) return '';
  const i = raw.search(/,\s*"areaId"\s*:/);
  return i >= 0 ? raw.slice(i) : '';
}

/**
 * 逗号归后半段，两段拼接还原原文；缺少areaId时完整原文归前半段。
 */
export function extractFront(raw) {
  if (!raw) return '';
  const i = raw.search(/,\s*"areaId"\s*:/);
  if (i < 0) return raw;
  return raw.slice(0, i);
}

/**
 * 并发采集配置中的电表，共用入库事务；最终失败仅写data，不推进状态或通知。
 */
export async function runCollect(env, { source = 'cron' } = {}) {
  const meters = getMeters(env);
  const deviceApiUrl = URL.parse(env.SOURCE_URL);
  if (deviceApiUrl?.protocol !== 'http:' && deviceApiUrl?.protocol !== 'https:') {
    throw new Error('SOURCE_URL 必须配置为有效的 HTTP(S) 地址');
  }
  const startedAt = Date.now();
  const batchId = `${startedAt}-${Math.random().toString(36).slice(2, 8)}`;

  const results = await Promise.all(
    meters.map(async (meter) => {
      const reading = await fetchDevice(meter.serial, deviceApiUrl);
      return { ...meter, ...reading };
    }),
  );

  return persistCollections(env, results, { startedAt, batchId, source });
}

/** 定时采集与手动上报共用事务、去重和通知处理。 */
export async function persistCollections(env, results, {
  startedAt = Date.now(), batchId = `${startedAt}-${Math.random().toString(36).slice(2, 8)}`, source = 'upload',
} = {}) {

  const okOnes = results.filter((r) => r.ok && r.payload.valveStateName !== null);
  const failed = results.filter((r) => !r.ok);

  const statements = [];
  const plan = [];
  const failurePlan = [];

  for (const r of okOnes) {
    const p = r.payload;

    // 截取失败不阻断入库，退而存空串，保证这条采样照样落库
    let endText = '';
    let frontText = '';
    try {
      endText = extractEnd(r.raw);
      frontText = extractFront(r.raw);
    } catch (e) {
      console.error('截取原文失败', p.serialNo, e.message);
    }

    // 厂商响应使用有效上游时间，手动上报由路由填入服务端接收时间。
    const ts = toEpoch(p.lastOnlineTime);
    const head = await first(env.DB,
      `SELECT serial_no, last_online_time, occupied, low_balance, delta, last_kwh, tail
         FROM status WHERE serial_no = ?1 ORDER BY last_online_time DESC LIMIT 1`,
      [p.serialNo]);
    const statusTime = p.lastOnlineTime;
    // 手动数据没有厂商后半段，沿用已有版本，只推进状态和有效时间。
    if (r.manual) {
      frontText = 'manual';
      endText = head?.tail ?? '';
    }
    // 两种来源均只推进新采样，重复或倒序响应不能回退状态或改写已有后半段区间。
    if (head && statusTime <= head.last_online_time) continue;
    const previousBalance = env[`WH_${r.room}`]
      ? await first(env.DB, `SELECT balance FROM data WHERE serial_no = ?1
          AND balance IS NOT NULL ORDER BY ts DESC LIMIT 1`, [p.serialNo]) : null;
    const sample = { ts, kwh: typeof p.readNumber === 'number' ? p.readNumber : null,
      balance: typeof p.residualAmount === 'number' ? p.residualAmount : null };
    const { state, events } = advanceStatus(head, sample, previousBalance?.balance ?? null);
    const base = statements.length;

    statements.push(
      env.DB.prepare(INSERT_DATA).bind(
        ts,
        p.serialNo,
        p.houseName || p.userName || null,
        p.lastOnlineTime,
        typeof p.readNumber === 'number' ? p.readNumber : null,
        typeof p.residualAmount === 'number' ? p.residualAmount : null,
        typeof r.durationMs === 'number' ? r.durationMs : null,
        frontText,
      ),
    );

    const hasEnd = !head || head.tail !== endText;
    statements.push(hasEnd
      ? env.DB.prepare(INSERT_STATUS).bind(p.serialNo, statusTime, state.occupied,
          state.low_balance, state.delta, state.last_kwh, endText)
      : env.DB.prepare(UPDATE_STATUS).bind(p.serialNo, statusTime, state.occupied,
          state.low_balance, state.delta, state.last_kwh, head.last_online_time));
    plan.push({ serial: p.serialNo, room: r.room, base, hasEnd, events });
  }

  for (const r of failed) {
    failurePlan.push(statements.length);
    statements.push(env.DB.prepare(INSERT_FAILURE).bind(
      Math.floor(startedAt / 1000), r.serial, r.room, null, null, null, r.durationMs, r.raw,
    ));
  }

  let inserted = 0;
  let failedInserted = 0;
  let endChanged = 0;
  let insertError = null;

  if (statements.length > 0) {
    try {
      const batchResults = await env.DB.batch(statements);
      for (const item of plan) {
        const changes = batchResults[item.base]?.meta?.changes ?? 0;
        item.changes = changes;
        item.statusChanges = batchResults[item.base + 1]?.meta?.changes ?? 0;
        inserted += changes;
        if (item.hasEnd && (batchResults[item.base + 1]?.meta?.changes ?? 0) > 0) {
          endChanged += 1;
        }
      }
      for (const index of failurePlan) failedInserted += batchResults[index]?.meta?.changes ?? 0;
      inserted += failedInserted;
    } catch (e) {
      insertError = e.message;
      inserted = 0;
    }
  }

  // 通知失败不回滚已提交的采样和状态。
  if (!insertError && plan.length > 0) {
    try {
      for (const item of plan) {
        if ((item.changes ?? 0) === 0 || !item.statusChanges) continue;   // 重复采样，没有新数据
        if (!env[`WH_${item.room}`]) continue;      // 这个房间没配群机器人，不推
        await checkNotifications(env, item.serial, item.room, item.events);
      }
    } catch (e) {
      console.error('通知检查失败:', e.message);
    }
  }

  return {
    batch_id: batchId,
    source,
    meters_total: results.length,
    meters_ok: okOnes.length,
    meters_fail: failed.length,
    attempted: okOnes.length,
    inserted,
    duplicated: insertError ? 0 : okOnes.length - (inserted - failedInserted),
    failed_inserted: failedInserted,
    end_changed: endChanged,
    insert_error: insertError,
    duration_ms: Date.now() - startedAt,
    detail: results.map((r) => ({
      serial: r.serial,
      ok: r.ok,
      attempts: r.attempts,
      ms: r.durationMs,
      ts: r.ok ? toEpoch(r.payload.lastOnlineTime) : null,
      error: r.ok ? null : r.error,
    })),
  };
}
