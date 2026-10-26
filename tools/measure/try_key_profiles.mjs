/*
 * Tries published key profiles against the shipped one, on dumped chroma.
 *
 * The question
 * ------------
 * dsp.js correlates the chroma with a hand-made profile -- root and fifth at
 * 1, third at 1, minor seventh at 0.3 -- and tips close calls towards minor by
 * 1.3. Essentia ships profiles built for electronic dance music (Faraldo et
 * al.): "edma" from a corpus of EDM, and "bgate"/"braw" from Beatport medians
 * -- bgate is Essentia's default. Do any of them beat ours?
 *
 * They are used the way Essentia's KeyExtractor uses them: plain major and
 * minor profiles, with usePolyphony and the third "majmin" profile both off
 * (keyextractor.cpp). The majmin profile would also answer neither A nor B,
 * which a Camelot key cannot express.
 *
 * The profile is the only thing that changes. The chroma is the shipped
 * detector's own (tools/measure/dump_chroma.mjs), and the scoring loop below is
 * detectKey's, checked against the shipped answers before anything is reported.
 *
 * Honesty
 * -------
 * Each profile is tried twice: with no minor bias, as published, and with the
 * bias chosen on the train half of the owner's library. The choice may not
 * buy accuracy by giving up on major keys (see MAJOR_FLOOR). Results are
 * reported on the held-out half and on all of GiantSteps, which nothing here
 * was chosen on, with McNemar against the shipped detector on each.
 *
 * Usage
 * -----
 *   node tools/measure/dump_chroma.mjs --set rekordbox
 *   node tools/measure/dump_chroma.mjs --set giantsteps
 *   node tools/measure/try_key_profiles.mjs
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { ROOT, loadDsp, arg } from "./lib/measure.mjs";
import { summarize, mcnemar, halfOf } from "./key_report.mjs";

/*
 * Copied from Essentia, src/algorithms/tonal/key.cpp (MTG/essentia, master,
 * fetched 2026-10-26): `profileTypes` and `profileTypesWithOther`, major and
 * minor rows. Index 0 is the tonic, the same convention as dsp.js. The edma
 * entry is the one Essentia actually selects ("profileTypesWithOther", index
 * 2), not the commented-out older one.
 */
export const PROFILES = {
  krumhansl: {
    major: [6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88],
    minor: [6.33, 2.68, 3.52, 5.38, 2.60, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17],
  },
  temperley: {
    major: [5.0, 2.0, 3.5, 2.0, 4.5, 4.0, 2.0, 4.5, 2.0, 3.5, 1.5, 4.0],
    minor: [5.0, 2.0, 3.5, 4.5, 2.0, 4.0, 2.0, 4.5, 3.5, 2.0, 1.5, 4.0],
  },
  shaath: {
    major: [6.6, 2.0, 3.5, 2.3, 4.6, 4.0, 2.5, 5.2, 2.4, 3.7, 2.3, 3.4],
    minor: [6.5, 2.7, 3.5, 5.4, 2.6, 3.5, 2.5, 5.2, 4.0, 2.7, 4.3, 3.2],
  },
  bgate: {
    major: [1.00, 0.00, 0.42, 0.00, 0.53, 0.37, 0.00, 0.77, 0.00, 0.38, 0.21, 0.30],
    minor: [1.00, 0.00, 0.36, 0.39, 0.00, 0.38, 0.00, 0.74, 0.27, 0.00, 0.42, 0.23],
  },
  braw: {
    major: [1.0000, 0.1573, 0.4200, 0.1570, 0.5296, 0.3669, 0.1632, 0.7711, 0.1676, 0.3827, 0.2113, 0.2965],
    minor: [1.0000, 0.2330, 0.3615, 0.3905, 0.2925, 0.3777, 0.1961, 0.7425, 0.2701, 0.2161, 0.4228, 0.2272],
  },
  edma: {
    major: [1.00, 0.29, 0.50, 0.40, 0.60, 0.56, 0.32, 0.80, 0.31, 0.45, 0.42, 0.39],
    minor: [1.00, 0.31, 0.44, 0.58, 0.33, 0.49, 0.29, 0.78, 0.43, 0.29, 0.53, 0.32],
  },
};

// detectKey's scoring loop, with the profiles and the minor bias as arguments.
export function decideKey(chroma, profile, bias, pearson, camelotMajor, camelotMinor) {
  let bestScore = -Infinity;
  let bestPitch = 0;
  let bestMode = "major";
  const rotated = new Float64Array(12);
  for (let shift = 0; shift < 12; shift++) {
    for (let i = 0; i < 12; i++) rotated[i] = chroma[(i + shift) % 12];
    for (const [mode, score] of [["major", pearson(rotated, profile.major)], ["minor", pearson(rotated, profile.minor) * bias]]) {
      if (Number.isFinite(score) && score > bestScore) {
        bestScore = score; bestPitch = shift; bestMode = mode;
      }
    }
  }
  // Silence correlates with nothing; detectKey returns no key there too.
  if (!Number.isFinite(bestScore)) return { key: null, score: null };
  const table = bestMode === "major" ? camelotMajor : camelotMinor;
  return { key: table[bestPitch] || null, score: bestScore };
}

/*
 * Same guard as sweep_key.mjs: a bias that wins by no longer calling anything
 * major has not learnt anything, the base rate has. A candidate must predict
 * at least half as many major keys as the train half really has.
 */
const MAJOR_FLOOR = 0.5;
const BIASES = Array.from({ length: 17 }, (_, i) => Math.round((0.9 + i * 0.05) * 100) / 100);

function loadChroma(file) {
  const tracks = JSON.parse(readFileSync(join(ROOT, "ground-truth", file), "utf8")).tracks;
  return Object.entries(tracks)
    .filter(([, t]) => Array.isArray(t.chroma) && t.chroma.length === 12)
    .map(([name, t]) => ({ name, chroma: t.chroma, truth: String(t.key).toUpperCase(), shipped: t.shipped }));
}

function main() {
  const dsp = loadDsp(["pearson", "CAMELOT_MAJOR", "CAMELOT_MINOR",
    "KEY_MAJOR_PROFILE", "KEY_MINOR_PROFILE", "KEY_MINOR_BIAS"]);
  const decide = (chroma, profile, bias) =>
    decideKey(chroma, profile, bias, dsp.pearson, dsp.CAMELOT_MAJOR, dsp.CAMELOT_MINOR).key;
  const shipped = { major: dsp.KEY_MAJOR_PROFILE, minor: dsp.KEY_MINOR_PROFILE };

  const library = loadChroma(arg("--rekordbox", "chroma.json"));
  const giantsteps = loadChroma(arg("--giantsteps", "chroma_giantsteps.json"));
  const train = library.filter((t) => halfOf(t.name) === "train");
  const test = library.filter((t) => halfOf(t.name) === "test");

  // The loop here must be the shipped one, or every comparison below is off.
  for (const [label, set] of [["library", library], ["giantsteps", giantsteps]]) {
    const same = set.filter((t) => decide(t.chroma, shipped, dsp.KEY_MINOR_BIAS) === t.shipped).length;
    console.log("%s: %d tracks, scoring loop reproduces the shipped answer on %d", label, set.length, same);
    if (same < set.length * 0.999) throw new Error("scoring loop does not match detectKey -- fix before trusting this");
  }
  console.log("train half %d, test half %d\n", train.length, test.length);

  const rows = (set, profile, bias) => set.map((t) => ({ name: t.name, truth: t.truth, ours: decide(t.chroma, profile, bias) }));
  const majorsIn = (set) => set.filter((t) => t.truth.endsWith("B")).length;

  function chooseBias(profile) {
    const floor = majorsIn(train) * MAJOR_FLOOR;
    let best = null;
    for (const bias of BIASES) {
      const r = rows(train, profile, bias);
      const predictedMajor = r.filter((x) => String(x.ours).endsWith("B")).length;
      if (predictedMajor < floor) continue;
      const exact = summarize(r).exact;
      if (!best || exact > best.exact) best = { bias, exact };
    }
    return best ? best.bias : 1;
  }

  const candidates = [{ name: "shipped", profile: shipped, bias: dsp.KEY_MINOR_BIAS }];
  for (const [name, profile] of Object.entries(PROFILES)) {
    candidates.push({ name, profile, bias: 1 });
    candidates.push({ name: name + " +bias", profile, bias: chooseBias(profile) });
  }

  const baseTest = rows(test, shipped, dsp.KEY_MINOR_BIAS);
  const baseGs = rows(giantsteps, shipped, dsp.KEY_MINOR_BIAS);
  const pct = (x) => (100 * x).toFixed(1).padStart(5);
  const sig = (t) => `${String(t.better).padStart(4)}/${String(t.worse).padEnd(4)} p=${t.p < 0.001 ? t.p.toExponential(0) : t.p.toFixed(3)}`;

  console.log("                       |  library, held-out half (%d)            |  GiantSteps (%d)", test.length, giantsteps.length);
  console.log("profile          bias  | exact  major  maj.said  +/- vs shipped   | exact  major  maj.said  +/- vs shipped");
  for (const c of candidates) {
    const rt = rows(test, c.profile, c.bias);
    const rg = rows(giantsteps, c.profile, c.bias);
    const st = summarize(rt);
    const sg = summarize(rg);
    const said = (r) => String(r.filter((x) => String(x.ours).endsWith("B")).length).padStart(5);
    console.log(
      `${c.name.padEnd(16)} ${c.bias.toFixed(2)}  | ${pct(st.exact)}  ${pct(st.byMode.major.exact)}  ${said(rt)}    ${c.name === "shipped" ? "".padEnd(17) : sig(mcnemar(baseTest, rt)).padEnd(17)}`
      + `| ${pct(sg.exact)}  ${pct(sg.byMode.major.exact)}  ${said(rg)}    ${c.name === "shipped" ? "" : sig(mcnemar(baseGs, rg))}`);
  }
  console.log("\nmajor = exact on true-major tracks; maj.said = how many answers were major");
  console.log("(true majors: held-out %d, GiantSteps %d); +/- = tracks fixed / broken vs shipped.",
    majorsIn(test), majorsIn(giantsteps));
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main();
