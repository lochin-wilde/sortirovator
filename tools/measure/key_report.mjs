/*
 * Reads key results written by measure_key.mjs and says where the detector
 * goes wrong -- and, given two result files, whether a change helped.
 *
 * One number hides the two weaknesses that matter: confusing a key with its
 * relative major/minor (8A vs 8B), and calling majors minor. So the report
 * separates them:
 *
 *   exact        same key
 *   compatible   exact, relative (8A/8B), or one step round the wheel (8A/7A/9A)
 *   by mode      the same scores for tracks whose true key is minor (A) and
 *                major (B), and how often the mode itself is wrong
 *   error pairs  the commonest (truth -> ours) mistakes, with their relation
 *   per key      exact rate for each of the 24 true keys
 *
 * Held-out halves
 * ---------------
 * --half train|test keeps the tracks whose name hashes into that half. Choose
 * parameters on "train", report on "test": a best-of-many sweep always beats
 * the baseline on the data it was tuned on. The split depends only on the
 * track name, so it is the same for every run and every results file.
 *
 * Comparing two runs
 * ------------------
 * --compare BEFORE.json AFTER.json pairs the tracks both files scored and
 * runs McNemar's test on exact matches: only tracks that changed verdict carry
 * information, and the test asks whether the changes lean one way by more than
 * chance. It also reports, separately, how many answers became "no key" --
 * a detector that refuses to answer can look better on what it does answer.
 *
 * Usage
 * -----
 *   node tools/measure/key_report.mjs [RESULTS.json] [--half train|test] [--top N]
 *   node tools/measure/key_report.mjs --compare BEFORE.json AFTER.json [--half test]
 *   (default results file: ground-truth/key_results.json)
 */

import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = fileURLToPath(new URL(".", import.meta.url));
const ROOT = join(HERE, "../..");

/* ------------------------------------------------------------------ */
/* Pure parts -- exported for tools/test/test_key_report.mjs           */
/* ------------------------------------------------------------------ */

const CAMELOT = /^(\d{1,2})([AB])$/;

export function parseCamelot(value) {
  const m = CAMELOT.exec(String(value || "").trim().toUpperCase());
  if (!m) return null;
  const n = parseInt(m[1], 10);
  return n >= 1 && n <= 12 ? { n, letter: m[2] } : null;
}

// Same categories as measure_key.mjs, so old result files read the same way.
export function relation(ours, truth) {
  const a = parseCamelot(ours);
  const b = parseCamelot(truth);
  if (!b) return "unlabelled";
  if (!a) return "failed";
  if (a.n === b.n && a.letter === b.letter) return "exact";
  if (a.n === b.n) return "relative";
  const step = Math.abs(a.n - b.n);
  if (a.letter === b.letter && (step === 1 || step === 11)) return "neighbour";
  return "wrong";
}

const COMPATIBLE = new Set(["exact", "relative", "neighbour"]);

/*
 * Which held-out half a track belongs to. FNV-1a over the name: stable across
 * runs, machines and Node versions, and unrelated to folder or key, so neither
 * half is easier by construction.
 */
export function halfOf(name) {
  let h = 0x811c9dc5;
  const s = String(name);
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h % 2 === 0 ? "train" : "test";
}

export function summarize(rows) {
  const scored = rows.filter((r) => parseCamelot(r.truth));
  const count = (pred) => scored.filter(pred).length;
  const rate = (k, n) => (n ? k / n : 0);
  const verdict = (r) => relation(r.ours, r.truth);

  const byMode = {};
  for (const [mode, letter] of [["minor", "A"], ["major", "B"]]) {
    const group = scored.filter((r) => parseCamelot(r.truth).letter === letter);
    const exact = group.filter((r) => verdict(r) === "exact").length;
    const compatible = group.filter((r) => COMPATIBLE.has(verdict(r))).length;
    // Mode wrong: we answered, and the letter differs from the truth's.
    const modeWrong = group.filter((r) => {
      const a = parseCamelot(r.ours);
      return a && a.letter !== letter;
    }).length;
    byMode[mode] = {
      n: group.length,
      exact: rate(exact, group.length),
      compatible: rate(compatible, group.length),
      modeWrong: rate(modeWrong, group.length),
    };
  }

  const pairs = new Map();
  for (const r of scored) {
    const v = verdict(r);
    if (v === "exact") continue;
    const key = String(r.truth).toUpperCase() + " -> " + (parseCamelot(r.ours) ? String(r.ours).toUpperCase() : "none");
    const entry = pairs.get(key) || { pair: key, relation: v, n: 0 };
    entry.n++;
    pairs.set(key, entry);
  }

  const perKey = {};
  for (const r of scored) {
    const k = String(r.truth).toUpperCase();
    perKey[k] = perKey[k] || { n: 0, exact: 0 };
    perKey[k].n++;
    if (verdict(r) === "exact") perKey[k].exact++;
  }

  const categories = {};
  for (const r of scored) categories[verdict(r)] = (categories[verdict(r)] || 0) + 1;

  return {
    n: scored.length,
    exact: rate(count((r) => verdict(r) === "exact"), scored.length),
    compatible: rate(count((r) => COMPATIBLE.has(verdict(r))), scored.length),
    failed: rate(count((r) => verdict(r) === "failed"), scored.length),
    categories,
    byMode,
    pairs: [...pairs.values()].sort((a, b) => b.n - a.n || a.pair.localeCompare(b.pair)),
    perKey,
  };
}

/*
 * McNemar on paired exact/not-exact verdicts. b = right before, wrong after;
 * c = wrong before, right after. Exact two-sided binomial p for small b + c,
 * the continuity-corrected chi-square above that; z keeps the sign, so a
 * negative z is a change for the worse.
 */
export function mcnemar(before, after) {
  const right = (r) => relation(r.ours, r.truth) === "exact";
  const index = new Map(before.filter((r) => parseCamelot(r.truth)).map((r) => [r.name, r]));
  let b = 0;
  let c = 0;
  let n = 0;
  let newlyNone = 0;
  let noLongerNone = 0;
  for (const r of after) {
    const old = index.get(r.name);
    if (!old || !parseCamelot(r.truth)) continue;
    n++;
    const was = right(old);
    const now = right(r);
    if (was && !now) b++;
    if (!was && now) c++;
    const hadKey = parseCamelot(old.ours) !== null;
    const hasKey = parseCamelot(r.ours) !== null;
    if (hadKey && !hasKey) newlyNone++;
    if (!hadKey && hasKey) noLongerNone++;
  }
  const discordant = b + c;
  let p;
  if (discordant === 0) {
    p = 1;
  } else if (discordant <= 50) {
    // Two-sided exact binomial with p = 0.5.
    const k = Math.min(b, c);
    let tail = 0;
    let term = Math.pow(0.5, discordant);
    for (let i = 0; i <= k; i++) {
      tail += term;
      term = (term * (discordant - i)) / (i + 1);
    }
    p = Math.min(1, 2 * tail);
  } else {
    const chi2 = Math.pow(Math.abs(b - c) - 1, 2) / discordant;
    p = chiSquare1Tail(chi2);
  }
  const z = discordant === 0 ? 0 : (c - b) / Math.sqrt(discordant);
  return { n, worse: b, better: c, z, p, newlyNone, noLongerNone };
}

// Survival function of chi-square with 1 degree of freedom: erfc(sqrt(x/2)).
function chiSquare1Tail(x) {
  return erfc(Math.sqrt(x / 2));
}

function erfc(x) {
  // Abramowitz & Stegun 7.1.26, |error| < 1.5e-7 -- plenty for a p-value.
  const t = 1 / (1 + 0.3275911 * x);
  const poly = t * (0.254829592 + t * (-0.284496736 + t * (1.421413741 + t * (-1.453152027 + t * 1.061405429))));
  return poly * Math.exp(-x * x);
}

/* ------------------------------------------------------------------ */
/* Command line                                                        */
/* ------------------------------------------------------------------ */

function load(path) {
  if (!existsSync(path)) throw new Error("no results file at " + path);
  const data = JSON.parse(readFileSync(path, "utf8"));
  const rows = data.results || data;
  // measure_key.mjs keys results by file path in `name`.
  return rows.map((r) => ({ name: r.name || r.file, ours: r.ours, truth: r.truth, confident: r.confident }));
}

function option(flag, fallback) {
  const i = process.argv.indexOf(flag);
  return i > 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const pct = (x) => (100 * x).toFixed(1) + "%";

function printReport(title, rows, top) {
  const s = summarize(rows);
  console.log(`\n${title}: ${s.n} tracks`);
  console.log(`  exact        ${pct(s.exact)}`);
  console.log(`  compatible   ${pct(s.compatible)}   (exact + relative + one step on the wheel)`);
  console.log(`  no answer    ${pct(s.failed)}`);
  console.log("  " + Object.entries(s.categories).map(([k, v]) => `${k} ${v}`).join(" · "));
  for (const mode of ["minor", "major"]) {
    const m = s.byMode[mode];
    console.log(`  ${mode.padEnd(6)} n=${String(m.n).padStart(4)}  exact ${pct(m.exact).padStart(6)}  compatible ${pct(m.compatible).padStart(6)}  mode wrong ${pct(m.modeWrong).padStart(6)}`);
  }
  const confident = rows.filter((r) => r.confident === true && parseCamelot(r.truth));
  const unsure = rows.filter((r) => r.confident === false && parseCamelot(r.truth));
  for (const [label, group] of [["marked sure", confident], ["marked unsure (?)", unsure]]) {
    if (!group.length) continue;
    const ex = group.filter((r) => relation(r.ours, r.truth) === "exact").length;
    console.log(`  ${label.padEnd(18)} n=${String(group.length).padStart(4)}  exact ${pct(ex / group.length)}`);
  }
  console.log(`\n  commonest mistakes (truth -> ours):`);
  for (const p of s.pairs.slice(0, top)) {
    console.log(`    ${p.pair.padEnd(14)} ${String(p.n).padStart(4)}  ${p.relation}`);
  }
  console.log(`\n  exact by true key:`);
  const keys = Object.keys(s.perKey).sort((a, b) => {
    const x = parseCamelot(a); const y = parseCamelot(b);
    return x.n - y.n || x.letter.localeCompare(y.letter);
  });
  const cells = keys.map((k) => `${k.padStart(3)} ${pct(s.perKey[k].exact / s.perKey[k].n).padStart(6)} (${s.perKey[k].n})`);
  for (let i = 0; i < cells.length; i += 4) console.log("    " + cells.slice(i, i + 4).join("   "));
}

function main() {
  const half = option("--half", null);
  const top = Number(option("--top", 15));
  const keep = (rows) => (half ? rows.filter((r) => halfOf(r.name) === half) : rows);
  const suffix = half ? ` [${half} half]` : "";

  const compareAt = process.argv.indexOf("--compare");
  if (compareAt > 0) {
    const before = keep(load(process.argv[compareAt + 1]));
    const after = keep(load(process.argv[compareAt + 2]));
    printReport("before" + suffix, before, top);
    printReport("after" + suffix, after, top);
    const t = mcnemar(before, after);
    console.log(`\nMcNemar on exact, ${t.n} paired tracks${suffix}:`);
    console.log(`  better ${t.better}  worse ${t.worse}  z = ${t.z.toFixed(2)}  p = ${t.p < 0.0001 ? t.p.toExponential(1) : t.p.toFixed(4)}`);
    console.log(`  answers that became "no key": ${t.newlyNone}   (and the other way: ${t.noLongerNone})`);
    return;
  }

  const path = process.argv[2] && !process.argv[2].startsWith("--")
    ? process.argv[2] : join(ROOT, "ground-truth/key_results.json");
  printReport("key" + suffix, keep(load(path)), top);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main();
