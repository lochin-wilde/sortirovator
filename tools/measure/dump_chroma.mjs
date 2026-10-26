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
 *   node tools/measure/dump_chroma.mjs [--set rekordbox|giantsteps] [--blocks SECONDS] [--limit N] [--jobs N] [--out FILE]
 *
 * --blocks also stores the chroma of every consecutive SECONDS-long stretch,
 * as { n: frames, chroma } -- what tools/measure/try_key_segments.mjs needs to
 * vote over segments of any length that is a multiple of SECONDS. The frame
 * means of the blocks, weighted by n, add back up to the whole-track chroma.
 */

import { isMainThread, parentPort } from "node:worker_threads";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { ROOT, loadDsp, loadKeyLabels, decodeMono, arg, pickSample, runPool, writeResults } from "./lib/measure.mjs";

const KEY_RATE = 22050; // worker.js:25

/*
 * Appended inside dsp.js's scope. `pearson` is a function declaration, so the
 * binding can be reassigned; both of its call sites are in detectKey's scoring
 * loop and nowhere else, which is what makes this safe to intercept.
 */
const CAPTURE = `
let __capture = null;
let __frames = null;
const __pearson = pearson;
pearson = function (a, b) {
  if (__capture !== null && __capture.length === 0) __capture.push(Array.from(a));
  return __pearson(a, b);
};
function chromaOf(y, sr, blockSeconds) {
  __capture = [];
  __frames = null;
  const result = detectKey(y, sr);
  const captured = __capture[0] || null;
  __capture = null;
  let blocks = null;
  if (blockSeconds && __frames) {
    const per = Math.max(1, Math.round((blockSeconds * sr) / CQT_HOP));
    const total = __frames[0].length;
    blocks = [];
    for (let start = 0; start < total; start += per) {
      const end = Math.min(total, start + per);
      const chroma = [];
      for (let c = 0; c < 12; c++) {
        let acc = 0;
        for (let t = start; t < end; t++) acc += __frames[c][t];
        chroma.push(acc / (end - start));
      }
      blocks.push({ n: end - start, chroma });
    }
  }
  return { chroma: captured, blocks, key: result.key, confidence: result.confidence };
}
`;

/*
 * The per-frame chroma, taken just before detectKey averages it. Same caveat
 * as the pearson hook: a patch that stops matching throws (patchSource), and
 * a capture that comes back empty leaves `blocks` null for every track.
 */
const FRAMES_LINE = "  if (perClassFrames[0].length === 0) return { key: null, confidence: null, confident: false };";
const FRAMES_PATCH = [[FRAMES_LINE, "  __frames = perClassFrames;\n" + FRAMES_LINE]];

if (!isMainThread) {
  const dsp = loadDsp(["chromaOf"], CAPTURE, FRAMES_PATCH);
  const blockSeconds = parseFloat(arg("--blocks", "0")) || 0;
  parentPort.on("message", (task) => {
    if (task === null) process.exit(0);
    try {
      const { y } = decodeMono(task.file, KEY_RATE);
      if (y.length < KEY_RATE) throw new Error("too short");
      const out = dsp.chromaOf(y, KEY_RATE, blockSeconds);
      parentPort.postMessage({
        name: task.name,
        // Six decimals is far below anything the scoring can resolve and keeps
        // the file to a few megabytes.
        chroma: out.chroma ? out.chroma.map((v) => Math.round(v * 1e6) / 1e6) : null,
        blocks: out.blocks ? out.blocks.map((b) => ({ n: b.n, chroma: b.chroma.map((v) => Math.round(v * 1e6) / 1e6) })) : null,
        key: out.key,
      });
    } catch (e) {
      parentPort.postMessage({ name: task.name, chroma: null, error: String(e.message || e) });
    }
  });
}

async function main() {
  const set = arg("--set", "rekordbox");
  const labels = loadKeyLabels(set);
  const outPath = arg("--out", join(ROOT, set === "rekordbox" ? "ground-truth/chroma.json" : `ground-truth/chroma_${set}.json`));
  const usable = Object.keys(labels);

  const tracks = {};
  let captured = 0;
  await runPool(fileURLToPath(import.meta.url),
    pickSample(usable).map((p) => ({ name: p, file: p })),
    (r) => {
      if (r.chroma) captured++;
      tracks[r.name] = { chroma: r.chroma, key: labels[r.name], shipped: r.key };
      if (r.blocks) tracks[r.name].blocks = r.blocks;
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
