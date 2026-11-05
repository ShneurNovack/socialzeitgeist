-- Social Zeitgeist: what the Jewish social internet is doing right now, read for Meaningful Minute.

CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

-- The accounts we watch. id is platform:handle (lowercase).
CREATE TABLE IF NOT EXISTS accounts (
  id TEXT PRIMARY KEY,
  platform TEXT NOT NULL,            -- instagram | x | telegram | bluesky | reddit | threads
  handle TEXT NOT NULL,
  native_id TEXT,
  display TEXT,
  category TEXT NOT NULL DEFAULT 'peer',  -- self | peer | big | niche | news | creator | org
  weight REAL NOT NULL DEFAULT 1.0,       -- how much this account's attention counts (0.2 .. 2)
  followers INTEGER,
  active INTEGER NOT NULL DEFAULT 1,
  added_at INTEGER NOT NULL,
  polled_at INTEGER,
  last_error TEXT,
  baseline TEXT,                      -- JSON: per media_type {med, mad, n, rate24} on log(1+E)
  note TEXT
);
CREATE INDEX IF NOT EXISTS accounts_platform ON accounts (platform, active);

-- One row per post we have seen. Metrics are the latest reading; snapshots keep the trail.
CREATE TABLE IF NOT EXISTS posts (
  id TEXT PRIMARY KEY,               -- platform:native_id
  account_id TEXT NOT NULL,
  platform TEXT NOT NULL,
  url TEXT,
  text TEXT,
  media_type TEXT NOT NULL DEFAULT 'text',  -- reel | carousel | image | video | text | link
  posted_at INTEGER NOT NULL,
  first_seen_at INTEGER NOT NULL,
  seen_at INTEGER NOT NULL,
  likes INTEGER NOT NULL DEFAULT 0,
  comments INTEGER NOT NULL DEFAULT 0,
  shares INTEGER NOT NULL DEFAULT 0,  -- reposts, retweets, forwards
  views INTEGER NOT NULL DEFAULT 0,
  saves INTEGER NOT NULL DEFAULT 0,
  quotes INTEGER NOT NULL DEFAULT 0,
  e REAL NOT NULL DEFAULT 0,          -- engagement, platform-normalized
  ratio REAL,                         -- e against the account's baseline at this age (1 = normal)
  z REAL,                             -- robust z of log ratio
  velocity REAL,                      -- engagement gained per hour over the last window, as a multiple of normal
  moment_id TEXT,
  terms TEXT,                         -- JSON array of key terms
  hook TEXT,                          -- JSON: {opener, has_number, caps, question, length}
  is_repost INTEGER NOT NULL DEFAULT 0,
  raw TEXT
);
CREATE INDEX IF NOT EXISTS posts_account_time ON posts (account_id, posted_at);
CREATE INDEX IF NOT EXISTS posts_time ON posts (posted_at);
CREATE INDEX IF NOT EXISTS posts_moment ON posts (moment_id);

CREATE TABLE IF NOT EXISTS snapshots (
  post_id TEXT NOT NULL,
  at INTEGER NOT NULL,
  e REAL NOT NULL,
  likes INTEGER NOT NULL DEFAULT 0,
  comments INTEGER NOT NULL DEFAULT 0,
  shares INTEGER NOT NULL DEFAULT 0,
  views INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (post_id, at)
);

-- A moment: several tracked accounts posting about the same thing in the same window.
CREATE TABLE IF NOT EXISTS moments (
  id TEXT PRIMARY KEY,
  label TEXT NOT NULL,
  terms TEXT NOT NULL,                -- JSON array of the shared key terms
  first_at INTEGER NOT NULL,
  last_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  n_posts INTEGER NOT NULL DEFAULT 0,
  n_accounts INTEGER NOT NULL DEFAULT 0,
  platforms TEXT,                     -- JSON array
  heat REAL NOT NULL DEFAULT 0,
  heat_prev REAL NOT NULL DEFAULT 0,  -- heat at the previous run, for direction
  peak_heat REAL NOT NULL DEFAULT 0,
  state TEXT NOT NULL DEFAULT 'new',  -- new | rising | peak | cooling | gone
  carrier_post_id TEXT,               -- the post that carries it best
  best_format TEXT,
  mm_fit REAL,                        -- 0..1, from MM's own history
  mm_covered_at INTEGER,              -- when MM last posted about it, if it did
  mm_match TEXT,                      -- JSON: the closest MM posts
  why TEXT,                           -- one line, written by the engine
  score REAL NOT NULL DEFAULT 0,      -- the ranking used by the brief
  archived INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS moments_live ON moments (archived, score);

-- Meaningful Minute's own posts, imported from the old app and kept current from the account.
CREATE TABLE IF NOT EXISTS mm_posts (
  ext_id TEXT PRIMARY KEY,
  url TEXT,
  caption TEXT,
  format TEXT,                        -- reel | carousel | image | podcast
  source TEXT,                        -- import | collab | live
  posted_at INTEGER NOT NULL,
  likes INTEGER DEFAULT 0,
  comments INTEGER DEFAULT 0,
  views INTEGER DEFAULT 0,
  saves INTEGER DEFAULT 0,
  shares INTEGER DEFAULT 0,
  reach INTEGER DEFAULT 0,
  y REAL,                             -- percentile within format and season (0..1), from the old analyst
  yv REAL,                            -- same on views
  high INTEGER,
  terms TEXT
);
CREATE INDEX IF NOT EXISTS mm_posts_time ON mm_posts (posted_at);

-- Term document frequencies over the live window, for rarity.
CREATE TABLE IF NOT EXISTS term_df (
  term TEXT PRIMARY KEY,
  df INTEGER NOT NULL,
  mm_df INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS feedback (
  id TEXT PRIMARY KEY,
  at INTEGER NOT NULL,
  moment_id TEXT,
  post_id TEXT,
  value TEXT NOT NULL,                -- posted | liked | passed
  note TEXT
);

CREATE TABLE IF NOT EXISTS runs (
  at INTEGER NOT NULL,
  stage TEXT NOT NULL,
  status TEXT NOT NULL,
  message TEXT,
  ms INTEGER
);
CREATE INDEX IF NOT EXISTS runs_time ON runs (at);

CREATE TABLE IF NOT EXISTS briefs (
  at INTEGER PRIMARY KEY,
  body TEXT NOT NULL
);
