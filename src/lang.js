// Language: everything shown is English. Posts in Hebrew (or anything else) are translated once, on the
// Worker, with Workers AI; moments get an English name and a one-line summary written from their posts.
// Both are small, bounded calls per run, and nothing leaves Cloudflare.

import { all, batch, j, p, run } from "./db.js";
import { hook, terms } from "./text.js";

const HEBREW = /[֐-׿]/g;
const ARABIC = /[؀-ۿ]/g;
const LATIN = /[A-Za-z]/g;

export function langOf(text) {
  const t = String(text || "");
  const he = (t.match(HEBREW) || []).length;
  const ar = (t.match(ARABIC) || []).length;
  const la = (t.match(LATIN) || []).length;
  const total = he + ar + la;
  if (!total) return "en";
  if (he / total > 0.3) return "he";
  if (ar / total > 0.3) return "ar";
  return "en";
}

const MODEL = "@cf/meta/llama-3.3-70b-instruct-fp8-fast";
const content = (r) => r?.choices?.[0]?.message?.content ?? r?.response ?? "";

async function translate(env, text) {
  const r = await env.AI.run(MODEL, {
    max_tokens: 700,
    messages: [
      { role: "system", content: "Translate the user's social media post to natural English. Output only the translation, nothing else: no preface, no notes. Keep names and places as commonly written in English media. Keep hashtags and @handles as they are. Never use em dashes." },
      { role: "user", content: String(text).slice(0, 2500) },
    ],
  });
  const out = String(content(r)).trim();
  return out.length >= 2 ? out : null;
}

// Posts that still need an English text. Up to `max` per run, newest first, so the brief reads in English fast.
export async function translateDue(env, { max = 30, budgetMs = 40000 } = {}) {
  if (!env.AI) return { skipped: "no AI binding" };
  // Posts stored before the language column existed: detect them now.
  const unlabeled = await all(env, "SELECT id, text FROM posts WHERE lang = 'en' AND text_en IS NULL AND posted_at > ? LIMIT 400", Date.now() - 7 * 86400000);
  const relabel = unlabeled.filter((r) => langOf(r.text) !== "en");
  if (relabel.length) await batch(env, relabel.map((r) => env.DB.prepare("UPDATE posts SET lang = ? WHERE id = ?").bind(langOf(r.text), r.id)));
  const rows = await all(env, "SELECT id, text, lang FROM posts WHERE lang IN ('he', 'ar') AND text_en IS NULL AND posted_at > ? ORDER BY posted_at DESC LIMIT ?", Date.now() - 7 * 86400000, max);
  const started = Date.now();
  const stmts = [];
  let done = 0, failed = 0;
  for (const r of rows) {
    if (Date.now() - started > budgetMs) break;
    try {
      const en = await translate(env, r.text);
      if (!en) throw new Error("empty");
      stmts.push(env.DB.prepare("UPDATE posts SET text_en = ?, terms = ?, hook = ? WHERE id = ?").bind(en.slice(0, 4000), j(terms(en)), j(hook(en)), r.id));
      done++;
    } catch (err) {
      // Left NULL, so it is tried again next run; the per-run cap and the 7-day window bound the cost.
      failed++;
    }
  }
  await batch(env, stmts);
  return { translated: done, failed, waiting: Math.max(0, rows.length - done - failed) };
}

// English names for moments whose posts changed since they were last named. One short call each.
export async function nameMoments(env, { max = 8 } = {}) {
  if (!env.AI) return { skipped: "no AI binding" };
  const moments = await all(env, "SELECT id, label, terms, n_posts, named_n FROM moments WHERE archived = 0 AND (named_n IS NULL OR n_posts >= named_n + 3 OR summary IS NULL) ORDER BY score DESC LIMIT ?", max);
  let named = 0;
  const errors = [];
  for (const m of moments) {
    const posts = await all(env, "SELECT p.text, p.text_en, a.handle FROM posts p JOIN accounts a ON a.id = p.account_id WHERE p.moment_id = ? ORDER BY p.z DESC NULLS LAST LIMIT 4", m.id);
    if (!posts.length) continue;
    const sample = posts.map((x, i) => `${i + 1}. @${x.handle}: ${String(x.text_en || x.text).replace(/\s+/g, " ").slice(0, 400)}`).join("\n");
    try {
      const r = await env.AI.run(MODEL, {
        max_tokens: 160,
        messages: [
          { role: "system", content: "You name news moments for an editor. Reply with JSON only: {\"label\": \"...\", \"summary\": \"...\"}. label: a specific headline of at most 9 words, in English, naming who and what (names, places), no hashtags, no quotes, no trailing period. summary: one plain English sentence, at most 25 words, saying what happened. Never use em dashes." },
          { role: "user", content: `Several accounts posted about the same thing. Name it.\n\n${sample}` },
        ],
      });
      const text = String(content(r));
      const m2 = text.match(/\{[\s\S]*\}/);
      const parsed = m2 ? JSON.parse(m2[0]) : null;
      const label = String(parsed?.label || "").replace(/[—–]/g, ",").trim().slice(0, 90);
      const summary = String(parsed?.summary || "").replace(/[—–]/g, ",").trim().slice(0, 240);
      if (label.length < 4) { errors.push(`${m.id}: no label in ${text.slice(0, 80)}`); continue; }
      await run(env, "UPDATE moments SET label = ?, summary = ?, named_n = ? WHERE id = ?", label, summary || null, m.n_posts, m.id);
      named++;
    } catch (err) {
      errors.push(`${m.id}: ${err.message}`.slice(0, 160));
      await run(env, "UPDATE moments SET named_n = ? WHERE id = ?", m.n_posts, m.id);
    }
  }
  return { named, checked: moments.length, errors };
}

// Names coming up today: terms (mostly names) that several accounts used in the last 24 hours, against how
// often they usually appear. Multi-word names and hashtags only, so this reads as names, not words.
export async function risingTerms(env, { limit = 24 } = {}) {
  const now = Date.now();
  const rows = await all(env, "SELECT p.account_id, p.terms, p.posted_at, p.moment_id FROM posts p JOIN accounts a ON a.id = p.account_id WHERE a.active = 1 AND p.posted_at > ? AND p.terms IS NOT NULL", now - 14 * 86400000);
  const today = new Map(); // term -> {accounts:Set, posts:n, moment}
  const before = new Map(); // term -> count over the prior 13 days
  for (const r of rows) {
    const recent = now - r.posted_at < 24 * 3600000;
    for (const [k] of p(r.terms, [])) {
      if (!(k.includes(" ") || /^#/.test(k)) || k.startsWith("@")) continue;
      if (recent) {
        if (!today.has(k)) today.set(k, { accounts: new Set(), posts: 0, moment: null });
        const t = today.get(k);
        t.accounts.add(r.account_id);
        t.posts++;
        if (r.moment_id) t.moment = r.moment_id;
      } else before.set(k, (before.get(k) || 0) + 1);
    }
  }
  const out = [];
  for (const [k, t] of today) {
    if (t.accounts.size < 2) continue;
    const usual = (before.get(k) || 0) / 13; // per day
    const lift = (t.posts + 0.5) / (usual + 0.5);
    out.push({ term: k.replace(/\b\p{L}/gu, (c) => c.toUpperCase()), today: t.posts, accounts: t.accounts.size, usual: Math.round(usual * 10) / 10, lift: Math.round(lift * 10) / 10, moment_id: t.moment });
  }
  return out.sort((a, b) => b.lift * Math.sqrt(b.accounts) - a.lift * Math.sqrt(a.accounts)).slice(0, limit);
}
