#!/usr/bin/env python3
"""Home collector for Social Zeitgeist.

Runs on Zami's Mac (a home IP), reads the platforms the Worker cannot read from the cloud, and
pushes normalized posts to the Worker's /ingest/x endpoint.

  X:      through twscrape, with a BURNER account's cookies only. Never a real MM or personal account.
          twscrape talks to X's internal API the way the web app does; X's terms don't allow it, so the
          only account exposed to a suspension is the burner. Reads only, nothing is ever posted.
  Reddit: the public listing JSON, which Reddit refuses to cloud IPs but serves to a home connection.

Config lives in ~/.socialzeitgeist/config.json:
  {
    "endpoint": "https://socialzeitgeist.shneur.workers.dev",
    "key": "<SZ_KEY>",
    "x_accounts": ["handle1", "handle2"],      # handles to read
    "x_list_id": "1234567890",                  # optional: a private X List to read instead of / as well as handles
    "x_limit": 20,                              # posts per handle per run
    "reddit_subs": ["Judaism", "Israel"]
  }

The twscrape account pool is ~/.socialzeitgeist/accounts.db. Add the burner once with:
  twscrape --db ~/.socialzeitgeist/accounts.db add_accounts burner.txt username:password:email:email_password:cookies
or interactively with `twscrape add_accounts` and then `twscrape login_accounts`. Cookies are the
reliable way: export the burner's cookies (auth_token and ct0) from the browser.

Install: pip3 install twscrape requests
Schedule: see scripts/com.reshape.socialzeitgeist.plist (launchd, every 15 minutes).
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


async def collect_x(cfg):
    from twscrape import API, gather

    api = API(str(HOME / "accounts.db"))
    rows = []
    limit = int(cfg.get("x_limit", 20))
    seen = set()
    if cfg.get("x_list_id"):
        try:
            for t in await gather(api.list_timeline(int(cfg["x_list_id"]), limit=max(limit * 4, 80))):
                if t.id in seen:
                    continue
                seen.add(t.id)
                rows.append(tweet_row(t))
        except Exception as e:
            print(f"list {cfg['x_list_id']}: {e}", file=sys.stderr)
    for handle in cfg.get("x_accounts", []):
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


def collect_reddit(cfg):
    rows = []
    for sub in cfg.get("reddit_subs", []):
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
    rows = []
    if cfg.get("x_accounts") or cfg.get("x_list_id"):
        rows += asyncio.run(collect_x(cfg))
    rows += collect_reddit(cfg)
    result = push(cfg, rows)
    state = load(STATE, {})
    state.update({"last_run": time.strftime("%Y-%m-%dT%H:%M:%S%z"), "pushed": len(rows), "result": result})
    HOME.mkdir(exist_ok=True)
    STATE.write_text(json.dumps(state, indent=1))
    print(json.dumps(state))


if __name__ == "__main__":
    main()
