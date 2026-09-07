/*
 * Scores the app's tempo detector against the beat grid Rekordbox produced.
 *
 * Labels come from tools/rekordbox_anlz.py, which reads them out of Rekordbox's
 * own analysis files. Everything generic -- decoding, the worker pool, the
 * report -- lives in lib/measure.mjs.
 *
 * A tempo detector's failures are not spread evenly. The common one is
 * reporting a simple multiple of the real tempo, which is a different kind of
 * wrong from an unrelated number: a DJ shown 174 for an 87 BPM track can still
 * use it, while 103 for the same track is useless. They are counted apart.
 *
 * Usage
 * -----
 *   node tools/measure_bpm.mjs [--limit N] [--jobs N] [--seed N] [--out FILE]
 *   node tools/measure_bpm.mjs --rescore     # re-label a finished run
 */

import { isMainThread, parentPort } from "node:worker_threads";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import {
  ROOT, loadDsp, decodeMono, arg, pickSample, runPool,
  printCounts, printByFolder, writeResults, rescore,
} from "./lib/measure.mjs";

// Wide enough to absorb rounding on both sides -- we round to whole BPM,
// Rekordbox keeps two decimals -- and narrow enough that a genuinely wrong
// answer cannot slip through.
const TOLERANCE = 1.0;

/*
 * The ratios are not arbitrary. A tempogram picks its answer from a comb of
 * harmonically related peaks, so a wrong pick is a simple fraction of the truth:
 * 2 and 1/2 when the backbeat or a half-time feel is taken for the pulse, 4/3
 * and 3/4 when a shuffle or a triplet hat is. The first full run put 4/3 alone
 * at 43 of 175 supposedly unrelated answers -- a fixable class of error rather
 * than noise -- so each is counted rather than buried in "wrong".
 *
 * Tolerance scales with the ratio: at ×2 a fixed ±1 would be twice as strict.
 */
const RATIOS = [[2, "double"], [0.5, "half"], [4 / 3, "×4/3"], [0.75, "×3/4"],
  [1.5, "×1.5"], [1 / 1.5, "÷1.5"]];
const CATEGORIES = ["exact", "half", "double", "×4/3", "×3/4", "×1.5", "÷1.5", "wrong", "failed"];

function classify(ours, truth) {
  if (ours === null) return "failed";
  if (Math.abs(ours - truth) <= TOLERANCE) return "exact";
  for (const [ratio, label] of RATIOS) {
    if (Math.abs(ours - truth * ratio) <= TOLERANCE * Math.max(1, ratio)) return label;
  }
  return "wrong";
}

if (!isMainThread) {
  const dsp = loadDsp(["analyzeTempo"]);
  parentPort.on("message", (task) => {
    if (task === null) process.exit(0);
    try {
      // Native rate: worker.js:82 hands analyzeTempo the untouched mono.
      const { y, sampleRate } = decodeMono(task.file);
      if (!sampleRate || y.length < sampleRate) throw new Error("too short");
      const tempo = dsp.analyzeTempo(y, sampleRate);
      parentPort.postMessage({
        name: task.name,
        ours: tempo ? tempo.bpm : null,
        mode: tempo ? tempo.mode : null,
        spread: tempo ? Math.round((tempo.max - tempo.min) * 10) / 10 : null,
      });
    } catch (e) {
      parentPort.postMessage({ name: task.name, ours: null, error: String(e.message || e) });
    }
  });
}

async function main() {
  const matched = JSON.parse(readFileSync(join(ROOT, "ground-truth/matched.json"), "utf8"));
  const outPath = arg("--out", join(ROOT, "ground-truth/bpm_results.json"));

  let results;
  if (process.argv.includes("--rescore")) {
    results = rescore(outPath, classify);
  } else {
    results = [];
    const names = pickSample(Object.keys(matched));
    await runPool(fileURLToPath(import.meta.url),
      names.map((name) => ({ name, file: matched[name].file })),
      (r) => {
        const truth = matched[r.name].bpm;
        results.push({ ...r, truth, verdict: classify(r.ours, truth), file: matched[r.name].file });
      });
  }

  const counts = printCounts("tempo vs Rekordbox", results, CATEGORIES);
  const n = results.length;
  const usable = (counts.exact || 0) + (counts.half || 0) + (counts.double || 0);
  console.log("\n  exact                %s%%", ((100 * (counts.exact || 0)) / n).toFixed(1));
  console.log("  exact or octave-off  %s%%", ((100 * usable) / n).toFixed(1));

  printByFolder(results, [
    { label: "exact", test: (r) => r.verdict === "exact" },
    { label: "octave", test: (r) => r.verdict === "half" || r.verdict === "double" },
  ]);

  writeResults(outPath, { tolerance: TOLERANCE, counts, results });
}

if (isMainThread) main();
