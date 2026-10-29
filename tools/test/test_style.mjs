/*
 * Keeps every surface of the project on one set of design tokens.
 *
 * web/css/styles.css is the design system. Two pages cannot link it -- the
 * landing and the login page, because the gate answers every other path with
 * the login page itself -- so they carry the same custom properties inline.
 * Inline copies drift: before this test existed the landing was drawn in a
 * green of its own and the login page in a blue that was close to the app's but
 * not equal to it, so the three screens a visitor passes through looked like
 * three products.
 *
 * This fails the moment a token differs, or an off-palette colour creeps into a
 * page that is supposed to be on the system.
 *
 *   node tools/test/test_style.mjs
 */
import { readFileSync } from "node:fs";

const results = [];
const check = (label, cond) => results.push(`  ${cond ? "OK  " : "МИМО"} ${label}`);

/*
 * Custom properties declared in a `:root { ... }` block. `light` picks the one
 * inside `@media (prefers-color-scheme: light)`, otherwise the first bare one.
 */
function tokens(css, light) {
  let body;
  if (light) {
    const media = css.indexOf("prefers-color-scheme: light");
    if (media < 0) return null;
    const open = css.indexOf(":root", media);
    body = css.slice(css.indexOf("{", open) + 1, css.indexOf("}", open));
  } else {
    const open = css.search(/(^|\n)\s*:root\s*\{/);
    if (open < 0) return null;
    const brace = css.indexOf("{", open);
    body = css.slice(brace + 1, css.indexOf("}", brace));
  }
  const out = {};
  for (const [, name, value] of body.matchAll(/--([\w-]+)\s*:\s*([^;]+);/g)) {
    out[name] = value.trim().toLowerCase();
  }
  return out;
}

const styleOf = (text) => {
  const start = text.indexOf("<style>");
  return start < 0 ? text : text.slice(start, text.indexOf("</style>", start));
};

const system = readFileSync("web/css/styles.css", "utf8");
const SYSTEM_DARK = tokens(system, false);
const SYSTEM_LIGHT = tokens(system, true);
check("в styles.css найдены токены тёмной темы", Object.keys(SYSTEM_DARK).length >= 10);
check("в styles.css найдены токены светлой темы", Object.keys(SYSTEM_LIGHT).length >= 6);

const allowed = new Set([...Object.values(SYSTEM_DARK), ...Object.values(SYSTEM_LIGHT), "#fff", "#ffffff"]);

const surfaces = [
  ["витрина", styleOf(readFileSync("web/landing.html", "utf8"))],
  ["страница логина", styleOf(readFileSync("functions/_middleware.js", "utf8")
    .slice(readFileSync("functions/_middleware.js", "utf8").indexOf("function loginPage(")))],
];

for (const [name, css] of surfaces) {
  const dark = tokens(css, false) || {};
  const light = tokens(css, true) || {};
  const darkDiff = Object.keys(SYSTEM_DARK).filter((k) => dark[k] !== SYSTEM_DARK[k]);
  const lightDiff = Object.keys(SYSTEM_LIGHT).filter((k) => light[k] !== SYSTEM_LIGHT[k]);
  check(`${name}: тёмные токены совпадают с приложением`
    + (darkDiff.length ? ` (расходятся: ${darkDiff.join(", ")})` : ""), darkDiff.length === 0);
  check(`${name}: светлые токены совпадают с приложением`
    + (lightDiff.length ? ` (расходятся: ${lightDiff.join(", ")})` : ""), lightDiff.length === 0);

  const stray = [...css.matchAll(/#[0-9a-f]{3,8}\b/gi)]
    .map((m) => m[0].toLowerCase()).filter((hex) => !allowed.has(hex));
  check(`${name}: нет цветов вне палитры`
    + (stray.length ? ` (${[...new Set(stray)].join(", ")})` : ""), stray.length === 0);
}

/*
 * Static pages carry no inline style at all. web/_headers sets style-src 'self',
 * so a <style> block or a style="" attribute in a page served as a file is
 * silently dropped by the browser. The admin page's own styles were inline,
 * and a local preview, which sends no such header, would never show it.
 * (landing.html and loginPage() are served by the middleware, outside that
 * policy, and are checked against the tokens above instead.)
 */
for (const page of ["web/index.html", "web/admin.html"]) {
  const html = readFileSync(page, "utf8");
  check(`${page}: нет встроенных стилей (их блокирует CSP)`,
    !/<style[\s>]/i.test(html) && !/\sstyle\s*=/i.test(html));
}

/*
 * The track panel's player plays the user's own file through a blob: URL
 * (app.js, placePlayer). Without media-src the policy falls back to
 * default-src 'self', which refuses it: the player sat dead on the live site
 * while a local preview, sending no policy, played fine, and only the grid
 * editor -- Web Audio, outside media-src -- made a sound.
 */
{
  const csp = (readFileSync("web/_headers", "utf8").match(/Content-Security-Policy:\s*(.+)/) || [])[1] || "";
  const directive = (name) => (csp.split(";").map((d) => d.trim().split(/\s+/)).find((d) => d[0] === name) || []).slice(1);
  const usesBlobAudio = /createObjectURL\(file\)/.test(readFileSync("web/js/app.js", "utf8"));
  check("CSP: плеер может играть файл с диска (media-src 'self' blob:)",
    !usesBlobAudio || (directive("media-src").includes("blob:") && directive("media-src").includes("'self'")));
}

// The link card is drawn by a script, so it is checked against the same system.
const og = readFileSync("tools/build/make_og_image.py", "utf8");
const rgb = (hex) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16)).join(", ");
check("карточка ссылки: акцент из палитры приложения",
  og.includes(`ACCENT = (${rgb(SYSTEM_DARK.accent)})`));
check("карточка ссылки: фон из палитры приложения",
  og.includes(`GROUND = (${rgb(SYSTEM_DARK.bg)})`));

const failed = results.filter((line) => line.includes("МИМО"));
for (const line of failed) console.log(line);
console.log(`пройдено ${results.length - failed.length}/${results.length}`);
process.exit(failed.length === 0 ? 0 : 1);
