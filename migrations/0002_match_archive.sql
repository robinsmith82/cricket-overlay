-- D1 match archive: promote completed matches out of KV (which is volatile and
-- per-key) into a queryable relational store. One match = one batch transaction
-- across these four tables. All inserts are INSERT OR REPLACE so the archive
-- step is idempotent and can be retried safely.

CREATE TABLE IF NOT EXISTS matches (
  match_id      TEXT PRIMARY KEY,
  scope         TEXT NOT NULL DEFAULT '',
  home_team     TEXT,
  away_team     TEXT,
  status        TEXT,
  source_url    TEXT,
  archived_at   INTEGER NOT NULL,
  total_events  INTEGER NOT NULL DEFAULT 0,
  total_balls   INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS matches_archived_at ON matches(archived_at DESC);

CREATE TABLE IF NOT EXISTS innings (
  match_id      TEXT NOT NULL,
  innings       INTEGER NOT NULL,
  batting_team  TEXT,
  runs          INTEGER,
  wickets       INTEGER,
  overs         TEXT,
  status        TEXT,
  PRIMARY KEY (match_id, innings)
);

CREATE TABLE IF NOT EXISTS balls (
  match_id   TEXT NOT NULL,
  innings    INTEGER NOT NULL,
  over_num   INTEGER NOT NULL,
  ball_num   INTEGER NOT NULL,
  zone       INTEGER,
  shot       TEXT,
  tagged_at  INTEGER,
  PRIMARY KEY (match_id, innings, over_num, ball_num)
);

CREATE INDEX IF NOT EXISTS balls_lookup ON balls(match_id, innings, over_num, ball_num);

CREATE TABLE IF NOT EXISTS events (
  match_id  TEXT NOT NULL,
  idx       INTEGER NOT NULL,
  type      TEXT NOT NULL,
  innings   INTEGER,
  over      TEXT,
  batter    TEXT,
  bowler    TEXT,
  runs      INTEGER,
  context   TEXT,
  ts        INTEGER,
  PRIMARY KEY (match_id, idx)
);

CREATE INDEX IF NOT EXISTS events_match_idx ON events(match_id, idx);
