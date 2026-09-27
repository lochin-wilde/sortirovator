/*
 * Checks the one thing that matters most for /api/admin/feedback: that a
 * request without the admin role never reaches the database, regardless of
 * method or query string. Everything else -- limit clamping, D1 failures --
 * is checked too, but the access check is what a regression here would most
 * dangerously get wrong.
 *
 *   node tools/test_admin_feedback.mjs
 */
import { readFileSync } from "node:fs";

const results = [];
const check = (label, cond) => results.push(`  ${cond ? "OK  " : "\u041c\u0418\u041c\u041e"} ${label}`);

const src = readFileSync("functions/api/admin/feedback.js", "utf8");
const endpoint = await import(
    "data:text/javascript;base64," + Buffer.from(src).toString("base64"));

// Minimal stand-in for D1: records the SQL/args it was asked to run and
// returns canned rows, or throws if told to.
const makeDb = ({ rows = [], fail = false } = {}) => {
  const calls = [];
    return {
          calls,
          prepare(sql) {
                  return {
                            bind: (...args) => ({
                                        async all() {
                                                      calls.push({ sql, args });
                                                      if (fail) throw new Error("D1 unavailable");
                                                      return { results: rows };
                                        },
                            }),
                  };
          },
    };
};

const get = (url, { db, role, invite = "someone" } = {}) =>
    endpoint.onRequest({
          request: new Request(url, { method: "GET" }),
          env: db ? { DB: db } : {},
          data: role === undefined ? null : { role, invite },
    });

const post = (db) =>
    endpoint.onRequest({
          request: new Request("https://example.com/api/admin/feedback", { method: "POST" }),
          env: { DB: db },
          data: { role: "admin", invite: "\u041b\u043e\u0447\u0438\u043d" },
    });

/* ---------------------------------------------------------------- */
/* Method and access control                                         */
/* ---------------------------------------------------------------- */

{
    const db = makeDb({ rows: [{ id: 1, corrected: "Techno" }] });
    const r = await post(db);
    check("POST -> 405, \u043c\u0435\u0442\u043e\u0434 \u043d\u0435 \u0440\u0430\u0437\u0440\u0435\u0448\u0451\u043d", r.status === 405);
    check("405 \u043d\u0435 \u0442\u0440\u043e\u0433\u0430\u0435\u0442 \u0431\u0430\u0437\u0443", db.calls.length === 0);
}

{
    // No session data at all -- should not happen behind _middleware.js, but
  // this route must not assume it always will.
  const db = makeDb({ rows: [{ id: 1, corrected: "Techno" }] });
    const r = await get("https://example.com/api/admin/feedback", { db, role: undefined });
    check("\u043d\u0435\u0442 data -> 403, \u043d\u0435 500", r.status === 403);
    check("\u043e\u0442\u0441\u0443\u0442\u0441\u0442\u0432\u0438\u0435 data \u043d\u0435 \u0442\u0440\u043e\u0433\u0430\u0435\u0442 \u0431\u0430\u0437\u0443", db.calls.length === 0);
}

{
    const db = makeDb({ rows: [{ id: 1, corrected: "Techno" }] });
    const r = await get("https://example.com/api/admin/feedback", { db, role: "user" });
    check("\u0440\u043e\u043b\u044c user -> 403", r.status === 403);
    check("403 \u043d\u0435 \u0442\u0440\u043e\u0433\u0430\u0435\u0442 \u0431\u0430\u0437\u0443", db.calls.length === 0);
}

{
    // A role string that merely resembles "admin" must not pass the check --
  // the middleware only ever emits exactly "admin", but this route re-checks
  // rather than trusting that nothing upstream can ever be persuaded otherwise.
  const db = makeDb({ rows: [] });
    const r = await get("https://example.com/api/admin/feedback", { db, role: "Admin" });
    check("\u043f\u043e\u0445\u043e\u0436\u0430\u044f, \u043d\u043e \u043d\u0435 \u0442\u043e\u0447\u043d\u0430\u044f \u0440\u043e\u043b\u044c -> 403", r.status === 403);
}

{
    const r = await get("https://example.com/api/admin/feedback", { role: "admin" }); // no db
  check("admin \u0431\u0435\u0437 \u0431\u0438\u043d\u0434\u0438\u043d\u0433\u0430 DB -> 503", r.status === 503);
}

/* ---------------------------------------------------------------- */
/* Successful reads                                                   */
/* ---------------------------------------------------------------- */

{
    const rows = [
      { id: 2, corrected: "Deep House", invite: "\u0422\u0435\u0441\u0442-1" },
      { id: 1, corrected: "Techno", invite: "\u041b\u043e\u0447\u0438\u043d" },
        ];
    const db = makeDb({ rows });
    const r = await get("https://example.com/api/admin/feedback", { db, role: "admin" });
    const body = await r.json();
    check("admin \u0441 DB -> 200", r.status === 200);
    check("\u043e\u0442\u0434\u0430\u0451\u0442 \u0440\u044f\u0434\u044b \u043a\u0430\u043a \u0435\u0441\u0442\u044c", JSON.stringify(body.entries) === JSON.stringify(rows));
    check("\u043b\u0438\u043c\u0438\u0442 \u043f\u043e \u0443\u043c\u043e\u043b\u0447\u0430\u043d\u0438\u044e \u2014 200", db.calls[0].args[0] === 200);
}

{
    const db = makeDb({ rows: [] });
    await get("https://example.com/api/admin/feedback?limit=5", { db, role: "admin" });
    check("\u044f\u0432\u043d\u044b\u0439 limit \u043f\u0440\u0438\u043c\u0435\u043d\u044f\u0435\u0442\u0441\u044f", db.calls[0].args[0] === 5);
}

{
    const db = makeDb({ rows: [] });
    await get("https://example.com/api/admin/feedback?limit=999999", { db, role: "admin" });
    check("limit \u043e\u0433\u0440\u0430\u043d\u0438\u0447\u0435\u043d \u043f\u043e\u0442\u043e\u043b\u043a\u043e\u043c", db.calls[0].args[0] === 1000);
}

{
    const db = makeDb({ rows: [] });
    await get("https://example.com/api/admin/feedback?limit=-5", { db, role: "admin" });
    check("\u043e\u0442\u0440\u0438\u0446\u0430\u0442\u0435\u043b\u044c\u043d\u044b\u0439 limit -> \u043b\u0438\u043c\u0438\u0442 \u043f\u043e \u0443\u043c\u043e\u043b\u0447\u0430\u043d\u0438\u044e", db.calls[0].args[0] === 200);
}

{
    const db = makeDb({ rows: [] });
    await get("https://example.com/api/admin/feedback?limit=not-a-number", { db, role: "admin" });
    check("\u043d\u0435\u0447\u0438\u0441\u043b\u043e\u0432\u043e\u0439 limit -> \u043b\u0438\u043c\u0438\u0442 \u043f\u043e \u0443\u043c\u043e\u043b\u0447\u0430\u043d\u0438\u044e", db.calls[0].args[0] === 200);
}

{
    const db = makeDb({ fail: true });
    const r = await get("https://example.com/api/admin/feedback", { db, role: "admin" });
    check("\u0441\u0431\u043e\u0439 \u0437\u0430\u043f\u0440\u043e\u0441\u0430 \u043a D1 -> 500, \u043d\u0435 \u043f\u0430\u0434\u0435\u043d\u0438\u0435", r.status === 500);
}

console.log(results.join("\n"));
const passed = results.filter((r) => r.includes("OK")).length;
console.log(`\n  \u043f\u0440\u043e\u0439\u0434\u0435\u043d\u043e ${passed}/${results.length}`);
if (passed !== results.length) process.exit(1);
