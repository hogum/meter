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
 * 成功须有有效lastOnlineTime，最终失败交上层落库，attemptsLog保留逐次耗时和错误。
 */
export async function fetchDevice(serial, deviceApiUrl) {
  const url = new URL(deviceApiUrl);
  url.searchParams.set('SerialNo', serial);
  const attemptsLog = [];
  let lastError = null;
  let lastFailure = null;

  for (let i = 0; i < RETRY_DELAYS_MS.length; i++) {
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

      if (!body.success || !body.response) {
        throw new Error(body.msg || '接口 success=false');
      }
      if (toEpoch(body.response.lastOnlineTime) == null) {
        throw new Error('缺少有效的 lastOnlineTime');
      }

      attemptsLog.push({ attempt: i + 1, ms: Date.now() - started, ok: true });
      return {
        ok: true,
        payload: body.response,
        raw: text,                            // 原始响应原文，用于原样截取后半段
        httpStatus: res.status,
        attempts: i + 1,
        durationMs: Date.now() - started,
        attemptsLog,
      };
    } catch (e) {
      lastError = e;
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
    error: `${lastError?.name || 'Error'}: ${lastError?.message || lastError}`,
    attempts: RETRY_DELAYS_MS.length,
    attemptsLog,
    // 8秒超时的约定标记；9999表示超时，不是9.999秒的实际耗时。
    durationMs: lastFailure?.type === 'timeout' ? COLLECTION_TIMEOUT_MS : attemptsLog.at(-1)?.ms ?? null,
    raw: encodeCollectionError(lastFailure),
  };
}
