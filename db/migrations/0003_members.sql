-- Who signs in: the name or nickname typed next to the invite code.
--
-- Apply to the existing database once (the name is in Cloudflare -> D1):
--   npx wrangler d1 execute <database-name> --remote --file=db/migrations/0003_members.sql
-- Until it is applied, signing in works as before and nothing is recorded
-- (functions/_middleware.js, recordMember). A fresh database gets the same
-- table from db/schema.sql; tools/test/test_gate.mjs fails if the two drift.
--
-- Asked for now so accounts can later be built on it without asking everyone
-- again. Nothing about tracks or libraries is here, and no addresses.
CREATE TABLE IF NOT EXISTS members (
  -- The label next to the code in INVITE_CODES: who the code was handed to.
  invite    TEXT    NOT NULL,
  -- What the person typed, normalised (cleanName): NFC, single spaces, 2-40 characters.
  name      TEXT    NOT NULL,
  -- ISO 8601 UTC, the server's clock.
  first_at  TEXT    NOT NULL,
  last_at   TEXT    NOT NULL,
  logins    INTEGER NOT NULL DEFAULT 1,
  UNIQUE (invite, name)
);
