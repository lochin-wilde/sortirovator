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
 *   node tools/test_style.mjs
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

// The admin page links styles.css; its inline additions must use tokens, not hex.
const adminStyle = styleOf(readFileSync("web/admin.html", "utf8"));
check("админка: дополнительные стили без захардкоженных цветов",
  !/#[0-9a-f]{3,8}\b/i.test(adminStyle));

// The link card is drawn by a script, so it is checked against the same system.
const og = readFileSync("tools/make_og_image.py", "utf8");
const rgb = (hex) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16)).join(", ");
check("карточка ссылки: акцент из палитры приложения",
  og.includes(`ACCENT = (${rgb(SYSTEM_DARK.accent)})`));
check("карточка ссылки: фон из палитры приложения",
  og.includes(`GROUND = (${rgb(SYSTEM_DARK.bg)})`));

const failed = results.filter((line) => line.includes("МИМО"));
for (const line of failed) console.log(line);
console.log(`пройдено ${results.length - failed.length}/${results.length}`);
process.exit(failed.length === 0 ? 0 : 1);
