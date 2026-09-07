/*
 * Extracts the 12-value chroma dsp.js computes for each track and stores it.
 *
 * Why
 * ---
 * detectKey does two things: a constant-Q transform over two minutes of audio,
 * which costs seconds, and a comparison of the resulting chroma against two
 * 12-element profiles, which costs nothing. Only the second depends on the
 * numbers we want to tune, so re-running the first for every candidate would
 * spend four minutes to answer a question that takes a millisecond.
 *
 * Dumped once, a profile sweep over the whole library runs instantly.
 *
 * How the chroma is reached
 * -------------------------
 * detectKey returns a key, not the chroma behind it. Rather than reimplement
 * the CQT here -- a copy would drift from the shipped version and quietly
 * measure the wrong thing -- `pearson` is wrapped inside dsp.js's own scope and
 * the vector it is handed on the first call of the scoring loop is copied out.
 * At that point the loop's rotation is zero, so the vector *is* the chroma.
 *
 * That is a hook into private state and it is only tolerable because it fails
 * loudly: if the scoring loop is ever restructured, the capture comes back
 * empty and every track reports `null` instead of silently drifting.
 *
 * Usage
 * -----
 *   node tools/dump_chroma.mjs [--limit N] [--jobs N] [--out FILE]
 */

import { isMainThread, parentPort } from "node:worker_threads";
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { ROOT, loadDsp, decodeMono, arg, pickSample, runPool, writeResults } from "./lib/measure.mjs";

const KEY_RATE = 22050; // worker.js:25
const CAMELOT = /^\d{1,2}[AB]$/;

/*
 * Appended inside dsp.js's scope. `pearson` is a function declaration, so the
 * binding can be reassigned; both of its call sites are in detectKey's scoring
 * loop and nowhere else, which is what makes this safe to intercept.
 */
const CAPTURE = `
let __capture = null;
const __pearson = pearson;
pearson = function (a, b) {
  if (__capture !== null && __capture.length === 0) __capture.push(Array.from(a));
  return __pearson(a, b);
};
function chromaOf(y, sr) {
  __capture = [];
  const result = detectKey(y, sr);
  const captured = __capture[0] || null;
  __capture = null;
  return { chroma: captured, key: result.key, confidence: result.confidence };
}
`;

if (!isMainThread) {
  const dsp = loadDsp(["chromaOf"], CAPTURE);
  parentPort.on("message", (task) => {
    if (task === null) process.exit(0);
    try {
      const { y } = decodeMono(task.file, KEY_RATE);
      if (y.length < KEY_RATE) throw new Error("too short");
      const out = dsp.chromaOf(y, KEY_RATE);
      parentPort.postMessage({
        name: task.name,
        // Six decimals is far below anything the scoring can resolve and keeps
        // the file to a few megabytes.
        chroma: out.chroma ? out.chroma.map((v) => Math.round(v * 1e6) / 1e6) : null,
        key: out.key,
      });
    } catch (e) {
      parentPort.postMessage({ name: task.name, chroma: null, error: String(e.message || e) });
    }
  });
}

async function main() {
  const db = JSON.parse(readFileSync(join(ROOT, "ground-truth/rekordbox_db.json"), "utf8")).byPath;
  const outPath = arg("--out", join(ROOT, "ground-truth/chroma.json"));

  const usable = Object.keys(db)
    .filter((p) => CAMELOT.test(String(db[p].key || "").toUpperCase()) && existsSync(p));

  const tracks = {};
  let captured = 0;
  await runPool(fileURLToPath(import.meta.url),
    pickSample(usable).map((p) => ({ name: p, file: p })),
    (r) => {
      if (r.chroma) captured++;
      tracks[r.name] = { chroma: r.chroma, key: db[r.name].key, shipped: r.key };
    });

  const total = Object.keys(tracks).length;
  console.log("tracks   %d", total);
  console.log("chroma   %d", captured);
  if (captured === 0) {
    console.log("\nNothing captured -- detectKey's scoring loop no longer calls pearson the\n"
      + "way this script expects. Fix the hook in CAPTURE before trusting a sweep.");
  }
  writeResults(outPath, { rate: KEY_RATE, tracks });
}

if (isMainThread) main();
