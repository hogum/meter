import { buildSummary, RANGE_SECONDS, DEFAULT_RANGE } from '../modules/summary.js';
import { all, first } from '../db/index.js';
import { getSession } from '../lib/auth.js';
import { successfulCollectionSql } from '../modules/collection-error.js';

const RANGE_OPTIONS = [
  ['24h', '近 24 小时'],
  ['3d', '近 3 天'],
  ['7d', '近 7 天'],
];

function pickRange(value) {
  return RANGE_SECONDS[value] ? value : DEFAULT_RANGE;
}

/**
 * 解析东八区日期时间，兼容输入框的分钟及导出链接的秒精度 → Unix 秒。
 * 解析不出来返回 null，交给上层退回预设范围。
 */
function parseLocalMinute(value, endOfMinute = false) {
  const m = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2}))?$/.exec(String(value || ''));
  if (!m) return null;
  const canonical = `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6] ?? (endOfMinute ? '59' : '00')}`;
  const ms = Date.parse(`${canonical}+08:00`);
  if (!Number.isFinite(ms) || new Date(ms + 8 * 3600000).toISOString().slice(0, 19) !== canonical) return null;
  return Math.floor(ms / 1000);
}

/** 从 query 里取一对合法区间；不合法或不完整时返回 null */
function pickWindow(searchParams) {
  const from = parseLocalMinute(searchParams.get('from'));
  // 输入框精度到分钟，结束边界包含该分钟；导出链接有秒数时保留精确边界。
  const to = parseLocalMinute(searchParams.get('to'), true);
  if (from === null || to === null || to <= from) return null;
  return { from, to };
}

async function loadTemplate(env, url) {
  const res = await env.ASSETS.fetch(new URL('/dashboard.html', url).toString());
  if (!res.ok) {
    return {
      ok: false,
      response: new Response('页面模板缺失', {
        status: 500,
        headers: { 'content-type': 'text/plain; charset=utf-8' },
      }),
    };
  }
  return { ok: true, html: await res.text() };
}

/** 注入的数据必须转义 `<`，否则字符串里的 `</script>` 会截断标签 */
function inject(html, key, value) {
  return html.replace(`"__${key}_PLACEHOLDER__"`, () => JSON.stringify(value).replace(/</g, '\\u003c'));
}

/** 未登录不注入业务数据；登录后仅查询 JWT 绑定的电表。 */
export async function dashboard(request, env) {
  const url = new URL(request.url);
  const range = pickRange(url.searchParams.get('range'));

  const tpl = await loadTemplate(env, url);
  if (!tpl.ok) return tpl.response;
  let html = tpl.html;

  const session = await getSession(request, env);

  if (!session) {
    html = inject(html, 'SESSION', { loggedIn: false });
    html = inject(html, 'DATA', null);
    return new Response(html, {
      headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' },
    });
  }

  const win = pickWindow(url.searchParams);

  let view = null;
  try {
    const payload = await buildSummary(env, {
      serial: session.serial,
      range,
      from: win?.from,
      to: win?.to,
    });
    view = payload ? {
      ...payload,
      ranges: RANGE_OPTIONS,
      range: win ? 'custom' : range,
      // 用 summary 截断过的区间，否则输入框会显示选到未来去的 to
      window: payload.window,
    } : { error: '该电表暂无采集数据' };
  } catch (e) {
    const message = String(e?.message || e);
    const quota = /exceeded D1.*daily row (read|write) limit/i.exec(message);
    view = { error: quota
      ? `数据库今日${quota[1].toLowerCase() === 'read' ? '读取' : '写入'}额度已耗尽，采集保存及历史查询暂不可用。额度将于北京时间每天 08:00 重置，请在重置后刷新页面。`
      : message };
  }

  html = inject(html, 'SESSION', {
    loggedIn: true,
    rechargeEnabled: getRechargeUrl(env) !== null,
  });
  html = inject(html, 'DATA', view);

  return new Response(html, {
    headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' },
  });
}

function getRechargeUrl(env) {
  const url = URL.parse(env.RECHARGE_URL);
  return url?.protocol === 'http:' || url?.protocol === 'https:' ? url : null;
}

export async function recharge(request, env) {
  const headers = { 'cache-control': 'no-store' };
  const session = await getSession(request, env);
  if (!session) {
    return new Response('请先登录', { status: 401, headers });
  }
  const url = getRechargeUrl(env);
  if (!url) return new Response('充值入口未配置', { status: 404, headers });

  if (url.hash.startsWith('#/')) {
    const queryStart = url.hash.indexOf('?');
    const path = queryStart < 0 ? url.hash : url.hash.slice(0, queryStart);
    const params = new URLSearchParams(queryStart < 0 ? '' : url.hash.slice(queryStart + 1));
    params.set('no', session.serial);
    url.hash = `${path}?${params}`;
  } else {
    url.searchParams.set('no', session.serial);
  }
  return new Response(null, { status: 302, headers: { ...headers, location: url.href } });
}

/** TXT 混合保存厂商原文及 manual CSV，排除失败采样。 */
export async function exportData(request, env) {
  const url = new URL(request.url);
  const range = pickRange(url.searchParams.get('range'));

  const session = await getSession(request, env);
  if (!session) {
    return new Response('请先登录', {
      status: 401,
      headers: { 'content-type': 'text/plain; charset=utf-8' },
    });
  }

  const serial = session.serial;

  const latest = await first(env.DB, `SELECT ts FROM data WHERE serial_no = ?1 ORDER BY ts DESC LIMIT 1`, [serial]);
  if (!latest) return new Response('该表还没有数据', { status: 404 });

  const win = pickWindow(url.searchParams);
  const from = win ? win.from : latest.ts - (RANGE_SECONDS[range] || RANGE_SECONDS[DEFAULT_RANGE]);
  const to = win ? Math.min(win.to, latest.ts) : latest.ts;

  const rows = await all(
    env.DB,
    `SELECT raw, serial_no, room, kwh, balance,
       COALESCE(time, datetime(ts, 'unixepoch', '+8 hours')) AS sample_time
       FROM data
      WHERE serial_no = ?1 AND ts >= ?2 AND ts <= ?3
        AND ${successfulCollectionSql()}
      ORDER BY ts`,
    [serial, from, to],
  );

  // 一次读取该表的后半段版本，在内存匹配，避免对每条采样执行关联子查询。
  const versions = rows.some(r => r.raw !== 'manual') ? await all(env.DB,
    `SELECT last_online_time, tail FROM status WHERE serial_no = ?1 ORDER BY last_online_time`,
    [serial]) : [];
  let versionIndex = 0;
  let previousTime = null;
  const body = rows.map((r) => {
    if (r.raw === 'manual') {
      return ['manual', r.serial_no, r.room, r.sample_time, r.kwh, r.balance].map(value => {
        const text = String(value ?? '');
        return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
      }).join(',');
    }
    const time = r.sample_time;
    // 通常 time 与 ts 同序；异常旧数据时间倒序时重新定位，保持原 SQL 语义。
    if (time != null && previousTime != null && time < previousTime) versionIndex = 0;
    if (time != null) {
      while (versionIndex < versions.length && versions[versionIndex].last_online_time < time) versionIndex++;
      previousTime = time;
    }
    const tail = time == null ? '' : versions[versionIndex]?.tail;
    return (r.raw || '') + (tail || '');
  }).join('\n');

  return new Response(body, {
    headers: {
      'content-type': 'text/plain; charset=utf-8',
      'content-disposition': `attachment; filename="${encodeURIComponent(session.user)}_${win ? 'custom' : range}.txt"`,
      'cache-control': 'no-store',
    },
  });
}
