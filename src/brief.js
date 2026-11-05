// The brief: what is moving on Jewish social right now, read for Meaningful Minute.

import { all, first, j, p, run } from "./db.js";
import { formatPulse } from "./engine.js";
import { risingTerms } from "./lang.js";

const H = 3600000;
const D = 86400000;

function excerpt(text, n = 160) {
  const t = String(text || "").replace(/\s+/g, " ").trim();
  return t.length > n ? t.slice(0, n - 1) + "…" : t;
}

function age(ms, now) {
  const h = (now - ms) / H;
  if (h < 1) return `${Math.round(h * 60)}m`;
  if (h < 48) return `${Math.round(h)}h`;
  return `${Math.round(h / 24)}d`;
}

export function postView(r, now = Date.now()) {
  return {
    id: r.id,
    account: `@${r.handle}`,
    platform: r.platform,
    format: r.media_type,
    age: age(r.posted_at, now),
    posted_at: new Date(r.posted_at).toISOString(),
    text: excerpt(r.text_en || r.text),
    original: r.text_en && r.lang !== "en" ? excerpt(r.text, 120) : undefined,
    url: r.url,
    likes: r.likes,
    comments: r.comments,
    shares: r.shares || undefined,
    views: r.views || undefined,
    vs_normal: r.ratio === null || r.ratio === undefined ? null : `${Number(r.ratio).toFixed(1)}x`,
    pace: r.velocity === null || r.velocity === undefined ? undefined : `${Number(r.velocity).toFixed(1)}x`,
    z: r.z === null || r.z === undefined ? undefined : Math.round(r.z * 10) / 10,
    repost: r.is_repost ? true : undefined,
  };
}

export async function momentView(env, m, { posts = 6 } = {}) {
  const now = Date.now();
  const members = await all(
    env,
    `SELECT p.*, a.handle FROM posts p JOIN accounts a ON a.id = p.account_id WHERE p.moment_id = ? ORDER BY p.z DESC NULLS LAST, p.e DESC LIMIT ?`,
    m.id, posts,
  );
  return {
    id: m.id,
    label: m.label,
    summary: m.summary || undefined,
    state: m.state,
    score: m.score,
    heat: m.heat,
    direction: m.heat > m.heat_prev * 1.15 ? "up" : m.heat < m.heat_prev * 0.85 ? "down" : "flat",
    started: age(m.first_at, now) + " ago",
    last_post: age(m.last_at, now) + " ago",
    accounts: m.n_accounts,
    posts: m.n_posts,
    platforms: p(m.platforms, []),
    best_format: m.best_format,
    terms: p(m.terms, []).slice(0, 8),
    mm_fit: m.mm_fit === null ? null : `${Math.round(m.mm_fit * 100)}th pct`,
    mm_covered: m.mm_covered_at ? `${age(m.mm_covered_at, now)} ago` : null,
    mm_closest: p(m.mm_match, []),
    why: m.why,
    top_posts: members.map((r) => postView(r, now)),
  };
}

export async function composeBrief(env) {
  const now = Date.now();
  const moments = await all(env, "SELECT * FROM moments WHERE archived = 0 ORDER BY score DESC LIMIT 40");
  const moving = [];
  for (const m of moments.slice(0, 8)) moving.push(await momentView(env, m, { posts: 3 }));
  const gaps = moments
    .filter((m) => (m.mm_fit ?? 0) >= 0.55 && !(m.mm_covered_at && now - m.mm_covered_at < 7 * D) && m.state !== "cooling")
    .slice(0, 5)
    .map((m) => ({ id: m.id, label: m.label, score: m.score, mm_fit: `${Math.round(m.mm_fit * 100)}th pct`, best_format: m.best_format, why: m.why }));
  const cooling = moments.filter((m) => m.state === "cooling").slice(0, 5).map((m) => ({ id: m.id, label: m.label, peak: m.peak_heat, heat: m.heat }));

  const outperformers = await all(
    env,
    `SELECT p.*, a.handle FROM posts p JOIN accounts a ON a.id = p.account_id
      WHERE a.active = 1 AND a.category != 'self' AND p.is_repost = 0 AND p.posted_at > ? AND p.z IS NOT NULL
      ORDER BY p.z DESC LIMIT 12`,
    now - 48 * H,
  );
  const fastest = await all(
    env,
    `SELECT p.*, a.handle FROM posts p JOIN accounts a ON a.id = p.account_id
      WHERE a.active = 1 AND a.category != 'self' AND p.is_repost = 0 AND p.posted_at > ? AND p.velocity IS NOT NULL AND p.velocity > 1.5
      ORDER BY p.velocity DESC LIMIT 8`,
    now - 24 * H,
  );
  const mmOwn = await all(
    env,
    `SELECT p.*, a.handle FROM posts p JOIN accounts a ON a.id = p.account_id WHERE a.category = 'self' ORDER BY p.posted_at DESC LIMIT 8`,
  );
  const weekRows = await all(
    env,
    `SELECT a.id, a.handle, a.platform, a.category, p.ratio FROM posts p JOIN accounts a ON a.id = p.account_id
      WHERE a.active = 1 AND a.category != 'self' AND p.is_repost = 0 AND p.ratio IS NOT NULL AND p.posted_at > ?`,
    now - 7 * D,
  );
  const agg = new Map();
  for (const r of weekRows) {
    if (!agg.has(r.id)) agg.set(r.id, { handle: r.handle, platform: r.platform, category: r.category, lrs: [], best: 0 });
    const a = agg.get(r.id);
    a.lrs.push(Math.log(Math.max(0.05, r.ratio)));
    a.best = Math.max(a.best, r.ratio);
  }
  const accountsWeek = [...agg.values()]
    .filter((a) => a.lrs.length >= 2)
    .map((a) => ({ ...a, lr: a.lrs.reduce((s, x) => s + x, 0) / a.lrs.length, n: a.lrs.length }))
    .sort((a, b) => b.lr - a.lr)
    .slice(0, 8);
  const pulse = await formatPulse(env);
  const names = await risingTerms(env);
  const counts = await first(
    env,
    `SELECT (SELECT COUNT(*) FROM accounts WHERE active = 1) AS accounts,
            (SELECT COUNT(*) FROM accounts WHERE active = 1 AND last_error IS NOT NULL) AS failing,
            (SELECT COUNT(*) FROM posts WHERE posted_at > ?) AS posts_72h,
            (SELECT COUNT(*) FROM moments WHERE archived = 0) AS moments`,
    now - 72 * H,
  );

  const brief = {
    as_of: new Date(now).toISOString(),
    read_me:
      "Everything here is relative to the accounts themselves: 'vs_normal' is a post against its own account's usual result for that format at that age (1.0x = normal). A moment is several tracked accounts posting about the same thing inside 72 hours. mm_fit is where the subject lands in MM's own two-year history (percentile of result). gaps are moments MM's history likes that MM has not posted yet.",
    post_now: moving[0] ? { ...moving[0], top_posts: moving[0].top_posts.slice(0, 2) } : null,
    moving,
    gaps,
    cooling,
    outperformers: outperformers.map((r) => postView(r, now)),
    fastest: fastest.map((r) => postView(r, now)),
    names_today: names,
    format_pulse: pulse,
    accounts_this_week: accountsWeek.map((a) => ({ account: `@${a.handle}`, platform: a.platform, category: a.category, posts: a.n, typical: `${Math.exp(a.lr).toFixed(2)}x`, best: `${Number(a.best).toFixed(1)}x` })),
    mm_recent: mmOwn.map((r) => postView(r, now)),
    counts,
  };
  await run(env, "INSERT OR REPLACE INTO briefs (at, body) VALUES (?, ?)", now, j(brief));
  return brief;
}

export async function latestBrief(env) {
  const row = await first(env, "SELECT body FROM briefs ORDER BY at DESC LIMIT 1");
  return row ? p(row.body) : null;
}
