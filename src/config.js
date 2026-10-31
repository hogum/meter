/** 电表映射来自 env.METERS，支持 JSON 文本或对象。 */
export function getMeters(env) {
  let mapping = env.METERS;
  try {
    if (typeof mapping === 'string') mapping = JSON.parse(mapping);
  } catch {
    throw new Error('METERS配置不是有效JSON');
  }
  if (!mapping || typeof mapping !== 'object' || Array.isArray(mapping)
      || Object.keys(mapping).length === 0) {
    throw new Error('METERS须为非空的表号与房间映射对象');
  }
  return Object.entries(mapping).map(([serial, room]) => {
    if (!/^\d+$/.test(serial) || typeof room !== 'string' || !room.trim()) {
      throw new Error('METERS中的表号或房间号无效');
    }
    return { serial, room: room.trim() };
  });
}

/** 单次请求超时（毫秒） */
export const FETCH_TIMEOUT_MS = 8000;

/** 批内重试间隔：首次 + 两次重试 */
export const RETRY_DELAYS_MS = [0, 1000, 3000];

