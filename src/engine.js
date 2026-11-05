// The engine. Four readings, all relative to the accounts themselves, none of them a news score:
//
//   1. Outperformance: a post against its own account's normal for that format, at that age.
//   2. Velocity: how fast it is gaining right now, against the account's usual pace at that age.
//   3. Convergence: several tracked accounts posting about the same thing inside the same window (a moment).
//   4. MM fit and gap: what Meaningful Minute's own two years of posts say about the subject, and whether
//      MM already covered it.
//
// Plus the format pulse: which formats and openers are winning this week across the peer set.

import { all, batch, first, j, p, run } from "./db.js";
import { cosine, labelFrom, makeIdf, termMap } from "./text.js";

const H = 3600000;
const D = 86400000;

// Engagement arrives over time. f(age) is the share of the 48-hour total a post typically has at that age.
const TAU = { instagram: 10, x: 4, bluesky: 4, telegram: 8, reddit: 6, threads: 6 };
function f(platform, ageH) {
  const tau = TAU[platform] || 8;
  const t = Math.max(0.25, Math.min(ageH, 48));
  return (1 - Math.exp(-t / tau)) / (1 - Math.exp(-48 / tau));
}
function fRate(platform, ageH) {
  const tau = TAU[platform] || 8;
  const t = Math.max(0.25, Math.min(ageH, 48));
  return Math.exp(-t / tau) / (tau * (1 - Math.exp(-48 / tau)));
}

function median(xs) {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}
function mad(xs, med) {
  return median(xs.map((x) => Math.abs(x - med))) * 1.4826;
}

// ---- 1 and 2: baselines, ratio, z, velocity ---------------------------------------------------

export async function readPosts(env) {
  const now = Date.now();
  const accounts = await all(env, "SELECT * FROM accounts WHERE active = 1");
  const posts = await all(env, "SELECT id, account_id, platform, media_type, posted_at, seen_at, e, is_repost FROM posts WHERE posted_at > ?", now - 45 * D);
  const byAccount = new Map();
  for (const x of posts) {
    if (!byAccount.has(x.account_id)) byAccount.set(x.account_id, []);
    byAccount.get(x.account_id).push(x);
  }
  const stmts = [];
  const live = [];
  for (const acc of accounts) {
    const mine = byAccount.get(acc.id) || [];
    // Baseline per format from matured posts (older than 48h). Young accounts fall back to everything they have.
    const baseline = {};
    const groups = new Map();
    for (const x of mine) {
      if (x.is_repost) continue;
      const k = x.media_type;
      if (!groups.has(k)) groups.set(k, { mature: [], young: [] });
      (now - x.posted_at > 48 * H ? groups.get(k).mature : groups.get(k).young).push(x);
    }
    const allMature = mine.filter((x) => !x.is_repost && now - x.posted_at > 48 * H).map((x) => Math.log1p(x.e));
    const allLogs = mine.filter((x) => !x.is_repost).map((x) => Math.log1p(x.e));
    for (const [k, g] of groups) {
      let logs = g.mature.map((x) => Math.log1p(x.e));
      let pooled = false;
      if (logs.length < 5) {
        // Too few of this format: pool with the account's other formats, and with young posts scaled to maturity.
        logs = (allMature.length >= 5 ? allMature : allLogs).slice();
        pooled = true;
        if (logs.length < 5) logs = logs.concat(g.young.map((x) => Math.log1p(x.e / f(acc.platform, (now - x.posted_at) / H))));
      }
      const med = median(logs);
      baseline[k] = { med: Math.round(med * 1000) / 1000, mad: Math.round(Math.max(mad(logs, med), 0.2) * 1000) / 1000, n: logs.length, pooled };
    }
    stmts.push(env.DB.prepare("UPDATE accounts SET baseline = ? WHERE id = ?").bind(j(baseline), acc.id));
    for (const x of mine) {
      if (now - x.posted_at > 7 * D) continue;
      const b = baseline[x.media_type] || baseline.text || Object.values(baseline)[0];
      if (!b || b.n < 3) continue;
      const ageH = (now - x.posted_at) / H;
      const expected = Math.expm1(b.med) * f(x.platform, ageH);
      // A small prior so an account whose normal is 1 like doesn't show 40x on 40 likes.
      const lr = Math.log(x.e + 4) - Math.log(expected + 4);
      const ratio = Math.exp(lr);
      const z = lr / (b.mad + 0.25);
      live.push({ id: x.id, ratio, z, ageH, expected, platform: x.platform, account: acc, media_type: x.media_type, e: x.e });
    }
  }
  // Velocity from the snapshot trail of the posts that are still young.
  const young = live.filter((x) => x.ageH < 48);
  const velocity = new Map();
  for (let i = 0; i < young.length; i += 60) {
    const slice = young.slice(i, i + 60);
    const rows = await all(
      env,
      `SELECT post_id, at, e FROM snapshots WHERE post_id IN (${slice.map(() => "?").join(",")}) AND at > ? ORDER BY post_id, at`,
      ...slice.map((x) => x.id), now - 12 * H,
    );
    const trail = new Map();
    for (const r of rows) {
      if (!trail.has(r.post_id)) trail.set(r.post_id, []);
      trail.get(r.post_id).push(r);
    }
    for (const x of slice) {
      const t = trail.get(x.id) || [];
      if (t.length < 2) continue;
      const last = t[t.length - 1];
      // The earliest reading at least 20 minutes before the last one.
      const prev = [...t].reverse().find((r) => last.at - r.at >= 20 * 60000);
      if (!prev) continue;
      const hours = (last.at - prev.at) / H;
      const rate = (last.e - prev.e) / hours;
      const b = x.account.baseline && p(x.account.baseline)?.[x.media_type];
      const normalRate = x.expected > 0 ? Math.expm1((b || {}).med || Math.log1p(x.expected)) * fRate(x.platform, x.ageH) : 0;
      velocity.set(x.id, Math.min(20, rate / (normalRate + 0.5)));
    }
  }
  for (const x of live) {
    const v = velocity.has(x.id) ? Math.round(velocity.get(x.id) * 100) / 100 : null;
    stmts.push(env.DB.prepare("UPDATE posts SET ratio = ?, z = ?, velocity = ? WHERE id = ?").bind(Math.round(x.ratio * 1000) / 1000, Math.round(x.z * 1000) / 1000, v, x.id));
  }
  await batch(env, stmts);
  return { accounts: accounts.length, read: live.length, with_velocity: velocity.size };
}

// ---- 3: moments ---------------------------------------------------------------------------------

function union(parent, a, b) {
  const fa = find(parent, a), fb = find(parent, b);
  if (fa !== fb) parent.set(fa, fb);
}
function find(parent, a) {
  while (parent.get(a) !== a) {
    parent.set(a, parent.get(parent.get(a)));
    a = parent.get(a);
  }
  return a;
}

async function termStats(env) {
  const rows = await all(env, "SELECT term, df, mm_df FROM term_df");
  const df = new Map();
  for (const r of rows) df.set(r.term, r.df + r.mm_df * 0.3);
  return df;
}

export async function refreshTermDf(env) {
  const now = Date.now();
  const rows = await all(env, "SELECT terms FROM posts WHERE posted_at > ?", now - 30 * D);
  const df = new Map();
  for (const r of rows) for (const [k] of p(r.terms, [])) df.set(k, (df.get(k) || 0) + 1);
  const mm = await all(env, "SELECT terms FROM mm_posts WHERE terms IS NOT NULL");
  const mmdf = new Map();
  for (const r of mm) for (const [k] of p(r.terms, [])) mmdf.set(k, (mmdf.get(k) || 0) + 1);
  const keys = new Set([...df.keys(), ...mmdf.keys()]);
  const stmts = [env.DB.prepare("DELETE FROM term_df")];
  for (const k of keys) {
    const a = df.get(k) || 0, b = mmdf.get(k) || 0;
    if (a + b < 2) continue;
    stmts.push(env.DB.prepare("INSERT INTO term_df (term, df, mm_df, updated_at) VALUES (?, ?, ?, ?)").bind(k, a, b, now));
  }
  await batch(env, stmts);
  return { live_docs: rows.length, mm_docs: mm.length, terms: stmts.length - 1 };
}

export async function buildMoments(env) {
  const now = Date.now();
  const window = 72 * H;
  const rows = await all(
    env,
    `SELECT p.id, p.account_id, p.platform, p.media_type, p.posted_at, p.text, p.url, p.terms, p.ratio, p.z, p.velocity, p.is_repost, p.e,
            a.weight, a.category, a.handle, a.display
       FROM posts p JOIN accounts a ON a.id = p.account_id
      WHERE p.posted_at > ? AND a.active = 1 AND a.category != 'self' AND p.terms IS NOT NULL`,
    now - window,
  );
  const liveDocs = (await first(env, "SELECT COUNT(*) AS n FROM posts WHERE posted_at > ?", now - 30 * D))?.n || 100;
  const df = await termStats(env);
  const idf = makeIdf(df, liveDocs);
  const docs = rows.map((r) => ({ ...r, tm: termMap(p(r.terms, [])) }));

  // Inverted index on the terms that can carry a link: rare enough to mean something.
  const index = new Map();
  for (let i = 0; i < docs.length; i++) {
    for (const [k, w] of docs[i].tm) {
      if (idf(k) < 2.2 && !k.includes(" ")) continue; // common single words don't link posts
      if (!index.has(k)) index.set(k, []);
      index.get(k).push(i);
    }
  }
  const parent = new Map(docs.map((_, i) => [i, i]));
  const pairScore = new Map();
  for (const [k, ids] of index) {
    if (ids.length < 2 || ids.length > 60) continue;
    // A multi-word name can link two posts on its own; a single word cannot, however rare, so that a
    // common Hebrew word or one odd token never makes a moment by itself.
    const strength = k.includes(" ") ? idf(k) * 1.6 : Math.min(idf(k), 3.0) * (k.startsWith("@") ? 0.8 : 1);
    for (let a = 0; a < ids.length; a++) {
      for (let b = a + 1; b < ids.length; b++) {
        const i = ids[a], jx = ids[b];
        if (docs[i].account_id === docs[jx].account_id) continue; // a moment needs more than one voice
        const key = i < jx ? `${i}:${jx}` : `${jx}:${i}`;
        pairScore.set(key, (pairScore.get(key) || 0) + strength);
      }
    }
  }
  for (const [key, s] of pairScore) {
    const [i, jx] = key.split(":").map(Number);
    // One strong name, or several rarer words, or a close cosine.
    if (s >= 4.8 || cosine(docs[i].tm, docs[jx].tm, idf) > 0.45) union(parent, i, jx);
  }
  const groups = new Map();
  docs.forEach((d, i) => {
    const r = find(parent, i);
    if (!groups.has(r)) groups.set(r, []);
    groups.get(r).push(d);
  });

  const existing = await all(env, "SELECT id, label, heat, peak_heat, first_at, mm_covered_at, why FROM moments WHERE archived = 0");
  const existingPosts = await all(env, "SELECT id, moment_id FROM posts WHERE moment_id IS NOT NULL AND posted_at > ?", now - window);
  const postsOfMoment = new Map();
  for (const r of existingPosts) {
    if (!postsOfMoment.has(r.moment_id)) postsOfMoment.set(r.moment_id, new Set());
    postsOfMoment.get(r.moment_id).add(r.id);
  }
  const used = new Set();
  const stmts = [env.DB.prepare("UPDATE posts SET moment_id = NULL WHERE posted_at > ?").bind(now - window)];
  const out = [];
  for (const members of groups.values()) {
    const accounts = new Set(members.map((m) => m.account_id));
    if (accounts.size < 2) continue;
    // Shared terms: appear in posts from at least two accounts.
    const termAccounts = new Map();
    for (const m of members) for (const [k] of m.tm) {
      if (!termAccounts.has(k)) termAccounts.set(k, new Set());
      termAccounts.get(k).add(m.account_id);
    }
    const shared = [...termAccounts.entries()]
      .filter(([k, s]) => s.size >= 2 && (idf(k) >= 2.2 || k.includes(" ")))
      .sort((a, b) => b[1].size * idf(b[0]) - a[1].size * idf(a[0]))
      .map(([k]) => k)
      .slice(0, 12);
    if (!shared.length) continue;
    // Keep the id of the existing moment that overlaps most.
    const ids = new Set(members.map((m) => m.id));
    let best = null, bestOverlap = 0;
    for (const ex of existing) {
      if (used.has(ex.id)) continue;
      const prev = postsOfMoment.get(ex.id);
      if (!prev) continue;
      let o = 0;
      for (const id of ids) if (prev.has(id)) o++;
      const overlap = o / Math.min(prev.size, ids.size);
      if (overlap > bestOverlap) { bestOverlap = overlap; best = ex; }
    }
    const prior = bestOverlap >= 0.5 ? best : null;
    if (prior) used.add(prior.id);
    const id = prior ? prior.id : `m_${now.toString(36)}_${Math.random().toString(36).slice(2, 7)}`;

    // Heat: each post's outperformance (floored so merely being posted counts a little), weighted by the
    // account's weight, decaying with a 24h half-life, plus a bonus for how many voices joined.
    let heat = 0;
    let carrier = null, carrierScore = -1;
    const formatScores = new Map();
    for (const m of members) {
      const ageH = (now - m.posted_at) / H;
      const lift = Math.max(0, 0.6 + Math.log2(Math.max(0.1, m.ratio || 1)));
      const contrib = (m.weight || 1) * lift * Math.pow(0.5, ageH / 24) * (m.is_repost ? 0.4 : 1);
      heat += contrib;
      const cs = (m.z || 0) + (m.velocity || 0) * 0.5 + Math.log1p(m.e) * 0.15;
      if (cs > carrierScore) { carrierScore = cs; carrier = m; }
      if (!formatScores.has(m.media_type)) formatScores.set(m.media_type, []);
      formatScores.get(m.media_type).push(Math.log(Math.max(0.1, m.ratio || 1)));
    }
    heat *= Math.sqrt(accounts.size);
    heat = Math.round(heat * 100) / 100;
    const bestFormat = [...formatScores.entries()].map(([k, v]) => [k, median(v), v.length]).sort((a, b) => b[1] - a[1])[0];
    const firstAt = Math.min(...members.map((m) => m.posted_at));
    const lastAt = Math.max(...members.map((m) => m.posted_at));
    const prevHeat = prior ? prior.heat : 0;
    const peak = Math.max(prior ? prior.peak_heat : 0, heat);
    let state;
    if (!prior) state = "new";
    else if (heat > prevHeat * 1.15) state = "rising";
    else if (heat < peak * 0.6) state = "cooling";
    else state = "peak";
    // Keep a name the naming pass wrote; otherwise a label from the shared terms until it runs.
    const label = prior?.label && !/^Untitled/.test(prior.label) ? prior.label : labelFrom(shared);
    const platforms = [...new Set(members.map((m) => m.platform))];
    out.push({ id, label, shared, members, heat, prevHeat, peak, state, carrier, bestFormat, firstAt, lastAt, platforms, accounts: accounts.size, prior });
    stmts.push(
      env.DB.prepare(
        `INSERT INTO moments (id, label, terms, first_at, last_at, updated_at, n_posts, n_accounts, platforms, heat, heat_prev, peak_heat, state,
           carrier_post_id, best_format, archived)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)
         ON CONFLICT (id) DO UPDATE SET label = excluded.label, terms = excluded.terms, last_at = excluded.last_at, updated_at = excluded.updated_at,
           n_posts = excluded.n_posts, n_accounts = excluded.n_accounts, platforms = excluded.platforms, heat = excluded.heat,
           heat_prev = excluded.heat_prev, peak_heat = excluded.peak_heat, state = excluded.state, carrier_post_id = excluded.carrier_post_id,
           best_format = excluded.best_format, archived = 0`,
      ).bind(id, label, j(shared), firstAt, lastAt, now, members.length, accounts.size, j(platforms), heat, prevHeat, peak, state, carrier?.id || null, bestFormat ? bestFormat[0] : null),
    );
    for (let i = 0; i < members.length; i += 40) {
      const slice = members.slice(i, i + 40);
      stmts.push(env.DB.prepare(`UPDATE posts SET moment_id = ? WHERE id IN (${slice.map(() => "?").join(",")})`).bind(id, ...slice.map((m) => m.id)));
    }
  }
  // Moments that got no members this run are gone.
  for (const ex of existing) if (!used.has(ex.id)) stmts.push(env.DB.prepare("UPDATE moments SET state = 'gone', archived = 1, updated_at = ? WHERE id = ?").bind(now, ex.id));
  await batch(env, stmts);
  return { moments: out.length, posts: docs.length, idf, out };
}

// ---- 4: MM fit and coverage -----------------------------------------------------------------------

let mmCache = { at: 0, docs: [] };
async function mmDocs(env) {
  if (Date.now() - mmCache.at < 30 * 60000 && mmCache.docs.length) return mmCache.docs;
  const rows = await all(env, "SELECT ext_id, url, caption, format, source, posted_at, y, yv, terms FROM mm_posts WHERE terms IS NOT NULL");
  mmCache = { at: Date.now(), docs: rows.map((r) => ({ ...r, tm: termMap(p(r.terms, [])) })) };
  return mmCache.docs;
}

function firstLine(text) {
  const lines = String(text || "").split("\n").map((l) => l.trim()).filter((l) => l.replace(/[^\p{L}\p{N}]/gu, "").length >= 12);
  return (lines[0] || String(text || "").trim()).slice(0, 110);
}

export function mmRead(vec, docs, idf, now = Date.now()) {
  const scored = [];
  for (const d of docs) {
    const c = cosine(vec, d.tm, idf);
    if (c > 0.12) scored.push({ c, d });
  }
  scored.sort((a, b) => b.c - a.c);
  const top = scored.slice(0, 10);
  let num = 0, den = 0;
  for (const { c, d } of top) {
    const y = d.y ?? d.yv;
    if (y === null || y === undefined || d.source === "collab") continue;
    const w = Math.pow(c, 3);
    num += w * y;
    den += w;
  }
  const fit = den > 0 ? num / den : null;
  const strength = top.length ? top[0].c : 0;
  const recent = top.find(({ c, d }) => c >= 0.45 && now - d.posted_at < 10 * D);
  return {
    fit: fit === null ? null : Math.round(fit * 100) / 100,
    strength: Math.round(strength * 100) / 100,
    covered_at: recent ? recent.d.posted_at : null,
    matches: top.slice(0, 3).map(({ c, d }) => ({
      sim: Math.round(c * 100) / 100,
      caption: firstLine(d.caption),
      format: d.format,
      source: d.source,
      posted_at: new Date(d.posted_at).toISOString().slice(0, 10),
      pct: d.y === null || d.y === undefined ? null : Math.round(d.y * 100),
      url: d.url,
    })),
  };
}

export async function scoreMoments(env, built) {
  const now = Date.now();
  const docs = await mmDocs(env);
  // MM's own live posts (category self) also count as coverage.
  const own = await all(
    env,
    "SELECT p.posted_at, p.terms FROM posts p JOIN accounts a ON a.id = p.account_id WHERE a.category = 'self' AND p.posted_at > ?",
    now - 10 * D,
  );
  const ownDocs = own.map((r) => ({ at: r.posted_at, tm: termMap(p(r.terms, [])) }));
  const stmts = [];
  for (const m of built.out) {
    const vec = new Map();
    for (const mem of m.members) for (const [k, w] of mem.tm) vec.set(k, (vec.get(k) || 0) + w);
    const read = mmRead(vec, docs, built.idf, now);
    let coveredAt = read.covered_at;
    for (const o of ownDocs) if (cosine(vec, o.tm, built.idf) >= 0.4 && (!coveredAt || o.at > coveredAt)) coveredAt = o.at;
    const fit = read.fit ?? 0.5;
    const direction = m.state === "rising" || m.state === "new" ? 1.15 : m.state === "cooling" ? 0.65 : 1;
    const covered = coveredAt && now - coveredAt < 4 * D ? 0.35 : 1;
    const score = Math.round(m.heat * (0.5 + fit) * direction * covered * 100) / 100;
    const hours = Math.max(1, Math.round((now - m.firstAt) / H));
    const c = m.carrier;
    const why = [
      `${m.accounts} accounts in ${hours}h on ${m.platforms.join("/")}`,
      c ? `carried by @${c.handle} at ${(c.ratio || 1).toFixed(1)}x their normal${c.velocity ? `, gaining ${c.velocity.toFixed(1)}x the usual pace` : ""}` : null,
      m.bestFormat ? `${m.bestFormat[0]} doing best` : null,
      read.fit !== null ? `MM history puts it at the ${Math.round(read.fit * 100)} percentile (closest: "${read.matches[0]?.caption || ""}")` : "nothing like it in MM's history",
      coveredAt ? `MM covered it ${Math.round((now - coveredAt) / D)}d ago` : null,
    ].filter(Boolean).join("; ");
    stmts.push(env.DB.prepare("UPDATE moments SET mm_fit = ?, mm_covered_at = ?, mm_match = ?, why = ?, score = ? WHERE id = ?").bind(read.fit, coveredAt, j(read.matches), why, score, m.id));
  }
  await batch(env, stmts);
  return { scored: built.out.length };
}

// ---- Format pulse -----------------------------------------------------------------------------------

export async function formatPulse(env) {
  const now = Date.now();
  const rows = await all(
    env,
    `SELECT p.platform, p.media_type, p.ratio, p.hook, p.posted_at FROM posts p JOIN accounts a ON a.id = p.account_id
      WHERE a.active = 1 AND a.category != 'self' AND p.is_repost = 0 AND p.ratio IS NOT NULL AND p.posted_at > ? AND p.posted_at < ?`,
    now - 14 * D, now - 6 * H,
  );
  const byKey = new Map();
  const hooks = new Map();
  for (const r of rows) {
    const week = now - r.posted_at < 7 * D ? "this" : "last";
    const k = `${r.platform}:${r.media_type}`;
    if (!byKey.has(k)) byKey.set(k, { this: [], last: [] });
    byKey.get(k)[week].push(Math.log(Math.max(0.05, r.ratio)));
    const h = p(r.hook, {});
    for (const trait of ["question", "number", "caps", "quote", "emoji_lead"]) {
      const kk = `${trait}:${h[trait] ? "yes" : "no"}`;
      if (!hooks.has(kk)) hooks.set(kk, []);
      if (week === "this") hooks.get(kk).push(Math.log(Math.max(0.05, r.ratio)));
    }
  }
  const formats = [...byKey.entries()]
    .map(([k, v]) => ({
      format: k,
      n: v.this.length,
      this_week: v.this.length ? Math.round(Math.exp(median(v.this)) * 100) / 100 : null,
      last_week: v.last.length ? Math.round(Math.exp(median(v.last)) * 100) / 100 : null,
    }))
    .filter((x) => x.n >= 3)
    .sort((a, b) => (b.this_week || 0) - (a.this_week || 0));
  const openers = [];
  for (const trait of ["question", "number", "caps", "quote", "emoji_lead"]) {
    const yes = hooks.get(`${trait}:yes`) || [], no = hooks.get(`${trait}:no`) || [];
    if (yes.length >= 5 && no.length >= 5) openers.push({ trait, with: Math.round(Math.exp(median(yes)) * 100) / 100, without: Math.round(Math.exp(median(no)) * 100) / 100, n: yes.length });
  }
  return { formats, openers, posts_read: rows.length };
}

// ---- Housekeeping -----------------------------------------------------------------------------------

export async function prune(env) {
  const now = Date.now();
  await run(env, "DELETE FROM snapshots WHERE at < ?", now - 21 * D);
  await run(env, "DELETE FROM posts WHERE posted_at < ?", now - 60 * D);
  await run(env, "DELETE FROM runs WHERE at < ?", now - 14 * D);
  await run(env, "DELETE FROM briefs WHERE at < ?", now - 30 * D);
  await run(env, "DELETE FROM moments WHERE archived = 1 AND updated_at < ?", now - 30 * D);
}
