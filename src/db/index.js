
export async function all(db, sql, params = []) {
  const stmt = db.prepare(sql);
  const { results } = await stmt.bind(...params).all();
  return results ?? [];
}

export async function first(db, sql, params = []) {
  const stmt = db.prepare(sql);
  return (await stmt.bind(...params).first()) ?? null;
}

export async function run(db, sql, params = []) {
  const stmt = db.prepare(sql);
  return stmt.bind(...params).run();
}

