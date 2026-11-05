// Social Zeitgeist on Cloudflare Workers.
//
//   POST /?bearer_token=...          MCP endpoint
//   POST /ingest/x                   X posts pushed from the Mac script (header x-sz-key)
//   POST /admin/import-mm            MM post history (JSON array), header x-sz-key
//   POST /admin/run                  run the pipeline now, header x-sz-key
//   GET  /app?key=...                the web app (the key is kept in the browser after the first open)
//   POST /api/tool                   { name, args } for the app, same tools as the MCP, header x-sz-key
//   GET  /setup?key=...              the setup page (all integrations)
//   GET  /home/config?key=...        config for the Mac collector
//   GET  /health
//
// Cron every 10 minutes: collect due accounts, read, find moments, score, write the brief.

import { normalizeX, storePosts } from "./collect.js";
import { all, batch, first, j, run, setSetting } from "./db.js";
import { callToolJson, handleMcp } from "./mcp.js";
import appHtml from "./ui/app.html";
import appCss from "./ui/app.css";
import tokensCss from "./ui/tokens.css";
import baseCss from "./ui/base.css";
import componentsCss from "./ui/components.css";
import { runPipeline } from "./pipeline.js";
import { terms } from "./text.js";
import { fbCallback, homeConfig, saveAccount, saveMeta, saveReddit, saveX, setupPage, startFb } from "./setup.js";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, GET, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Accept, Authorization, Mcp-Session-Id, Mcp-Protocol-Version, x-sz-key",
};

const json = (data, status = 200) => new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json", ...CORS } });

async function safeEqual(a, b) {
  if (!a || !b) return false;
  const enc = new TextEncoder();
  const [x, y] = await Promise.all([crypto.subtle.digest("SHA-256", enc.encode(a)), crypto.subtle.digest("SHA-256", enc.encode(b))]);
  const p = new Uint8Array(x), q = new Uint8Array(y);
  let diff = 0;
  for (let i = 0; i < p.length; i++) diff |= p[i] ^ q[i];
  return diff === 0;
}

function requestToken(request, url) {
  const header = request.headers.get("authorization") || "";
  return url.searchParams.get("bearer_token") || header.replace(/^Bearer\s+/i, "") || request.headers.get("x-sz-key") || null;
}

// X posts come from the Mac. The body is { posts: [...] } as the script sends it; accounts not yet tracked
// are added as peers so nothing pushed is lost, and the pusher can send `accounts` with follower counts.
async function ingestX(env, body) {
  const items = normalizeX(body.posts || []);
  const now = Date.now();
  const byHandle = new Map();
  for (const it of items) {
    if (!it.handle) continue;
    const key = `${it.platform}:${it.handle}`;
    if (!byHandle.has(key)) byHandle.set(key, []);
    byHandle.get(key).push(it);
  }
  let stored = 0, added = 0;
  for (const [id, posts] of byHandle) {
    const [platform, handle] = id.split(":");
    let account = await first(env, "SELECT * FROM accounts WHERE id = ?", id);
    if (!account) {
      await run(env, "INSERT INTO accounts (id, platform, handle, category, weight, active, added_at, note) VALUES (?, ?, ?, 'peer', 1, 1, ?, 'added by the home push')", id, platform, handle, now);
      account = { id, platform, handle, category: "peer" };
      added++;
    }
    if (!account.active) continue;
    const r = await storePosts(env, account, posts);
    stored += r.stored;
    const meta = posts.find((x) => x.followers || x.display);
    await run(env, "UPDATE accounts SET polled_at = ?, last_error = NULL, followers = COALESCE(?, followers), display = COALESCE(?, display) WHERE id = ?", now, meta?.followers ?? null, meta?.display ?? null, id);
  }
  await setSetting(env, "x_last_push", new Date(now).toISOString());
  return { received: items.length, stored, accounts: byHandle.size, added };
}

async function importMm(env, rows) {
  const stmts = [];
  let n = 0;
  for (const r of rows) {
    if (!r.ext_id || !r.posted_at) continue;
    const at = typeof r.posted_at === "number" ? r.posted_at : Date.parse(r.posted_at);
    if (!at) continue;
    stmts.push(
      env.DB.prepare(
        `INSERT INTO mm_posts (ext_id, url, caption, format, source, posted_at, likes, comments, views, saves, shares, reach, y, yv, high, terms)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (ext_id) DO UPDATE SET caption = excluded.caption, format = excluded.format, source = excluded.source, likes = excluded.likes,
           comments = excluded.comments, views = excluded.views, saves = excluded.saves, shares = excluded.shares, reach = excluded.reach,
           y = excluded.y, yv = excluded.yv, high = excluded.high, terms = excluded.terms`,
      ).bind(
        String(r.ext_id), r.url || null, String(r.caption || "").slice(0, 4000), r.format || null, r.source || "import", at,
        r.likes || 0, r.comments || 0, r.views || 0, r.saves || 0, r.shares || 0, r.reach || 0,
        r.y ?? null, r.yv ?? null, r.high ?? null, j(terms(r.caption || "")),
      ),
    );
    n++;
  }
  await batch(env, stmts);
  return { imported: n };
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const { pathname } = url;
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
    if (pathname === "/health") return json({ ok: true, service: "socialzeitgeist" });
    if (pathname === "/auth/callback") return fbCallback(request, env);
    // The app: static, and it keeps the key in the browser, so these need no auth. The data does.
    if (pathname === "/app" || (pathname === "/" && request.method === "GET")) {
      return new Response(appHtml, { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "x-frame-options": "DENY" } });
    }
    if (pathname === "/ui/kit.css") return new Response(`${tokensCss}\n${baseCss}\n${componentsCss}`, { headers: { "content-type": "text/css", "cache-control": "public, max-age=3600" } });
    if (pathname === "/ui/app.css") return new Response(appCss, { headers: { "content-type": "text/css", "cache-control": "no-store" } });

    // Setup pages carry the key in a form field or the query string.
    if (pathname.startsWith("/setup")) {
      const form = request.method === "POST" ? await request.formData() : null;
      const key = form ? form.get("key") : url.searchParams.get("key");
      if (!(await safeEqual(key, env.SZ_KEY))) return new Response("Not found", { status: 404 });
      let notice;
      try {
        if (pathname === "/setup/connect-fb") return startFb(request, env);
        if (pathname === "/setup/meta" && form) notice = await saveMeta(env, form);
        else if (pathname === "/setup/x" && form) notice = await saveX(env, form);
        else if (pathname === "/setup/reddit" && form) notice = await saveReddit(env, form);
        else if (pathname === "/setup/account" && form) notice = await saveAccount(env, form);
      } catch (err) {
        notice = `Error: ${err.message}`;
      }
      return setupPage(request, env, key, notice);
    }

    const authed = await safeEqual(requestToken(request, url), env.SZ_KEY);
    if (!authed) return json({ error: "Unauthorized" }, 401);
    try {
      if (pathname === "/api/tool" && request.method === "POST") {
        const { name, args } = await request.json();
        try {
          return json({ result: await callToolJson(name, args, env) });
        } catch (err) {
          return json({ error: err.message }, 400);
        }
      }
      if (pathname === "/ingest/x" && request.method === "POST") return json(await ingestX(env, await request.json()));
      if (pathname === "/home/config" && request.method === "GET") return json(await homeConfig(env));
      if (pathname === "/admin/import-mm" && request.method === "POST") return json(await importMm(env, await request.json()));
      if (pathname === "/admin/run" && request.method === "POST") return json({ ok: true, log: await runPipeline(env, { budgetMs: 45000, collect: url.searchParams.get("collect") !== "0" }) });
      if (pathname === "/admin/sql" && request.method === "POST") {
        // Read-only diagnostics.
        const { sql } = await request.json();
        if (!/^\s*select/i.test(sql)) return json({ error: "select only" }, 400);
        return json(await all(env, sql));
      }
      if (pathname === "/" || pathname === "/mcp") {
        if (request.method !== "POST") return new Response("Method Not Allowed", { status: 405, headers: { Allow: "POST, OPTIONS", ...CORS } });
        return handleMcp(request, env, CORS);
      }
      return json({ error: "not found" }, 404);
    } catch (err) {
      return json({ error: String(err?.message || err).slice(0, 300) }, 500);
    }
  },

  async scheduled(event, env, ctx) {
    ctx.waitUntil(runPipeline(env).then((log) => console.log(JSON.stringify(log.map((l) => ({ stage: l.stage, status: l.status, ms: l.ms, message: l.message }))))));
  },
};
