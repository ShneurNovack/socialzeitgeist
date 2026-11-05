# socialzeitgeist

What the Jewish social internet is doing right now, read for Meaningful Minute. A Cloudflare Worker (D1, cron, MCP) that watches a chosen set of accounts on Instagram, X, Telegram, Bluesky and Reddit and reads every post against that account's own normal. It is the social-only successor to the news-based Jewish Zeitgeist app, with a different engine; `docs/ENGINE.md` explains the readings.

GitHub pushes to `main` deploy automatically through Cloudflare Workers Builds.

## What it answers

- What is moving right now across the accounts that matter to MM, as moments (several accounts on the same thing inside 72 hours), ranked by heat, direction and MM fit.
- Which single posts are out-performing their own account most, and which are gaining fastest right now.
- Which formats and openers are beating normal this week versus last week across the peer set.
- Where MM has a gap: subjects MM's own two-year history likes that MM has not posted.
- How any idea would do, against MM's history and the live moments.

## Sources and how they are read

| Platform | How | Notes |
|---|---|---|
| Instagram | Meta's official Graph API | Other accounts via Business Discovery with this Worker's own Meta app and a Facebook-Login token (any professional account Zami admins through a Page); MM's own posts via the `instagrammcp` Worker. Professional accounts only. Polled hourly, inside Meta's 200 calls/hour. |
| X | `scripts/home_collector.py` on the Mac, pushed to `/ingest/x` | twscrape with a burner account's cookies (saved on the setup page, pulled by the Mac), reads only. Never a real account. |
| Telegram | public channel preview (`t.me/s/<channel>`) | views only |
| Bluesky | public AppView API | no login |
| Reddit | official API, app-only OAuth (script app id and secret on the setup page) | subreddit listings, read only |

## Setup

1. Create the D1 database and apply `migrations/0001_init.sql` (`wrangler d1 migrations apply socialzeitgeist`).
2. Secrets on the Worker: `SZ_KEY` (guards the MCP endpoint, the setup page, the push and admin routes), `ENCRYPTION_KEY` (encrypts the Meta app secret, the Page token and the X cookies in D1), `IG_MCP_TOKEN` (the instagrammcp key, for MM's own posts). `IG_MCP_URL` is a plain var in `wrangler.toml`; instagrammcp is reached through a service binding.
3. Import MM's history: `POST /admin/import-mm` with the JSON array exported from the old app's `MMPost` entity (header `x-sz-key`).
4. Everything else is on the setup page, `/setup?key=<SZ_KEY>`: the Meta app (its own app, Facebook Login for Business, redirect `/auth/callback`), the Facebook login that enables Business Discovery, the X burner cookies, the Mac collector one-liner, and the accounts to watch. The `sz_track` tool manages accounts from a chat too.
5. Add `https://socialzeitgeist.shneur.workers.dev/?bearer_token=<SZ_KEY>` as a custom connector in Claude.

## The app

`/app?key=<SZ_KEY>` is the web app (the key is kept in the browser after the first open): Now (the one-screen brief), Moments, Posts, Accounts, Formats, MM, Test, plus the setup page. It is built on the Canva UI kit from `canva-ui-guide` (`src/ui/tokens.css`, `base.css`, `components.css`, unchanged) with our own brand colors in `src/ui/app.css`. The app calls the same tools as the MCP through `POST /api/tool`.

## Routes

- `POST /?bearer_token=<SZ_KEY>`: MCP (tools `sz_now`, `sz_moments`, `sz_moment`, `sz_posts`, `sz_post`, `sz_accounts`, `sz_track`, `sz_formats`, `sz_test_idea`, `sz_mm`, `sz_feedback`, `sz_engine`)
- `POST /ingest/x`: posts pushed from the Mac (`x-sz-key` header)
- `POST /admin/import-mm`, `POST /admin/run`, `POST /admin/sql` (select only): admin, same header
- `GET /health`

## Policy notes

Instagram is read only through Meta's official Graph API with the account's own permissions, which is what Business Discovery exists for. Nothing scrapes Instagram, nothing logs in to Instagram outside Meta's own login, and nothing is posted by this Worker. X is read through a burner account on the Mac, which is against X's terms for that burner and exposes nothing else. Telegram, Bluesky and Reddit are public reads of what those platforms publish openly.
