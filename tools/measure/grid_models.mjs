/*
 * Refits the grid's two decisions from ground-truth/grid_features.json
 * (tools/measure/grid_features.mjs) and scores them on the held-out half.
 *
 *   flip     which of two half-beat phases is the beat. Now: a logistic model
 *            over band on/off shares and the kick (beatgrid.js). Added here:
 *            how much sharper the bar boundaries are on the grid than half a
 *            beat away (downbeat.js) -- a bar starts on a beat.
 *   verdict  whether the grid is written. Before: a confidence model, plus a
 *            hard "no" whenever the tempo detector says the tempo moves.
 *            Here: the same model with the bar evidence and the tempo range
 *            as inputs, and the "dynamic" verdict as one input among others.
 *
 * The models these experiments chose are in beatgrid.js (gridDecision); the
 * last section scores that code on the same rows, so the shipped numbers are
 * the ones printed here. "Before" is rebuilt from the fit with the earlier
 * weights below, so the comparison holds whatever estimateBeatGrid did when
 * the features were dumped.
 *
 * A grid is good when it matches Rekordbox's beats within 70 ms on at least
 * 80% of them (F-measure, as measure_grid.mjs). Rekordbox grids that change
 * tempo are included: a one-tempo grid on such a track scores as it scores.
 *
 *   node tools/measure/grid_models.mjs [--in FILE]
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ROOT, loadDsp, arg } from "./lib/measure.mjs";
import { scoreGrid } from "./measure_grid.mjs";
import { halfOf } from "./key_report.mjs";

const GOOD_F = 0.8;
// The confidence model before the bar evidence, threshold 0.75, never on "dynamic".
const BEFORE_CONFIDENCE = [2.421, -0.802, -0.559, -1.043, -0.879, -0.211, 0.401, 0.227, -0.407, -0.142, -0.255, 0.37, -1.031, -0.258, 0.947, 0.129, -0.784];

export function fitLogistic(X, y, { iterations = 4000, rate = 0.3, l2 = 1e-3 } = {}) {
  const d = X[0].length;
  const w = new Float64Array(d + 1);
  for (let it = 0; it < iterations; it++) {
    const g = new Float64Array(d + 1);
    for (let i = 0; i < X.length; i++) {
      let z = w[d];
      for (let j = 0; j < d; j++) z += w[j] * X[i][j];
      const err = 1 / (1 + Math.exp(-z)) - y[i];
      for (let j = 0; j < d; j++) g[j] += err * X[i][j];
      g[d] += err;
    }
    for (let j = 0; j <= d; j++) w[j] -= rate * (g[j] / X.length + (j < d ? l2 * w[j] : 0));
  }
  return Array.from(w, (v) => Math.round(v * 1000) / 1000);
}

export const logit = (w, x) => w[x.length] + x.reduce((s, v, j) => s + w[j] * v, 0);

function mcnemar(rows, a, b) {
  let fixed = 0, broken = 0;
  for (const r of rows) { const x = a(r), y = b(r); if (!x && y) fixed++; if (x && !y) broken++; }
  return { fixed, broken, chi: fixed + broken ? ((Math.abs(fixed - broken) - 1) ** 2) / (fixed + broken) : 0 };
}

const pct = (k, n) => (n ? ((100 * k) / n).toFixed(1) + "%" : "-");

function main() {
  const dsp = loadDsp(["gridEvidence", "kickFirstBeat", "gridDecision", "DOWNBEAT_WEIGHTS"],
    readFileSync(join(ROOT, "web/js/beatgrid.js"), "utf8") + readFileSync(join(ROOT, "web/js/downbeat.js"), "utf8"));
  const { results } = JSON.parse(readFileSync(arg("--in", join(ROOT, "ground-truth/grid_features.json")), "utf8"));
  const grids = JSON.parse(readFileSync(join(ROOT, "ground-truth/rekordbox_grids.json"), "utf8")).byName;
  const base = (p) => p.slice(p.lastIndexOf("/") + 1);
  const W = dsp.DOWNBEAT_WEIGHTS;
  const barScore = (c) => Math.max(...c.map((x, p) => x.reduce((s, v, j) => s + W[j] * v, 0) + (p === 0 ? W[x.length] : 0)));
  const featureMax = (c, j) => Math.max(...c.map((x) => x[j]));

  const rows = [];
  for (const r of results) {
    if (r.error) continue;
    const g = grids[base(r.name)];
    if (!g) continue;
    const half = halfOf(r.name);
    if (!r.fit || !r.final || !r.onBeat || !r.offBeat) { rows.push({ half, graded: false }); continue; }
    const tempos = g.tempos.map(([, t]) => t / 100);
    // "Now" is the grid the kick flip picks, which onBeat describes; "alt" is
    // half a beat later, offBeat.
    const first = dsp.kickFirstBeat(r.fit) + r.rekordboxOffset;
    const fNow = scoreGrid(g.ms, r.fit.bpm, first, 0).f;
    const fAlt = scoreGrid(g.ms, r.fit.bpm, first + r.fit.period / 2, 0).f;
    const ev = dsp.gridEvidence(r.fit, r.tempo.mode);
    const bar = barScore(r.onBeat) - barScore(r.offBeat);
    const barDiffs = r.onBeat[0].map((_, j) => featureMax(r.onBeat, j) - featureMax(r.offBeat, j));
    const confidence = 1 / (1 + Math.exp(-logit(BEFORE_CONFIDENCE, ev.features)));
    rows.push({
      half, graded: true, name: r.name, variable: Math.max(...tempos) - Math.min(...tempos) > 0.5,
      place: confidence >= 0.75 && r.tempo.mode !== "dynamic", confidence, shipped: dsp.gridDecision(r.fit, r.tempo, r.onBeat, r.offBeat),
      goodNow: fNow >= GOOD_F, goodAlt: fAlt >= GOOD_F, z: ev.z, x: ev.x, features: ev.features,
      // Evidence that the half-beat phase *away from* final is the beat.
      barAway: -bar, barDiffsAway: barDiffs.map((v) => -v),
      tempo: r.tempo,
    });
  }
  const train = rows.filter((r) => r.half === "train");
  const test = rows.filter((r) => r.half === "test");
  console.log(`tracks: train ${train.length} (graded ${train.filter((r) => r.graded).length}), test ${test.length} (graded ${test.filter((r) => r.graded).length})`);

  /* ---------- 1. flip ---------- */

  // Features for "switch away from what the kick flip chose": the kick flip
  // score signed so positive means "switch" -- always -|z|, since it chose by
  // its sign -- and the bar evidence.
  const flipVariants = {
    "bar evidence only": (r) => [r.barAway],
    "old score + bar evidence": (r) => [-Math.abs(r.z), r.barAway],
    "old score + bar evidence + per-feature bar differences": (r) => [-Math.abs(r.z), r.barAway, ...r.barDiffsAway],
  };
  const matters = (r) => r.graded && r.goodNow !== r.goodAlt;
  console.log(`\n1. HALF-BEAT CHOICE (tracks where one phase is good and the other not: train ${train.filter(matters).length}, test ${test.filter(matters).length})`);
  console.log(`   now: right on ${pct(test.filter((r) => matters(r) && r.goodNow).length, test.filter(matters).length)} of those (test)`);
  const flipModels = {};
  for (const [label, feat] of Object.entries(flipVariants)) {
    const tr = train.filter(matters);
    const w = fitLogistic(tr.map(feat), tr.map((r) => (r.goodAlt ? 1 : 0)));
    flipModels[label] = { w, feat };
    const switchIt = (r) => logit(w, feat(r)) > 0;
    const goodAfter = (r) => (switchIt(r) ? r.goodAlt : r.goodNow);
    const te = test.filter(matters);
    const graded = test.filter((r) => r.graded);
    const m = mcnemar(graded, (r) => r.goodNow, goodAfter);
    console.log(`   ${label}: right on ${pct(te.filter(goodAfter).length, te.length)}; all graded good ${pct(graded.filter((r) => r.goodNow).length, graded.length)} -> ${pct(graded.filter(goodAfter).length, graded.length)}; McNemar fixed ${m.fixed} broken ${m.broken} chi2 ${m.chi.toFixed(1)}  w=${JSON.stringify(w)}`);
  }

  /* ---------- 2. verdict ---------- */

  const best = flipModels[arg("--flip", "old score + bar evidence + per-feature bar differences")];
  const switchBest = (r) => logit(best.w, best.feat(r)) > 0;
  for (const r of rows) {
    if (!r.graded) continue;
    r.good = switchBest(r) ? r.goodAlt : r.goodNow;
    const margin = Math.abs(logit(best.w, best.feat(r)));
    r.verdictX = [...r.features, margin / 3, Math.log(1 + Math.max(0, r.tempo.max - r.tempo.min)), r.tempo.mode === "dynamic" ? 1 : 0];
  }
  console.log("\n2. WRITE IT OR NOT (coverage: share of all tracks in the half; accuracy: good among written)");
  const report = (label, rowsOf, writes) => {
    const all = rowsOf.length;
    const w = rowsOf.filter((r) => r.graded && writes(r));
    console.log(`   ${label}: coverage ${pct(w.length, all)}, accuracy ${pct(w.filter((r) => r.good).length, w.length)} (${w.length})`);
  };
  const oldTest = test.map((r) => ({ ...r, good: r.goodNow }));
  report("before (kick flip, confidence >= 0.75, never on 'dynamic')", oldTest, (r) => r.place);
  report("new flip, old verdict", test, (r) => r.place);
  report("new flip, old confidence >= 0.75, 'dynamic' allowed", test, (r) => r.confidence >= 0.75);

  const trG = train.filter((r) => r.graded);
  const wv = fitLogistic(trG.map((r) => r.verdictX), trG.map((r) => (r.good ? 1 : 0)));
  console.log(`   verdict weights ${JSON.stringify(wv)}`);
  const p = (r) => 1 / (1 + Math.exp(-logit(wv, r.verdictX)));
  // Threshold: the lowest that keeps train accuracy at the current level.
  const target = trG.filter((r) => r.place && r.goodNow).length / trG.filter((r) => r.place).length;
  let threshold = 0.99;
  for (let t = 0.99; t >= 0.3; t -= 0.01) {
    const w = trG.filter((r) => p(r) >= t);
    if (w.length && w.filter((r) => r.good).length / w.length >= target) threshold = t;
  }
  console.log(`   threshold ${threshold.toFixed(2)} (train accuracy kept at ${pct(Math.round(target * 1000), 1000)})`);
  report("new flip + new verdict", test, (r) => p(r) >= threshold);
  for (const t of [0.9, 0.85, 0.8, 0.75, 0.7, 0.65, 0.6]) report(`   at ${t.toFixed(2)}`, test, (r) => p(r) >= t);
  const graded = test.filter((r) => r.graded);
  let auc = 0; const pos = graded.filter((r) => r.good), neg = graded.filter((r) => !r.good);
  for (const a of pos) for (const b of neg) auc += p(a) > p(b) ? 1 : p(a) === p(b) ? 0.5 : 0;
  let aucOld = 0;
  for (const a of oldTest.filter((r) => r.graded && r.good)) for (const b of oldTest.filter((r) => r.graded && !r.good)) aucOld += a.confidence > b.confidence ? 1 : a.confidence === b.confidence ? 0.5 : 0;
  console.log(`   AUC: old confidence ${(aucOld / (oldTest.filter((r) => r.graded && r.good).length * oldTest.filter((r) => r.graded && !r.good).length)).toFixed(3)}, new ${(auc / (pos.length * neg.length)).toFixed(3)} (test)`);
  const v = test.filter((r) => r.graded && r.variable);
  console.log(`   tracks whose Rekordbox grid changes tempo (test ${v.length}): written before ${v.filter((r) => r.place).length}, new ${v.filter((r) => p(r) >= threshold).length}; good among new ones ${v.filter((r) => p(r) >= threshold && r.good).length}`);

  /* ---------- 3. as shipped ---------- */

  console.log("\n3. AS SHIPPED (beatgrid.js gridDecision on the same rows)");
  for (const [label, part] of [["train", train], ["test", test]]) {
    const shipped = part.map((r) => (r.graded ? { ...r, good: r.shipped.switched ? r.goodAlt : r.goodNow } : r));
    report(`${label}: before`, part.map((r) => ({ ...r, good: r.goodNow })), (r) => r.place);
    report(`${label}: shipped`, shipped, (r) => r.shipped.place);
    const g = shipped.filter((r) => r.graded);
    const m = mcnemar(g, (r) => r.goodNow, (r) => r.good);
    console.log(`   ${label}: every grid good ${pct(g.filter((r) => r.goodNow).length, g.length)} -> ${pct(g.filter((r) => r.good).length, g.length)} (McNemar fixed ${m.fixed} broken ${m.broken} chi2 ${m.chi.toFixed(1)})`);
  }
}

if (process.argv[1] && process.argv[1].endsWith("grid_models.mjs")) main();
