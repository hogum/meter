import { getMeters } from '../config.js';
import { fetchDevice, toEpoch } from './collector.js';
export { toEpoch } from './collector.js';
import { advanceStatus, checkNotifications } from './notify.js';
import { first } from '../db/index.js';
import { successfulCollectionSql } from './collection-error.js';

export const IMPORTED_JSON_PREFIX = 'import: ';
export const UPSERT_SUCCESSFUL_DATA = `
  ON CONFLICT (serial_no, ts) DO UPDATE SET
    room=excluded.room, time=excluded.time, kwh=excluded.kwh, balance=excluded.balance,
    ms=excluded.ms, raw=excluded.raw
  WHERE NOT (${successfulCollectionSql('data')})
`;
const STATUS_HEAD = 'FROM status WHERE serial_no = ?1 ORDER BY last_online_time DESC LIMIT 1';
const HEAD_STATUS = `
  SELECT last_online_time, occupied, broke, base_line, last_kwh, delta, duration, tail
    ${STATUS_HEAD}
`;

// 采样与状态共用头快照，含空库与仅基线变更的情况。
const matchesHead = (time, base) =>
  `(?${time}, ?${base}) IS (SELECT last_online_time, base_line ${STATUS_HEAD})`;
const INSERT_DATA = `
  INSERT INTO data (ts, serial_no, room, time, kwh, balance, ms, raw)
  SELECT ?2, ?1, ?3, ?4, ?5, ?6, ?7, ?8 FROM (SELECT 1)
   WHERE ${matchesHead(9, 10)} ${UPSERT_SUCCESSFUL_DATA}
`;
const INSERT_FAILURE = `
  INSERT INTO data (ts, serial_no, room, time, kwh, balance, ms, raw)
  VALUES (?,?,?,?,?,?,?,?) ON CONFLICT (serial_no, ts) DO NOTHING
`;

const INSERT_STATUS = `
  INSERT INTO status (serial_no, last_online_time, occupied, broke, base_line, last_kwh, delta, duration, tail)
  SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9
   WHERE ${matchesHead(10, 11)}
`;
const UPDATE_STATUS = `
  UPDATE status SET last_online_time = ?2, occupied = ?3, broke = ?4,
                    last_kwh = ?5, delta = ?6, duration = ?7
   WHERE serial_no = ?1 AND last_online_time = ?8 AND ${matchesHead(8, 9)}
`;

const existingSample = (ts) => `FROM data WHERE serial_no = ?1 AND ts = ${ts} AND ${successfulCollectionSql()}`;
const HAS_SAMPLE = ` AND EXISTS (SELECT 1 ${existingSample("unixepoch(?2, '-8 hours')")})`;

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
 * 首轮并发抓取，成功采样立即入库并通知，失败的电表退避重试后单独入库。
 */
export async function runCollect(env, { source = 'cron' } = {}) {
  const meters = getMeters(env);
  const deviceApiUrl = URL.parse(env.SOURCE_URL);
  if (deviceApiUrl?.protocol !== 'http:' && deviceApiUrl?.protocol !== 'https:') {
    throw new Error('SOURCE_URL 必须配置为有效的 HTTP(S) 地址');
  }
  const startedAt = Date.now();
  const batchId = `${startedAt}-${Math.random().toString(36).slice(2, 8)}`;

  const batch = { startedAt, batchId, source };
  const firstResults = await Promise.all(meters.map(async (meter) => ({
    ...meter, ...await fetchDevice(meter.serial, deviceApiUrl, { firstOnly: true }),
  })));
  const failed = firstResults.filter((r) => !r.ok);
  if (!failed.length) return persistCollections(env, firstResults, batch);

  const ready = firstResults.filter((r) => r.ok);
  const firstBatch = ready.length ? persistCollections(env, ready, batch) : null;
  const retryBatch = Promise.all(failed.map(async ({ serial, room, attemptsLog }) => ({
    serial, room, ...await fetchDevice(serial, deviceApiUrl, { attemptsLog }),
  }))).then((results) => persistCollections(env, results, batch));
  const [early, late] = await Promise.all([firstBatch, retryBatch]);
  if (!early) return late;

  const insertError = early.insert_error ?? late.insert_error;
  const detailBySerial = new Map([...early.detail, ...late.detail].map((d) => [d.serial, d]));
  return {
    ...early,
    meters_total: meters.length,
    meters_ok: early.meters_ok + late.meters_ok,
    meters_fail: early.meters_fail + late.meters_fail,
    attempted: early.attempted + late.attempted,
    inserted: early.inserted + late.inserted,
    duplicated: insertError ? 0 : early.duplicated + late.duplicated,
    failed_inserted: early.failed_inserted + late.failed_inserted,
    end_changed: early.end_changed + late.end_changed,
    insert_error: insertError,
    duration_ms: Date.now() - startedAt,
    detail: meters.map(({ serial }) => detailBySerial.get(serial)),
  };
}

/** 返回 null 表示状态已处理或超越这一时刻。 */
function describeCollection(reading, head) {
  const p = reading.payload;
  const serial = reading.serial;
  const statusTime = p.lastOnlineTime;
  if (head && statusTime <= head.last_online_time) return null;
  const ts = toEpoch(statusTime);
  let endText = '';
  let frontText = '';
  try {
    endText = extractEnd(reading.raw);
    frontText = extractFront(reading.raw);
  } catch (e) {
    console.error('截取原文失败', serial, e.message);
  }

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
  };
}

/** 只在有电表需要充值判断时，批量查询各表上次有效余额。 */
async function loadPreviousBalances(env, descs) {
  const targets = descs.filter((d) => d.sample.balance != null && env[`WH_${d.reading.room}`]);
  if (!targets.length) return descs.map(() => null);
  const results = await env.DB.batch(
    targets.map((d) => env.DB.prepare(PREVIOUS_BALANCE).bind(d.serial, d.ts)),
  );
  const balanceOf = new Map(targets.map((d, i) => [d, results[i]?.results?.[0]?.balance ?? null]));
  return descs.map((d) => balanceOf.get(d) ?? null);
}

function buildStatus(env, desc, previousBalance, guard) {
  const { state, events } = advanceStatus(desc.head, desc.sample, previousBalance);
  const hasEnd = !desc.head || desc.head.tail !== desc.endText;
  const headTime = desc.head?.last_online_time ?? null;
  const headBase = desc.head?.base_line ?? null;
  const statusStatement = hasEnd
    ? env.DB.prepare(INSERT_STATUS + guard).bind(desc.serial, desc.statusTime, state.occupied,
        state.broke, state.base_line, state.last_kwh, state.delta, state.duration, desc.endText, headTime, headBase)
    : env.DB.prepare(UPDATE_STATUS + guard).bind(desc.serial, desc.statusTime, state.occupied,
        state.broke, state.last_kwh, state.delta, state.duration, headTime, headBase);
  return { reading: desc.reading, serial: desc.serial, hasEnd, events, statusStatement };
}

/** 依据状态快照与上次余额生成该表的两条写语句。 */
function buildStatements(env, desc, previousBalance) {
  const p = desc.reading.payload;
  const dataStatement = env.DB.prepare(INSERT_DATA).bind(
    desc.serial, desc.ts, p.houseName || p.userName || null, desc.statusTime, desc.sample.kwh,
    desc.sample.balance,
    typeof desc.reading.durationMs === 'number' ? desc.reading.durationMs : null, desc.frontText,
    desc.head?.last_online_time ?? null, desc.head?.base_line ?? null,
  );
  return { ...buildStatus(env, desc, previousBalance, ' AND changes() > 0'), dataStatement };
}

/** 重新核对头快照；同刻已有成功记录时，以已入库的读数补写状态。 */
async function retryCollection(env, reading) {
  for (let attempt = 0; attempt < 3; attempt++) {
    const head = await first(env.DB, HEAD_STATUS, [reading.serial]);
    const desc = describeCollection(reading, head);
    if (!desc) return null;

    const existing = await first(env.DB, `SELECT kwh, balance, raw ${existingSample('?2')}`, [desc.serial, desc.ts]);
    if (existing) {
      desc.sample = { ts: desc.ts, kwh: existing.kwh, balance: existing.balance };
      if (existing.raw === 'manual') {
        desc.endText = head?.tail ?? '';
      } else if (existing.raw.startsWith(IMPORTED_JSON_PREFIX)) {
        desc.endText = extractEnd(existing.raw) || head?.tail || '';
      }
    }
    const [previousBalance] = await loadPreviousBalances(env, [desc]);
    if (existing) {
      const item = buildStatus(env, desc, previousBalance, HAS_SAMPLE);
      const result = await item.statusStatement.run();
      if (result.meta?.changes > 0) return { item, inserted: 0 };
    } else {
      const item = buildStatements(env, desc, previousBalance);
      const [data, status] = await env.DB.batch([item.dataStatement, item.statusStatement]);
      if (status.meta?.changes > 0) return { item, inserted: data.meta.changes };
    }
  }
  throw new Error(`电表 ${reading.serial} 的采样提交仍有冲突`);
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
          okOnes.map((r) => env.DB.prepare(HEAD_STATUS).bind(r.serial)),
        )).map((r) => r.results?.[0] ?? null)
      : [];
    // 重复采样只消耗一次头部读取，不进入余额查询与写入批次。
    const descs = okOnes.map((r, i) => describeCollection(r, heads[i])).filter(Boolean);

    const balances = await loadPreviousBalances(env, descs);
    const plan = descs.map((desc, i) => buildStatements(env, desc, balances[i]));

    const statements = plan.flatMap(item => [item.dataStatement, item.statusStatement]);
    const failureOffset = statements.length;
    if (failureStatements.length) statements.push(...failureStatements);

    if (statements.length) {
      const batchResults = await env.DB.batch(statements);
      const conflicts = [];
      for (let i = 0; i < plan.length; i++) {
        inserted += batchResults[i * 2]?.meta?.changes ?? 0;
        if ((batchResults[i * 2 + 1]?.meta?.changes ?? 0) > 0) {
          committed.push(plan[i]);
          if (plan[i].hasEnd) endChanged++;
        } else {
          conflicts.push(plan[i].reading);
        }
      }
      for (const result of batchResults.slice(failureOffset)) failedInserted += result.meta?.changes ?? 0;

      for (const reading of conflicts) {
        try {
          const retry = await retryCollection(env, reading);
          if (!retry) continue;
          const { item } = retry;
          inserted += retry.inserted;
          committed.push(item);
          if (item.hasEnd) endChanged++;
        } catch (e) {
          insertError ??= e.message;
        }
      }
    }
  } catch (e) {
    insertError = e.message;
  }

  // 通知失败不回滚已提交的采样和状态。
  const notifications = await Promise.allSettled(
    committed.map((item) => checkNotifications(env, item.serial, item.reading.room, item.events)),
  );
  for (const result of notifications) {
    if (result.status === 'rejected') console.error('通知检查失败:', result.reason?.message ?? result.reason);
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
