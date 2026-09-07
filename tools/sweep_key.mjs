/*
 * Searches for better key profiles against the chroma dumped by
 * tools/dump_chroma.mjs.
 *
 * The question
 * ------------
 * Measurement put the key detector at 59.4% exact on 2532 tracks, and showed
 * where it loses: 15.6% of answers land exactly a fifth from the truth, while
 * the mode is right 86.6% of the time. The suspect is the profile shape --
 * root, third and fifth all carry weight 1, so A minor and E minor share two of
 * three weighted degrees and the correlation can barely separate them.
 *
 * That is a hypothesis about four numbers. This searches them.
 *
 * What is searched
 * ----------------
 * The profiles keep their shape -- root, third, fifth, minor seventh -- and only
 * the weights move. Pearson correlation is invariant to scaling the profile, so
 * the root is pinned at 1 and the rest are relative to it. The minor bias, which
 * tips a close call towards minor, is searched alongside: it interacts with the
 * weights and tuning one without the other would find a false optimum.
 *
 * A coarse pass over the grid is followed by a fine pass around the winner.
 * Scoring uses dsp.js's own `pearson` and its own Camelot tables, so the only
 * thing that differs from the shipped detector is the numbers under test.
 *
 * Honesty
 * -------
 * Tracks are split in half by position in the sorted list -- which alternates
 * within every folder, so both halves see the same genres. The search only ever
 * looks at the training half; the number reported at the end is from the half it
 * never saw. Without that, a sweep over a few thousand candidates on 2532 tracks
 * finds the noise as happily as the signal.
 *
 * Usage
 * -----
 *   node tools/sweep_key.mjs [--in FILE]
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ROOT, loadDsp, arg } from "./lib/measure.mjs";

const dsp = loadDsp(["pearson", "CAMELOT_MAJOR", "CAMELOT_MINOR",
  "KEY_MAJOR_PROFILE", "KEY_MINOR_PROFILE", "KEY_MINOR_BIAS"]);

// Where each weight sits in a 12-element profile.
const ROOT_DEG = 0, MAJOR_THIRD = 4, MINOR_THIRD = 3, FIFTH = 7, SEVENTH = 10;

function profiles(third, fifth, seventh) {
  const major = new Array(12).fill(0);
  const minor = new Array(12).fill(0);
  major[ROOT_DEG] = minor[ROOT_DEG] = 1;
  major[MAJOR_THIRD] = third;
  minor[MINOR_THIRD] = third;
  major[FIFTH] = minor[FIFTH] = fifth;
  major[SEVENTH] = minor[SEVENTH] = seventh;
  return { major, minor };
}

// The scoring loop from detectKey, with the profiles as arguments.
function decide(chroma, major, minor, bias) {
  let bestScore = -Infinity;
  let bestPitch = 0;
  let bestMode = "major";
  const rotated = new Float64Array(12);
  for (let shift = 0; shift < 12; shift++) {
    for (let i = 0; i < 12; i++) rotated[i] = chroma[(i + shift) % 12];
    const majorScore = dsp.pearson(rotated, major);
    const minorScore = dsp.pearson(rotated, minor) * bias;
    if (Number.isFinite(majorScore) && majorScore > bestScore) {
      bestScore = majorScore; bestPitch = shift; bestMode = "major";
    }
    if (Number.isFinite(minorScore) && minorScore > bestScore) {
      bestScore = minorScore; bestPitch = shift; bestMode = "minor";
    }
  }
  const table = bestMode === "major" ? dsp.CAMELOT_MAJOR : dsp.CAMELOT_MINOR;
  return table[bestPitch] || null;
}

const isMajor = (camelot) => String(camelot).endsWith("B");

/*
 * Is the difference between two configurations real, or is it the same tracks
 * shuffling around?
 *
 * Comparing two percentages is the wrong test here: both are measured on the
 * same tracks, and most of those tracks are answered identically either way.
 * Only the disagreements carry information, so McNemar counts them -- how many
 * the old one alone gets right against how many the new one alone does -- and
 * asks whether the imbalance is bigger than a coin would produce.
 *
 * Without this a sweep will always report an improvement, because the best of
 * several thousand candidates on a fixed set is above average by construction.
 */
function mcnemar(set, a, b) {
  let onlyA = 0;
  let onlyB = 0;
  for (const t of set) {
    const rightA = decide(t.chroma, a.major, a.minor, a.bias) === t.key;
    const rightB = decide(t.chroma, b.major, b.minor, b.bias) === t.key;
    if (rightA && !rightB) onlyA++;
    else if (!rightA && rightB) onlyB++;
  }
  const n = onlyA + onlyB;
  return { onlyA, onlyB, z: n ? (onlyB - onlyA) / Math.sqrt(n) : 0 };
}

function evaluate(set, major, minor, bias) {
  let exact = 0;
  let predictedMajor = 0;
  for (const t of set) {
    const answer = decide(t.chroma, major, minor, bias);
    if (answer === t.key) exact++;
    if (isMajor(answer)) predictedMajor++;
  }
  return { exact: (100 * exact) / set.length, predictedMajor };
}

/*
 * The guard that makes this search worth trusting.
 *
 * Roughly 9% of the library is in a major key. A scorer that simply stopped
 * calling anything major would therefore be right more often -- and the first
 * unconstrained run did exactly that: it pushed the minor bias to 1.72, cut
 * predicted major keys from 98 to 13, found 2 of 118 real ones, and reported the
 * result as a 1.5-point improvement. That is not a better detector, it is a
 * detector that has given up on a question and been rewarded by the base rate.
 * The comment in dsp.js warned about precisely this before the sweep existed.
 *
 * So a candidate has to keep predicting major keys at something like the rate
 * they occur. Half the true count is loose enough to allow a real trade and
 * tight enough to reject a collapse.
 */
const MAJOR_FLOOR = 0.5;

function search(set, thirds, fifths, sevenths, biases) {
  const actualMajor = set.filter((t) => isMajor(t.key)).length;
  const floor = actualMajor * MAJOR_FLOOR;
  let best = null;
  let bestUnconstrained = null;
  for (const third of thirds) {
    for (const fifth of fifths) {
      for (const seventh of sevenths) {
        const { major, minor } = profiles(third, fifth, seventh);
        for (const bias of biases) {
          const { exact, predictedMajor } = evaluate(set, major, minor, bias);
          const candidate = { third, fifth, seventh, bias, exact, predictedMajor };
          if (!bestUnconstrained || exact > bestUnconstrained.exact) bestUnconstrained = candidate;
          if (predictedMajor < floor) continue;
          if (!best || exact > best.exact) best = candidate;
        }
      }
    }
  }
  return { best, bestUnconstrained, actualMajor };
}

const range = (from, to, step) => {
  const out = [];
  for (let v = from; v <= to + 1e-9; v += step) out.push(Math.round(v * 1000) / 1000);
  return out;
};

function main() {
  const inPath = arg("--in", join(ROOT, "ground-truth/chroma.json"));
  const dump = JSON.parse(readFileSync(inPath, "utf8")).tracks;

  const all = Object.keys(dump).sort()
    .map((path) => ({ path, chroma: dump[path].chroma, key: String(dump[path].key).toUpperCase() }))
    .filter((t) => Array.isArray(t.chroma) && t.chroma.length === 12);

  // Alternating rather than a random draw: the paths are sorted, so folders are
  // contiguous, and taking every other one keeps each genre split evenly.
  const train = all.filter((_, i) => i % 2 === 0);
  const test = all.filter((_, i) => i % 2 === 1);
  console.log("chroma %d tracks -- train %d, test %d", all.length, train.length, test.length);

  const shipped = {
    third: dsp.KEY_MAJOR_PROFILE[MAJOR_THIRD],
    fifth: dsp.KEY_MAJOR_PROFILE[FIFTH],
    seventh: dsp.KEY_MAJOR_PROFILE[SEVENTH],
    bias: dsp.KEY_MINOR_BIAS,
  };
  const base = profiles(shipped.third, shipped.fifth, shipped.seventh);
  const baseTrain = evaluate(train, base.major, base.minor, shipped.bias);
  const baseTest = evaluate(test, base.major, base.minor, shipped.bias);
  console.log("\nshipped  third=%s fifth=%s seventh=%s bias=%s",
    shipped.third, shipped.fifth, shipped.seventh, shipped.bias);
  console.log("         train %s%%   test %s%%",
    baseTrain.exact.toFixed(1), baseTest.exact.toFixed(1));

  const show = (label, c) => console.log("  %s third=%s fifth=%s seventh=%s bias=%s"
    + "  train %s%%  predicts %d major", label, c.third, c.fifth, c.seventh, c.bias,
    c.exact.toFixed(1), c.predictedMajor);

  console.log("\ncoarse pass...");
  const coarse = search(train,
    range(0.4, 1.4, 0.2), range(0.1, 1.2, 0.2), range(0, 0.6, 0.15), range(1.0, 1.8, 0.15));
  show("kept  ", coarse.best);
  if (coarse.bestUnconstrained.exact > coarse.best.exact) {
    show("(rejected as degenerate)", coarse.bestUnconstrained);
    console.log("  %d of the training half is actually major", coarse.actualMajor);
  }

  console.log("\nfine pass around it...");
  const near = (v, span, step, min = 0) => range(Math.max(min, v - span), v + span, step);
  const c = coarse.best;
  const fine = search(train, near(c.third, 0.15, 0.05), near(c.fifth, 0.15, 0.05),
    near(c.seventh, 0.12, 0.04), near(c.bias, 0.12, 0.04, 1.0)).best;
  show("kept  ", fine);

  const tuned = profiles(fine.third, fine.fifth, fine.seventh);
  const tunedTest = evaluate(test, tuned.major, tuned.minor, fine.bias);
  const actualMajorTest = test.filter((t) => isMajor(t.key)).length;

  console.log("\n=== held-out half, %d tracks (%d major) ===", test.length, actualMajorTest);
  console.log("  shipped  %s%%   predicts %d major", baseTest.exact.toFixed(1), baseTest.predictedMajor);
  console.log("  tuned    %s%%   predicts %d major", tunedTest.exact.toFixed(1), tunedTest.predictedMajor);
  console.log("  change   %s%s points",
    tunedTest.exact - baseTest.exact >= 0 ? "+" : "", (tunedTest.exact - baseTest.exact).toFixed(1));

  const m = mcnemar(test, { ...base, bias: shipped.bias }, { ...tuned, bias: fine.bias });
  console.log("\n  shipped right where tuned is wrong  %d", m.onlyA);
  console.log("  tuned right where shipped is wrong  %d", m.onlyB);
  console.log("  McNemar z = %s", m.z.toFixed(2));
  console.log(Math.abs(m.z) > 1.96
    ? "  -> a real difference; worth changing dsp.js"
    : "  -> indistinguishable from chance; do not change dsp.js on this");

  console.log("\nKEY_MAJOR_PROFILE = [%s];", tuned.major.join(", "));
  console.log("KEY_MINOR_PROFILE = [%s];", tuned.minor.join(", "));
  console.log("KEY_MINOR_BIAS    = %s;", fine.bias);
}

main();
