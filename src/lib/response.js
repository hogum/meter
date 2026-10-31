
const BASE_HEADERS = {
  'content-type': 'application/json; charset=utf-8',
  'cache-control': 'no-store',
};

export function fail(code, message, status = 400, extra) {
  return new Response(
    JSON.stringify({ success: false, error: { code, message, ...(extra || {}) } }),
    { status, headers: BASE_HEADERS },
  );
}

