import { createRouter } from './lib/router.js';
import { fail } from './lib/response.js';
import { dashboard, exportData, recharge } from './routes/page.js';
import { login, logout } from './routes/auth.js';
import { runCollect } from './modules/collect.js';
import { upload, uploadPage } from './routes/api.js';
import { clean } from './routes/clean.js';

const router = createRouter();

router.get('/', dashboard);
router.get('/export', exportData);
router.get('/recharge', recharge);
router.get('/api', uploadPage);
router.post('/api', upload);
router.post('/login', login);
router.post('/logout', logout);
router.get('/clean', clean);

export default {
  async fetch(request, env, ctx) {
    const { pathname } = new URL(request.url);

    const isRoute = pathname === '/' || pathname === '/export' || pathname === '/recharge'
      || pathname === '/login' || pathname === '/logout' || pathname === '/api' || pathname === '/clean';
    if (isRoute) {
      try {
        return await router.handle(request, env, ctx);
      } catch (e) {
        console.error('unhandled', e && e.stack ? e.stack : e);
        return fail('INTERNAL', e.message || '服务器内部错误', 500);
      }
    }

    return env.ASSETS.fetch(request);
  },

  // 等待采集和通知完成后再结束定时任务。
  async scheduled(event, env, ctx) {
    try {
      const r = await runCollect(env, { source: 'cron' });
      console.log('collect', JSON.stringify({
        batch: r.batch_id,
        ok: r.meters_ok,
        fail: r.meters_fail,
        inserted: r.inserted,
        failed_inserted: r.failed_inserted,
        duplicated: r.duplicated,
        insert_error: r.insert_error,
        failures: r.detail.filter((item) => !item.ok).map(({ serial, error }) => ({ serial, error })),
        ms: r.duration_ms,
        cron: event?.cron,
      }));
      if (r.insert_error) console.error('collect database write failed', r.insert_error);
    } catch (e) {
      console.error('collect failed', e && e.stack ? e.stack : e);
    }
  },
};
