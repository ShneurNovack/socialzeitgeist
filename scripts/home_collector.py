#!/usr/bin/env python3
"""Home collector for Social Zeitgeist.

Runs on Zami's Mac (a home IP), reads the platforms the Worker cannot read from the cloud, and
pushes normalized posts to the Worker's /ingest/x endpoint.

  X:      through twscrape, with a BURNER account's cookies only. Never a real MM or personal account.
          twscrape talks to X's internal API the way the web app does; X's terms don't allow it, so the
          only account exposed to a suspension is the burner. Reads only, nothing is ever posted.
  Reddit: the public listing JSON, which Reddit refuses to cloud IPs but serves to a home connection.

The only thing on the Mac is ~/.socialzeitgeist/config.json:
  { "endpoint": "https://socialzeitgeist.shneur.workers.dev", "key": "<SZ_KEY>" }

Everything else (the burner's cookies, the X handles and List, the subreddits) is set on the Worker's
setup page and pulled from GET /home/config on every run. The burner is kept in a twscrape pool at
~/.socialzeitgeist/accounts.db and re-added whenever the cookies on the Worker change.

Install: the one-liner on the setup page (it also loads the launchd job, every 15 minutes).
"""

import asyncio
import json
import os
import sys
import time
from pathlib import Path

import requests

HOME = Path.home() / ".socialzeitgeist"
CONFIG = HOME / "config.json"
STATE = HOME / "state.json"
UA = "socialzeitgeist-home/1.0 (private research tool)"


def load(path, default):
    try:
        return json.loads(path.read_text())
    except Exception:
        return default


def push(cfg, posts):
    if not posts:
        return {"received": 0}
    r = requests.post(
        cfg["endpoint"].rstrip("/") + "/ingest/x",
        json={"posts": posts},
        headers={"x-sz-key": cfg["key"], "content-type": "application/json"},
        timeout=60,
    )
    r.raise_for_status()
    return r.json()


def media_type(tweet):
    m = getattr(tweet, "media", None)
    if not m:
        return "text"
    if getattr(m, "videos", None) or getattr(m, "animated", None):
        return "video"
    if getattr(m, "photos", None):
        return "image"
    return "text"


def tweet_row(t, platform="x"):
    u = t.user
    rt = getattr(t, "retweetedTweet", None)
    return {
        "platform": platform,
        "username": u.username,
        "display_name": u.displayname,
        "followers": getattr(u, "followersCount", None),
        "id": str(t.id),
        "url": t.url,
        "text": t.rawContent,
        "date": t.date.isoformat(),
        "likes": t.likeCount or 0,
        "retweets": t.retweetCount or 0,
        "replies": t.replyCount or 0,
        "quotes": t.quoteCount or 0,
        "views": t.viewCount or 0,
        "media_type": media_type(t),
        "is_retweet": bool(rt),
    }


def fetch_config(cfg):
    r = requests.get(cfg["endpoint"].rstrip("/") + "/home/config", headers={"x-sz-key": cfg["key"]}, timeout=30)
    r.raise_for_status()
    return r.json()


async def ensure_burner(api, x):
    """Keep the twscrape pool in step with the cookies saved on the Worker."""
    cookies = x.get("cookies") or {}
    if not cookies.get("auth_token") or not cookies.get("ct0"):
        return False
    username = (x.get("username") or "burner").lstrip("@")
    marker = HOME / "burner.fingerprint"
    fp = cookies["auth_token"][-8:] + ":" + cookies["ct0"][-8:]
    if marker.exists() and marker.read_text() == fp:
        return True
    cookie_str = f"auth_token={cookies['auth_token']}; ct0={cookies['ct0']}"
    try:
        await api.pool.delete_accounts(username)
    except Exception:
        pass
    await api.pool.add_account(username, "x", "x@example.com", "x", cookies=cookie_str)
    marker.write_text(fp)
    return True


async def collect_x(x):
    from twscrape import API, gather

    api = API(str(HOME / "accounts.db"))
    if not await ensure_burner(api, x):
        print("no burner cookies on the Worker yet", file=sys.stderr)
        return []
    rows = []
    limit = int(x.get("limit", 20))
    seen = set()
    if x.get("list_id"):
        try:
            for t in await gather(api.list_timeline(int(x["list_id"]), limit=max(limit * 4, 80))):
                if t.id in seen:
                    continue
                seen.add(t.id)
                rows.append(tweet_row(t))
        except Exception as e:
            print(f"list {x['list_id']}: {e}", file=sys.stderr)
    for handle in x.get("accounts", []):
        try:
            user = await api.user_by_login(handle.lstrip("@"))
            if not user:
                print(f"@{handle}: not found", file=sys.stderr)
                continue
            for t in await gather(api.user_tweets(user.id, limit=limit)):
                if t.id in seen:
                    continue
                seen.add(t.id)
                rows.append(tweet_row(t))
            await asyncio.sleep(2)  # gentle pacing
        except Exception as e:
            print(f"@{handle}: {e}", file=sys.stderr)
    return rows


def collect_reddit(subs):
    rows = []
    for sub in subs:
        try:
            r = requests.get(
                f"https://www.reddit.com/r/{sub}/new.json?limit=50&raw_json=1",
                headers={"user-agent": UA, "accept": "application/json"},
                timeout=30,
            )
            r.raise_for_status()
            for child in r.json().get("data", {}).get("children", []):
                d = child["data"]
                if d.get("stickied"):
                    continue
                rows.append(
                    {
                        "platform": "reddit",
                        "username": sub.lower(),
                        "id": d["id"],
                        "url": "https://www.reddit.com" + d["permalink"],
                        "text": "\n".join(x for x in [d.get("title"), d.get("selftext")] if x)[:3000],
                        "date": int(d["created_utc"] * 1000),
                        "likes": max(0, d.get("score", 0)),
                        "replies": d.get("num_comments", 0),
                        "retweets": d.get("num_crossposts", 0),
                        "media_type": "video" if d.get("is_video") else "image" if d.get("post_hint") == "image" else "text" if d.get("is_self") else "link",
                    }
                )
            time.sleep(1.5)
        except Exception as e:
            print(f"r/{sub}: {e}", file=sys.stderr)
    return rows


def main():
    cfg = load(CONFIG, None)
    if not cfg or not cfg.get("endpoint") or not cfg.get("key"):
        print(f"Missing {CONFIG}: needs endpoint and key", file=sys.stderr)
        sys.exit(2)
    remote = fetch_config(cfg)
    rows = []
    x = remote.get("x") or {}
    if x.get("accounts") or x.get("list_id"):
        rows += asyncio.run(collect_x(x))
    rows += collect_reddit((remote.get("reddit") or {}).get("subs", []))
    result = push(cfg, rows)
    state = load(STATE, {})
    state.update({"last_run": time.strftime("%Y-%m-%dT%H:%M:%S%z"), "pushed": len(rows), "result": result})
    HOME.mkdir(exist_ok=True)
    STATE.write_text(json.dumps(state, indent=1))
    print(json.dumps(state))


if __name__ == "__main__":
    main()
