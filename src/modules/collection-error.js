// 失败记录使用简短文本；成功原文的拆分和导出格式不变。
export const COLLECTION_ERROR_PREFIX = 'error: ';
export const COLLECTION_TIMEOUT_MS = 9999;

export function encodeCollectionError(error) {
  if (error.type === 'timeout') return 'error: timeout';
  if (error.type === 'http' && Number.isInteger(error.http_status)) return `error: ${error.http_status}`;
  return error.type === 'response' ? 'error: response' : 'error: network';
}

// 统一用于看板、导出和成功覆盖失败的条件。
export function successfulCollectionSql(alias = '') {
  const column = alias ? `${alias}.` : '';
  return `COALESCE(${column}ms, 0) <> ${COLLECTION_TIMEOUT_MS}
    AND substr(${column}raw, 1, ${COLLECTION_ERROR_PREFIX.length}) <> '${COLLECTION_ERROR_PREFIX}'`;
}

export function readCollectionError(raw, ms) {
  if (ms === COLLECTION_TIMEOUT_MS) return { type: 'timeout' };
  if (typeof raw !== 'string') return null;
  if (raw.startsWith(COLLECTION_ERROR_PREFIX)) {
    const reason = raw.slice(COLLECTION_ERROR_PREFIX.length).trim();
    return /^\d{3}$/.test(reason) ? { type: 'http', http_status: Number(reason) }
      : { type: reason || 'unknown' };
  }
  return null;
}
