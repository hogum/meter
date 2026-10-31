/** 支持 :param 路径参数。 */

function compile(pattern) {
  const keys = [];
  const source = pattern
    .split('/')
    .map((seg) => {
      if (seg.startsWith(':')) {
        keys.push(seg.slice(1));
        return '([^/]+)';
      }
      return seg.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    })
    .join('/');
  return { regex: new RegExp(`^${source}$`), keys };
}

export function createRouter() {
  const routes = [];

  const add = (method, pattern, handler) => {
    const { regex, keys } = compile(pattern);
    routes.push({ method, regex, keys, handler });
  };

  return {
    get: (p, h) => add('GET', p, h),
    post: (p, h) => add('POST', p, h),
    put: (p, h) => add('PUT', p, h),
    delete: (p, h) => add('DELETE', p, h),

    async handle(request, env, ctx) {
      const { pathname } = new URL(request.url);
      for (const route of routes) {
        if (route.method !== request.method) continue;
        const m = route.regex.exec(pathname);
        if (!m) continue;
        const params = {};
        route.keys.forEach((k, i) => { params[k] = decodeURIComponent(m[i + 1]); });
        return route.handler(request, env, ctx, params);
      }
      return new Response(
        JSON.stringify({ success: false, error: { code: 'NOT_FOUND', message: `无此接口: ${request.method} ${pathname}` } }),
        { status: 404, headers: { 'content-type': 'application/json; charset=utf-8' } },
      );
    },
  };
}
