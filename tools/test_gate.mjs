import { readFileSync } from "node:fs";
const src = readFileSync(process.argv[2], "utf8");
const mod = await import("data:text/javascript;base64," + Buffer.from(src).toString("base64"));

const SECRET = "тестовый-секрет-32-байта-минимум-ок";
const CODES = JSON.stringify({
  "DJ-AAAA-BBBB-CCCC": "tester-one",
  "DJ-DDDD-EEEE-FFFF": "tester-two",
  // Codes are labelled with the name of whoever got them, and those names are
  // Russian here. An ASCII-only sanitiser silently erased them.
  "DJ-1111-2222-3333": "Ваня",
  "DJ-4444-5555-6666": "клуб Осень",
  // A dot is the token's own field separator, so a label containing one must
  // not be able to shift what the rest of the payload parses as.
  "DJ-7777-8888-9999": "клуб им. Кирова",
});
const env = { SESSION_SECRET: SECRET, INVITE_CODES: CODES };
let served = 0;
const next = async () => { served++; return new Response("ПРИЛОЖЕНИЕ", { status: 200 }); };

const req = (method, opts = {}) => {
  const headers = {};
  if (opts.cookie) headers.Cookie = opts.cookie;
  if (opts.ip) headers["CF-Connecting-IP"] = opts.ip;
  return new Request("https://example.com/", {
    method,
    headers,
    body: opts.code !== undefined ? new URLSearchParams({ code: opts.code }) : undefined,
  });
};

/*
 * Stand-in for D1, holding just enough to answer the three statements the rate
 * limiter issues. Real SQL is not parsed -- the statements are recognised by
 * shape -- so this tests the limiter's decisions, not SQLite.
 */
const makeAttemptsDb = ({ fail = false } = {}) => {
  let rows = [];
  const exec = (sql, args) => {
    if (fail) throw new Error("D1 unavailable");
    if (sql.startsWith("SELECT")) {
      const [ip, cutoff] = args;
      const hits = rows.filter((r) => r.ip === ip && r.at > cutoff);
      return {
        failures: hits.length,
        oldest: hits.length ? Math.min(...hits.map((r) => r.at)) : null,
      };
    }
    if (sql.startsWith("INSERT")) rows.push({ ip: args[0], at: args[1] });
    else if (sql.includes("WHERE at <=")) rows = rows.filter((r) => r.at > args[0]);
    else if (sql.includes("WHERE ip =")) rows = rows.filter((r) => r.ip !== args[0]);
    return null;
  };
  return {
    get rows() { return rows; },
    prepare(sql) {
      return {
        bind: (...args) => ({
          first: async () => exec(sql, args),
          run: async () => exec(sql, args),
          _apply: () => exec(sql, args),
        }),
      };
    },
    async batch(statements) {
      if (fail) throw new Error("D1 unavailable");
      for (const s of statements) s._apply();
    },
  };
};

/*
 * `data` is the object Cloudflare passes from middleware to the routes behind
 * it, and the real runtime always supplies one. It is created per request here
 * for the same reason, and kept so a test can read what the middleware put in
 * it -- which is how the invite label reaches /api/feedback.
 */
let lastData = null;
const run = (r, e = env) => {
  lastData = {};
  return mod.onRequest({ request: r, env: e, next, data: lastData });
};
const results = [];
const check = (label, cond) => results.push(`  ${cond ? "OK  " : "МИМО"} ${label}`);

// 1. Без куки — приложение не отдаётся
let r = await run(req("GET"));
check("GET без сессии -> 401, приложение не отдано", r.status === 401 && served === 0);
check("в теле форма логина, не код приложения", (await r.text()).includes("КОД ПРИГЛАШЕНИЯ"));

// 2. Неверный код
r = await run(req("POST", { code: "НЕВЕРНЫЙ" }));
check("неверный код -> 401", r.status === 401 && served === 0);

// 3. Верный код выдаёт куку
r = await run(req("POST", { code: "DJ-AAAA-BBBB-CCCC" }));
const setCookie = r.headers.get("Set-Cookie") || "";
check("верный код -> 303 редирект", r.status === 303);
check("кука HttpOnly", /HttpOnly/.test(setCookie));
check("кука Secure", /Secure/.test(setCookie));
check("кука SameSite=Lax", /SameSite=Lax/.test(setCookie));
const token = setCookie.split(";")[0].split("=").slice(1).join("=");

// 4. С валидной кукой приложение отдаётся
r = await run(req("GET", { cookie: "sortir_session=" + token }));
check("валидная сессия -> приложение отдано", served === 1 && (await r.text()) === "ПРИЛОЖЕНИЕ");
check("метка сессии передана дальше", lastData.invite === "tester-one");

// 4a. Отклонённая сессия не оставляет метку: иначе маршрут за гейтом принял бы
//     её за подтверждённую и записал бы исправление от чужого имени.
r = await run(req("GET", { cookie: "sortir_session=" + token.slice(0, -4) + "ZZZZ" }));
check("отклонённая сессия метку не оставляет", lastData.invite === undefined);

// 5. Подделка подписи
const tampered = token.slice(0, -4) + "AAAA";
r = await run(req("GET", { cookie: "sortir_session=" + tampered }));
check("подделанная подпись отклонена", r.status === 401 && served === 1);

// 6. Подмена срока действия в открытой части
const parts = token.split(".");
const forged = [String(Math.floor(Date.now()/1000) + 999999), parts[1], parts[2]].join(".");
r = await run(req("GET", { cookie: "sortir_session=" + forged }));
check("продление срока без подписи отклонено", r.status === 401 && served === 1);

// 7. Просроченная сессия (подписываем прошедшее время настоящим секретом)
const enc = new TextEncoder();
const key = await crypto.subtle.importKey("raw", enc.encode(SECRET), {name:"HMAC",hash:"SHA-256"}, false, ["sign"]);
const b64u = b => Buffer.from(b).toString("base64").replace(/\+/g,"-").replace(/\//g,"_").replace(/=+$/,"");
const past = `${Math.floor(Date.now()/1000) - 10}.tester-one`;
const expired = `${past}.${b64u(await crypto.subtle.sign("HMAC", key, enc.encode(past)))}`;
r = await run(req("GET", { cookie: "sortir_session=" + expired }));
check("просроченная сессия отклонена", r.status === 401 && served === 1);

// 8. Ротация секрета аннулирует старые куки
r = await run(req("GET", { cookie: "sortir_session=" + token }), { ...env, SESSION_SECRET: "другой-секрет" });
check("смена SESSION_SECRET рвёт все сессии", r.status === 401);

// 9. Выход: POST /logout гасит куку
const logoutReq = (method, cookie) => new Request("https://example.com/logout", {
  method, headers: cookie ? { Cookie: cookie } : {},
});
r = await run(logoutReq("POST", "sortir_session=" + token));
const cleared = r.headers.get("Set-Cookie") || "";
check("POST /logout -> 303 на /", r.status === 303 && r.headers.get("Location") === "/");
check("кука гасится (Max-Age=0)", /Max-Age=0/.test(cleared) && /sortir_session=;/.test(cleared));
check("гасящая кука тоже HttpOnly и Secure", /HttpOnly/.test(cleared) && /Secure/.test(cleared));

// 10. Выход работает и без сессии, и приложение при этом не отдаётся
const servedBefore = served;
r = await run(logoutReq("POST"));
check("выход без сессии -> 303, приложение не отдано", r.status === 303 && served === servedBefore);

// 11. GET /logout не гасит куку: иначе чужая ссылка выкидывала бы пользователя
r = await run(logoutReq("GET", "sortir_session=" + token));
check("GET /logout ничего не гасит", !/Max-Age=0/.test(r.headers.get("Set-Cookie") || ""));

// 12. После выхода прежняя кука должна перестать пускать
//     (сервер её погасил у клиента; сама подпись остаётся валидной, поэтому
//      проверяем именно то, что гарантирует сервер — гашение, а не отзыв)

// 11a. Метка тестировщика доходит целиком, какой бы она ни была
const labelFor = async (code) => {
  const resp = await run(req("POST", { code }));
  const tok = (resp.headers.get("Set-Cookie") || "").split(";")[0].split("=").slice(1).join("=");
  await run(req("GET", { cookie: "sortir_session=" + tok }));
  return lastData.invite;
};

check("русская метка не теряется", (await labelFor("DJ-1111-2222-3333")) === "Ваня");
check("метка с пробелом доходит целиком", (await labelFor("DJ-4444-5555-6666")) === "клуб Осень");
check("точка внутри метки не ломает разбор", (await labelFor("DJ-7777-8888-9999")) === "клуб им. Кирова");
check("латинская метка как была", (await labelFor("DJ-AAAA-BBBB-CCCC")) === "tester-one");

// 11b. Сессии, выданные до перехода на кодирование, продолжают пускать:
//      в них метка записана открытым ASCII, и раскодирование её не меняет.
const legacyPayload = `${Math.floor(Date.now()/1000) + 9999}.tester-one`;
const legacyEnc = new TextEncoder();
const legacyKey = await crypto.subtle.importKey(
  "raw", legacyEnc.encode(SECRET), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
const legacyB64 = (b) => Buffer.from(b).toString("base64")
  .replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const legacyToken = `${legacyPayload}.${legacyB64(
  await crypto.subtle.sign("HMAC", legacyKey, legacyEnc.encode(legacyPayload)))}`;
const servedBeforeLegacy = served;
r = await run(req("GET", { cookie: "sortir_session=" + legacyToken }));
check("сессия, выданная до изменения, ещё действует",
  served === servedBeforeLegacy + 1 && lastData.invite === "tester-one");

// 12a. POST с JSON без сессии — это не попытка входа, а запрос от приложения,
//      у которого истекла сессия. Должен получить отказ, а не 500.
const jsonPost = new Request("https://example.com/api/feedback", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify([{ corrected: "Techno" }]),
});
const servedBeforeJson = served;
r = await run(jsonPost);
check("POST с JSON без сессии -> 401, а не 500", r.status === 401);
check("и приложение при этом не отдано", served === servedBeforeJson);

// 13. Забыли настроить — закрыто, а не открыто
// 14. Ограничение частоты попыток входа
{
  const db = makeAttemptsDb();
  const envRL = { ...env, DB: db };
  const guess = (ip) => run(req("POST", { code: "НЕВЕРНЫЙ", ip }), envRL);

  let last;
  for (let i = 0; i < 10; i++) last = await guess("203.0.113.7");
  check("десять неверных попыток ещё отвечают 401", last.status === 401);

  last = await guess("203.0.113.7");
  check("одиннадцатая -> 429", last.status === 429);
  check("сказано, когда повторить", Number(last.headers.get("Retry-After")) > 0);
  check("в теле объяснение, а не пустая ошибка",
    (await last.text()).includes("Слишком много попыток"));

  // Правильный код от заблокированного адреса тоже не проходит: иначе
  // ограничение снималось бы подбором, ради которого оно и стоит.
  last = await run(req("POST", { code: "DJ-AAAA-BBBB-CCCC", ip: "203.0.113.7" }), envRL);
  check("верный код с заблокированного адреса -> 429", last.status === 429);

  // Счёт ведётся по адресу, а не глобально: чужой перебор не должен запирать
  // тестировщика, который ни при чём.
  last = await run(req("POST", { code: "DJ-AAAA-BBBB-CCCC", ip: "198.51.100.2" }), envRL);
  check("другой адрес не затронут", last.status === 303);

  // Успешный вход стирает прежние неудачи этого адреса.
  const db2 = makeAttemptsDb();
  const env2 = { ...env, DB: db2 };
  for (let i = 0; i < 5; i++) await run(req("POST", { code: "МИМО", ip: "198.51.100.9" }), env2);
  await run(req("POST", { code: "DJ-AAAA-BBBB-CCCC", ip: "198.51.100.9" }), env2);
  check("успешный вход обнуляет счётчик",
    db2.rows.filter((r) => r.ip === "198.51.100.9").length === 0);

  // Недоступная база не должна запирать вход: иначе сбой хранилища
  // превращается в отказ в обслуживании для тех, кто ни в чём не виноват.
  const envBroken = { ...env, DB: makeAttemptsDb({ fail: true }) };
  last = await run(req("POST", { code: "DJ-AAAA-BBBB-CCCC", ip: "203.0.113.7" }), envBroken);
  check("сбой базы не запирает вход", last.status === 303);

  // Без привязки базы ограничение просто не действует, а не падает.
  last = await run(req("POST", { code: "DJ-AAAA-BBBB-CCCC", ip: "203.0.113.7" }), env);
  check("без базы вход работает как раньше", last.status === 303);
}

const servedBeforeUnconfigured = served;
r = await run(req("GET"), { SESSION_SECRET: "", INVITE_CODES: "" });
check("без настройки -> 503, приложение не отдано",
  r.status === 503 && served === servedBeforeUnconfigured);

console.log(results.join("\n"));
console.log(`\n  пройдено ${results.filter(x=>x.startsWith("  OK")).length}/${results.length}`);
