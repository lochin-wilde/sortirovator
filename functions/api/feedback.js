/*
 * Receives genre corrections and stores them in D1.
 *
 * A correction is the only thing this project learns from that measurement
 * cannot supply. BPM and key can be checked against Rekordbox; whether a track
 * "is" deep house or afro house is a judgement, and the only source for it is a
 * DJ disagreeing with the answer on a track they know.
 *
 * Deploy
 * ------
 *   1. Create a D1 database (Cloudflare dashboard -> Storage & Databases -> D1).
 *   2. Bind it to the Pages project as `DB` (Settings -> Bindings), for both
 *      Production and Preview.
 *   3. Create the table by running db/schema.sql in the D1 console.
 *
 * Without the binding the endpoint answers 503 and the app keeps corrections
 * locally, which is the same behaviour as before this file existed. That is the
 * deliberate direction to fail in: a correction is worth far less than the batch
 * the user is in the middle of, so nothing here is allowed to interrupt them.
 *
 * Access
 * ------
 * `_middleware.js` runs first and rejects any request without a valid session,
 * so this route is already behind the invite gate and does not check again. It
 * reads `context.data.invite` -- the label the middleware recovered from the
 * verified session -- to record which tester a correction came from, which is
 * what makes it possible to ask them about it afterwards.
 */

// Enough for a large batch of corrections, small enough that a runaway client
// cannot spend the daily write quota in one request.
const MAX_ENTRIES = 200;
const MAX_BODY_BYTES = 256 * 1024;
// Long enough for real filenames and titles; anything longer is a bug or abuse.
const MAX_FIELD_CHARS = 500;

function json(body, status) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" },
  });
}

/*
 * Values arrive from a browser and go into a database, so each one is clamped to
 * a type and a length here rather than trusted. The statements below bind their
 * parameters, so this is not about SQL injection -- it is about a single client
 * being unable to fill the table with megabyte-long strings.
 */
function text(value) {
  if (value === null || value === undefined) return null;
  const s = String(value).trim();
  if (!s) return null;
  return s.length > MAX_FIELD_CHARS ? s.slice(0, MAX_FIELD_CHARS) : s;
}

function number(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

export async function onRequest(context) {
  const { request, env, data } = context;

  if (request.method !== "POST") {
    return json({ error: "method not allowed" }, 405);
  }

  if (!env.DB) {
    return json({ error: "storage not configured" }, 503);
  }

  /*
   * Content-Length is a claim, not a fact: a client may omit it, send a chunked
   * body, or simply lie. Checking it first is still worth doing, because it
   * rejects an oversized upload before any of it is read -- but the body has to
   * be measured as well, or the limit is advisory.
   */
  const declared = Number(request.headers.get("Content-Length"));
  if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) {
    return json({ error: "payload too large" }, 413);
  }

  let payload;
  try {
    const raw = await request.text();
    if (raw.length > MAX_BODY_BYTES) {
      return json({ error: "payload too large" }, 413);
    }
    payload = JSON.parse(raw);
  } catch (e) {
    return json({ error: "malformed json" }, 400);
  }

  const entries = Array.isArray(payload) ? payload : [payload];
  if (entries.length === 0) return json({ stored: 0 }, 200);
  if (entries.length > MAX_ENTRIES) {
    return json({ error: "too many entries" }, 413);
  }

  const invite = text(data && data.invite);
  const receivedAt = new Date().toISOString();

  /*
   * An entry without a corrected genre carries no information -- it is the one
   * field the whole record exists to hold -- so it is dropped rather than
   * stored as a null that would have to be filtered out of every later query.
   */
  const statements = [];
  for (const entry of entries) {
    if (!entry || typeof entry !== "object") continue;
    const corrected = text(entry.corrected);
    if (!corrected) continue;

    statements.push(
      env.DB.prepare(
        `INSERT INTO genre_feedback
           (received_at, invite, made_at, file, artist, title,
            detected, detected_source, corrected, bpm, song_key)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).bind(
        receivedAt,
        invite,
        text(entry.at),
        text(entry.file),
        text(entry.artist),
        text(entry.title),
        text(entry.detected),
        text(entry.detectedSource),
        corrected,
        number(entry.bpm),
        text(entry.key)
      )
    );
  }

  if (statements.length === 0) return json({ stored: 0 }, 200);

  /*
   * One batch, so the client's view of what was stored cannot end up half true:
   * it either gets an acknowledgement for everything it sent or keeps all of it
   * queued for the next attempt. Anything in between would have it either
   * dropping corrections or sending duplicates.
   */
  try {
    await env.DB.batch(statements);
  } catch (e) {
    return json({ error: "write failed" }, 500);
  }

  return json({ stored: statements.length }, 200);
}
