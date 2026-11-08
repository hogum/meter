import { getMeters } from '../config.js';
import { fetchDevice, toEpoch } from './collector.js';
export { toEpoch } from './collector.js';
import { advanceStatus, checkNotifications } from './notify.js';
import { first } from '../db/index.js';
import { successfulCollectionSql } from './collection-error.js';

export const UPSERT_SUCCESSFUL_DATA = `
  ON CONFLICT (serial_no, ts) DO UPDATE SET
    room=excluded.room, time=excluded.time, kwh=excluded.kwh, balance=excluded.balance,
    ms=excluded.ms, raw=excluded.raw
  WHERE NOT (${successfulCollectionSql('data')})
`;
const INSERT_DATA = `
  INSERT INTO data (ts, serial_no, room, time, kwh, balance, ms, raw)
  VALUES (?,?,?,?,?,?,?,?) ${UPSERT_SUCCESSFUL_DATA}
`;
const INSERT_FAILURE = `
  INSERT INTO data (ts, serial_no, room, time, kwh, balance, ms, raw)
  VALUES (?,?,?,?,?,?,?,?) ON CONFLICT (serial_no, ts) DO NOTHING
`;

// 必须紧跟 INSERT_DATA 执行：重复采样 changes() = 0，不更新状态。
const INSERT_STATUS = `
  INSERT INTO status (serial_no, last_online_time, occupied, broke, base_line, last_kwh, delta, duration, tail)
  SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9 WHERE changes() > 0
`;
const UPDATE_STATUS = `
  UPDATE status SET last_online_time = ?2, occupied = ?3, broke = ?4,
                    last_kwh = ?5, delta = ?6, duration = ?7
   WHERE serial_no = ?1 AND last_online_time = ?8 AND changes() > 0
`;

// 采集前的状态快照与提交前的复核共用同一条查询。
const HEAD_STATUS = `
  SELECT last_online_time, occupied, broke, base_line, last_kwh, delta, duration, tail
    FROM status WHERE serial_no = ?1 ORDER BY last_online_time DESC LIMIT 1
`;
const CHECK_STATUS = `
  SELECT last_online_time, base_line
    FROM status WHERE serial_no = ?1 ORDER BY last_online_time DESC LIMIT 1
`;
// 仅当该房间配置了群机器人且本次采集带余额时才回查上次余额。
const PREVIOUS_BALANCE = `
  SELECT balance FROM data
    WHERE serial_no = ?1 AND ts < ?2 AND balance IS NOT NULL AND ${successfulCollectionSql()}
    ORDER BY ts DESC LIMIT 1
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

/** 只解析和去重，不访问数据库；返回 null 表示该时刻已有采样。 */
function describeCollection(env, reading, head) {
  const p = reading.payload;
  const serial = p.serialNo;
  let endText = '';
  let frontText = '';
  try {
    endText = extractEnd(reading.raw);
    frontText = extractFront(reading.raw);
  } catch (e) {
    console.error('截取原文失败', serial, e.message);
  }

  const statusTime = p.lastOnlineTime;
  const ts = toEpoch(statusTime);
  // 两种来源均只推进新采样，重复或倒序响应不能回退状态或改写已有后半段区间。
  if (head && statusTime <= head.last_online_time) return null;
  // 手动数据没有厂商后半段，沿用已有版本，只推进状态和有效时间。
  if (reading.manual) {
    frontText = 'manual';
    endText = head?.tail ?? '';
  }

  return {
    reading, serial, statusTime, ts, head, frontText, endText,
    sample: {
      ts,
      kwh: typeof p.readNumber === 'number' ? p.readNumber : null,
      balance: typeof p.residualAmount === 'number' ? p.residualAmount : null,
    },
    // 只有配置了该房间的推送地址、且本次带余额时才需要上次余额。
    needBalance: Boolean(env[`WH_${reading.room}`]) && typeof p.residualAmount === 'number',
  };
}

/** 只在有电表需要充值判断时，批量查询各表上次有效余额。 */
async function loadPreviousBalances(env, descs) {
  const targets = descs.filter((d) => d.needBalance);
  if (!targets.length) return { queried: false, balances: descs.map(() => null) };
  const results = await env.DB.batch(
    targets.map((d) => env.DB.prepare(PREVIOUS_BALANCE).bind(d.serial, d.ts)),
  );
  const balanceOf = new Map(targets.map((d, i) => [d, results[i]?.results?.[0]?.balance ?? null]));
  return {
    queried: true,
    balances: descs.map((d) => balanceOf.get(d) ?? null),
  };
}

/** 依据状态快照与上次余额生成该表的两条写语句。 */
function buildStatements(env, desc, previousBalance) {
  const { state, events } = advanceStatus(desc.head, desc.sample, previousBalance);
  const p = desc.reading.payload;

  const dataStatement = env.DB.prepare(INSERT_DATA).bind(
    desc.ts, desc.serial, p.houseName || p.userName || null, desc.statusTime, desc.sample.kwh,
    desc.sample.balance,
    typeof desc.reading.durationMs === 'number' ? desc.reading.durationMs : null, desc.frontText,
  );
  const hasEnd = !desc.head || desc.head.tail !== desc.endText;
  const statusStatement = hasEnd
    ? env.DB.prepare(INSERT_STATUS).bind(desc.serial, desc.statusTime, state.occupied,
        state.broke, state.base_line, state.last_kwh, state.delta, state.duration, desc.endText)
    : env.DB.prepare(UPDATE_STATUS).bind(desc.serial, desc.statusTime, state.occupied,
        state.broke, state.last_kwh, state.delta, state.duration, desc.head.last_online_time);
  return {
    reading: desc.reading, serial: desc.serial, ts: desc.ts, hasEnd, events,
    dataStatement, statusStatement,
    headLastOnlineTime: desc.head?.last_online_time ?? null,
    headBaseLine: desc.head?.base_line ?? null,
  };
}

/** 复核发现快照已变：重新读该表的头部与按需余额后重建语句。 */
async function reselectCollection(env, reading) {
  const head = await first(env.DB, HEAD_STATUS, [reading.payload.serialNo]);
  const desc = describeCollection(env, reading, head);
  if (!desc) return null;
  const { balances: [previousBalance] } = await loadPreviousBalances(env, [desc]);
  return buildStatements(env, desc, previousBalance);
}

/** 定时采集与手动上报共用事务、去重和通知处理。 */
export async function persistCollections(env, results, {
  startedAt = Date.now(), batchId = `${startedAt}-${Math.random().toString(36).slice(2, 8)}`, source = 'upload',
} = {}) {
  const okOnes = results.filter((r) => r.ok && r.payload.valveStateName !== null);
  const failed = results.filter((r) => !r.ok);
  const failureStatements = failed.map(r => env.DB.prepare(INSERT_FAILURE).bind(
    Math.floor(startedAt / 1000), r.serial, r.room, null, null, null, r.durationMs, r.raw,
  ));

  let inserted = 0;
  let failedInserted = 0;
  let endChanged = 0;
  let insertError = null;
  const committed = [];

  try {
    const heads = okOnes.length
      ? (await env.DB.batch(
          okOnes.map((r) => env.DB.prepare(HEAD_STATUS).bind(r.payload.serialNo)),
        )).map((r) => r.results?.[0] ?? null)
      : [];
    // 重复采样只消耗一次头部读取，不进入余额查询与写入批次。
    const descs = okOnes.map((r, i) => describeCollection(env, r, heads[i])).filter(Boolean);

    let plan = [];
    let queriedData = false;
    if (descs.length) {
      const { queried, balances } = await loadPreviousBalances(env, descs);
      queriedData = queried;
      plan = descs.map((d, i) => buildStatements(env, d, balances[i]));
    }
    // 仅当查询过余额产生异步间隙时，提交前再核对一次状态快照。
    if (plan.length && queriedData) {
      const checks = await env.DB.batch(
        plan.map((item) => env.DB.prepare(CHECK_STATUS).bind(item.serial)),
      );
      for (let i = 0; i < plan.length; i++) {
        const current = checks[i]?.results?.[0] ?? null;
        if ((current?.last_online_time ?? null) === plan[i].headLastOnlineTime
          && (current?.base_line ?? null) === plan[i].headBaseLine) continue;
        plan[i] = await reselectCollection(env, plan[i].reading);
      }
      plan = plan.filter(Boolean);
    }

    const statements = plan.flatMap(item => [item.dataStatement, item.statusStatement]);
    const failureOffset = statements.length;
    if (failureStatements.length) statements.push(...failureStatements);

    if (statements.length) {
      const batchResults = await env.DB.batch(statements);
      for (let i = 0; i < plan.length; i++) {
        const changes = batchResults[i * 2]?.meta?.changes ?? 0;
        if (changes === 0) continue;   // 已有同一时刻的成功采样，按重复处理。
        inserted += changes;
        if ((batchResults[i * 2 + 1]?.meta?.changes ?? 0) > 0) {
          committed.push(plan[i]);
          if (plan[i].hasEnd) endChanged++;
        }
      }
      for (const result of batchResults.slice(failureOffset)) failedInserted += result.meta?.changes ?? 0;
    }
  } catch (e) {
    insertError = e.message;
  }

  // 通知失败不回滚已提交的采样和状态。
  try {
    for (const item of committed) {
      await checkNotifications(env, item.serial, item.reading.room, item.events);
    }
  } catch (e) {
    console.error('通知检查失败:', e.message);
  }

  return {
    batch_id: batchId,
    source,
    meters_total: results.length,
    meters_ok: okOnes.length,
    meters_fail: failed.length,
    attempted: okOnes.length,
    inserted: inserted + failedInserted,
    duplicated: insertError ? 0 : okOnes.length - inserted,
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
