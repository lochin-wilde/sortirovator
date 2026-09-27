/*
 * Lists genre corrections for review. Admin-only.
 *
 * _middleware.js already rejects any request without a valid session, so by
 * the time this file runs the caller is signed in as *someone* -- but "signed
 * in" and "allowed to read every tester's corrections" are different
 * questions, and this route is the one place that asks the second. It reads
 * context.data.role, which the middleware only ever sets after verifying the
 * session's signature, so there is no path here that trusts a role the
 * client merely claims to have.
 *
 * Deploy: same D1 binding as /api/feedback (Settings -> Bindings -> DB).
 * Without it this answers 503, same as the write side.
 */

const DEFAULT_LIMIT = 200;
const MAX_LIMIT = 1000;

function json(body, status) {
    return new Response(JSON.stringify(body), {
          status,
          headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" },
    });
}

export async function onRequest(context) {
    const { request, env, data } = context;

  if (request.method !== "GET") {
        return json({ error: "method not allowed" }, 405);
  }

  // Checked before the DB binding, so a non-admin gets the same 403 whether or
  // not the project happens to have D1 configured -- that detail is not
  // theirs to learn from this response.
  if (!data || data.role !== "admin") {
        return json({ error: "admin only" }, 403);
  }

  if (!env.DB) {
        return json({ error: "storage not configured" }, 503);
  }

  const url = new URL(request.url);
    const requested = Number(url.searchParams.get("limit"));
    const limit = Number.isFinite(requested) && requested > 0
      ? Math.min(Math.floor(requested), MAX_LIMIT)
          : DEFAULT_LIMIT;

  let result;
    try {
          result = await env.DB
            .prepare(
                      `SELECT id, received_at, invite, made_at, file, artist, title,
                                      detected, detected_source, corrected, bpm, song_key
                                                 FROM genre_feedback
                                                           ORDER BY id DESC
                                                                     LIMIT ?`
                    )
            .bind(limit)
            .all();
    } catch (e) {
          return json({ error: "query failed" }, 500);
    }

  return json({ entries: result.results || [] }, 200);
}
