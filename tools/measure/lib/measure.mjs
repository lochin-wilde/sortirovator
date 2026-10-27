/*
 * Shared machinery for measuring dsp.js against Rekordbox.
 *
 * Two things are measured -- tempo and key -- and almost everything around them
 * is the same: load the shipped analysis code, decode a file the way the browser
 * does, spread the work over cores, score the answers, print a per-folder
 * breakdown. Only the detector call and the notion of "close enough" differ, so
 * only those live in the individual scripts.
 *
 * Fidelity to the app is the point of this file. The browser decodes with
 * decodeAudioData, averages the channels to mono, keeps the first two minutes,
 * and passes that to the detector; ffmpeg stands in for the decoder and the rest
 * is matched deliberately. A harness that measured a different signal than the
 * app plays would be scoring the wrong thing.
 */

import { Worker } from "node:worker_threads";
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync, mkdirSync, readdirSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, relative } from "node:path";
import os from "node:os";
import { camelotFromKeyName } from "../key_report.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
export const ROOT = join(HERE, "../../..");
// app.js:33 -- the browser analyses the first two minutes and no more.
export const ANALYSIS_MAX_SECONDS = 120;

/*
 * Which stretch of a track the key is measured on. "first" is what the app
 * does today; the others are candidates. A window that does not fit falls
 * back to as much of the track as there is.
 */
export const KEY_WINDOWS = ["first", "skip60", "middle", "whole"];
// Longest track decoded whole -- a DJ edit, not a recorded set.
export const WHOLE_TRACK_MAX_SECONDS = 900;

export function keyWindow(y, rate, window) {
  const span = ANALYSIS_MAX_SECONDS * rate;
  if (window === "whole") return y;
  if (y.length <= span) return y;
  let start = 0;
  if (window === "skip60") start = Math.min(60 * rate, y.length - span);
  if (window === "middle") start = Math.floor((y.length - span) / 2);
  if (window !== "first" && window !== "skip60" && window !== "middle") throw new Error("unknown key window " + window);
  return y.subarray(start, start + span);
}
// The library these labels come from. Only used to shorten paths in the report.
const LIBRARY_ROOT = "/Volumes/HomeSSD/Lochin";

/*
 * dsp.js is a plain script: no exports, no module wrapper, and no browser API in
 * it. Evaluating it whole and lifting the functions out keeps the measured code
 * byte-identical to the shipped code, which a port or a copy would not.
 *
 * `extra` is appended inside that same scope, which is how a harness reaches a
 * value the shipped code computes but does not return. Use it sparingly: it is
 * a hook into private state, and it breaks loudly rather than silently only
 * because the caller checks what came back.
 */
export function loadDsp(names, extra = "", patches = []) {
  const code = patchSource(readFileSync(join(ROOT, "web/js/dsp.js"), "utf8"), patches);
  // eslint-disable-next-line no-new-func
  return new Function(code + "\n" + extra + `\nreturn { ${names.join(", ")} };`)();
}

const CAMELOT_CODE = /^(?:[1-9]|1[0-2])[AB]$/;

/*
 * Key labels, as { path: Camelot }, for every labelled track whose audio is on
 * disk. Two sets:
 *   rekordbox    the owner's library, keys from a copy of master.db.
 *   giantsteps   GiantSteps-key, ground-truth/giantsteps/{key-dataset,audio}.
 */
// { path: Camelot } for every labelled track whose audio is on disk.
export function loadKeyLabels(set) {
  if (!["rekordbox", "giantsteps"].includes(set)) throw new Error("unknown key label set " + set);
  if (set === "giantsteps") {
    const base = join(ROOT, "ground-truth/giantsteps");
    const labels = {};
    for (const f of readdirSync(join(base, "key-dataset/annotations/key"))) {
      if (!f.endsWith(".key")) continue;
      const key = camelotFromKeyName(readFileSync(join(base, "key-dataset/annotations/key", f), "utf8"));
      const audio = join(base, "audio", f.replace(/\.key$/, ".mp3"));
      if (key && existsSync(audio)) labels[audio] = key;
    }
    return labels;
  }
  const db = JSON.parse(readFileSync(join(ROOT, "ground-truth/rekordbox_db.json"), "utf8")).byPath;
  const labels = {};
  // A label is only useful next to a file we can still decode: the database
  // remembers tracks that have since been moved off the drive.
  for (const p of Object.keys(db)) {
    const key = String(db[p].key || "").trim().toUpperCase();
    if (CAMELOT_CODE.test(key) && existsSync(p)) labels[p] = key;
  }
  return labels;
}

/*
 * Apply [find, replace] pairs to a source text -- how an idea is tried on the
 * detector before anyone edits dsp.js. Each `find` must occur exactly once:
 * a patch that silently matched nothing would measure the unchanged detector
 * and report it as the idea.
 */
export function patchSource(code, patches) {
  for (const [find, replace] of patches) {
    const count = code.split(find).length - 1;
    if (count !== 1) throw new Error(`patch target found ${count} times, expected once: ${find.slice(0, 60)}`);
    code = code.replace(find, () => replace);
  }
  return code;
}

/*
 * Decode to mono float32, optionally resampled.
 *
 * WAV on stdout rather than raw f32le: the sample rate has to come from
 * somewhere, and reading it from the header we are already receiving costs one
 * process per track instead of two.
 *
 * When `rate` is given, ffmpeg resamples rather than the browser's
 * OfflineAudioContext. Both are good resamplers and neither is the one the app
 * uses in the other's place, so a handful of tracks may land differently here
 * than in the browser -- worth remembering before chasing a single-track
 * disagreement between this harness and the running app.
 */
export function decodeMono(file, rate, maxSeconds = ANALYSIS_MAX_SECONDS) {
  const args = ["-v", "quiet", "-i", file, "-t", String(maxSeconds), "-ac", "1"];
  if (rate) args.push("-ar", String(rate));
  args.push("-c:a", "pcm_f32le", "-f", "wav", "-");
  const buf = execFileSync("ffmpeg", args, { maxBuffer: 1024 * 1024 * 512 });

  if (buf.length < 12 || buf.toString("latin1", 0, 4) !== "RIFF") throw new Error("not RIFF");
  let offset = 12;
  let sampleRate = 0;
  while (offset + 8 <= buf.length) {
    const id = buf.toString("latin1", offset, offset + 4);
    const size = buf.readUInt32LE(offset + 4);
    const body = offset + 8;
    if (id === "fmt ") {
      sampleRate = buf.readUInt32LE(body + 4);
    } else if (id === "data") {
      // ffmpeg writes 0xFFFFFFFF for a stream of unknown length, so the declared
      // size cannot be trusted -- take everything that arrived.
      const end = size === 0xffffffff || body + size > buf.length ? buf.length : body + size;
      const bytes = (end - body) & ~3;
      const y = new Float32Array(bytes / 4);
      for (let i = 0; i < y.length; i++) y[i] = buf.readFloatLE(body + i * 4);
      return { y, sampleRate };
    }
    offset = body + size + (size & 1);
  }
  throw new Error("no data chunk");
}

export function arg(flag, fallback) {
  const i = process.argv.indexOf(flag);
  return i === -1 ? fallback : process.argv[i + 1];
}

// Deterministic sampling, so a limited run can be compared with the one before
// it instead of moving underfoot every time.
function mulberry32(seed) {
  return function () {
    seed |= 0; seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function pickSample(keys) {
  const limit = parseInt(arg("--limit", "0"), 10);
  const sorted = keys.slice().sort();
  if (!(limit > 0) || limit >= sorted.length) return sorted;
  const rnd = mulberry32(parseInt(arg("--seed", "1"), 10));
  for (let i = sorted.length - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1));
    [sorted[i], sorted[j]] = [sorted[j], sorted[i]];
  }
  return sorted.slice(0, limit).sort();
}

/*
 * Hand `tasks` to a pool of workers running `workerUrl`, one at a time each.
 *
 * A worker takes a whole track and is busy for a second or two, so there is no
 * reason for anything cleverer than "give the next job to whoever just
 * finished": that keeps every core fed even though tracks differ in length.
 * `null` tells a worker there is no more work and it should exit.
 */
export function runPool(workerUrl, tasks, onResult) {
  const jobs = Math.max(1, parseInt(arg("--jobs", String(Math.max(1, os.cpus().length - 2))), 10));
  const queue = tasks.slice();
  const total = queue.length;
  let done = 0;
  if (!total) return Promise.resolve();
  process.stderr.write(`tracks ${total}, workers ${Math.min(jobs, total)}\n`);

  return new Promise((resolve, reject) => {
    let live = 0;
    for (let i = 0; i < Math.min(jobs, total); i++) {
      // Workers do not inherit the command line; options such as --patch
      // have to be handed over or the workers silently ignore them. The
      // script path tells a measuring module imported by another one
      // (measure_grid.mjs for scoreGrid) that the worker is not its own.
      const w = new Worker(workerUrl, { argv: process.argv.slice(2), workerData: { script: workerUrl } });
      live++;
      const next = () => {
        const task = queue.shift();
        w.postMessage(task === undefined ? null : task);
      };
      w.on("message", (r) => {
        onResult(r);
        if (++done % 25 === 0 || done === total) process.stderr.write(`\r  ${done}/${total}`);
        next();
      });
      w.on("error", reject);
      w.on("exit", () => { if (--live === 0) { process.stderr.write("\n"); resolve(); } });
      next();
    }
  });
}

// console.log takes printf-style %s and %d but not widths or precision --
// "%6.1f" prints literally -- so columns are built with padStart.
const col = (s, w) => String(s).padStart(w);

export function printCounts(title, results, categories) {
  const counts = {};
  for (const r of results) counts[r.verdict] = (counts[r.verdict] || 0) + 1;
  const n = results.length;
  console.log("\n=== %s, %d tracks ===\n", title, n);
  for (const k of categories) {
    if (counts[k]) {
      console.log("  " + k.padEnd(9) + col(((100 * counts[k]) / n).toFixed(1) + "%", 7)
        + col(counts[k], 7));
    }
  }
  return counts;
}

/*
 * Per-folder, because a detector can be fine on four-to-the-floor house and fall
 * apart on halftime bass music, and one average hides that completely. The
 * folder names are the owner's own sorting, so they stand in for genre.
 */
export function printByFolder(results, columns, minTracks = 10) {
  const byFolder = {};
  for (const r of results) {
    const folder = dirname(relative(LIBRARY_ROOT, r.file)) || ".";
    (byFolder[folder] ||= []).push(r);
  }
  const rows = Object.entries(byFolder)
    .filter(([, v]) => v.length >= minTracks)
    .map(([f, v]) => ({
      f, n: v.length,
      values: columns.map((c) => (100 * v.filter(c.test).length) / v.length),
    }))
    .sort((a, b) => a.values[0] - b.values[0]);
  if (!rows.length) return;

  // Each column is at least two spaces wider than its own heading, or a long
  // heading butts straight up against the one before it.
  const widths = columns.map((c) => Math.max(8, c.label.length + 2));
  console.log("\n  " + "folder".padEnd(38) + col("n", 6)
    + columns.map((c, i) => col(c.label, widths[i])).join(""));
  for (const r of rows) {
    console.log("  " + r.f.slice(0, 38).padEnd(38) + col(r.n, 6)
      + r.values.map((v, i) => col(v.toFixed(1) + "%", widths[i])).join(""));
  }
}

export function writeResults(outPath, payload) {
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, JSON.stringify(payload, null, 1));
  console.log("\nwritten to %s", outPath);
}

/*
 * Re-score a finished run without re-analysing the audio.
 *
 * A run is eight minutes of CPU; changing how an answer is *labelled* should not
 * cost that. The detector's answers are already in the results file, so this
 * replays the scoring over them.
 */
export function rescore(path, classify) {
  const saved = JSON.parse(readFileSync(path, "utf8"));
  for (const r of saved.results) r.verdict = classify(r.ours, r.truth);
  return saved.results;
}
