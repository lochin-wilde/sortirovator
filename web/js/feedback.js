"use strict";
/*
 * feedback.js -- "what genre is this really?" corrections from the user.
 *
 * A correction has to teach something beyond the one track it was made on, or
 * the user is just relabelling files by hand. Two levels are stored:
 *
 *   track   -- this exact recording is X. Always applied, always wins.
 *   artist  -- once the same artist has been corrected to the same genre twice,
 *              that becomes the answer for their other tracks too.
 *
 * The artist rule needs two agreeing corrections deliberately. One correction
 * says something about a track; two say something about the artist. Plenty of
 * artists genuinely span genres, so a single data point is not enough to start
 * overriding the lookups for everything they made.
 *
 * Corrections are kept in localStorage and also sent to /api/feedback, which is
 * how they reach the genre map rather than only the library of whoever made
 * them. Sending is best-effort: see flushFeedback below.
 */

const FEEDBACK_STORAGE_KEY = "sortirovator.genreFeedback";
const FEEDBACK_FORMAT_VERSION = 1;
// How many agreeing corrections make an artist-level rule.
const ARTIST_RULE_THRESHOLD = 2;
const FEEDBACK_ENDPOINT = "/api/feedback";
// Matches MAX_ENTRIES in functions/api/feedback.js, which rejects more.
const FEEDBACK_BATCH_LIMIT = 200;

let feedbackEntries = null;

function feedbackKey(artist, title) {
  const norm = (s) => String(s || "").toLowerCase().replace(/[^\wа-яё\s]/gi, "").replace(/\s+/g, " ").trim();
  return norm(artist) + " " + norm(title);
}

function artistKey(artist) {
  return String(artist || "").toLowerCase().replace(/\s+/g, " ").trim();
}

function loadFeedback() {
  if (feedbackEntries) return feedbackEntries;
  feedbackEntries = [];
  try {
    const raw = localStorage.getItem(FEEDBACK_STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) feedbackEntries = parsed;
    }
  } catch (e) { /* corrupt or unavailable storage is not worth failing over */ }
  return feedbackEntries;
}

function persistFeedback() {
  try {
    localStorage.setItem(FEEDBACK_STORAGE_KEY, JSON.stringify(feedbackEntries || []));
  } catch (e) { /* private browsing, or quota — the correction still applies this session */ }
}

/*
 * The record a server would receive. Everything needed to learn from the
 * correction without the audio: what was detected, which source said so, and
 * what the analysis measured. The filename is included because it is often the
 * only clue to a release that no database knows.
 */
function buildFeedbackEntry(result, correctedGenre) {
  return {
    v: FEEDBACK_FORMAT_VERSION,
    at: new Date().toISOString(),
    file: result.name || null,
    artist: result.feedbackArtist || null,
    title: result.feedbackTitle || null,
    detected: result.genre || null,
    detectedSource: result.genreSource || null,
    corrected: correctedGenre,
    bpm: result.bpm !== undefined ? result.bpm : null,
    key: result.key || null,
  };
}

function recordGenreCorrection(result, correctedGenre) {
  const entries = loadFeedback();
  const key = feedbackKey(result.feedbackArtist, result.feedbackTitle);
  const entry = buildFeedbackEntry(result, correctedGenre);

  // One correction per track: a later answer replaces an earlier one.
  const existing = entries.findIndex(
    (e) => feedbackKey(e.artist, e.title) === key && key !== " ");
  if (existing >= 0) entries[existing] = entry;
  else entries.push(entry);

  persistFeedback();
  submitFeedback(entry);
  return entry;
}

/*
 * Sends everything not yet acknowledged by the server, oldest first.
 *
 * Every correction carries a `sent` flag, and only an acknowledgement clears
 * it. That makes an interrupted send harmless: the entry stays queued and goes
 * out with the next one, or on the next visit. The alternative -- treating a
 * dispatched request as delivered -- loses corrections silently on a dropped
 * connection, which is the failure this is most likely to meet, since the app
 * is used on laptops in places with unreliable wifi.
 *
 * Nothing here is allowed to interrupt a batch. A correction is made in the
 * middle of reviewing results, and a failed request must not produce an error
 * dialog, a thrown exception, or a lost correction -- the local copy is already
 * saved and already being applied, so the send failing costs nothing today.
 * Hence the catch that only logs, and hence no retry loop.
 *
 * Entries stored before this existed have no `sent` flag and are treated as
 * unsent, so corrections made during the closed test are not stranded.
 */
let _flushInFlight = null;

function flushFeedback() {
  if (_flushInFlight) return _flushInFlight;

  const entries = loadFeedback();
  const pending = entries.filter((e) => !e.sent).slice(0, FEEDBACK_BATCH_LIMIT);
  if (pending.length === 0) return Promise.resolve({ sent: 0 });

  // `sent` is ours, not the server's business; it would be stored as an unused
  // column and read as if it meant something there.
  const payload = pending.map(({ sent, ...rest }) => rest);

  _flushInFlight = fetch(FEEDBACK_ENDPOINT, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
    // The session cookie is what identifies the tester; without it the gate
    // answers with the login page and nothing is stored.
    credentials: "same-origin",
  })
    .then((response) => {
      if (!response.ok) throw new Error("HTTP " + response.status);
      for (const entry of pending) entry.sent = true;
      persistFeedback();
      if (typeof log === "function") {
        log(t("feedback.sent", { count: pending.length }));
      }
      return { sent: pending.length };
    })
    .catch((error) => {
      if (typeof log === "function") {
        log(t("feedback.sendFailed", { count: pending.length }));
      }
      return { sent: 0, error: String(error) };
    })
    .finally(() => {
      _flushInFlight = null;
    });

  return _flushInFlight;
}

function submitFeedback(entry) {
  entry.sent = false;
  return flushFeedback();
}

/*
 * Looks up what the user has already said about this track or artist.
 * Returns { genre, scope } or null.
 */
function correctionFor(artist, title) {
  const entries = loadFeedback();
  if (entries.length === 0) return null;

  const key = feedbackKey(artist, title);
  for (const entry of entries) {
    if (key !== " " && feedbackKey(entry.artist, entry.title) === key) {
      return { genre: entry.corrected, scope: "track" };
    }
  }

  const wanted = artistKey(artist);
  if (!wanted) return null;
  const votes = {};
  for (const entry of entries) {
    if (artistKey(entry.artist) !== wanted) continue;
    votes[entry.corrected] = (votes[entry.corrected] || 0) + 1;
  }
  let best = null;
  for (const [genre, count] of Object.entries(votes)) {
    if (count >= ARTIST_RULE_THRESHOLD && (!best || count > best.count)) {
      best = { genre, count };
    }
  }
  return best ? { genre: best.genre, scope: "artist" } : null;
}

function feedbackCount() {
  return loadFeedback().length;
}

function exportFeedback() {
  return JSON.stringify(loadFeedback(), null, 1);
}

function clearFeedback() {
  feedbackEntries = [];
  persistFeedback();
}

/*
 * Every genre the app can sort into, for the correction dropdown. Read from the
 * loaded map so a category added there shows up here without a second edit.
 */
function knownGenres(genresMap) {
  const seen = new Set(Object.values(genresMap || {}));
  seen.add("Unknown");
  return Array.from(seen).sort();
}
