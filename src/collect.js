// Collectors. Each returns normalized posts for one account:
//   { native_id, url, text, media_type, posted_at, likes, comments, shares, views, saves, quotes, is_repost, raw }
// Instagram goes through Meta's official API (Business Discovery, via the instagrammcp Worker).
// X arrives by push from the Mac script (see /ingest/x in index.js), never fetched from here.
// Telegram, Bluesky and Reddit are public, unauthenticated reads of what those platforms publish openly.

import { hook, terms } from "./text.js";
import { all, batch, j, run } from "./db.js";

const UA = "socialzeitgeist/1.0 (+https://reshapecreative.com; private research tool)";

// ---- Instagram (official API, through instagrammcp) -------------------------------------------

async function igRpc(env, name, args) {
  if (!env.IG_MCP_URL || !env.IG_MCP_TOKEN) throw new Error("IG_MCP_URL / IG_MCP_TOKEN not set");
  // Worker-to-Worker on workers.dev needs the service binding (a plain fetch gets Cloudflare error 1042).
  const doFetch = env.IG ? env.IG.fetch.bind(env.IG) : fetch;
  const res = await doFetch(`${env.IG_MCP_URL}?bearer_token=${encodeURIComponent(env.IG_MCP_TOKEN)}`, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }),
    signal: AbortSignal.timeout(25000),
  });
  const data = await res.json();
  if (data.error) throw new Error(data.error.message || "MCP error");
  const text = data.result?.content?.[0]?.text || "";
  if (data.result?.isError) throw new Error(text.slice(0, 300));
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`Unreadable reply: ${text.slice(0, 120)}`);
  }
}

function igMediaType(m) {
  if (m.media_product_type === "REELS" || m.media_type === "VIDEO") return "reel";
  if (m.media_type === "CAROUSEL_ALBUM") return "carousel";
  return "image";
}

export async function collectInstagram(env, account) {
  // Our own account (category self) reads its own media, which also works on the Instagram Login connection.
  if (account.category === "self") {
    const data = await igRpc(env, "ig_recent_media", { account: account.handle, limit: 25 });
    return (data || []).map((m) => ({
      native_id: m.id,
      url: m.permalink,
      text: m.caption || "",
      media_type: igMediaType(m),
      posted_at: Date.parse(m.timestamp),
      likes: m.like_count || 0,
      comments: m.comments_count || 0,
    }));
  }
  const data = await igRpc(env, "ig_business_discovery", { username: account.handle, limit: 25 });
  const profile = data.account || {};
  return {
    profile: { followers: profile.followers_count, display: profile.name, native_id: profile.id },
    posts: (data.posts || []).map((m) => ({
      native_id: m.id,
      url: m.permalink,
      text: m.caption || "",
      media_type: igMediaType(m),
      posted_at: Date.parse(m.timestamp),
      likes: m.like_count || 0,
      comments: m.comments_count || 0,
    })),
  };
}

// ---- Telegram public channel preview (t.me/s/<channel>) -----------------------------------------

function tgCount(s) {
  const m = String(s || "").trim().match(/^([\d.,]+)\s*([KkMm])?$/);
  if (!m) return 0;
  const n = parseFloat(m[1].replace(/,/g, ""));
  return Math.round(n * (m[2] ? (m[2].toLowerCase() === "k" ? 1000 : 1000000) : 1));
}

function decode(html) {
  return html
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#(\d+);/g, (_, c) => String.fromCodePoint(Number(c)))
    .trim();
}

export async function collectTelegram(env, account) {
  const res = await fetch(`https://t.me/s/${encodeURIComponent(account.handle)}`, { headers: { "user-agent": UA }, signal: AbortSignal.timeout(20000) });
  if (!res.ok) throw new Error(`t.me ${res.status}`);
  const html = await res.text();
  const posts = [];
  const blocks = html.split('class="tgme_widget_message_wrap');
  for (const b of blocks.slice(1)) {
    const id = b.match(/data-post="([^"]+)"/)?.[1];
    if (!id) continue;
    const text = decode(b.match(/class="tgme_widget_message_text[^"]*"[^>]*>([\s\S]*?)<\/div>/)?.[1] || "");
    const views = tgCount(b.match(/class="tgme_widget_message_views">([^<]+)</)?.[1]);
    const when = b.match(/<time[^>]+datetime="([^"]+)"/)?.[1];
    const hasVideo = /tgme_widget_message_video|message_video_player/.test(b);
    const hasPhoto = /tgme_widget_message_photo/.test(b);
    const forwarded = /tgme_widget_message_forwarded_from/.test(b);
    if (!when) continue;
    posts.push({
      native_id: id.replace("/", "_"),
      url: `https://t.me/${id}`,
      text,
      media_type: hasVideo ? "video" : hasPhoto ? "image" : "text",
      posted_at: Date.parse(when),
      views,
      is_repost: forwarded ? 1 : 0,
    });
  }
  return { posts };
}

// ---- Bluesky (public AppView, no login) --------------------------------------------------------

export async function collectBluesky(env, account) {
  const url = new URL("https://public.api.bsky.app/xrpc/app.bsky.feed.getAuthorFeed");
  url.searchParams.set("actor", account.handle);
  url.searchParams.set("limit", "30");
  url.searchParams.set("filter", "posts_no_replies");
  const res = await fetch(url, { headers: { "user-agent": UA }, signal: AbortSignal.timeout(20000) });
  if (!res.ok) throw new Error(`bsky ${res.status}`);
  const data = await res.json();
  const posts = [];
  let profile;
  for (const item of data.feed || []) {
    const post = item.post;
    if (!post) continue;
    const isRepost = item.reason?.$type === "app.bsky.feed.defs#reasonRepost";
    if (!profile && !isRepost) profile = { native_id: post.author?.did, display: post.author?.displayName };
    const rkey = post.uri.split("/").pop();
    const embed = post.embed?.$type || "";
    posts.push({
      native_id: rkey,
      url: `https://bsky.app/profile/${post.author?.handle}/post/${rkey}`,
      text: post.record?.text || "",
      media_type: /video/.test(embed) ? "video" : /images/.test(embed) ? "image" : /external/.test(embed) ? "link" : "text",
      posted_at: Date.parse(post.record?.createdAt || post.indexedAt),
      likes: post.likeCount || 0,
      comments: post.replyCount || 0,
      shares: post.repostCount || 0,
      quotes: post.quoteCount || 0,
      is_repost: isRepost ? 1 : 0,
    });
  }
  return { profile, posts };
}

// ---- Reddit (public listing JSON) ---------------------------------------------------------------

export async function collectReddit(env, account) {
  const sub = account.handle.replace(/^r\//, "");
  const res = await fetch(`https://www.reddit.com/r/${encodeURIComponent(sub)}/new.json?limit=50&raw_json=1`, {
    headers: { "user-agent": UA, accept: "application/json" },
    signal: AbortSignal.timeout(20000),
  });
  if (!res.ok) throw new Error(`reddit ${res.status}`);
  const data = await res.json();
  const posts = [];
  for (const child of data.data?.children || []) {
    const d = child.data;
    if (!d || d.stickied) continue;
    posts.push({
      native_id: d.id,
      url: `https://www.reddit.com${d.permalink}`,
      text: [d.title, d.selftext].filter(Boolean).join("\n").slice(0, 3000),
      media_type: d.is_video ? "video" : d.post_hint === "image" ? "image" : d.is_self ? "text" : "link",
      posted_at: Math.round(d.created_utc * 1000),
      likes: Math.max(0, d.score || 0),
      comments: d.num_comments || 0,
      shares: d.num_crossposts || 0,
    });
  }
  return { posts };
}

// ---- X (pushed from the Mac; this only normalizes) -----------------------------------------------

export function normalizeX(items) {
  return (items || []).map((t) => ({
    platform: ["x", "reddit", "threads"].includes(t.platform) ? t.platform : "x",
    handle: String(t.username || t.handle || "").toLowerCase(),
    display: t.display_name || t.name,
    followers: t.followers,
    native_id: String(t.id),
    url: t.url || (t.username ? `https://x.com/${t.username}/status/${t.id}` : null),
    text: t.text || "",
    media_type: t.media_type || (t.has_video ? "video" : t.has_image ? "image" : "text"),
    posted_at: typeof t.date === "number" ? t.date : Date.parse(t.date),
    likes: t.likes || 0,
    comments: t.replies || 0,
    shares: t.retweets || 0,
    quotes: t.quotes || 0,
    views: t.views || 0,
    is_repost: t.is_retweet ? 1 : 0,
  }));
}

// ---- Shared write path -------------------------------------------------------------------------

export function engagement(platform, p) {
  // One number per post so accounts can be compared with themselves. Views are kept apart for IG
  // (not readable for other accounts) and lead for Telegram (the only number it has).
  switch (platform) {
    case "instagram":
      return (p.likes || 0) + 3 * (p.comments || 0);
    case "x":
      return (p.likes || 0) + 2 * (p.shares || 0) + 2 * (p.quotes || 0) + (p.comments || 0);
    case "bluesky":
      return (p.likes || 0) + 2 * (p.shares || 0) + 2 * (p.quotes || 0) + (p.comments || 0);
    case "telegram":
      return (p.views || 0) / 20;
    case "reddit":
      return (p.likes || 0) + 2 * (p.comments || 0);
    default:
      return (p.likes || 0) + 2 * (p.comments || 0) + 2 * (p.shares || 0);
  }
}

// Upsert posts and snapshots for an account. Posts older than the window are ignored.
export async function storePosts(env, account, posts, { windowDays = 14 } = {}) {
  const now = Date.now();
  const cutoff = now - windowDays * 86400000;
  const fresh = posts.filter((x) => x.posted_at && x.posted_at > cutoff && x.native_id);
  if (!fresh.length) return { stored: 0 };
  const ids = fresh.map((x) => `${account.platform}:${x.native_id}`);
  const existing = new Map();
  for (let i = 0; i < ids.length; i += 50) {
    const slice = ids.slice(i, i + 50);
    const rows = await all(env, `SELECT id, first_seen_at, e, seen_at FROM posts WHERE id IN (${slice.map(() => "?").join(",")})`, ...slice);
    for (const r of rows) existing.set(r.id, r);
  }
  const stmts = [];
  let newCount = 0;
  for (const x of fresh) {
    const id = `${account.platform}:${x.native_id}`;
    const e = engagement(account.platform, x);
    const prior = existing.get(id);
    const firstSeen = prior ? prior.first_seen_at : now;
    if (!prior) newCount++;
    const t = terms(x.text);
    stmts.push(
      env.DB.prepare(
        `INSERT INTO posts (id, account_id, platform, url, text, media_type, posted_at, first_seen_at, seen_at,
           likes, comments, shares, views, saves, quotes, e, terms, hook, is_repost, raw)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)
         ON CONFLICT (id) DO UPDATE SET url = excluded.url, text = excluded.text, media_type = excluded.media_type,
           seen_at = excluded.seen_at, likes = excluded.likes, comments = excluded.comments, shares = excluded.shares,
           views = excluded.views, saves = excluded.saves, quotes = excluded.quotes, e = excluded.e,
           terms = excluded.terms, hook = excluded.hook, is_repost = excluded.is_repost`,
      ).bind(
        id, account.id, account.platform, x.url || null, String(x.text || "").slice(0, 4000), x.media_type || "text",
        x.posted_at, firstSeen, now, x.likes || 0, x.comments || 0, x.shares || 0, x.views || 0, x.saves || 0, x.quotes || 0,
        e, j(t), j(hook(x.text)), x.is_repost ? 1 : 0,
      ),
    );
    // A snapshot only when the number moved, so the trail stays small.
    if (!prior || Math.abs((prior.e || 0) - e) > 0.5 || now - prior.seen_at > 6 * 3600000) {
      stmts.push(
        env.DB.prepare("INSERT OR REPLACE INTO snapshots (post_id, at, e, likes, comments, shares, views) VALUES (?, ?, ?, ?, ?, ?, ?)").bind(
          id, now, e, x.likes || 0, x.comments || 0, x.shares || 0, x.views || 0,
        ),
      );
    }
  }
  await batch(env, stmts);
  return { stored: fresh.length, new: newCount };
}

export async function markPolled(env, account, { error, profile } = {}) {
  await run(
    env,
    `UPDATE accounts SET polled_at = ?, last_error = ?, followers = COALESCE(?, followers), display = COALESCE(?, display),
       native_id = COALESCE(?, native_id) WHERE id = ?`,
    Date.now(), error ? String(error).slice(0, 300) : null, profile?.followers ?? null, profile?.display ?? null, profile?.native_id ?? null, account.id,
  );
}

const COLLECTORS = { instagram: collectInstagram, telegram: collectTelegram, bluesky: collectBluesky, reddit: collectReddit };

// Poll the accounts that are due. Instagram is polled hourly (Meta's rate limit is 200 calls an hour
// per token); the open platforms every 20 minutes. X and Reddit are pushed from the Mac (Reddit refuses
// cloud IPs), so they are never polled from here.
export async function collectDue(env, { budgetMs = 40000, max = 40 } = {}) {
  const now = Date.now();
  const due = await all(
    env,
    `SELECT * FROM accounts WHERE active = 1 AND platform NOT IN ('x', 'reddit')
       AND (polled_at IS NULL OR polled_at < CASE WHEN platform = 'instagram' THEN ? ELSE ? END)
     ORDER BY polled_at IS NOT NULL, polled_at LIMIT ?`,
    now - 55 * 60000, now - 20 * 60000, max,
  );
  const started = Date.now();
  const log = { polled: 0, stored: 0, new: 0, failed: 0, errors: [] };
  for (const account of due) {
    if (Date.now() - started > budgetMs) break;
    const collector = COLLECTORS[account.platform];
    if (!collector) continue;
    try {
      const result = await collector(env, account);
      const posts = Array.isArray(result) ? result : result.posts;
      const r = await storePosts(env, account, posts);
      await markPolled(env, account, { profile: Array.isArray(result) ? undefined : result.profile });
      log.polled++;
      log.stored += r.stored;
      log.new += r.new || 0;
    } catch (err) {
      log.failed++;
      log.errors.push(`${account.id}: ${err.message}`);
      await markPolled(env, account, { error: err.message });
    }
  }
  return log;
}
