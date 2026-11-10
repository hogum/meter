import { getMeters } from '../config.js';
import { persistCollections } from '../modules/collect.js';
import { prepareHistoryImport, writeHistory } from '../modules/history-import.js';

const headers = { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' };
const reply = (status, body) => new Response(JSON.stringify(body), { status, headers });
const MAX_FILE_MIB = 16;
const MAX_FILE_BYTES = MAX_FILE_MIB * 1024 * 1024;
const FILE_TOO_LARGE = '上传文件不能超过 ' + MAX_FILE_MIB + ' MiB';

const uploadHtml = `<!doctype html>
<html lang="zh-CN">
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>导入电表历史数据</title>
<style>
  :root { color-scheme: light dark; font: 16px/1.6 system-ui, sans-serif; }
  body { margin: 0; padding: 24px; }
  main { max-width: 30rem; margin: 8vh auto; }
  h1 { font-size: 1.5rem; }
  label, input, button { display: block; }
  input, button { font: inherit; margin-top: 12px; max-width: 100%; }
  button { padding: 6px 18px; }
</style>
<main>
  <h1>导入电表历史数据</h1>
  <form method="post" enctype="multipart/form-data">
    <label for="file">选择 TXT 或 JSONL 历史数据文件（最大 ${MAX_FILE_MIB} MiB）</label>
    <input id="file" name="file" type="file" accept=".txt,.jsonl" required>
    <button>上传并导入</button>
  </form>
  <p id="result" role="status"></p>
</main>
<script>
  const form = document.querySelector('form');
  const button = form.querySelector('button');
  const result = document.querySelector('#result');
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    button.disabled = true;
    result.textContent = '正在导入…';
    try {
      const response = await fetch(location.pathname + location.search, {
        method: 'POST',
        body: new FormData(form),
      });
      const data = await response.json();
      const counts = Number.isInteger(data.written)
        ? '已写入 ' + data.written + ' 条，跳过 ' + data.skipped + ' 条。' : '';
      const message = typeof data.error === 'string' ? data.error : data.error?.message;
      result.textContent = data.success ? counts : (message || '导入失败') + ' ' + counts;
    } catch {
      result.textContent = '上传失败，可以重新提交同一文件。';
    } finally {
      button.disabled = false;
    }
  });
</script>
</html>`;

function checkUploadRequest(request, env) {
  const params = new URL(request.url).searchParams;
  if (!env.UPLOAD_TOKEN || params.get('tk') !== env.UPLOAD_TOKEN) {
    return reply(401, { success: false, error: '上报凭证无效' });
  }
  if (params.get('act') !== 'up') return reply(400, { success: false, error: '不支持的操作' });
  return null;
}

export function uploadPage(request, env) {
  return checkUploadRequest(request, env) ?? new Response(uploadHtml, {
    headers: {
      'content-type': 'text/html; charset=utf-8',
      'cache-control': 'no-store',
      'referrer-policy': 'no-referrer',
    },
  });
}

export async function upload(request, env) {
  const startedAt = Date.now();
  const error = checkUploadRequest(request, env);
  if (error) return error;

  if (Number(request.headers.get('content-length')) > MAX_FILE_BYTES + 65536) {
    return reply(413, { success: false, error: FILE_TOO_LARGE });
  }
  let form;
  try {
    form = await request.formData();
  } catch {
    return reply(400, { success: false, error: '请提交表单数据' });
  }
  let meters;
  try {
    meters = getMeters(env);
  } catch {
    return reply(503, { success: false, error: '电表映射配置无效' });
  }
  if (form.has('file')) return importFile(env.DB, form.get('file'), meters);
  return uploadReading(env, form, meters, startedAt);
}

async function importFile(db, file, meters) {
  if (!(file instanceof File) || !file.size) {
    return reply(400, { success: false, error: '请选择包含采样记录的 TXT 或 JSONL 文件' });
  }
  if (file.size > MAX_FILE_BYTES) return reply(413, { success: false, error: FILE_TOO_LARGE });

  let text;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(await file.arrayBuffer());
  } catch {
    return reply(400, { success: false, error: '文件须使用 UTF-8 编码' });
  }
  let plan;
  try {
    plan = prepareHistoryImport(text, meters);
  } catch (error) {
    return reply(400, { success: false, error: error.message });
  }
  const result = await writeHistory(db, plan);
  return reply(result.success ? 200 : 500, result);
}

async function uploadReading(env, form, meters, startedAt) {
  const meter = meters.find(m => m.serial === form.get('no'));
  if (!meter) return reply(400, { success: false, error: '未知电表' });
  const room = form.get('room');
  if (room && room !== meter.room) return reply(400, { success: false, error: '房间号与电表不匹配' });
  const number = key => {
    const value = form.get(key);
    return typeof value === 'string' && /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)$/.test(value)
      ? Number(value) : NaN;
  };
  const kwh = number('kwh');
  const balance = number('balance');
  if (!Number.isFinite(kwh) || kwh < 0 || !Number.isFinite(balance)) {
    return reply(400, { success: false, error: 'kwh须为非负数，balance须为有效数字' });
  }
  const time = new Date(startedAt + 28800000).toISOString().slice(0, 19).replace('T', ' ');
  let result;
  try {
    result = await persistCollections(env, [{
      ok: true, manual: true, serial: meter.serial, room: meter.room, raw: 'manual', durationMs: null,
      payload: { serialNo: meter.serial, houseName: meter.room, lastOnlineTime: time,
        readNumber: kwh, residualAmount: balance },
    }], { startedAt });
  } catch {
    return reply(500, { success: false, error: '数据库访问失败' });
  }
  if (result.insert_error) return reply(500, { success: false, error: '数据库写入失败' });
  return reply(200, { success: true, result: result.inserted ? 'inserted' : 'skipped', time });
}
