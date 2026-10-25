-- The whole schema, for a fresh database: run once in the D1 console, or
--   npx wrangler d1 execute <database-name> --remote --file=db/schema.sql
-- An existing database is brought up to date with the files in db/migrations/.

-- Genre corrections collected from testers.
--
-- One row per correction, never updated. The same track corrected twice by the
-- same person produces two rows on purpose: a changed mind is itself a signal,
-- and collapsing them would hide it.
CREATE TABLE IF NOT EXISTS genre_feedback (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  -- When the server stored it. Assigned here rather than taken from the client,
  -- whose clock can be wrong or deliberately set to anything.
  received_at     TEXT NOT NULL,
  -- Which invite code the session was opened with, so a surprising correction
  -- can be discussed with the person who made it.
  invite          TEXT,
  -- When the correction was made in the browser. Kept for ordering within one
  -- batch that was queued offline and sent later.
  made_at         TEXT,
  file            TEXT,
  artist          TEXT,
  title           TEXT,
  -- What the app answered, and which source in the chain produced it. Without
  -- the source a wrong answer says nothing about where to fix it.
  detected        TEXT,
  detected_source TEXT,
  corrected       TEXT NOT NULL,
  bpm             REAL,
  song_key        TEXT
);

-- The two questions asked of this table: which genres get corrected away from
-- most often, and everything one artist was corrected to.
CREATE INDEX IF NOT EXISTS genre_feedback_detected ON genre_feedback (detected);
CREATE INDEX IF NOT EXISTS genre_feedback_artist   ON genre_feedback (artist);


-- Failed attempts at the invite form, one row each, used to rate-limit
-- guessing. Cloudflare's own rate limiting is configured per zone -- per domain
-- you own -- and this deployment answers on a pages.dev address, so there is no
-- zone to attach a rule to.
--
-- Only failures are recorded and a success deletes that address's rows, so this
-- table holds nothing about anyone who signed in normally. Rows outside the
-- window are deleted as later attempts pass through, so it does not grow.
CREATE TABLE IF NOT EXISTS login_attempts (
  ip TEXT NOT NULL,
  -- Unix seconds. An integer rather than a timestamp string because every read
  -- is a comparison against "now minus the window".
  at INTEGER NOT NULL
);

-- The only query made against it: failures from one address inside the window.
CREATE INDEX IF NOT EXISTS login_attempts_ip_at ON login_attempts (ip, at);


-- Usage counter: one row per finished run, numbers only. Same statement as
-- db/migrations/0002_usage.sql, which explains each column.
CREATE TABLE IF NOT EXISTS usage (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  -- When the server stored it, ISO 8601 UTC. Not the client's clock.
  at         TEXT    NOT NULL,
  -- HMAC of the invite label with SESSION_SECRET, cut short. Stable per tester,
  -- meaningless without the secret, and never the label or the code itself.
  pseudonym  TEXT    NOT NULL,
  mode       TEXT    NOT NULL CHECK (mode IN ('files', 'rekordbox')),
  -- library / everything / analyze / genres / custom; NULL for the Rekordbox mode,
  -- which has no presets.
  preset     TEXT,
  tracks     INTEGER NOT NULL,
  succeeded  INTEGER NOT NULL,
  failed     INTEGER NOT NULL,
  seconds    INTEGER NOT NULL,
  version    TEXT    NOT NULL
);

-- Every read is "since some time", and the rate limit is "this tester since some time".
CREATE INDEX IF NOT EXISTS usage_at ON usage (at);
CREATE INDEX IF NOT EXISTS usage_pseudonym_at ON usage (pseudonym, at);
