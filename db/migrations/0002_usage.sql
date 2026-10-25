-- Usage counter: one row per finished run, numbers only.
--
-- Apply to the existing database once (the name is in Cloudflare -> D1):
--   npx wrangler d1 execute <database-name> --remote --file=db/migrations/0002_usage.sql
-- A fresh database gets the same table from db/schema.sql; tools/test/test_usage.mjs
-- fails if the two copies of this statement drift apart.
--
-- What is deliberately not here: file names, artists, titles, genres, paths,
-- IP addresses. A row says that someone ran the app over N tracks, never what
-- the tracks were. Nothing in it can be joined back to a library.
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
