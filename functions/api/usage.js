/*
 * Counts use of the app: one row per finished run, numbers only.
 *
 * The question it answers is "is anyone using this, and how much" -- how many
 * testers, how many runs, how many tracks. It is not a log of what they
 * processed, and the shape of the record is what keeps it that way: an allowed
 * list of fields, each a number, a version string or a word from a fixed set.
 * Anything else in the body -- a file name, an artist, a genre -- is dropped
 * before the insert is built, so it cannot reach the table even by mistake on
 * the client's side. The IP address is not read at all.
 *
 * Who is counted
 * --------------
 * By a pseudonym: an HMAC of the invite label, keyed with SESSION_SECRET and
 * cut to PSEUDONYM_CHARS. The session carries the label, not the code -- the
 * code is checked once at sign-in and never stored -- so the label is what is
 * available here. The pseudonym tells two testers apart and the same tester
 * across runs; without the secret it cannot be turned back into the label.
 *
 * Failure
 * -------
 * The client sends this after a run and never waits for the answer, so every
 * failure here is silent to the user. That is the right direction: a lost
 * count costs nothing, an error in the middle of someone's batch costs trust.
 *
 * Deploy: same D1 binding as /api/feedback (DB), plus the usage table from
 * db/migrations/0002_usage.sql.
 */

const MAX_BODY_BYTES = 2048;
// Well past any real library; a number above it is a bug or a forgery.
const MAX_TRACKS = 100000;
const MAX_SECONDS = 24 * 60 * 60;
const MODES = ["files", "rekordbox"];
// Mirrors PRESETS in web/js/views.js, plus "custom" for the user's own mix.
const PRESETS = ["library", "everything", "analyze", "genres", "custom"];
const VERSION_PATTERN = /^\d{4}\.\d{2}\.\d{2}\.\d{1,3}$/;
const PSEUDONYM_CHARS = 10;

/*
 * A real run takes seconds at the very least, so thirty in ten minutes from one
 * tester is already far beyond use. The limit is per pseudonym rather than per
 * address because the address is the one thing this file promises not to read.
 */
const RATE_WINDOW_SECONDS = 10 * 60;
const RATE_MAX_RUNS = 30;

const encoder = new TextEncoder();

function json(body, status) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" },
  });
}

async function pseudonymFor(secret, label) {
  const key = await crypto.subtle.importKey(
    "raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  // Prefixed so this HMAC can never coincide with the session signature, which
  // is made with the same secret over a different message.
  const mac = new Uint8Array(await crypto.subtle.sign("HMAC", key, encoder.encode("usage:" + label)));
  let binary = "";
  for (const b of mac) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "").slice(0, PSEUDONYM_CHARS);
}

function count(value) {
  return Number.isInteger(value) && value >= 0 && value <= MAX_TRACKS ? value : null;
}

/*
 * The record as it will be stored, or null if the body is not one.
 *
 * Built field by field from an allowed list rather than by copying the body and
 * deleting what is unwanted: a field nobody thought to delete is a field that
 * gets stored. Types are checked strictly -- "12" is not 12 -- because the
 * only legitimate sender is our own client, which sends numbers.
 */
function usageRecord(body) {
  if (!body || typeof body !== "object" || Array.isArray(body)) return null;

  const mode = MODES.includes(body.mode) ? body.mode : null;
  if (!mode) return null;
  // The Rekordbox mode has no presets; anything sent for it is ignored.
  let preset = null;
  if (mode === "files") {
    preset = PRESETS.includes(body.preset) ? body.preset : null;
    if (!preset) return null;
  }

  const tracks = count(body.tracks);
  const succeeded = count(body.succeeded);
  const failed = count(body.failed);
  if (tracks === null || succeeded === null || failed === null) return null;
  if (tracks === 0 || succeeded + failed > tracks) return null;

  const seconds = Number.isFinite(body.seconds) && body.seconds >= 0 && body.seconds <= MAX_SECONDS
    ? Math.round(body.seconds) : null;
  if (seconds === null) return null;

  const version = typeof body.version === "string" && VERSION_PATTERN.test(body.version)
    ? body.version : null;
  if (!version) return null;

  return { mode, preset, tracks, succeeded, failed, seconds, version };
}

export async function onRequest(context) {
  const { request, env, data } = context;

  if (request.method !== "POST") return json({ error: "method not allowed" }, 405);
  // The middleware refuses to run without the secret, so this is belt and braces.
  if (!env.SESSION_SECRET) return json({ error: "not configured" }, 503);
  if (!env.DB) return json({ error: "storage not configured" }, 503);

  const declared = Number(request.headers.get("Content-Length"));
  if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) {
    return json({ error: "payload too large" }, 413);
  }
  let body;
  try {
    const raw = await request.text();
    if (raw.length > MAX_BODY_BYTES) return json({ error: "payload too large" }, 413);
    body = JSON.parse(raw);
  } catch (e) {
    return json({ error: "malformed json" }, 400);
  }

  const record = usageRecord(body);
  if (!record) return json({ error: "invalid record" }, 400);

  const pseudonym = await pseudonymFor(env.SESSION_SECRET, (data && data.invite) || "");
  const now = new Date();
  const since = new Date(now.getTime() - RATE_WINDOW_SECONDS * 1000).toISOString();

  try {
    const recent = await env.DB
      .prepare("SELECT COUNT(*) AS runs FROM usage WHERE pseudonym = ? AND at > ?")
      .bind(pseudonym, since)
      .first();
    if (recent && recent.runs >= RATE_MAX_RUNS) {
      return json({ error: "too many runs" }, 429);
    }
    await env.DB
      .prepare(
        `INSERT INTO usage (at, pseudonym, mode, preset, tracks, succeeded, failed, seconds, version)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .bind(now.toISOString(), pseudonym, record.mode, record.preset, record.tracks,
        record.succeeded, record.failed, record.seconds, record.version)
      .run();
  } catch (e) {
    return json({ error: "write failed" }, 500);
  }

  return json({ stored: 1 }, 200);
}
