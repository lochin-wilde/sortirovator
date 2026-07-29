import { readFileSync } from "node:fs";
const src = readFileSync(process.argv[2], "utf8");
const mod = await import("data:text/javascript;base64," + Buffer.from(src).toString("base64"));

const SECRET = "тестовый-секрет-32-байта-минимум-ок";
const CODES = JSON.stringify({ "DJ-AAAA-BBBB-CCCC": "tester-one", "DJ-DDDD-EEEE-FFFF": "tester-two" });
const env = { SESSION_SECRET: SECRET, INVITE_CODES: CODES };
let served = 0;
const next = async () => { served++; return new Response("ПРИЛОЖЕНИЕ", { status: 200 }); };

const req = (method, opts = {}) => new Request("https://example.com/", {
  method,
  headers: opts.cookie ? { Cookie: opts.cookie } : {},
  body: opts.code !== undefined ? new URLSearchParams({ code: opts.code }) : undefined,
});

const run = (r, e = env) => mod.onRequest({ request: r, env: e, next });
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

// 9. Забыли настроить — закрыто, а не открыто
r = await run(req("GET"), { SESSION_SECRET: "", INVITE_CODES: "" });
check("без настройки -> 503, приложение не отдано", r.status === 503 && served === 1);

console.log(results.join("\n"));
console.log(`\n  пройдено ${results.filter(x=>x.startsWith("  OK")).length}/${results.length}`);
