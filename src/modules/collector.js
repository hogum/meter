import { FETCH_TIMEOUT_MS, RETRY_DELAYS_MS } from '../config.js';
import { COLLECTION_TIMEOUT_MS, encodeCollectionError } from './collection-error.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 上游东八区时间转Unix秒；缺失、格式错误或不存在的日期均为无效。 */
export function toEpoch(timeText) {
  if (typeof timeText !== 'string' || !/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(timeText)) return null;
  const ms = Date.parse(`${timeText.replace(' ', 'T')}+08:00`);
  if (!Number.isFinite(ms)) return null;
  const normalized = new Date(ms + 8 * 3600000).toISOString().slice(0, 19).replace('T', ' ');
  return normalized === timeText ? Math.floor(ms / 1000) : null;
}

/**
 * 拉取设备详情，网络、超时、HTTP和响应异常按配置重试。
 * 可只执行首轮，或携带首轮日志继续剩余重试。
 */
export async function fetchDevice(serial, deviceApiUrl, { firstOnly = false, attemptsLog: previous = [] } = {}) {
  const url = new URL(deviceApiUrl);
  url.searchParams.set('SerialNo', serial);
  const attemptsLog = [...previous];
  const limit = firstOnly ? 1 : RETRY_DELAYS_MS.length;
  let lastFailure;

  for (let i = attemptsLog.length; i < limit; i++) {
    if (RETRY_DELAYS_MS[i] > 0) await sleep(RETRY_DELAYS_MS[i]);
    const started = Date.now();
    let signal;
    let httpStatus = null;
    let failureType = 'network';

    try {
      signal = AbortSignal.timeout(FETCH_TIMEOUT_MS);
      const res = await fetch(url.href, {
        method: 'GET',
        headers: { accept: 'application/json' },
        signal,
      });

      httpStatus = res.status;
      const text = await res.text();
      if (!res.ok) {
        failureType = 'http';
        throw new Error(`HTTP ${res.status}`);
      }
      failureType = 'response';

      let body;
      try {
        body = JSON.parse(text);
      } catch {
        throw new Error(`返回不是 JSON: ${text.slice(0, 80)}`);
      }

      if (!body?.success || !body.response) {
        throw new Error(body?.msg || '接口 success=false');
      }
      const payload = body.response;
      if (String(payload.serialNo ?? '') !== serial) {
        throw new Error('响应 serialNo 与请求表号不一致');
      }
      const reading = payload.readNumber;
      if (typeof reading !== 'number' || !Number.isFinite(reading) || reading < 0) {
        throw new Error('readNumber 须为有限非负数');
      }
      const ts = toEpoch(payload.lastOnlineTime);
      if (ts == null) {
        throw new Error('缺少有效的 lastOnlineTime');
      }
      if (ts > Math.floor(Date.now() / 1000) + 300) {
        throw new Error('lastOnlineTime 超前当前时间超过 300 秒');
      }

      const ms = Date.now() - started;
      attemptsLog.push({ attempt: i + 1, ms, ok: true });
      return {
        ok: true,
        payload,
        raw: text,                            // 原始响应原文，用于原样截取后半段
        httpStatus: res.status,
        attempts: i + 1,
        durationMs: ms,
        attemptsLog,
      };
    } catch (e) {
      const timedOut = e?.name === 'TimeoutError'
        || (signal?.aborted && signal.reason?.name === 'TimeoutError');
      lastFailure = {
        type: timedOut ? 'timeout' : failureType,
        ...(failureType === 'http' && httpStatus != null ? { http_status: httpStatus } : {}),
      };
      attemptsLog.push({
        attempt: i + 1,
        ms: Date.now() - started,
        ok: false,
        error: `${e?.name || 'Error'}: ${e?.message || e}`,
      });
    }
  }

  return {
    ok: false,
    error: attemptsLog.at(-1).error,
    attempts: attemptsLog.length,
    attemptsLog,
    // 8秒超时的约定标记；9999表示超时，不是9.999秒的实际耗时。
    durationMs: lastFailure?.type === 'timeout' ? COLLECTION_TIMEOUT_MS : attemptsLog.at(-1)?.ms ?? null,
    raw: encodeCollectionError(lastFailure),
  };
}
