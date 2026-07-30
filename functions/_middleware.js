/*
 * Invite gate that actually holds, as Cloudflare Pages middleware.
 *
 * The gate in web/js/invite.js is not access control and never was: it runs in
 * the visitor's browser, after the browser has already been given every file.
 * Anyone who opens the console is past it in a minute. It exists so the flow and
 * the storage are in place; this file is what makes the flow mean something.
 *
 * The rule that makes it real: this runs before any file is served, and an
 * unauthenticated request is answered with the login page instead of the app.
 * The visitor never receives web/js/*, the genre map, or anything else until a
 * code has been accepted. Failure closed is the whole point -- if this code
 * throws, nothing is served, which is the safe direction.
 *
 * Deploy
 * ------
 *   1. Cloudflare Pages project, build output directory = web
 *   2. Set two secrets in the Pages project (Settings -> Environment variables,
 *      "Encrypt" enabled). Never in the repository:
 *
 *        SESSION_SECRET   32+ random bytes, e.g. `openssl rand -base64 32`
 *        INVITE_CODES     JSON: {"<code>": "<who it went to>", ...}
 *
 *   3. Revoke one tester by deleting their entry and redeploying. Revoke
 *      everyone at once by rotating SESSION_SECRET, which invalidates every
 *      cookie already issued.
 *
 * On code length
 * --------------
 * Codes must be long and random -- 20+ characters from `openssl rand -hex 12`.
 * "SORTIR-2026" is guessable, and an attacker gets unlimited tries against an
 * endpoint that costs them nothing. Length is the only thing standing between a
 * closed test and an open one; put Cloudflare's rate limiting in front of POSTs
 * to this path as well.
 */

const COOKIE_NAME = "sortir_session";
const SESSION_TTL_SECONDS = 30 * 24 * 60 * 60; // 30 days
// Must match the form action in web/index.html.
const LOGOUT_PATH = "/logout";

const encoder = new TextEncoder();

function base64url(bytes) {
  let binary = "";
  for (const b of new Uint8Array(bytes)) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function hmac(secret, message) {
  const key = await crypto.subtle.importKey(
    "raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return base64url(await crypto.subtle.sign("HMAC", key, encoder.encode(message)));
}

/*
 * Compared without an early exit. A `===` on strings can return as soon as it
 * finds a difference, and the time that takes leaks how much of the value was
 * guessed correctly -- enough, over many attempts, to reconstruct it.
 */
function equalsConstantTime(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

async function issueSession(secret, label) {
  const expires = Math.floor(Date.now() / 1000) + SESSION_TTL_SECONDS;
  const payload = `${expires}.${label}`;
  return `${payload}.${await hmac(secret, payload)}`;
}

/*
 * Returns the label the session was issued to, or null if the token is not
 * valid. The label rather than a boolean, because routes behind this need to
 * know *whose* session it is -- /api/feedback records which tester a correction
 * came from -- and having them re-parse the cookie themselves would invite one
 * of them to read the label without checking the signature first.
 *
 * A label is only ever returned after the signature has been verified, so a
 * caller cannot accidentally trust an unverified one.
 */
async function sessionLabel(secret, token) {
  if (!token) return null;
  const cut = token.lastIndexOf(".");
  if (cut < 0) return null;
  const payload = token.slice(0, cut);
  const signature = token.slice(cut + 1);

  const expected = await hmac(secret, payload);
  if (!equalsConstantTime(signature, expected)) return null;

  // issueSession() strips dots from the label, so the payload splits cleanly.
  const [rawExpires, label] = payload.split(".");
  const expires = Number(rawExpires);
  if (!Number.isFinite(expires) || expires <= Math.floor(Date.now() / 1000)) {
    return null;
  }
  return label || "";
}

function readCookie(request, name) {
  const header = request.headers.get("Cookie") || "";
  for (const part of header.split(";")) {
    const [key, ...rest] = part.trim().split("=");
    if (key === name) return rest.join("=");
  }
  return null;
}

function loginPage(message) {
  const notice = message
    ? `<p class="error">${message}</p>`
    : "";
  return `<!doctype html>
<html lang="ru"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex,nofollow">
<title>Музыкальный сортир — закрытое тестирование</title>
<style>
  :root { color-scheme: dark; }
  body { margin:0; min-height:100vh; display:grid; place-items:center;
         background:#111318; color:#e8eaf0;
         font:16px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif; }
  form { width:min(92vw,26rem); padding:2rem; border:1px solid #262a35;
         border-radius:14px; background:#181b22; }
  h1 { margin:0 0 .5rem; font-size:1.4rem; }
  p { margin:0 0 1.25rem; color:#9aa2b4; }
  .error { color:#ff8f8f; }
  input { width:100%; box-sizing:border-box; padding:.75rem .9rem; font-size:1rem;
          letter-spacing:.08em; background:#0e1015; color:#e8eaf0;
          border:1px solid #2c3140; border-radius:9px; }
  button { margin-top:.85rem; width:100%; padding:.75rem; font-size:1rem;
           font-weight:600; color:#fff; background:#5b7cfa; border:0;
           border-radius:9px; cursor:pointer; }
  button:hover { background:#6d8bff; }
</style></head>
<body>
  <form method="POST">
    <h1>Закрытое тестирование</h1>
    <p>«Музыкальный сортир» пока доступен по приглашениям. Введите выданный код.</p>
    ${notice}
    <input name="code" autocomplete="off" autocapitalize="off" spellcheck="false"
           placeholder="КОД ПРИГЛАШЕНИЯ" autofocus>
    <button type="submit">Продолжить</button>
  </form>
</body></html>`;
}

function htmlResponse(body, status) {
  return new Response(body, {
    status,
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store",
      // The login page must never be framed by another site.
      "X-Frame-Options": "DENY",
      "Referrer-Policy": "no-referrer",
    },
  });
}

export async function onRequest(context) {
  const { request, env, next } = context;
  const secret = env.SESSION_SECRET;
  const rawCodes = env.INVITE_CODES;

  /*
   * Missing configuration closes the door rather than opening it. A deploy that
   * forgot its secrets should be visibly broken, not quietly public -- that
   * mistake is exactly how a closed test becomes an open one without anyone
   * noticing.
   */
  if (!secret || !rawCodes) {
    return htmlResponse(
      "<p>Гейт не настроен: не заданы SESSION_SECRET и INVITE_CODES.</p>", 503);
  }

  /*
   * Signing out has to happen here, on the server. The session cookie is
   * HttpOnly -- that is the point of it -- so no button on the page can clear
   * it; only a Set-Cookie in a response can.
   *
   * POST rather than GET. With SameSite=Lax a cross-site *navigation* still
   * carries the cookie, so a GET /logout could be triggered by any page that
   * links to it and would sign the user out unasked. A cross-site POST does not
   * carry it, so the same attempt simply fails.
   *
   * Handled before the session check, and without one: signing out must work
   * whatever state the session is in, including already expired. Nothing here
   * depends on who the caller is -- the worst a stranger can do is expire their
   * own cookie.
   */
  if (new URL(request.url).pathname === LOGOUT_PATH) {
    if (request.method !== "POST") {
      return new Response(null, { status: 303, headers: { Location: "/" } });
    }
    const response = new Response(null, { status: 303, headers: { Location: "/" } });
    response.headers.append("Set-Cookie",
      `${COOKIE_NAME}=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Lax`);
    return response;
  }

  const label = await sessionLabel(secret, readCookie(request, COOKIE_NAME));
  if (label !== null) {
    // Routes downstream read this instead of the cookie, so the signature check
    // above is the only place a session is ever trusted.
    context.data.invite = label;
    return next();
  }

  /*
   * A POST without a session is treated as someone submitting the login form --
   * but it is not necessarily one. The app POSTs JSON to /api/feedback, and if
   * the session expired between loading the page and correcting a genre, that
   * request lands here. Reading it as a form throws, and an exception in
   * middleware means a 500 for what is simply an unauthenticated request.
   *
   * So the body is only parsed when it claims to be a form, and a failure to
   * parse answers with the login page rather than propagating. Every path out
   * of here still refuses to serve the app, which is the part that matters.
   */
  const contentType = request.headers.get("Content-Type") || "";
  const looksLikeLoginForm =
    contentType.includes("application/x-www-form-urlencoded") ||
    contentType.includes("multipart/form-data");

  if (request.method === "POST" && looksLikeLoginForm) {
    let form;
    try {
      form = await request.formData();
    } catch (e) {
      return htmlResponse(loginPage(""), 401);
    }
    const submitted = String(form.get("code") || "").trim().toUpperCase();

    let codes;
    try {
      codes = JSON.parse(rawCodes);
    } catch (e) {
      return htmlResponse("<p>INVITE_CODES не разбирается как JSON.</p>", 503);
    }

    // Every code is checked, so the time taken does not reveal which one matched
    // or how far down the list it sat.
    let matched = null;
    for (const [code, label] of Object.entries(codes)) {
      if (equalsConstantTime(submitted, code.toUpperCase())) matched = label;
    }

    if (!matched) {
      return htmlResponse(loginPage("Код не подошёл."), 401);
    }

    const token = await issueSession(secret, String(matched).replace(/[^\w-]/g, ""));
    const response = new Response(null, { status: 303, headers: { Location: "/" } });
    response.headers.append("Set-Cookie",
      `${COOKIE_NAME}=${token}; Path=/; Max-Age=${SESSION_TTL_SECONDS}; ` +
      `HttpOnly; Secure; SameSite=Lax`);
    return response;
  }

  return htmlResponse(loginPage(""), 401);
}
