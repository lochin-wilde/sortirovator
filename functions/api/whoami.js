/*
 * Tells the client who it is signed in as.
 *
 * The session cookie is HttpOnly on purpose (see _middleware.js), so no
 * client script can read it directly -- that is what keeps a compromised
 * page from stealing it. But the UI still needs to know, in this one
 * harmless respect, whether to show the admin link: this route reads the
 * already-verified context.data set by the middleware and hands back just
 * the label and role, never the session token itself.
 *
 * Always 200: reaching this file at all means _middleware.js already
 * accepted the session, so there is nothing left to check here.
 */

function json(body) {
    return new Response(JSON.stringify(body), {
          status: 200,
          headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" },
    });
}

export async function onRequest(context) {
    const { data } = context;
    return json({
          label: (data && data.invite) || "",
          role: (data && data.role) || "user",
    });
}
