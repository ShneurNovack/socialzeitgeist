// MCP over Streamable HTTP (stateless JSON), the same shape as the other Workers MCP servers.

import { composeBrief, latestBrief, momentView, postView } from "./brief.js";
import { all, first, j, p, run } from "./db.js";
import { formatPulse, mmRead } from "./engine.js";
import { makeIdf, termMap, terms } from "./text.js";
import { runPipeline } from "./pipeline.js";

const SERVER_INFO = { name: "socialzeitgeist", version: "1.0.0" };
const SUPPORTED_PROTOCOLS = ["2025-06-18", "2025-03-26", "2024-11-05"];
const H = 3600000;
const D = 86400000;

const INSTRUCTIONS = `Social Zeitgeist: what the Jewish social internet (Instagram, X, Telegram, Bluesky, Reddit) is doing right now, read for Meaningful Minute (MM), a Jewish Instagram account. It watches a chosen set of accounts and reads every post against that account's own normal, so a small account over-performing counts as much as a big one.

Start with sz_now: the brief (what is moving, MM's gaps, the single posts out-performing most, what is gaining fastest, which formats and openers are winning this week). sz_moments and sz_moment drill into a moment (several accounts on the same thing). sz_posts lists posts with filters. sz_accounts and sz_track manage the watched accounts (adding one is how the system learns a new corner of the internet). sz_test_idea scores any idea against MM's history and the live moments. sz_feedback records what MM did with a moment (posted, good idea, not for us). Ids are the ones these tools return. Times are UTC ISO strings. 'vs_normal' means a post against its own account's usual result (1.0x = normal).`;

const READ = { readOnlyHint: true, openWorldHint: false };
const WRITE = { readOnlyHint: false, destructiveHint: false, openWorldHint: false };

const TOOLS = [
  {
    name: "sz_now",
    description: "The brief: what is moving across Jewish social right now, MM's gaps, top out-performing posts, fastest gaining posts, the format pulse, accounts winning this week, MM's own recent posts against its normal. The first call to make.",
    inputSchema: { type: "object", properties: { fresh: { type: "boolean", description: "Rebuild the brief now instead of returning the last one (slower). Default false." } } },
    annotations: READ,
  },
  {
    name: "sz_moments",
    description: "Live moments (several tracked accounts on the same thing inside 72 hours), ranked. Filter by state or platform.",
    inputSchema: {
      type: "object",
      properties: {
        state: { type: "string", enum: ["new", "rising", "peak", "cooling"] },
        platform: { type: "string", enum: ["instagram", "x", "telegram", "bluesky", "reddit", "threads"] },
        limit: { type: "integer", minimum: 1, maximum: 40, description: "Default 15." },
        min_accounts: { type: "integer", minimum: 2, description: "Only moments with at least this many accounts." },
      },
    },
    annotations: READ,
  },
  {
    name: "sz_moment",
    description: "One moment in full: its posts across accounts, the shared terms, MM's closest past posts and how they did, the engine's reasons.",
    inputSchema: { type: "object", properties: { id: { type: "string" }, posts: { type: "integer", minimum: 1, maximum: 40, description: "How many posts to include. Default 12." } }, required: ["id"] },
    annotations: READ,
  },
  {
    name: "sz_posts",
    description: "Posts from the watched accounts, with each one's result against its own account's normal. Sort by out-performance (default), pace, newest, or raw engagement.",
    inputSchema: {
      type: "object",
      properties: {
        hours: { type: "integer", minimum: 1, maximum: 720, description: "Look back this many hours. Default 48." },
        platform: { type: "string", enum: ["instagram", "x", "telegram", "bluesky", "reddit", "threads"] },
        account: { type: "string", description: "Handle, with or without @." },
        format: { type: "string", enum: ["reel", "carousel", "image", "video", "text", "link"] },
        sort: { type: "string", enum: ["outperformance", "pace", "newest", "engagement"] },
        query: { type: "string", description: "Only posts whose text contains this." },
        include_self: { type: "boolean", description: "Include MM's own posts. Default false." },
        limit: { type: "integer", minimum: 1, maximum: 60, description: "Default 20." },
      },
    },
    annotations: READ,
  },
  {
    name: "sz_post",
    description: "One post with its full text, metric trail (snapshots), and the moment it belongs to.",
    inputSchema: { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
    annotations: READ,
  },
  {
    name: "sz_accounts",
    description: "The watched accounts with category, weight, followers, baseline (normal result per format), last poll and errors, and this week's typical result.",
    inputSchema: { type: "object", properties: { platform: { type: "string" }, include_inactive: { type: "boolean" } } },
    annotations: READ,
  },
  {
    name: "sz_track",
    description:
      "Add, update, pause or remove a watched account. Instagram accounts must be professional (business or creator) accounts, read through Meta's official API. Telegram is a public channel name, Bluesky a handle, Reddit a subreddit, X a handle (collected by the Mac script). category: self (MM itself) | peer (accounts like MM) | big | niche | news | creator | org. weight 0.2 to 2 says how much that account's attention counts.",
    inputSchema: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["add", "update", "pause", "resume", "remove"] },
        platform: { type: "string", enum: ["instagram", "x", "telegram", "bluesky", "reddit", "threads"] },
        handle: { type: "string" },
        category: { type: "string", enum: ["self", "peer", "big", "niche", "news", "creator", "org"] },
        weight: { type: "number", minimum: 0.2, maximum: 2 },
        note: { type: "string" },
      },
      required: ["action", "platform", "handle"],
    },
    annotations: WRITE,
  },
  {
    name: "sz_formats",
    description: "The format pulse: which formats (reel, carousel, image...) per platform and which openers (question, number, all caps, quote, emoji) are beating normal this week versus last week, across the peer set.",
    inputSchema: { type: "object", properties: {} },
    annotations: READ,
  },
  {
    name: "sz_test_idea",
    description: "Score an idea for an MM post: where it lands in MM's own two-year history (closest past posts and their results), which live moments it rides, and whether MM already posted it recently.",
    inputSchema: { type: "object", properties: { text: { type: "string", description: "The idea, caption draft, or subject." } }, required: ["text"] },
    annotations: READ,
  },
  {
    name: "sz_mm",
    description: "Meaningful Minute's own record: recent posts against MM's normal, and the best past posts on a subject (search MM's history).",
    inputSchema: { type: "object", properties: { query: { type: "string", description: "Search MM's past posts for this subject." }, limit: { type: "integer", minimum: 1, maximum: 40 } } },
    annotations: READ,
  },
  {
    name: "sz_feedback",
    description: "Record what MM did with a moment or post: posted (MM made a post on it), liked (good idea, not posted), passed (not for us). Clear removes earlier feedback.",
    inputSchema: {
      type: "object",
      properties: { moment_id: { type: "string" }, post_id: { type: "string" }, value: { type: "string", enum: ["posted", "liked", "passed", "clear"] }, note: { type: "string" } },
      required: ["value"],
    },
    annotations: WRITE,
  },
  {
    name: "sz_engine",
    description: "Engine health: last runs per stage, counts, failing accounts, feedback tally, and the X push status.",
    inputSchema: { type: "object", properties: { run_now: { type: "boolean", description: "Run the collection and engine now (slow, up to a minute)." } } },
    annotations: READ,
  },
];

class ToolError extends Error {}

function textResult(data, isError = false) {
  const text = typeof data === "string" ? data : JSON.stringify(data, null, 1);
  return { content: [{ type: "text", text }], ...(isError ? { isError: true } : {}) };
}

function accountId(platform, handle) {
  return `${platform}:${String(handle || "").replace(/^@/, "").replace(/^r\//, "").trim().toLowerCase()}`;
}

async function callTool(name, args = {}, env) {
  const now = Date.now();
  switch (name) {
    case "sz_now": {
      let brief = args.fresh ? null : await latestBrief(env);
      if (!brief || now - Date.parse(brief.as_of) > 40 * 60000) brief = await composeBrief(env);
      return textResult(brief);
    }
    case "sz_moments": {
      const where = ["archived = 0"];
      const binds = [];
      if (args.state) { where.push("state = ?"); binds.push(args.state); }
      if (args.platform) { where.push("platforms LIKE ?"); binds.push(`%"${args.platform}"%`); }
      if (args.min_accounts) { where.push("n_accounts >= ?"); binds.push(args.min_accounts); }
      const rows = await all(env, `SELECT * FROM moments WHERE ${where.join(" AND ")} ORDER BY score DESC LIMIT ?`, ...binds, Math.min(args.limit || 15, 40));
      const out = [];
      for (const m of rows) out.push(await momentView(env, m, { posts: 2 }));
      return textResult(out);
    }
    case "sz_moment": {
      const m = await first(env, "SELECT * FROM moments WHERE id = ?", args.id);
      if (!m) throw new ToolError(`No moment ${args.id}.`);
      const fb = await all(env, "SELECT at, value, note FROM feedback WHERE moment_id = ? ORDER BY at DESC", args.id);
      return textResult({ ...(await momentView(env, m, { posts: Math.min(args.posts || 12, 40) })), feedback: fb.map((f) => ({ at: new Date(f.at).toISOString(), value: f.value, note: f.note })) });
    }
    case "sz_posts": {
      const where = ["a.active = 1", "p.posted_at > ?"];
      const binds = [now - Math.min(args.hours || 48, 720) * H];
      if (!args.include_self) where.push("a.category != 'self'");
      if (args.platform) { where.push("p.platform = ?"); binds.push(args.platform); }
      if (args.account) { where.push("a.handle = ?"); binds.push(String(args.account).replace(/^@/, "").toLowerCase()); }
      if (args.format) { where.push("p.media_type = ?"); binds.push(args.format); }
      if (args.query) { where.push("p.text LIKE ?"); binds.push(`%${args.query}%`); }
      const order = { pace: "p.velocity DESC NULLS LAST", newest: "p.posted_at DESC", engagement: "p.e DESC" }[args.sort] || "p.z DESC NULLS LAST";
      const rows = await all(env, `SELECT p.*, a.handle FROM posts p JOIN accounts a ON a.id = p.account_id WHERE ${where.join(" AND ")} ORDER BY ${order} LIMIT ?`, ...binds, Math.min(args.limit || 20, 60));
      return textResult(rows.map((r) => ({ ...postView(r, now), moment_id: r.moment_id || undefined })));
    }
    case "sz_post": {
      const r = await first(env, "SELECT p.*, a.handle FROM posts p JOIN accounts a ON a.id = p.account_id WHERE p.id = ?", args.id);
      if (!r) throw new ToolError(`No post ${args.id}.`);
      const trail = await all(env, "SELECT at, e, likes, comments, shares, views FROM snapshots WHERE post_id = ? ORDER BY at", args.id);
      const moment = r.moment_id ? await first(env, "SELECT id, label, state, score FROM moments WHERE id = ?", r.moment_id) : null;
      return textResult({ ...postView(r, now), full_text: r.text, terms: p(r.terms, []).slice(0, 15), hook: p(r.hook), moment, trail: trail.map((t) => ({ at: new Date(t.at).toISOString(), e: t.e, likes: t.likes, comments: t.comments, shares: t.shares, views: t.views })) });
    }
    case "sz_accounts": {
      const where = [args.include_inactive ? "1=1" : "a.active = 1"];
      const binds = [];
      if (args.platform) { where.push("a.platform = ?"); binds.push(args.platform); }
      const rows = await all(env, `SELECT a.* FROM accounts a WHERE ${where.join(" AND ")} ORDER BY a.platform, a.handle`, ...binds);
      const week = await all(env, "SELECT account_id, ratio FROM posts WHERE posted_at > ? AND ratio IS NOT NULL AND is_repost = 0", now - 7 * D);
      const agg = new Map();
      for (const w of week) {
        if (!agg.has(w.account_id)) agg.set(w.account_id, []);
        agg.get(w.account_id).push(Math.log(Math.max(0.05, w.ratio)));
      }
      return textResult(
        rows.map((a) => {
          const lrs = agg.get(a.id) || [];
          const typical = lrs.length ? Math.exp(lrs.reduce((s, x) => s + x, 0) / lrs.length) : null;
          const base = p(a.baseline, {});
          const normal = Object.fromEntries(Object.entries(base).map(([k, v]) => [k, `${Math.round(Math.expm1(v.med))} (${v.n}${v.pooled ? ", pooled" : ""})`]));
          return {
            id: a.id, platform: a.platform, handle: `@${a.handle}`, display: a.display || undefined, category: a.category, weight: a.weight,
            followers: a.followers || undefined, active: Boolean(a.active), normal_engagement: normal,
            this_week: typical ? `${typical.toFixed(2)}x over ${lrs.length} posts` : undefined,
            polled: a.polled_at ? new Date(a.polled_at).toISOString() : null, error: a.last_error || undefined, note: a.note || undefined,
          };
        }),
      );
    }
    case "sz_track": {
      const id = accountId(args.platform, args.handle);
      const handle = id.split(":")[1];
      if (!handle) throw new ToolError("A handle is needed.");
      const existing = await first(env, "SELECT * FROM accounts WHERE id = ?", id);
      if (args.action === "add") {
        if (existing) throw new ToolError(`${id} is already tracked${existing.active ? "" : " (paused)"}.`);
        await run(env, "INSERT INTO accounts (id, platform, handle, category, weight, active, added_at, note) VALUES (?, ?, ?, ?, ?, 1, ?, ?)", id, args.platform, handle, args.category || "peer", args.weight || 1, now, args.note || null);
        return textResult({ ok: true, id, note: "Added. It is polled on the next run; the first baseline needs a few posts." });
      }
      if (!existing) throw new ToolError(`${id} isn't tracked.`);
      if (args.action === "remove") {
        await run(env, "DELETE FROM accounts WHERE id = ?", id);
        return textResult({ ok: true, removed: id, note: "Its posts stay until they age out." });
      }
      if (args.action === "pause" || args.action === "resume") {
        await run(env, "UPDATE accounts SET active = ? WHERE id = ?", args.action === "resume" ? 1 : 0, id);
        return textResult({ ok: true, id, active: args.action === "resume" });
      }
      await run(env, "UPDATE accounts SET category = COALESCE(?, category), weight = COALESCE(?, weight), note = COALESCE(?, note) WHERE id = ?", args.category || null, args.weight || null, args.note || null, id);
      return textResult({ ok: true, id, category: args.category || existing.category, weight: args.weight || existing.weight });
    }
    case "sz_formats":
      return textResult(await formatPulse(env));
    case "sz_test_idea": {
      const text = String(args.text || "").trim();
      if (text.length < 3) throw new ToolError("Give the idea some words.");
      const vec = termMap(terms(text));
      const dfRows = await all(env, "SELECT term, df, mm_df FROM term_df");
      const df = new Map(dfRows.map((r) => [r.term, r.df + r.mm_df * 0.3]));
      const liveDocs = (await first(env, "SELECT COUNT(*) AS n FROM posts WHERE posted_at > ?", now - 30 * D))?.n || 100;
      const idf = makeIdf(df, liveDocs);
      const mm = await all(env, "SELECT ext_id, url, caption, format, source, posted_at, y, yv, terms FROM mm_posts WHERE terms IS NOT NULL");
      const read = mmRead(vec, mm.map((r) => ({ ...r, tm: termMap(p(r.terms, [])) })), idf, now);
      const moments = await all(env, "SELECT id, label, terms, state, score, heat, n_accounts FROM moments WHERE archived = 0");
      const rides = moments
        .map((m) => {
          const mt = new Map(p(m.terms, []).map((k) => [k, 2]));
          let hit = 0;
          for (const [k] of vec) if (mt.has(k)) hit += idf(k);
          return { id: m.id, label: m.label, state: m.state, score: m.score, accounts: m.n_accounts, match: Math.round(hit * 10) / 10 };
        })
        .filter((m) => m.match >= 2.5)
        .sort((a, b) => b.match - a.match)
        .slice(0, 5);
      const live = rides.length ? rides[0] : null;
      const fit = read.fit;
      const verdict =
        fit !== null && fit >= 0.65 && live && live.state !== "cooling" ? "Strong: MM's history likes this and it is live right now"
        : fit !== null && fit >= 0.65 ? "Good subject for MM, nothing live carrying it; it stands on its own"
        : live && live.state !== "cooling" ? "Live now; MM's history is lukewarm on the subject, so the angle has to do the work"
        : fit === null ? "No record: MM has not posted anything like it, so there is nothing to predict from"
        : "Weak on both counts";
      return textResult({ text, verdict, mm: read, rides, covered_recently: read.covered_at ? new Date(read.covered_at).toISOString().slice(0, 10) : null });
    }
    case "sz_mm": {
      const limit = Math.min(args.limit || 15, 40);
      if (args.query) {
        const vec = termMap(terms(args.query));
        const dfRows = await all(env, "SELECT term, df, mm_df FROM term_df");
        const df = new Map(dfRows.map((r) => [r.term, r.df + r.mm_df * 0.3]));
        const idf = makeIdf(df, 500);
        const mm = await all(env, "SELECT ext_id, url, caption, format, source, posted_at, likes, comments, views, y, yv, terms FROM mm_posts WHERE terms IS NOT NULL");
        const read = mmRead(vec, mm.map((r) => ({ ...r, tm: termMap(p(r.terms, [])) })), idf, now);
        return textResult(read);
      }
      const rows = await all(env, "SELECT p.*, a.handle FROM posts p JOIN accounts a ON a.id = p.account_id WHERE a.category = 'self' ORDER BY p.posted_at DESC LIMIT ?", limit);
      const history = await first(env, "SELECT COUNT(*) AS n, MIN(posted_at) AS first, MAX(posted_at) AS last FROM mm_posts");
      return textResult({ recent: rows.map((r) => postView(r, now)), history: { posts: history.n, first: history.first ? new Date(history.first).toISOString().slice(0, 10) : null, last: history.last ? new Date(history.last).toISOString().slice(0, 10) : null } });
    }
    case "sz_feedback": {
      if (!args.moment_id && !args.post_id) throw new ToolError("Give a moment_id or a post_id.");
      if (args.value === "clear") {
        await run(env, "DELETE FROM feedback WHERE (moment_id = ? AND ? IS NOT NULL) OR (post_id = ? AND ? IS NOT NULL)", args.moment_id || null, args.moment_id || null, args.post_id || null, args.post_id || null);
        return textResult({ ok: true, cleared: true });
      }
      const id = `f_${now.toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
      await run(env, "INSERT INTO feedback (id, at, moment_id, post_id, value, note) VALUES (?, ?, ?, ?, ?, ?)", id, now, args.moment_id || null, args.post_id || null, args.value, args.note || null);
      if (args.value === "posted" && args.moment_id) await run(env, "UPDATE moments SET mm_covered_at = ? WHERE id = ?", now, args.moment_id);
      return textResult({ ok: true, id });
    }
    case "sz_engine": {
      if (args.run_now) await runPipeline(env, { budgetMs: 45000 });
      const runs = await all(env, "SELECT * FROM runs ORDER BY at DESC LIMIT 40");
      const latest = {};
      for (const r of runs) if (!latest[r.stage]) latest[r.stage] = { at: new Date(r.at).toISOString(), status: r.status, message: r.message, ms: r.ms };
      const failing = await all(env, "SELECT id, last_error, polled_at FROM accounts WHERE active = 1 AND last_error IS NOT NULL");
      const counts = await first(env, `SELECT (SELECT COUNT(*) FROM accounts WHERE active = 1) AS accounts, (SELECT COUNT(*) FROM posts) AS posts, (SELECT COUNT(*) FROM snapshots) AS snapshots, (SELECT COUNT(*) FROM moments WHERE archived = 0) AS moments, (SELECT COUNT(*) FROM mm_posts) AS mm_posts, (SELECT COUNT(*) FROM feedback) AS feedback`);
      const byPlatform = await all(env, "SELECT platform, COUNT(*) AS n, MAX(polled_at) AS last FROM accounts WHERE active = 1 GROUP BY platform");
      const xLast = await first(env, "SELECT value FROM settings WHERE key = 'x_last_push'");
      const fb = await all(env, "SELECT value, COUNT(*) AS n FROM feedback GROUP BY value");
      return textResult({
        as_of: new Date(now).toISOString(), stages: latest, counts,
        platforms: byPlatform.map((x) => ({ platform: x.platform, accounts: x.n, last_poll: x.last ? new Date(x.last).toISOString() : null })),
        x_last_push: xLast ? xLast.value : "never (the Mac collector has not pushed yet)",
        setup_page: `${env.SZ_PUBLIC_URL || "https://socialzeitgeist.shneur.workers.dev"}/setup?key=${env.SZ_KEY}`,
        failing: failing.map((f) => ({ id: f.id, error: f.last_error, at: f.polled_at ? new Date(f.polled_at).toISOString() : null })),
        feedback: Object.fromEntries(fb.map((x) => [x.value, x.n])),
      });
    }
    default:
      throw new ToolError(`Unknown tool: ${name}`);
  }
}

async function handleRpc(msg, env) {
  const { id, method, params = {} } = msg || {};
  const reply = (result) => ({ jsonrpc: "2.0", id, result });
  const fail = (code, message) => ({ jsonrpc: "2.0", id, error: { code, message } });
  if (!msg || msg.jsonrpc !== "2.0" || typeof method !== "string") return fail(-32600, "Invalid request");
  if (id === undefined) return null; // notification
  switch (method) {
    case "initialize": {
      const asked = params.protocolVersion;
      return reply({ protocolVersion: SUPPORTED_PROTOCOLS.includes(asked) ? asked : SUPPORTED_PROTOCOLS[0], capabilities: { tools: { listChanged: false } }, serverInfo: SERVER_INFO, instructions: INSTRUCTIONS });
    }
    case "ping":
      return reply({});
    case "tools/list":
      return reply({ tools: TOOLS });
    case "resources/list":
      return reply({ resources: [] });
    case "prompts/list":
      return reply({ prompts: [] });
    case "tools/call": {
      const tool = TOOLS.find((t) => t.name === params.name);
      if (!tool) return fail(-32602, `Unknown tool: ${params.name}`);
      try {
        return reply(await callTool(params.name, params.arguments || {}, env));
      } catch (err) {
        if (err instanceof ToolError) return reply(textResult(err.message, true));
        return reply(textResult(`Error: ${err.message}`, true));
      }
    }
    default:
      return fail(-32601, `Method not found: ${method}`);
  }
}

export async function handleMcp(request, env, cors) {
  let body;
  try {
    body = await request.json();
  } catch {
    return new Response(JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } }), { status: 400, headers: { "content-type": "application/json", ...cors } });
  }
  const messages = Array.isArray(body) ? body : [body];
  const replies = [];
  for (const m of messages) {
    const r = await handleRpc(m, env);
    if (r) replies.push(r);
  }
  if (!replies.length) return new Response(null, { status: 202, headers: cors });
  return new Response(JSON.stringify(Array.isArray(body) ? replies : replies[0]), { headers: { "content-type": "application/json", ...cors } });
}
