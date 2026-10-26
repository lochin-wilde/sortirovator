/*
 * Scores the app's key detector against the key Rekordbox assigned.
 *
 * Labels come from tools/rekordbox_db.py. The key is the one field where the
 * database is unambiguously worth decrypting for: it is filled in on 2747 of
 * 2764 tracks, it is already in Camelot notation -- the same notation dsp.js
 * emits -- and the analysis files do not carry it at all.
 *
 * Scoring
 * -------
 * Wrong is not one thing on the Camelot wheel, and a DJ cares about the
 * difference:
 *
 *   relative   same number, other letter (8A vs 8B). The relative major or
 *              minor: identical key signature, and the two mix together. This
 *              is the mode question, and dsp.js says outright that major/minor
 *              discrimination there is weak.
 *   neighbour  one step round the wheel, same letter (8A vs 7A or 9A). One
 *              accidental apart, and a standard harmonic move.
 *   wrong      anything else -- a key that would clash.
 *
 * Counting them together would hide which of the two known weaknesses is
 * actually costing us.
 *
 * Two label sets
 * --------------
 *   rekordbox    (default) the owner's library, keys from a copy of master.db.
 *                Large, but the labels are Rekordbox's own detector, not ears.
 *   giantsteps   GiantSteps-key: 604 two-minute Beatport previews whose keys
 *                were corrected by listeners (Knees et al., ISMIR 2015). The
 *                outside check -- nothing in dsp.js was tuned on it. Expects
 *                ground-truth/giantsteps/key-dataset (the annotation repo) and
 *                ground-truth/giantsteps/audio (the previews).
 *
 * Usage
 * -----
 *   node tools/measure/measure_key.mjs [--set rekordbox|giantsteps] [--limit N] [--jobs N] [--seed N] [--out FILE]
 *   node tools/measure/measure_key.mjs --rescore [--out FILE]
 *
 * --window first|skip60|middle|whole picks the stretch of each track the key
 * is measured on (see keyWindow in lib/measure.mjs); "first", the default, is
 * what the app does. Each result records how long detectKey took, in ms.
 *
 * --patch FILE.mjs measures a variant: the module's default export is a list
 * of [find, replace] pairs applied to dsp.js before it is loaded (see
 * patchSource). The shipped file is not touched. Compare the result with
 * key_report.mjs --compare.
 */

import { isMainThread, parentPort } from "node:worker_threads";
import { readFileSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { join, resolve } from "node:path";
import {
  ROOT, loadDsp, patchSource, loadKeyLabels, decodeMono, keyWindow, KEY_WINDOWS, WHOLE_TRACK_MAX_SECONDS, arg, pickSample, runPool,
  printCounts, printByFolder, writeResults, rescore,
} from "./lib/measure.mjs";

// worker.js:25 -- the key runs on the 22.05 kHz mono, librosa's default rate,
// which is what the CQT kernels in dsp.js were built for.
const KEY_RATE = 22050;
const CATEGORIES = ["exact", "relative", "neighbour", "wrong", "failed"];

const CAMELOT = /^(\d{1,2})([AB])$/;

function parseCamelot(value) {
  const m = CAMELOT.exec(String(value || "").trim().toUpperCase());
  if (!m) return null;
  const n = parseInt(m[1], 10);
  return n >= 1 && n <= 12 ? { n, letter: m[2] } : null;
}

function classify(ours, truth) {
  const a = parseCamelot(ours);
  const b = parseCamelot(truth);
  if (!a || !b) return "failed";
  if (a.n === b.n && a.letter === b.letter) return "exact";
  if (a.n === b.n) return "relative";
  // The wheel wraps: 12 and 1 are neighbours.
  const step = Math.abs(a.n - b.n);
  if (a.letter === b.letter && (step === 1 || step === 11)) return "neighbour";
  return "wrong";
}

if (!isMainThread) {
  let dsp = null;
  parentPort.on("message", async (task) => {
    if (task === null) process.exit(0);
    if (!dsp) {
      const patchFile = arg("--patch", null);
      const patches = patchFile ? (await import(pathToFileURL(resolve(patchFile)).href)).default : [];
      dsp = loadDsp(["detectKey"], "", patches);
    }
    try {
      const window = arg("--window", "first");
      const decoded = decodeMono(task.file, KEY_RATE, window === "first" ? undefined : WHOLE_TRACK_MAX_SECONDS).y;
      const y = keyWindow(decoded, KEY_RATE, window);
      if (y.length < KEY_RATE) throw new Error("too short");
      const started = performance.now();
      const key = dsp.detectKey(y, KEY_RATE);
      const ms = Math.round(performance.now() - started);
      parentPort.postMessage({
        name: task.name,
        ours: key ? key.key : null,
        confidence: key && key.confidence !== null ? Math.round(key.confidence * 1000) / 1000 : null,
        confident: key ? !!key.confident : false,
        ms,
        seconds: Math.round(y.length / KEY_RATE),
      });
    } catch (e) {
      parentPort.postMessage({ name: task.name, ours: null, error: String(e.message || e) });
    }
  });
}

async function main() {
  const patchFile = arg("--patch", null);
  if (patchFile) {
    // Fail here, once, rather than in every worker.
    const patches = (await import(pathToFileURL(resolve(patchFile)).href)).default;
    patchSource(readFileSync(join(ROOT, "web/js/dsp.js"), "utf8"), patches);
    console.log("variant: %s (%d patches)", patchFile, patches.length);
  }
  const set = arg("--set", "rekordbox");
  if (!KEY_WINDOWS.includes(arg("--window", "first"))) throw new Error("unknown --window " + arg("--window", ""));
  const outPath = arg("--out", join(ROOT, set === "rekordbox" ? "ground-truth/key_results.json" : `ground-truth/key_results_${set}.json`));

  let results;
  if (process.argv.includes("--rescore")) {
    results = rescore(outPath, classify);
  } else {
    const labels = loadKeyLabels(set);
    results = [];
    await runPool(fileURLToPath(import.meta.url),
      pickSample(Object.keys(labels)).map((p) => ({ name: p, file: p })),
      (r) => {
        const truth = labels[r.name];
        results.push({ ...r, truth, verdict: classify(r.ours, truth), file: r.name });
      });
  }

  const counts = printCounts(`key vs ${set}`, results, CATEGORIES);
  const n = results.length;
  const share = (k) => ((100 * (counts[k] || 0)) / n).toFixed(1);
  const mixable = (counts.exact || 0) + (counts.relative || 0) + (counts.neighbour || 0);
  console.log("\n  exact              %s%%", share("exact"));
  console.log("  exact or mixable   %s%%", ((100 * mixable) / n).toFixed(1));

  // The detector reports whether it trusts its own answer. If that flag does not
  // separate right from wrong it is decoration, and the app should stop showing
  // it; this is the check.
  for (const [label, group] of [["confident", results.filter((r) => r.confident)],
    ["unsure", results.filter((r) => !r.confident)]]) {
    if (!group.length) continue;
    const ex = group.filter((r) => r.verdict === "exact").length;
    console.log("  %s  n=%d  exact %s%%",
      label.padEnd(17), group.length, ((100 * ex) / group.length).toFixed(1));
  }

  printByFolder(results, [
    { label: "exact", test: (r) => r.verdict === "exact" },
    { label: "relative", test: (r) => r.verdict === "relative" },
  ]);

  writeResults(outPath, { counts, results });
}

if (isMainThread) main();
