import { extractEnd, extractFront, IMPORTED_JSON_PREFIX, pickRoom, UPSERT_SUCCESSFUL_DATA } from './collect.js';
import { toEpoch } from './collector.js';

export { IMPORTED_JSON_PREFIX } from './collect.js';

// 用绑定参数构造 VALUES，避免 D1 将文件中的输入记录计为读取行。
const INSERT_HISTORY = `
  INSERT INTO data (ts, serial_no, room, time, kwh, balance, ms, raw)
  VALUES
`;

const BATCH_BYTES = 1_000_000;
const MAX_RECORD_BYTES = 2_000_000;
// 每行绑定 7 个参数。D1 单条语句最多绑定 100 个参数。
const ROWS_PER_STATEMENT = 14;
const encoder = new TextEncoder();

function readJson(text, start, content, lineBreak, jsonToken) {
  lineBreak.lastIndex = content;
  let end = lineBreak.exec(text)?.index ?? text.length;
  let raw = text.slice(start, end);
  try {
    return { value: JSON.parse(raw), raw, end };
  } catch {
    // 厂商原文可能跨行。先找到外层对象的结束位置，再交给 JSON.parse 校验。
    jsonToken.lastIndex = content;
    let depth = 0;
    for (let token; (token = jsonToken.exec(text));) {
      if (token[0] === '{') depth++;
      if (token[0] === '}' && --depth === 0) {
        lineBreak.lastIndex = jsonToken.lastIndex;
        end = lineBreak.exec(text)?.index ?? text.length;
        raw = text.slice(start, end);
        try {
          return { value: JSON.parse(raw), raw, end };
        } catch {
          break;
        }
      }
    }
    throw new Error('厂商 JSON 格式无效');
  }
}

function readManual(text, start, csvField) {
  const fields = [];
  let end = start + 'manual,'.length;
  for (let i = 0; i < 5; i++) {
    if (i > 0 && text[end++] !== ',') throw new Error('manual 记录应有 6 个字段');
    csvField.lastIndex = end;
    const field = csvField.exec(text);
    fields.push(field[1] === undefined ? field[0] : field[1].replaceAll('""', '"'));
    end = csvField.lastIndex;
  }
  return { fields, end };
}

function csvNumber(value) {
  if (value === '') return null;
  const number = Number(value);
  if (!value.trim() || !Number.isFinite(number)) throw new Error('电量或余额无效');
  return number;
}

/** 校验完整个文件，再将记录分成可独立重试的 D1 写入批次。 */
export function prepareHistoryImport(text, serials) {
  const firstContent = /[^ \t\r\n]/g;
  const lineBreak = /\r\n|[\r\n]/g;
  const jsonToken = /"[^"\\]*(?:\\[\s\S][^"\\]*)*"|[{}]/g;
  const csvField = /"([^"]*(?:""[^"]*)*)"|[^",\r\n]*/y;
  const separator = /[ \t]*(?:\r\n|[\r\n]|$)/y;
  const batches = [];
  const seen = new Set();
  let duplicates = 0;
  let records = [];
  let bytes = 0;
  let offset = 0;

  const flush = () => {
    batches.push(records);
    records = [];
    bytes = 0;
  };

  for (let match; (match = firstContent.exec(text));) {
    const content = match.index;
    let start = content;
    while (start > offset && (text[start - 1] === ' ' || text[start - 1] === '\t')) start--;
    try {
      let serial, room, time, kwh, balance, raw, end;
      let skipRecord = false;
      if (text.startsWith('manual,', content)) {
        const record = readManual(text, content, csvField);
        const [no, name, sampleTime, reading, amount] = record.fields;
        [serial, room, time, kwh, balance] = [
          no,
          typeof name === 'string' && name.trim() ? name.trim() : null,
          sampleTime,
          csvNumber(reading),
          csvNumber(amount),
        ];
        if (kwh == null || kwh < 0) throw new Error('电量须为非负数');
        raw = 'manual';
        end = record.end;
      } else if (text[content] === '{') {
        const record = readJson(text, start, content, lineBreak, jsonToken);
        const payload = record.value?.response;
        if (!record.value?.success || !payload || typeof payload !== 'object') {
          throw new Error('厂商记录缺少成功响应');
        }
        const no = payload.serialNo;
        serial = typeof no === 'string' || Number.isSafeInteger(no) ? String(no) : '';
        room = pickRoom(payload);
        time = payload.lastOnlineTime;
        if (payload.valveStateName === null) {
          skipRecord = true;
        } else {
          if (typeof payload.readNumber !== 'number' || !Number.isFinite(payload.readNumber) || payload.readNumber < 0) {
            throw new Error('电量读数须为有限非负数');
          }
          kwh = payload.readNumber;
        }
        balance = typeof payload.residualAmount === 'number' && Number.isFinite(payload.residualAmount)
          ? payload.residualAmount : null;
        raw = IMPORTED_JSON_PREFIX + record.raw;
        end = record.end;
      } else {
        throw new Error('应为厂商 JSON 或 manual 记录');
      }

      separator.lastIndex = end;
      if (!separator.test(text)) throw new Error('记录末尾有多余内容');
      offset = separator.lastIndex;
      firstContent.lastIndex = offset;

      if (!serials.has(serial)) throw new Error('未知电表');
      if (skipRecord) {
        duplicates++;
        continue;
      }
      const ts = toEpoch(time);
      if (ts === null) throw new Error('采样时间无效');
      const record = [ts, serial, room, time, kwh, balance, raw];
      const size = encoder.encode(JSON.stringify(record)).byteLength + 1;
      if (size > MAX_RECORD_BYTES) throw new Error('单条记录过大');
      const key = `${serial}:${ts}`;
      if (seen.has(key)) {
        duplicates++;
        continue;
      }
      seen.add(key);
      if (records.length && bytes + size > BATCH_BYTES) flush();
      records.push(record);
      bytes += size;
    } catch (error) {
      const line = (text.slice(0, start).match(/\r\n|[\r\n]/g)?.length ?? 0) + 1;
      throw new Error(`第 ${line} 行${error.message}`);
    }
  }
  if (records.length) flush();
  if (!batches.length && !duplicates) throw new Error('文件没有采样记录');
  return { batches, duplicates };
}

function findTail(versions, time) {
  let low = 0;
  let high = versions.length;
  while (low < high) {
    const mid = (low + high) >> 1;
    if (versions[mid].last_online_time < time) low = mid + 1;
    else high = mid;
  }
  return versions[low]?.tail ?? null;
}

async function loadStatusVersions(db, batches) {
  const ranges = new Map();
  for (const batch of batches) {
    for (const [, serial, , time, , , raw] of batch) {
      if (!raw.startsWith(IMPORTED_JSON_PREFIX)) continue;
      const range = ranges.get(serial);
      if (!range) ranges.set(serial, { from: time, to: time });
      else if (time < range.from) range.from = time;
      else if (time > range.to) range.to = time;
    }
  }
  if (!ranges.size) return new Map();
  const serials = [...ranges.keys()];
  const results = await db.batch(serials.map(serial => {
    const { from, to } = ranges.get(serial);
    return db.prepare(`SELECT last_online_time, tail FROM status
      WHERE serial_no = ?1 AND last_online_time BETWEEN ?2 AND ?3
      UNION ALL SELECT * FROM (
        SELECT last_online_time, tail FROM status WHERE serial_no = ?1 AND last_online_time > ?3
        ORDER BY last_online_time LIMIT 1
      ) ORDER BY last_online_time`).bind(serial, from, to);
  }));
  return new Map(serials.map((serial, i) => [serial, results[i].results]));
}

function compactRaw(record, versionsBySerial) {
  const raw = record[6];
  if (!raw.startsWith(IMPORTED_JSON_PREFIX)) return record;
  const versions = versionsBySerial.get(record[1]);
  if (!versions?.length) return record;
  const original = raw.slice(IMPORTED_JSON_PREFIX.length);
  const endText = extractEnd(original);
  if (!endText || findTail(versions, record[3]) !== endText) return record;
  return [record[0], record[1], record[2], record[3], record[4], record[5], extractFront(original)];
}

export async function writeHistory(db, { batches, duplicates }) {
  let written = 0;
  let skipped = duplicates;
  try {
    const versionsBySerial = await loadStatusVersions(db, batches);
    for (const records of batches) {
      const statements = [];
      for (let offset = 0; offset < records.length; offset += ROWS_PER_STATEMENT) {
        const rows = records.slice(offset, offset + ROWS_PER_STATEMENT)
          .map((record) => compactRaw(record, versionsBySerial));
        const placeholders = rows.map(() => '(?,?,?,?,?,?,NULL,?)').join(',');
        const sql = INSERT_HISTORY + placeholders + UPSERT_SUCCESSFUL_DATA;
        statements.push(db.prepare(sql).bind(...rows.flat()));
      }
      const results = await db.batch(statements);
      const changes = results.reduce((sum, { meta }) => sum + meta.changes, 0);
      written += changes;
      skipped += records.length - changes;
    }
    return { success: true, written, skipped };
  } catch {
    return { success: false, error: '数据库写入失败，可重新上传同一文件', written, skipped };
  }
}
