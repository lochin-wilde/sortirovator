/*
 * Checks the usage counter: what a record may hold, what it must never hold,
 * who may read the totals, and that a failure to send stays invisible.
 *
 * The privacy promise is the part worth testing hardest. The page tells users
 * that only an anonymous count leaves after a run; if a file name or an artist
 * ever reached the table, that sentence would be false, and nothing else in the
 * suite would notice.
 *
 *   node tools/test/test_usage.mjs
 */
import { readFileSync } from "node:fs";

const results = [];
const check = (label, cond) => results.push(`  ${cond ? "OK  " : "МИМО"} ${label}`);

const load = async (path) => import("data:text/javascript;base64," +
  Buffer.from(readFileSync(path, "utf8")).toString("base64"));
const usage = await load("functions/api/usage.js");
const adminUsage = await load("functions/api/admin/usage.js");
const views = new Function(readFileSync("web/js/views.js", "utf8") +
  "return { PRESETS, usagePayload };")();

const SECRET = "тестовый-секрет-32-байта-минимум-ок";
const VERSION = "2026.10.25.1";

/*
 * Stand-in for D1. Records every statement with its bound values, answers the
 * rate-limit count with `recent`, and can be told to fail. Statements are
 * recognised by shape, not parsed: this tests the endpoint's decisions.
 */
function fakeDb({ recent = 0, fail = false } = {}) {
  const log = [];
  return {
    log,
    prepare(sql) {
      if (fail) throw new Error("D1 unavailable");
      const statement = {
        sql, args: [],
        bind(...args) { statement.args = args; return statement; },
        async first() { log.push(statement); return { runs: recent }; },
        async run() { log.push(statement); return { success: true }; },
        async all() { log.push(statement); return { results: [] }; },
      };
      return statement;
    },
    async batch(statements) {
      if (fail) throw new Error("D1 unavailable");
      statements.forEach((s) => log.push(s));
      return statements.map(() => ({ results: [{ users7: 0, runsAll: 0 }] }));
    },
  };
}

const inserts = (db) => db.log.filter((s) => s.sql.includes("INSERT"));

async function post(body, { db = fakeDb(), invite = "Ваня", raw, headers = {}, env } = {}) {
  const request = new Request("https://example.com/api/usage", {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: raw !== undefined ? raw : JSON.stringify(body),
  });
  const response = await usage.onRequest({
    request,
    env: env || { SESSION_SECRET: SECRET, DB: db },
    data: { invite, role: "user" },
  });
  return { status: response.status, db };
}

const good = {
  mode: "files", preset: "library", tracks: 10, succeeded: 9, failed: 1,
  seconds: 41.6, version: VERSION,
};

/* ---------- A valid record ---------- */

{
  const { status, db } = await post(good);
  const row = inserts(db)[0];
  check("правильная запись -> 200", status === 200);
  check("ровно одна вставка", inserts(db).length === 1);
  check("время сервера в ISO UTC", row && /^\d{4}-\d{2}-\d{2}T.*Z$/.test(row.args[0]));
  check("поля записаны в нужном порядке",
    row && JSON.stringify(row.args.slice(2)) === JSON.stringify(["files", "library", 10, 9, 1, 42, VERSION]));
  const pseudonym = row && row.args[1];
  check("псевдоним — 10 символов base64url", /^[A-Za-z0-9_-]{10}$/.test(pseudonym));
  check("псевдоним не содержит метку", !String(pseudonym).includes("Ваня"));

  const again = inserts((await post(good)).db)[0].args[1];
  const other = inserts((await post(good, { invite: "клуб Осень" })).db)[0].args[1];
  check("тот же тестировщик — тот же псевдоним", again === pseudonym);
  check("другой тестировщик — другой псевдоним", other !== pseudonym);
}
{
  const db = fakeDb();
  await usage.onRequest({
    request: new Request("https://example.com/api/usage", { method: "POST", body: JSON.stringify(good) }),
    env: { SESSION_SECRET: SECRET + "-другой", DB: db },
    data: { invite: "Ваня", role: "user" },
  });
  const first = inserts((await post(good)).db)[0].args[1];
  check("другой секрет — другой псевдоним", inserts(db)[0].args[1] !== first);
}

/* ---------- What must never be stored ---------- */

{
  const leaky = {
    ...good,
    file: "Daft Punk - Around the World.mp3",
    artist: "Daft Punk",
    title: "Around the World",
    genre: "French House",
    path: "/Volumes/HomeSSD/Lochin/House/",
    ip: "203.0.113.7",
    names: ["Black Coffee - Drive"],
    tracksList: [{ name: "secret.mp3" }],
  };
  const { status, db } = await post(leaky, { headers: { "CF-Connecting-IP": "198.51.100.9" } });
  const stored = JSON.stringify(inserts(db).map((s) => s.args));
  check("лишние поля отброшены, запись принята", status === 200);
  for (const forbidden of ["Daft", "Around", "French", "Volumes", "203.0.113.7", "198.51.100.9", "Black Coffee", "secret.mp3", "Ваня"]) {
    check(`в таблицу не попало «${forbidden}»`, !stored.includes(forbidden));
  }
  check("вставка перечисляет только разрешённые столбцы",
    /\(at, pseudonym, mode, preset, tracks, succeeded, failed, seconds, version\)/.test(inserts(db)[0].sql));
}

/* ---------- Validation ---------- */

const rejected = async (label, body, opts) => {
  const { status, db } = await post(body, opts);
  check(`${label} -> 400, без вставки`, status === 400 && inserts(db).length === 0);
};
await rejected("неизвестный режим", { ...good, mode: "stream" });
await rejected("неизвестный набор", { ...good, preset: "all" });
await rejected("набор не указан в режиме файлов", { ...good, preset: undefined });
await rejected("число строкой", { ...good, tracks: "10" });
await rejected("дробное число треков", { ...good, tracks: 10.5 });
await rejected("отрицательное число", { ...good, failed: -1 });
await rejected("успешных и ошибок больше, чем треков", { ...good, succeeded: 10, failed: 1 });
await rejected("ноль треков", { ...good, tracks: 0, succeeded: 0, failed: 0 });
await rejected("треков больше предела", { ...good, tracks: 100001, succeeded: 100001, failed: 0 });
await rejected("длительность больше суток", { ...good, seconds: 86401 });
await rejected("длительность отрицательная", { ...good, seconds: -3 });
await rejected("версия не по шаблону", { ...good, version: "latest" });
await rejected("массив вместо объекта", [good]);
await rejected("битый JSON", null, { raw: "{mode:" });

{
  const { status, db } = await post({ ...good, mode: "rekordbox", preset: "library" });
  check("Rekordbox: набор не хранится", status === 200 && inserts(db)[0].args[3] === null);
}
{
  const { status, db } = await post({ ...good, mode: "rekordbox", preset: undefined });
  check("Rekordbox без набора принимается", status === 200 && inserts(db).length === 1);
}
{
  const { status } = await post(null, { raw: JSON.stringify({ ...good, pad: "x".repeat(3000) }) });
  check("тело больше 2 КБ -> 413", status === 413);
}
{
  const response = await usage.onRequest({
    request: new Request("https://example.com/api/usage", { method: "GET" }),
    env: { SESSION_SECRET: SECRET, DB: fakeDb() }, data: {},
  });
  check("GET -> 405", response.status === 405);
}
{
  const { status } = await post(good, { env: { SESSION_SECRET: SECRET } });
  check("без базы -> 503", status === 503);
}

/* ---------- Rate limit and failures ---------- */

{
  const { status, db } = await post(good, { db: fakeDb({ recent: 30 }) });
  check("30 прогонов за 10 минут -> 429 без вставки", status === 429 && inserts(db).length === 0);
  const limitQuery = db.log.find((s) => s.sql.startsWith("SELECT COUNT"));
  check("лимит считается по псевдониму, не по адресу",
    limitQuery && /pseudonym = \?/.test(limitQuery.sql) && !/ip/i.test(limitQuery.sql));
}
{
  const { status } = await post(good, { db: fakeDb({ recent: 29 }) });
  check("29 прогонов — ещё пропускает", status === 200);
}
{
  let thrown = false;
  let status = 0;
  try { ({ status } = await post(good, { db: fakeDb({ fail: true }) })); } catch (e) { thrown = true; }
  check("сбой базы -> 500, а не исключение", !thrown && status === 500);
}

/* ---------- Admin totals ---------- */

{
  let touched = false;
  const spyDb = { prepare() { touched = true; throw new Error("must not be reached"); }, batch() { touched = true; } };
  const response = await adminUsage.onRequest({
    request: new Request("https://example.com/api/admin/usage"),
    env: { DB: spyDb }, data: { invite: "Ваня", role: "user" },
  });
  check("статистика для не-админа -> 403", response.status === 403);
  check("не-админ не доходит до базы", touched === false);
}
{
  const response = await adminUsage.onRequest({
    request: new Request("https://example.com/api/admin/usage"),
    env: {}, data: { role: "admin" },
  });
  check("админ без базы -> 503", response.status === 503);
}
{
  const response = await adminUsage.onRequest({
    request: new Request("https://example.com/api/admin/usage"),
    env: { DB: fakeDb() }, data: { role: "admin" },
  });
  const body = await response.json();
  check("админ получает итоги, разбивки и последние прогоны",
    response.status === 200 && ["totals", "byMode", "byPreset", "byVersion", "recent"].every((k) => k in body));
}

/* ---------- The client's half ---------- */

const allowed = ["mode", "preset", "tracks", "succeeded", "failed", "seconds", "version"];
{
  const payload = views.usagePayload({
    mode: "files",
    steps: { fixNames: false, sort: true, bpmKey: true, loudness: false },
    tracks: 12, failed: 2, seconds: 30.4, version: VERSION,
    // What a careless caller might hand over along with the counts.
    name: "Daft Punk - Around the World.mp3", artist: "Daft Punk", results: [{ genre: "House" }],
  });
  check("клиент шлёт ровно разрешённые поля",
    JSON.stringify(Object.keys(payload).sort()) === JSON.stringify(allowed.slice().sort()));
  check("в запись клиента не попадают названия", !JSON.stringify(payload).includes("Daft"));
  check("набор определён по галочкам", payload.preset === "library");
  check("успешные = всего − ошибки", payload.succeeded === 10 && payload.failed === 2);

  const { status } = await post(payload);
  check("сервер принимает то, что шлёт клиент", status === 200);
}
check("своя комбинация -> custom",
  views.usagePayload({ mode: "files", steps: { loudness: true }, tracks: 1, version: VERSION }).preset === "custom");
check("Rekordbox -> без набора",
  views.usagePayload({ mode: "rekordbox", tracks: 5, failed: 0, version: VERSION }).preset === null);
check("ноль треков -> ничего не шлётся", views.usagePayload({ mode: "files", tracks: 0 }) === null);
check("ошибок не больше, чем треков",
  views.usagePayload({ mode: "rekordbox", tracks: 3, failed: 9, version: VERSION }).failed === 3);

const serverPresets = readFileSync("functions/api/usage.js", "utf8").match(/const PRESETS = \[([^\]]+)\]/)[1]
  .split(",").map((s) => s.trim().replace(/"/g, ""));
check("наборы сервера = наборы интерфейса + custom",
  JSON.stringify(serverPresets) === JSON.stringify([...views.PRESETS.map((p) => p.id), "custom"]));

/* ---------- Sending can never hurt the run ---------- */

const appSrc = readFileSync("web/js/app.js", "utf8");
const cut = (name) => {
  const start = appSrc.indexOf(`function ${name}(`);
  if (start < 0) throw new Error(`не найдена функция ${name} в web/js/app.js`);
  let depth = 0;
  for (let i = appSrc.indexOf("{", start); i < appSrc.length; i++) {
    if (appSrc[i] === "{") depth++;
    else if (appSrc[i] === "}" && --depth === 0) return appSrc.slice(start, i + 1);
  }
  throw new Error(`не удалось выделить ${name}`);
};
const makeReporter = (fetchImpl, payloadImpl) => new Function("fetch", "usagePayload", "APP_VERSION",
  cut("reportUsage") + "return reportUsage;")(fetchImpl, payloadImpl, VERSION);

let unhandled = 0;
process.on("unhandledRejection", () => { unhandled++; });

{
  const calls = [];
  const report = makeReporter((url, init) => { calls.push({ url, init }); return Promise.resolve(new Response("{}")); },
    views.usagePayload);
  report({ mode: "files", steps: {}, tracks: 4, failed: 0, seconds: 3 });
  const sent = calls[0];
  check("отправка идёт на /api/usage методом POST", sent && sent.url === "/api/usage" && sent.init.method === "POST");
  check("отправка с keepalive", sent && sent.init.keepalive === true);
  check("в теле — версия приложения", sent && JSON.parse(sent.init.body).version === VERSION);
  report({ mode: "files", steps: {}, tracks: 0 });
  check("пустой прогон не отправляется", calls.length === 1);
}

const survives = async (label, fetchImpl, payloadImpl = views.usagePayload) => {
  let thrown = false;
  try { makeReporter(fetchImpl, payloadImpl)({ mode: "files", steps: {}, tracks: 2, failed: 0, seconds: 1 }); }
  catch (e) { thrown = true; }
  await new Promise((r) => setTimeout(r, 20));
  check(label, !thrown);
};
const before = unhandled;
await survives("fetch бросает сразу — наружу не выходит", () => { throw new Error("offline"); });
await survives("fetch отклоняется — наружу не выходит", () => Promise.reject(new Error("network")));
await survives("fetch нет вовсе — наружу не выходит", undefined);
await survives("сборка записи бросает — наружу не выходит", () => Promise.resolve(), () => { throw new Error("bug"); });
await survives("сервер отвечает 500 — наружу не выходит", () => Promise.resolve(new Response("", { status: 500 })));
check("ни одного необработанного отказа промиса", unhandled === before);

/* ---------- Schema ---------- */

const ddl = (sql) => sql.slice(sql.indexOf("CREATE TABLE IF NOT EXISTS usage"))
  .split("\n").filter((line) => !line.trim().startsWith("--")).join("\n").trim();
const migration = ddl(readFileSync("db/migrations/0002_usage.sql", "utf8"));
const schema = ddl(readFileSync("db/schema.sql", "utf8"));
check("таблица usage одинакова в миграции и в schema.sql", migration.length > 0 && migration === schema);
check("в таблице нет столбцов для названий, жанров, путей и адресов",
  !/\b(file|artist|title|genre|path|ip|label|invite)\b/i.test(migration.replace(/--.*$/gm, "")));

/* ---------- report ---------- */

const failed = results.filter((line) => line.includes("МИМО"));
console.log(results.join("\n"));
console.log(`\nпройдено ${results.length - failed.length}/${results.length}`);
process.exit(failed.length > 0 ? 1 : 0);
