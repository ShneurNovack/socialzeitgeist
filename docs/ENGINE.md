# The engine

Social Zeitgeist is built on one idea: attention on social media is only readable relative to who is getting it. A thousand likes is a big day for a small account and a quiet one for a big account, so nothing here is scored in absolute numbers. Every post is read against its own account, and a moment is only ever a thing several accounts did at the same time. There is no topic map, no story clustering of headlines, no article reading, no language model in the loop. Those were the old app's machinery for organizing a news feed, and this is not a news feed.

## Objects

**Accounts** are the unit of attention. Each has a platform, a handle, a category (`self` for MM, `peer` for accounts like MM, `big`, `niche`, `news`, `creator`, `org`) and a weight from 0.2 to 2 that says how much that account's attention counts when moments are scored. Adding an account is how the system learns a new corner of the internet; the list is meant to be curated, not large.

**Posts** are kept for 60 days with their latest metrics, their key terms, and a hook reading (how the first line opens). **Snapshots** keep the metric trail for the first days, so the engine can see pace, not only totals.

**Moments** are what several accounts posted about inside 72 hours. They have a heat, a direction, a carrier post, a best format, and MM readings.

**MM posts** are Meaningful Minute's own history: 3,377 posts from September 2024 to October 2026 imported from the old app, each with its result percentile `y` (within format and season, as the old analyst computed it), plus MM's live posts read from the account.

## Readings

### 1. Outperformance (`ratio`, `z`)

For each account and format, the baseline is the median of `log(1 + E)` over the account's matured posts (older than 48 hours) in the last 45 days, with a robust spread (MAD). Formats with fewer than five matured posts pool with the account's other posts, and young accounts use their young posts scaled up to maturity. `E` is one engagement number per platform: Instagram `likes + 3 comments` (views are not readable for other accounts), X and Bluesky `likes + 2 reposts + 2 quotes + replies`, Reddit `score + 2 comments`, Telegram `views / 20`.

Engagement arrives over time, so a post is compared with what the account would normally have *at that age*: `expected = baseline × f(age)`, where `f` is a saturating curve with a platform time constant (Instagram 10 hours, X and Bluesky 4, Telegram 8, Reddit 6), normalized to 1 at 48 hours. `ratio = (1 + E) / (1 + expected)` and `z = log(ratio) / (MAD + 0.25)`. A ratio of 1.0 is normal for that account; 3.0 is three times its normal.

### 2. Velocity

From the snapshot trail: engagement gained per hour over the last window of at least 20 minutes, divided by the pace the account normally has at that age (the derivative of the same curve). A velocity of 2 means the post is gaining twice as fast as this account's posts usually do at this point. Only posts under 48 hours old get one.

### 3. Moments

Posts from the last 72 hours are linked when they share something that can carry a link: a multi-word name ("Hebrew University", "Ziv Abud") links two posts on its own; single words only link in combination, however rare, so one odd token or a common Hebrew word never makes a moment by itself; a close enough idf-weighted cosine also links. Two posts from the same account never link each other, because a moment needs more than one voice. Connected groups with at least two accounts become moments; the rest stay single posts, which still show up in the out-performer and pace lists.

Heat is the sum over the moment's posts of `weight × max(0, 0.6 + log2(ratio)) × 0.5^(age/24h)`, times the square root of the number of accounts. The floor means merely being posted by a tracked account counts a little; out-performing counts a lot; a repost counts 40%. Direction compares heat with the previous run (rising above +15%, cooling once below 60% of the peak). The carrier is the post with the highest `z + velocity/2`, and the best format is the one whose posts in the moment have the highest median ratio.

Moments keep their id across runs when at least half of the smaller side's posts overlap, so feedback and coverage stay attached as the moment grows.

### 4. MM fit and gap

Terms are weighted by inverse document frequency over the live posts (last 30 days) and MM's history. A moment's term vector is compared by cosine with every MM post; the fit is the result-percentile `y` of the closest posts, weighted by `cosine^3`, with collab posts excluded (they count for coverage only, never for performance). If the closest MM post with cosine 0.45 or more is under 10 days old, or MM's live account posted something close in the last 10 days, the moment is marked covered.

The ranking used by the brief is `heat × (0.5 + fit) × direction × covered`, where direction is 1.15 for new or rising, 0.65 for cooling, and covered is 0.35 within four days of an MM post. A **gap** is a live moment with fit of 0.55 or more that MM has not covered in a week.

### Format pulse

Across the peer set (everything but `self`), for each platform and format: the median ratio of this week's posts versus last week's. And for each opener trait (question, number, all caps, quote, emoji lead): the median ratio with the trait versus without, this week. These are about writing, so they inform how to post, not what.

### Idea tester

Any text gets the same two readings as a moment: MM fit with the closest past posts, and which live moments it rides (idf-weighted overlap with each moment's shared terms). The verdict is a small table over those two.

## Cadence and limits

The cron runs every ten minutes: collect what is due (Instagram hourly to stay inside Meta's 200 calls per hour per token; the open platforms every 20 minutes; X and Reddit arrive by push from the Mac every 15 minutes), refresh term frequencies, read every post of the last 7 days, rebuild moments, score them, write the brief. Snapshots are kept 21 days, posts 60, archived moments 30.

## What would make it better

- Learned age curves per platform from the snapshot trail instead of fixed time constants.
- Follower-aware weighting so a small peer out-performing counts more than a giant drifting.
- A naming pass (one small language-model call per run) to give moments English labels when the shared terms are Hebrew.
- Threads, once the official Threads API is set up on a Meta app (the keyword search and profile lookup endpoints need App Review).
- MM's live posts folded into the history with a result percentile computed here, so the fit reading keeps learning after October 2026.
