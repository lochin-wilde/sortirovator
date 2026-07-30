-- Genre corrections collected from testers. Run once in the D1 console.
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
