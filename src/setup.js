// The setup pages: everything that connects an integration lives here, so it is all done through the app.
//
//   GET  /setup?key=...               the one page: Meta app, Facebook login, X burner cookies, Mac collector, accounts
//   POST /setup/meta                  save the Meta app id and secret
//   GET  /setup/connect-fb?key=...    start Facebook Login (Business Discovery)
//   GET  /auth/callback               Facebook redirect
//   POST /setup/x                     save the X burner cookies
//   POST /setup/account               add / pause / resume / remove a tracked account
//   GET  /home/config?key=...         what the Mac collector needs (cookies, handles, subs)
//
// Secrets (app secret, Page token, X cookies) are encrypted at rest with ENCRYPTION_KEY.

import { all, first, getSetting, j, p, run, setSetting } from "./db.js";

const API = "v26.0";
const FB_SCOPES = ["instagram_basic", "instagram_manage_insights", "pages_show_list", "pages_read_engagement", "business_management"];

// ---- crypto -------------------------------------------------------------------------------------

const enc = new TextEncoder();
const dec = new TextDecoder();
const b64 = (bytes) => btoa(String.fromCharCode(...bytes));
const unb64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

async function aesKey(env) {
  if (!env.ENCRYPTION_KEY) throw new Error("ENCRYPTION_KEY secret is not set on the Worker.");
  const raw = await crypto.subtle.digest("SHA-256", enc.encode(env.ENCRYPTION_KEY));
  return crypto.subtle.importKey("raw", raw, "AES-GCM", false, ["encrypt", "decrypt"]);
}
export async function encrypt(env, plain) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const cipher = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, await aesKey(env), enc.encode(plain));
  return `${b64(iv)}.${b64(new Uint8Array(cipher))}`;
}
export async function decrypt(env, sealed) {
  const [iv, cipher] = sealed.split(".");
  return dec.decode(await crypto.subtle.decrypt({ name: "AES-GCM", iv: unb64(iv) }, await aesKey(env), unb64(cipher)));
}
export function randomId(bytes = 24) {
  return b64(crypto.getRandomValues(new Uint8Array(bytes))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export async function secret(env, key) {
  const v = await getSetting(env, key);
  return v ? decrypt(env, v) : null;
}

// ---- Meta (Facebook Login, Business Discovery) ----------------------------------------------------

async function graph(path, params) {
  const url = new URL(`https://graph.facebook.com/${API}/${path}`);
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null) url.searchParams.set(k, String(v));
  const res = await fetch(url, { signal: AbortSignal.timeout(25000) });
  const body = await res.json().catch(() => ({}));
  if (!res.ok || body.error) {
    const e = body.error || {};
    throw new Error(`${e.message || `Meta HTTP ${res.status}`}${e.code ? ` (code ${e.code})` : ""}`);
  }
  return body;
}

// Read another professional account through Business Discovery with the app user's token.
export async function businessDiscovery(env, username, limit = 25) {
  const token = await secret(env, "fb_token");
  const igUser = await getSetting(env, "fb_ig_user_id");
  if (!token || !igUser) throw new Error("Not connected to Facebook yet: open the setup page.");
  if (!/^[A-Za-z0-9._]{1,30}$/.test(username)) throw new Error(`${username} isn't a valid Instagram username.`);
  const media = `media.limit(${limit}){id,caption,media_type,media_product_type,permalink,timestamp,like_count,comments_count}`;
  const r = await graph(igUser, {
    fields: `business_discovery.username(${username}){id,username,name,followers_count,media_count,${media}}`,
    access_token: token,
  });
  const bd = r.business_discovery || {};
  return { profile: { native_id: bd.id, display: bd.name, followers: bd.followers_count }, posts: bd.media?.data || [] };
}

async function fbExchange(env, { appId, appSecret, redirectUri, code }) {
  const short = await graph("oauth/access_token", { client_id: appId, client_secret: appSecret, redirect_uri: redirectUri, code });
  const long = await graph("oauth/access_token", { grant_type: "fb_exchange_token", client_id: appId, client_secret: appSecret, fb_exchange_token: short.access_token });
  const accounts = [];
  let after;
  do {
    const page = await graph("me/accounts", { fields: "id,name,access_token,instagram_business_account{id,username,name}", limit: 100, access_token: long.access_token, after });
    for (const fb of page.data || []) if (fb.instagram_business_account?.username) accounts.push({ ig: fb.instagram_business_account, pageId: fb.id, pageName: fb.name, token: fb.access_token });
    after = page.paging?.next ? page.paging?.cursors?.after : undefined;
  } while (after);
  return accounts;
}

// ---- pages ---------------------------------------------------------------------------------------

function esc(v) {
  return String(v ?? "").replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

function page(title, body, status = 200) {
  const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="referrer" content="no-referrer"><meta name="robots" content="noindex">
<title>${esc(title)}</title>
<style>
  :root { --bg:#fff; --fg:#111; --muted:#6b6b6b; --line:#d9d9d9; --ok:#1d7a3e; --bad:#b3261e; }
  @media (prefers-color-scheme: dark) { :root { --bg:#111; --fg:#eee; --muted:#9a9a9a; --line:#3a3a3a; --ok:#5fcf86; --bad:#ff7b72; } }
  * { box-sizing: border-box; }
  body { margin:0; background:var(--bg); color:var(--fg); font:16px/1.55 -apple-system, system-ui, sans-serif; }
  main { max-width: 760px; margin: 0 auto; padding: 72px 20px 120px; }
  h1 { font-size: 34px; letter-spacing: 0.01em; margin: 0 0 8px; font-weight: 650; }
  h2 { font-size: 22px; margin: 72px 0 12px; font-weight: 650; }
  p { color: var(--muted); margin: 0 0 20px; max-width: 62ch; }
  p.lead { font-size: 18px; margin-bottom: 40px; }
  label { display:block; margin: 18px 0 6px; font-weight: 600; }
  input, select { width: 100%; padding: 12px; font: inherit; color: var(--fg); background: var(--bg); border: 1px solid var(--line); border-radius: 0; }
  button, .button { display:inline-block; margin-top: 18px; padding: 12px 20px; font: inherit; font-weight: 600; color: var(--bg); background: var(--fg); border: 0; border-radius: 0; text-decoration: none; cursor: pointer; }
  button.quiet { background: transparent; color: var(--fg); border: 1px solid var(--line); margin: 0; padding: 6px 10px; font-size: 14px; font-weight: 500; }
  .ok { color: var(--ok); font-weight: 600; } .bad { color: var(--bad); font-weight: 600; }
  .row { display:grid; grid-template-columns: 1fr 1fr; gap: 0 24px; } @media (max-width: 600px) { .row { grid-template-columns: 1fr; } }
  table { width:100%; border-collapse: collapse; margin-top: 12px; font-size: 15px; }
  th, td { text-align:left; padding: 10px 8px 10px 0; vertical-align: top; } th { color: var(--muted); font-weight: 600; }
  tr + tr td { border-top: 0; }
  code { font-size: 14px; word-break: break-all; background: color-mix(in srgb, var(--fg) 6%, transparent); padding: 2px 5px; }
  pre { font-size: 13px; padding: 14px; background: color-mix(in srgb, var(--fg) 6%, transparent); overflow:auto; white-space: pre-wrap; word-break: break-all; }
  .status { display:flex; gap: 32px; flex-wrap: wrap; margin: 0 0 8px; } .status div span { display:block; color: var(--muted); font-size: 14px; }
  form.inline { display:inline; }
</style></head><body><main>${body}</main></body></html>`;
  return new Response(html, { status, headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "referrer-policy": "no-referrer", "x-frame-options": "DENY" } });
}

async function igStatus(env) {
  try {
    const doFetch = env.IG ? env.IG.fetch.bind(env.IG) : fetch;
    const res = await doFetch(`${env.IG_MCP_URL}?bearer_token=${encodeURIComponent(env.IG_MCP_TOKEN)}`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "ig_setup_status", arguments: {} } }),
      signal: AbortSignal.timeout(10000),
    });
    const d = await res.json();
    return JSON.parse(d.result?.content?.[0]?.text || "{}");
  } catch (e) {
    return { error: e.message };
  }
}

export async function setupPage(request, env, key, notice) {
  const origin = new URL(request.url).origin;
  const k = encodeURIComponent(key);
  const [appId, fbUser, fbPage, xUser, xSaved, xLast, ig] = await Promise.all([
    getSetting(env, "meta_app_id"), getSetting(env, "fb_username"), getSetting(env, "fb_page_name"),
    getSetting(env, "x_username"), getSetting(env, "x_cookies"), getSetting(env, "x_last_push"), igStatus(env),
  ]);
  const accounts = await all(env, "SELECT * FROM accounts ORDER BY platform, handle");
  const lastRun = await first(env, "SELECT at, status, message FROM runs WHERE stage = 'brief' ORDER BY at DESC LIMIT 1");
  const counts = await first(env, "SELECT (SELECT COUNT(*) FROM posts) AS posts, (SELECT COUNT(*) FROM moments WHERE archived = 0) AS moments, (SELECT COUNT(*) FROM mm_posts) AS mm");
  const when = (ms) => (ms ? new Date(ms).toLocaleString("en-US", { timeZone: "America/New_York", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }) : "never");
  const opt = (v, cur) => `<option value="${v}"${v === cur ? " selected" : ""}>${v}</option>`;

  const rows = accounts.map((a) => `<tr>
    <td>${esc(a.platform)}</td><td>@${esc(a.handle)}${a.display ? `<br><span style="color:var(--muted);font-size:13px">${esc(a.display)}</span>` : ""}</td>
    <td>${esc(a.category)} · ${a.weight}</td>
    <td>${a.active ? (a.last_error ? `<span class="bad">error</span><br><span style="font-size:13px;color:var(--muted)">${esc(a.last_error.slice(0, 90))}</span>` : `<span class="ok">ok</span> <span style="color:var(--muted);font-size:13px">${when(a.polled_at)}</span>`) : "paused"}</td>
    <td style="white-space:nowrap">
      <form class="inline" method="post" action="/setup/account"><input type="hidden" name="key" value="${esc(key)}"><input type="hidden" name="id" value="${esc(a.id)}"><input type="hidden" name="action" value="${a.active ? "pause" : "resume"}"><button class="quiet">${a.active ? "Pause" : "Resume"}</button></form>
      <form class="inline" method="post" action="/setup/account"><input type="hidden" name="key" value="${esc(key)}"><input type="hidden" name="id" value="${esc(a.id)}"><input type="hidden" name="action" value="remove"><button class="quiet">Remove</button></form>
    </td></tr>`).join("");

  return page("Social Zeitgeist setup", `
<h1>Social Zeitgeist</h1>
<p class="lead">Every integration is set up from this page. Secrets are stored encrypted and never shown again.</p>
${notice ? `<p class="${notice.startsWith("Error") ? "bad" : "ok"}">${esc(notice)}</p>` : ""}
<div class="status">
  <div><span>Last brief</span>${lastRun ? `${when(lastRun.at)} (${esc(lastRun.status)})` : "not yet"}</div>
  <div><span>Posts</span>${counts.posts}</div>
  <div><span>Live moments</span>${counts.moments}</div>
  <div><span>MM history</span>${counts.mm} posts</div>
</div>

<h2>1. Meta app</h2>
<p>A Meta app of its own, used only to read other professional accounts through Business Discovery. In the Meta developer dashboard the app needs Facebook Login for Business with this redirect URI: <code>${esc(origin)}/auth/callback</code>. Paste the App ID and App Secret from App settings, Basic.</p>
<form method="post" action="/setup/meta"><input type="hidden" name="key" value="${esc(key)}">
  <div class="row"><div><label>App ID</label><input name="app_id" required value="${esc(appId || "")}" autocomplete="off"></div>
  <div><label>App Secret ${appId ? "<span style='color:var(--muted);font-weight:400'>(saved; paste again only to change)</span>" : ""}</label><input name="app_secret" type="password" ${appId ? "" : "required"} autocomplete="off"></div></div>
  <button type="submit">Save Meta app</button></form>

<h2>2. Facebook login</h2>
<p>Log in with a Facebook account that manages a Page linked to any Instagram professional account you run. That account's token is what reads the others; it does not need to be Meaningful Minute.</p>
${fbUser ? `<p class="ok">Connected as @${esc(fbUser)}${fbPage ? ` (Page: ${esc(fbPage)})` : ""}</p>` : `<p class="bad">Not connected</p>`}
${appId ? `<a class="button" href="/setup/connect-fb?key=${k}">${fbUser ? "Reconnect" : "Connect with Facebook"}</a>` : `<p>Save the Meta app first.</p>`}

<h2>3. Meaningful Minute's own account</h2>
<p>MM's own posts come through the Instagram connector (instagrammcp), which is already connected with Instagram Login.</p>
${ig.error ? `<p class="bad">Could not reach the Instagram connector: ${esc(ig.error)}</p>` : `<p class="ok">${(ig.connected_accounts || []).join(", ") || "no accounts connected"}</p>`}

<h2>4. X</h2>
<p>X is read by the Mac collector with a burner account, never a real one. Log in to the burner in a browser, open DevTools, Application, Cookies for x.com, and paste <code>auth_token</code> and <code>ct0</code>. They are stored encrypted and handed only to the Mac collector.</p>
${xSaved ? `<p class="ok">Burner saved${xUser ? ` (@${esc(xUser)})` : ""}. Last push from the Mac: ${xLast ? esc(xLast) : "never"}</p>` : `<p class="bad">No burner cookies yet</p>`}
<form method="post" action="/setup/x"><input type="hidden" name="key" value="${esc(key)}">
  <div class="row"><div><label>auth_token</label><input name="auth_token" type="password" autocomplete="off"></div><div><label>ct0</label><input name="ct0" type="password" autocomplete="off"></div></div>
  <label>Burner username (label only)</label><input name="username" value="${esc(xUser || "")}" autocomplete="off">
  <label>X List id (optional, a private List to read on top of the handles below)</label><input name="list_id" value="${esc((await getSetting(env, "x_list_id")) || "")}" autocomplete="off">
  <button type="submit">Save X</button></form>

<h2>5. Mac collector</h2>
<p>One script on the Mac reads X and Reddit (both refuse cloud IPs) every 15 minutes and pushes here. It pulls its own config from this Worker, so the only thing on the Mac is the endpoint and key. Install once in Terminal:</p>
<pre>mkdir -p ~/.socialzeitgeist && curl -fsSL https://raw.githubusercontent.com/ShneurNovack/socialzeitgeist/main/scripts/home_collector.py -o ~/.socialzeitgeist/home_collector.py && printf '{"endpoint":"${esc(origin)}","key":"${esc(key)}"}' > ~/.socialzeitgeist/config.json && curl -fsSL https://raw.githubusercontent.com/ShneurNovack/socialzeitgeist/main/scripts/install_launchd.sh | bash</pre>

<h2>6. Accounts</h2>
<p>The accounts being watched. Instagram must be professional accounts. Category says what the account is to MM; weight (0.2 to 2) says how much its attention counts.</p>
<form method="post" action="/setup/account"><input type="hidden" name="key" value="${esc(key)}"><input type="hidden" name="action" value="add">
  <div class="row">
    <div><label>Platform</label><select name="platform">${["instagram", "x", "telegram", "bluesky", "reddit"].map((v) => opt(v, "instagram")).join("")}</select></div>
    <div><label>Handle</label><input name="handle" required placeholder="username, channel, or subreddit" autocomplete="off"></div>
    <div><label>Category</label><select name="category">${["peer", "big", "niche", "news", "creator", "org", "self"].map((v) => opt(v, "peer")).join("")}</select></div>
    <div><label>Weight</label><input name="weight" value="1" autocomplete="off"></div>
  </div>
  <button type="submit">Add account</button></form>
<table><tr><th>Platform</th><th>Handle</th><th>Category · weight</th><th>Status</th><th></th></tr>${rows}</table>
`);
}

// ---- handlers -----------------------------------------------------------------------------------

export async function saveMeta(env, form) {
  const appId = String(form.get("app_id") || "").trim();
  const appSecret = String(form.get("app_secret") || "").trim();
  if (!/^\d{5,}$/.test(appId)) return "Error: the App ID should be all digits.";
  await setSetting(env, "meta_app_id", appId);
  if (appSecret) {
    if (appSecret.length < 16) return "Error: the App Secret looks too short.";
    await setSetting(env, "meta_app_secret", await encrypt(env, appSecret));
  } else if (!(await getSetting(env, "meta_app_secret"))) return "Error: the App Secret is needed the first time.";
  return "Meta app saved. Now connect with Facebook.";
}

export async function startFb(request, env) {
  const appId = await getSetting(env, "meta_app_id");
  if (!appId) return page("Not set up", `<h1>Save the Meta app first</h1>`, 400);
  const state = randomId(24);
  await setSetting(env, `oauth_${state}`, String(Date.now() + 15 * 60000));
  const url = new URL(`https://www.facebook.com/${API}/dialog/oauth`);
  url.searchParams.set("client_id", appId);
  url.searchParams.set("redirect_uri", `${new URL(request.url).origin}/auth/callback`);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", FB_SCOPES.join(","));
  url.searchParams.set("state", state);
  url.searchParams.set("auth_type", "rerequest");
  return Response.redirect(url.toString(), 302);
}

export async function fbCallback(request, env) {
  const url = new URL(request.url);
  const error = url.searchParams.get("error_description") || url.searchParams.get("error");
  if (error) return page("Not connected", `<h1>Not connected</h1><p>${esc(error)}</p>`, 400);
  const state = url.searchParams.get("state") || "";
  const expires = Number(await getSetting(env, `oauth_${state}`));
  await run(env, "DELETE FROM settings WHERE key = ?", `oauth_${state}`);
  if (!state || !expires || expires < Date.now()) return page("Link expired", `<h1>Link expired</h1><p>Start again from the setup page.</p>`, 400);
  try {
    const found = await fbExchange(env, {
      appId: await getSetting(env, "meta_app_id"),
      appSecret: await secret(env, "meta_app_secret"),
      redirectUri: `${url.origin}/auth/callback`,
      code: (url.searchParams.get("code") || "").replace(/#_$/, ""),
    });
    if (!found.length) return page("No accounts found", `<h1>No accounts found</h1><p>None of the Pages you picked has a linked Instagram professional account. Link one to its Page, or make sure your Facebook account can manage that Page, then try again.</p>`, 400);
    const a = found[0];
    await setSetting(env, "fb_token", await encrypt(env, a.token));
    await setSetting(env, "fb_ig_user_id", String(a.ig.id));
    await setSetting(env, "fb_username", a.ig.username);
    await setSetting(env, "fb_page_name", a.pageName);
    // Try it once so the page can say whether Business Discovery works.
    let check = "";
    try {
      const r = await businessDiscovery(env, "instagram", 1);
      check = `Business Discovery works (read @instagram, ${r.profile.followers} followers).`;
    } catch (e) {
      check = `Connected, but a Business Discovery test failed: ${e.message}`;
    }
    await run(env, "UPDATE accounts SET polled_at = NULL, last_error = NULL WHERE platform = 'instagram'");
    return page("Connected", `<h1>Connected as @${esc(a.ig.username)}</h1><p>${esc(check)} You can close this tab; Instagram accounts are read on the next run.</p>`);
  } catch (err) {
    return page("Not connected", `<h1>Not connected</h1><p>${esc(err.message)}</p>`, 400);
  }
}

export async function saveX(env, form) {
  const auth = String(form.get("auth_token") || "").trim();
  const ct0 = String(form.get("ct0") || "").trim();
  const username = String(form.get("username") || "").trim().replace(/^@/, "");
  const listId = String(form.get("list_id") || "").trim();
  if (username) await setSetting(env, "x_username", username);
  if (listId && !/^\d+$/.test(listId)) return "Error: the List id is all digits (it's in the List's URL).";
  await setSetting(env, "x_list_id", listId);
  if (auth || ct0) {
    if (!auth || !ct0) return "Error: both auth_token and ct0 are needed.";
    await setSetting(env, "x_cookies", await encrypt(env, JSON.stringify({ auth_token: auth, ct0 })));
    return "X burner saved. The Mac collector picks it up on its next run.";
  }
  return "X settings saved.";
}

export async function saveAccount(env, form) {
  const action = String(form.get("action") || "");
  const now = Date.now();
  if (action === "add") {
    const platform = String(form.get("platform") || "");
    const handle = String(form.get("handle") || "").replace(/^@/, "").replace(/^r\//, "").trim().toLowerCase();
    if (!["instagram", "x", "telegram", "bluesky", "reddit"].includes(platform) || !handle) return "Error: platform and handle are needed.";
    const id = `${platform}:${handle}`;
    if (await first(env, "SELECT id FROM accounts WHERE id = ?", id)) return `Error: ${id} is already tracked.`;
    const weight = Math.min(2, Math.max(0.2, Number(form.get("weight")) || 1));
    await run(env, "INSERT INTO accounts (id, platform, handle, category, weight, active, added_at) VALUES (?, ?, ?, ?, ?, 1, ?)", id, platform, handle, String(form.get("category") || "peer"), weight, now);
    return `Added ${id}.`;
  }
  const id = String(form.get("id") || "");
  if (action === "remove") { await run(env, "DELETE FROM accounts WHERE id = ?", id); return `Removed ${id}.`; }
  if (action === "pause" || action === "resume") { await run(env, "UPDATE accounts SET active = ? WHERE id = ?", action === "resume" ? 1 : 0, id); return `${action === "resume" ? "Resumed" : "Paused"} ${id}.`; }
  return "Error: unknown action.";
}

// What the Mac collector needs. Cookies travel only over this authenticated call.
export async function homeConfig(env) {
  const cookies = p(await secret(env, "x_cookies"), null);
  const xs = await all(env, "SELECT handle FROM accounts WHERE platform = 'x' AND active = 1");
  const rs = await all(env, "SELECT handle FROM accounts WHERE platform = 'reddit' AND active = 1");
  return {
    x: { cookies, username: await getSetting(env, "x_username"), list_id: (await getSetting(env, "x_list_id")) || null, accounts: xs.map((r) => r.handle), limit: 20 },
    reddit: { subs: rs.map((r) => r.handle) },
  };
}
