const MAX_RANGE_SIZE = 10_000n;

/** METERS 以英文逗号分隔单个表号或闭区间。 */
export function getMeters(env) {
  const raw = env.METERS;
  if (typeof raw !== 'string' || !raw.trim()) {
    throw new Error('METERS 须填写英文逗号分隔的表号或范围');
  }

  const serials = new Set();
  for (const entry of raw.split(',')) {
    const match = /^(\d+)(?:\s*-\s*(\d+))?$/.exec(entry.trim());
    if (!match) throw new Error('METERS 中的表号或范围格式无效');
    const [, first, last] = match;
    if (last === undefined) {
      serials.add(first);
      continue;
    }

    const start = BigInt(first);
    const end = BigInt(last);
    const width = first.length;
    if (end < start || end.toString().padStart(width, '0') !== last) {
      throw new Error('METERS 范围须按升序填写，前导零须与起点宽度一致');
    }
    if (end - start >= MAX_RANGE_SIZE) {
      throw new Error(`METERS 每段范围最多包含 ${MAX_RANGE_SIZE} 个表号`);
    }
    for (let value = start; value <= end; value++) {
      serials.add(value.toString().padStart(width, '0'));
    }
  }
  return serials;
}

/** 单次请求超时（毫秒） */
export const FETCH_TIMEOUT_MS = 8000;

/** 批内重试间隔：首次 + 两次重试 */
export const RETRY_DELAYS_MS = [0, 1000, 3000];

