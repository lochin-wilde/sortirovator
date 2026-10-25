/*
 * Usage figures for the admin page. Admin-only, same rule as ./feedback.js:
 * the middleware proves *a* session, and this file asks whether it is an
 * admin's, from context.data.role, which only the middleware sets.
 *
 * Everything is aggregated in SQL and only the totals leave the database, plus
 * the latest runs -- which hold nothing but numbers, a mode, a preset and a
 * version in the first place (see ../usage.js).
 */

const RECENT_RUNS = 50;
const DAY_MS = 24 * 60 * 60 * 1000;

function json(body, status) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" },
  });
}

export async function onRequest(context) {
  const { request, env, data } = context;

  if (request.method !== "GET") return json({ error: "method not allowed" }, 405);
  // Before the binding check, so a non-admin learns nothing about the setup.
  if (!data || data.role !== "admin") return json({ error: "admin only" }, 403);
  if (!env.DB) return json({ error: "storage not configured" }, 503);

  const now = Date.now();
  const since7 = new Date(now - 7 * DAY_MS).toISOString();
  const since30 = new Date(now - 30 * DAY_MS).toISOString();

  let results;
  try {
    results = await env.DB.batch([
      env.DB.prepare(
        `SELECT
           (SELECT COUNT(DISTINCT pseudonym) FROM usage WHERE at > ?) AS users7,
           (SELECT COUNT(DISTINCT pseudonym) FROM usage WHERE at > ?) AS users30,
           (SELECT COUNT(DISTINCT pseudonym) FROM usage) AS usersAll,
           (SELECT COUNT(*) FROM usage WHERE at > ?) AS runs30,
           (SELECT COUNT(*) FROM usage) AS runsAll,
           (SELECT COALESCE(SUM(tracks), 0) FROM usage WHERE at > ?) AS tracks30,
           (SELECT COALESCE(SUM(tracks), 0) FROM usage) AS tracksAll`
      ).bind(since7, since30, since30, since30),
      env.DB.prepare(
        `SELECT mode, COUNT(*) AS runs, SUM(tracks) AS tracks, SUM(failed) AS failed
           FROM usage GROUP BY mode ORDER BY runs DESC`
      ),
      env.DB.prepare(
        `SELECT COALESCE(preset, '') AS preset, COUNT(*) AS runs
           FROM usage WHERE mode = 'files' GROUP BY preset ORDER BY runs DESC`
      ),
      env.DB.prepare(
        `SELECT version, COUNT(*) AS runs, MAX(at) AS last
           FROM usage GROUP BY version ORDER BY version DESC LIMIT 20`
      ),
      env.DB.prepare(
        `SELECT at, pseudonym, mode, preset, tracks, succeeded, failed, seconds, version
           FROM usage ORDER BY id DESC LIMIT ?`
      ).bind(RECENT_RUNS),
    ]);
  } catch (e) {
    return json({ error: "query failed" }, 500);
  }

  const rows = (i) => (results[i] && results[i].results) || [];
  return json({
    totals: rows(0)[0] || {},
    byMode: rows(1),
    byPreset: rows(2),
    byVersion: rows(3),
    recent: rows(4),
  }, 200);
}
