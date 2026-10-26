/*
 * Tries segment voting -- the Mixed In Key / libKeyFinder idea -- against the
 * shipped whole-track average, on dumped chroma blocks.
 *
 * The question
 * ------------
 * detectKey averages the chroma of the whole analysed stretch and correlates
 * that one vector with the profiles. An intro of hats, a breakdown on a noise
 * riser, a drop on one sub note -- they all go into the same average as the
 * part that actually carries the harmony. Voting instead lets each segment
 * name its own key, and a segment with no clear key should carry little
 * weight.
 *
 * What is tried
 * -------------
 * Segment lengths of 10 to 60 seconds (multiples of the 5-second blocks in the
 * dump), and four ways to count:
 *
 *   count    one vote per segment for its best key
 *   score    the vote weighted by that key's correlation
 *   margin   the vote weighted by how far the best key beats the runner-up --
 *            a segment that cannot choose between 8A and 9A says almost nothing
 *   soft     every segment's scores for all 24 keys summed; best total wins
 *
 * The profiles, the minor bias and the scoring are the shipped ones, so only
 * the aggregation changes. Ties go to the whole-track answer.
 *
 * Honesty
 * -------
 * The configuration is chosen on the train half of the owner's library alone,
 * under the same guard as the profile search (it may not win by ceasing to
 * call keys major). It is then reported once on the held-out half and on
 * GiantSteps, with McNemar against the shipped detector. The full table on the
 * test sets is printed too, for transparency, but the choice is fixed first.
 *
 * Usage
 * -----
 *   node tools/measure/dump_chroma.mjs --set rekordbox --blocks 5 --out ground-truth/chroma_blocks.json
 *   node tools/measure/dump_chroma.mjs --set giantsteps --blocks 5 --out ground-truth/chroma_giantsteps_blocks.json
 *   node tools/measure/try_key_segments.mjs
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { ROOT, loadDsp, arg } from "./lib/measure.mjs";
import { summarize, mcnemar, halfOf } from "./key_report.mjs";

/*
 * Group consecutive blocks into segments of `perSegment` blocks, each the
 * frame-weighted mean of its blocks. A short tail (under half a segment) is
 * folded into the segment before it rather than voting on a few seconds.
 */
export function segmentsFromBlocks(blocks, perSegment) {
  const groups = [];
  for (let i = 0; i < blocks.length; i += perSegment) groups.push(blocks.slice(i, i + perSegment));
  if (groups.length > 1 && groups[groups.length - 1].length * 2 < perSegment) {
    const tail = groups.pop();
    groups[groups.length - 1] = groups[groups.length - 1].concat(tail);
  }
  return groups.map((group) => {
    const n = group.reduce((acc, b) => acc + b.n, 0);
    const chroma = new Array(12).fill(0);
    for (const b of group) for (let c = 0; c < 12; c++) chroma[c] += (b.n * b.chroma[c]) / n;
    return { n, chroma };
  });
}

/*
 * The 24 scores detectKey compares: index shift for major, 12 + shift for
 * minor (bias applied). NaN -- a flat chroma -- becomes -Infinity.
 */
export function keyScores(chroma, profile, bias, pearson) {
  const out = new Float64Array(24);
  const rotated = new Float64Array(12);
  for (let shift = 0; shift < 12; shift++) {
    for (let i = 0; i < 12; i++) rotated[i] = chroma[(i + shift) % 12];
    const major = pearson(rotated, profile.major);
    const minor = pearson(rotated, profile.minor) * bias;
    out[shift] = Number.isFinite(major) ? major : -Infinity;
    out[12 + shift] = Number.isFinite(minor) ? minor : -Infinity;
  }
  return out;
}

// Index of the best score; ties go to the lower index, as in detectKey.
function argmax(scores) {
  let best = 0;
  for (let i = 1; i < scores.length; i++) if (scores[i] > scores[best]) best = i;
  return best;
}

/*
 * Aggregate per-segment scores into one key index (0..23), or -1 if nothing
 * scored. `fallback` breaks ties: the whole-track answer's index.
 */
export function vote(segmentScores, method, fallback) {
  const tally = new Float64Array(24);
  let counted = 0;
  for (const s of segmentScores) {
    const best = argmax(s);
    if (!Number.isFinite(s[best])) continue;
    counted++;
    if (method === "soft") {
      for (let k = 0; k < 24; k++) if (Number.isFinite(s[k])) tally[k] += s[k];
      continue;
    }
    let weight = 1;
    if (method === "score") weight = Math.max(0, s[best]);
    if (method === "margin") {
      let second = -Infinity;
      for (let k = 0; k < 24; k++) if (k !== best && s[k] > second) second = s[k];
      weight = Number.isFinite(second) ? s[best] - second : s[best];
    }
    tally[best] += weight;
  }
  const top = Math.max(...tally);
  if (counted === 0 || (!(top > 0) && method !== "soft")) return fallback;
  const winners = [];
  for (let k = 0; k < 24; k++) if (tally[k] === top) winners.push(k);
  return winners.includes(fallback) ? fallback : winners[0];
}

const MAJOR_FLOOR = 0.5; // as in try_key_profiles.mjs and sweep_key.mjs
const BLOCK_COUNTS = [2, 3, 4, 6, 8, 12]; // x 5 s
const METHODS = ["count", "score", "margin", "soft"];

function loadBlocks(file) {
  const tracks = JSON.parse(readFileSync(join(ROOT, "ground-truth", file), "utf8")).tracks;
  return Object.entries(tracks)
    .filter(([, t]) => Array.isArray(t.blocks) && t.blocks.length > 0)
    .map(([name, t]) => ({ name, blocks: t.blocks, truth: String(t.key).toUpperCase(), shipped: t.shipped }));
}

function main() {
  const dsp = loadDsp(["pearson", "CAMELOT_MAJOR", "CAMELOT_MINOR",
    "KEY_MAJOR_PROFILE", "KEY_MINOR_PROFILE", "KEY_MINOR_BIAS"]);
  const profile = { major: dsp.KEY_MAJOR_PROFILE, minor: dsp.KEY_MINOR_PROFILE };
  const scores = (chroma) => keyScores(chroma, profile, dsp.KEY_MINOR_BIAS, dsp.pearson);
  const camelot = (k) => (k < 0 ? null : k < 12 ? dsp.CAMELOT_MAJOR[k] : dsp.CAMELOT_MINOR[k - 12]);

  const library = loadBlocks(arg("--rekordbox", "chroma_blocks.json"));
  const giantsteps = loadBlocks(arg("--giantsteps", "chroma_giantsteps_blocks.json"));

  // Per track: the whole-track answer, and per segment length the segment scores.
  function prepare(set) {
    for (const t of set) {
      const whole = segmentsFromBlocks(t.blocks, t.blocks.length)[0].chroma;
      const ws = scores(whole);
      t.whole = Number.isFinite(ws[argmax(ws)]) ? argmax(ws) : -1;
      t.bySegment = {};
      for (const per of BLOCK_COUNTS) t.bySegment[per] = segmentsFromBlocks(t.blocks, per).map((s) => scores(s.chroma));
    }
  }
  prepare(library);
  prepare(giantsteps);

  // The whole-track aggregate here must be the shipped detector, or the
  // comparison is against the wrong baseline.
  for (const [label, set] of [["library", library], ["giantsteps", giantsteps]]) {
    const same = set.filter((t) => camelot(t.whole) === t.shipped).length;
    console.log("%s: %d tracks, whole-track average reproduces the shipped answer on %d", label, set.length, same);
    if (same < set.length * 0.999) throw new Error("block average does not match detectKey -- fix before trusting this");
  }

  const train = library.filter((t) => halfOf(t.name) === "train");
  const test = library.filter((t) => halfOf(t.name) === "test");
  const rows = (set, per, method) => set.map((t) => ({
    name: t.name, truth: t.truth,
    ours: camelot(per === null ? t.whole : vote(t.bySegment[per], method, t.whole)),
  }));
  const majorsSaid = (r) => r.filter((x) => String(x.ours).endsWith("B")).length;
  const majorsIn = (set) => set.filter((t) => t.truth.endsWith("B")).length;

  // Choose on the train half.
  const floor = majorsIn(train) * MAJOR_FLOOR;
  const shippedTrain = summarize(rows(train, null)).exact;
  let chosen = null;
  console.log("\ntrain half %d tracks, shipped %s%% exact", train.length, (100 * shippedTrain).toFixed(1));
  console.log("segment  method  train exact  majors said");
  for (const per of BLOCK_COUNTS) {
    for (const method of METHODS) {
      const r = rows(train, per, method);
      const exact = summarize(r).exact;
      const said = majorsSaid(r);
      const ok = said >= floor;
      console.log(`${String(per * 5).padStart(4)} s   ${method.padEnd(7)} ${(100 * exact).toFixed(1).padStart(6)}%     ${String(said).padStart(4)}${ok ? "" : "  (below the major floor)"}`);
      if (ok && (!chosen || exact > chosen.exact)) chosen = { per, method, exact };
    }
  }
  console.log("\nchosen on train: %d s, %s (%s%% vs shipped %s%%)", chosen.per * 5, chosen.method,
    (100 * chosen.exact).toFixed(1), (100 * shippedTrain).toFixed(1));

  // Report the choice on the sets it was not chosen on.
  const sig = (t) => `fixed ${t.better}, broken ${t.worse}, p = ${t.p < 0.001 ? t.p.toExponential(1) : t.p.toFixed(3)}`;
  for (const [label, set] of [["library held-out half", test], ["GiantSteps", giantsteps]]) {
    const before = rows(set, null);
    const after = rows(set, chosen.per, chosen.method);
    const b = summarize(before);
    const a = summarize(after);
    console.log(`\n${label} (${set.length}): exact ${(100 * b.exact).toFixed(1)}% -> ${(100 * a.exact).toFixed(1)}%`
      + `   major ${(100 * b.byMode.major.exact).toFixed(1)}% -> ${(100 * a.byMode.major.exact).toFixed(1)}%`
      + `   majors said ${majorsSaid(before)} -> ${majorsSaid(after)} of ${majorsIn(set)}`);
    console.log("  " + sig(mcnemar(before, after)));
  }

  // Everything else on the test sets, for transparency only.
  console.log("\nall configurations on the test sets (not used for the choice):");
  console.log("segment  method   held-out   GiantSteps");
  const baseTest = summarize(rows(test, null)).exact;
  const baseGs = summarize(rows(giantsteps, null)).exact;
  console.log(` whole   shipped   ${(100 * baseTest).toFixed(1)}%      ${(100 * baseGs).toFixed(1)}%`);
  for (const per of BLOCK_COUNTS) {
    for (const method of METHODS) {
      console.log(`${String(per * 5).padStart(4)} s   ${method.padEnd(7)}  ${(100 * summarize(rows(test, per, method)).exact).toFixed(1)}%      ${(100 * summarize(rows(giantsteps, per, method)).exact).toFixed(1)}%`);
    }
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main();
