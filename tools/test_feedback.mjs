/*
 * Checks the two things that decide whether a correction survives.
 *
 *   1. The endpoint stores what it is given, and refuses what it should.
 *   2. The client keeps an unacknowledged correction queued rather than
 *      treating a dispatched request as a delivered one.
 *
 * The second is the one worth a test. A send that fails is the normal case on a
 * laptop in a club, and the bug it hides -- marking an entry sent when the
 * request never arrived -- is invisible: the correction is simply never seen
 * again by anyone.
 *
 *   node tools/test_feedback.mjs
 */
import { readFileSync } from "node:fs";

const results = [];
const check = (label, cond) => results.push(`  ${cond ? "OK  " : "МИМО"} ${label}`);

/* ---------------------------------------------------------------- */
/* Endpoint                                                          */
/* ---------------------------------------------------------------- */

const endpointSrc = readFileSync("functions/api/feedback.js", "utf8");
const endpoint = await import(
  "data:text/javascript;base64," + Buffer.from(endpointSrc).toString("base64"));

// Minimal stand-in for D1: records the rows a batch would have written.
const makeDb = ({ fail = false } = {}) => {
  const rows = [];
  return {
    rows,
    prepare(sql) {
      return { bind: (...args) => ({ sql, args }) };
    },
    async batch(statements) {
      if (fail) throw new Error("D1 unavailable");
      for (const s of statements) rows.push(s.args);
    },
  };
};

const post = (body, { db, invite = "tester-one" } = {}) =>
  endpoint.onRequest({
    request: new Request("https://example.com/api/feedback", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: typeof body === "string" ? body : JSON.stringify(body),
    }),
    env: db ? { DB: db } : {},
    data: { invite },
  });

const entry = {
  v: 1, at: "2026-07-29T10:00:00.000Z", file: "01 - track.mp3",
  artist: "Someone", title: "A Title", detected: "Hip-Hop",
  detectedSource: "musicbrainz", corrected: "Old School Hip-Hop",
  bpm: 93.5, key: "8A",
};

let db = makeDb();
let r = await post([entry], { db });
check("исправление записано", r.status === 200 && db.rows.length === 1);
check("метка сессии попала в строку", db.rows[0][1] === "tester-one");
check("исправленный жанр на своём месте", db.rows[0][8] === "Old School Hip-Hop");
check("BPM сохранён числом", db.rows[0][9] === 93.5);

// The server's own clock, not the browser's.
check("время приёма проставлено сервером",
  typeof db.rows[0][0] === "string" && db.rows[0][0] !== entry.at);

db = makeDb();
r = await post([{ ...entry, corrected: "" }], { db });
check("запись без исправленного жанра отброшена", r.status === 200 && db.rows.length === 0);

db = makeDb();
r = await post([{ ...entry, file: "x".repeat(5000) }], { db });
check("сверхдлинное поле обрезано", db.rows[0][3].length === 500);

db = makeDb();
r = await post(Array(201).fill(entry), { db });
check("слишком большая пачка отклонена", r.status === 413 && db.rows.length === 0);

r = await post("{не json", { db: makeDb() });
check("битый JSON -> 400", r.status === 400);

r = await post([entry]); // без привязки DB
check("без хранилища -> 503, а не падение", r.status === 503);

r = await endpoint.onRequest({
  request: new Request("https://example.com/api/feedback", { method: "GET" }),
  env: { DB: makeDb() }, data: {},
});
check("GET -> 405", r.status === 405);

/* ---------------------------------------------------------------- */
/* Client queue                                                      */
/* ---------------------------------------------------------------- */

// feedback.js is a plain script, not a module: evaluate it with the browser
// globals it expects and read the functions back out.
const clientSrc = readFileSync("web/js/feedback.js", "utf8");
const store = new Map();

/*
 * fetch is swapped between cases, so what the module receives has to be a
 * wrapper that forwards to the current one. Passing the implementation directly
 * would bind it at load time and quietly ignore every later swap -- which it
 * did, and the test read as two product failures.
 */
let fetchImpl = async () => new Response("{}", { status: 200 });

const sandbox = {
  localStorage: {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => store.set(k, String(v)),
    removeItem: (k) => store.delete(k),
  },
  t: (key, vars) => key + JSON.stringify(vars || {}),
  log: () => {},
  fetch: (...args) => fetchImpl(...args),
};

const load = () => {
  const names = Object.keys(sandbox);
  const factory = new Function(
    ...names,
    clientSrc + "\n;return { recordGenreCorrection, flushFeedback, loadFeedback, correctionFor };"
  );
  return factory(...names.map((n) => sandbox[n]));
};

let api = load();
const result = {
  name: "01 - track.mp3", feedbackArtist: "Someone", feedbackTitle: "A Title",
  genre: "Hip-Hop", genreSource: "musicbrainz", bpm: 93.5, key: "8A",
};

api.recordGenreCorrection(result, "Old School Hip-Hop");
await new Promise((r) => setTimeout(r, 0));
check("после успешной отправки запись помечена отправленной",
  api.loadFeedback()[0].sent === true);

// Now the case that matters: the request fails.
store.clear();
fetchImpl = async () => { throw new Error("сеть недоступна"); };
api = load();
api.recordGenreCorrection(result, "Afro House");
await new Promise((r) => setTimeout(r, 0));
const afterFailure = api.loadFeedback()[0];
check("после обрыва запись НЕ помечена отправленной", afterFailure.sent !== true);
check("исправление всё равно применяется локально",
  api.correctionFor("Someone", "A Title").genre === "Afro House");

// And that the queue drains once the network returns.
let sentCount = 0;
fetchImpl = async (url, opts) => {
  sentCount = JSON.parse(opts.body).length;
  return new Response("{}", { status: 200 });
};
await api.flushFeedback();
check("при следующей попытке очередь уходит", sentCount === 1);
check("и помечается отправленной", api.loadFeedback()[0].sent === true);

// A stored correction from before this feature existed has no flag at all.
store.set("sortirovator.genreFeedback", JSON.stringify([
  { v: 1, at: "2026-07-01T00:00:00.000Z", artist: "Old", title: "Entry",
    corrected: "Techno" },
]));
api = load();
sentCount = 0;
await api.flushFeedback();
check("запись без флага считается неотправленной", sentCount === 1);

console.log(results.join("\n"));
const passed = results.filter((x) => x.startsWith("  OK")).length;
console.log(`\n  пройдено ${passed}/${results.length}`);
if (passed !== results.length) process.exitCode = 1;
