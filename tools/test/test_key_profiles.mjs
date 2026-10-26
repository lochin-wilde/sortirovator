/*
 * Checks the scoring used to compare key profiles. A slip here -- a profile
 * read from the wrong end, the bias applied to the wrong mode -- would make
 * a published profile look worse or better than it is.
 *
 *   node tools/test/test_key_profiles.mjs
 */
import { readFileSync } from "node:fs";
import { PROFILES, decideKey } from "../measure/try_key_profiles.mjs";

const results = [];
const check = (label, cond) => results.push(`  ${cond ? "OK  " : "МИМО"} ${label}`);

const dsp = new Function(readFileSync("web/js/dsp.js", "utf8")
  + "return { pearson, CAMELOT_MAJOR, CAMELOT_MINOR, KEY_MAJOR_PROFILE, KEY_MINOR_PROFILE, KEY_MINOR_BIAS };")();
const decide = (chroma, profile, bias) =>
  decideKey(chroma, profile, bias, dsp.pearson, dsp.CAMELOT_MAJOR, dsp.CAMELOT_MINOR).key;

// Pitch classes from C. A chord's notes at 1, the rest at a small floor.
const chord = (...pcs) => Array.from({ length: 12 }, (_, i) => (pcs.includes(i) ? 1 : 0.05));
const C_MAJOR = chord(0, 4, 7);
const A_MINOR = chord(9, 0, 4);
const G_MAJOR = chord(7, 11, 2);
const E_MINOR = chord(4, 7, 11);

/* ---------- Tables ---------- */

for (const [name, p] of Object.entries(PROFILES)) {
  const parts = Object.values(p);
  check(`${name}: в каждом профиле 12 чисел`, parts.every((a) => a.length === 12 && a.every(Number.isFinite)));
  check(`${name}: тоника — самая сильная ступень`, parts.every((a) => a[0] === Math.max(...a)));
}
check("у каждого профиля ровно мажор и минор", Object.values(PROFILES).every((p) => Object.keys(p).join() === "major,minor"));

/* ---------- Decisions ---------- */

for (const [name, profile] of Object.entries(PROFILES)) {
  check(`${name}: до-мажорное трезвучие -> 8B`, decide(C_MAJOR, profile, 1) === "8B");
  check(`${name}: ля-минорное трезвучие -> 8A`, decide(A_MINOR, profile, 1) === "8A");
  check(`${name}: соль мажор -> 9B, ми минор -> 9A`, decide(G_MAJOR, profile, 1) === "9B" && decide(E_MINOR, profile, 1) === "9A");
}

const shipped = { major: dsp.KEY_MAJOR_PROFILE, minor: dsp.KEY_MINOR_PROFILE };
check("встроенный профиль: до мажор -> 8B", decide(C_MAJOR, shipped, 1) === "8B");
{
  // A large enough minor bias turns even a clean major triad minor -- and
  // never the other way round.
  const tipped = decide(C_MAJOR, shipped, 3);
  check(`большая надбавка переводит до мажор в минор (${tipped})`, tipped.endsWith("A"));
  check("надбавка меньше 1 не делает минор мажором", decide(A_MINOR, shipped, 0.95) === "8A");
}

check("пустая хрома не выдумывает тональность", decide(new Array(12).fill(0), shipped, 1) === null);

/* ---------- report ---------- */

const failed = results.filter((line) => line.includes("МИМО"));
console.log(results.join("\n"));
console.log(`\nпройдено ${results.length - failed.length}/${results.length}`);
process.exit(failed.length > 0 ? 1 : 0);
