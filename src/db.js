// Small D1 helpers.

export async function all(env, sql, ...binds) {
  const { results } = await env.DB.prepare(sql).bind(...binds).all();
  return results || [];
}

export async function first(env, sql, ...binds) {
  return env.DB.prepare(sql).bind(...binds).first();
}

export async function run(env, sql, ...binds) {
  return env.DB.prepare(sql).bind(...binds).run();
}

// Batched writes: D1 accepts up to ~100 statements per batch comfortably.
export async function batch(env, statements, size = 80) {
  for (let i = 0; i < statements.length; i += size) {
    await env.DB.batch(statements.slice(i, i + size));
  }
}

export async function logRun(env, stage, status, message, ms) {
  await run(env, "INSERT INTO runs (at, stage, status, message, ms) VALUES (?, ?, ?, ?, ?)", Date.now(), stage, status, String(message || "").slice(0, 400), ms || 0);
}

export async function getSetting(env, key, fallback = null) {
  const row = await first(env, "SELECT value FROM settings WHERE key = ?", key);
  return row ? row.value : fallback;
}

export async function setSetting(env, key, value) {
  await run(env, "INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value", key, String(value));
}

export const j = (v) => (v === undefined || v === null ? null : JSON.stringify(v));
export const p = (s, fallback = null) => {
  if (s === null || s === undefined) return fallback;
  try {
    return JSON.parse(s);
  } catch {
    return fallback;
  }
};
