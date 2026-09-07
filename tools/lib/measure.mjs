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
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, relative } from "node:path";
import os from "node:os";

const HERE = dirname(fileURLToPath(import.meta.url));
export const ROOT = join(HERE, "../..");
// app.js:33 -- the browser analyses the first two minutes and no more.
export const ANALYSIS_MAX_SECONDS = 120;
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
export function loadDsp(names, extra = "") {
  const code = readFileSync(join(ROOT, "web/js/dsp.js"), "utf8");
  // eslint-disable-next-line no-new-func
  return new Function(code + "\n" + extra + `\nreturn { ${names.join(", ")} };`)();
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
export function decodeMono(file, rate) {
  const args = ["-v", "quiet", "-i", file, "-t", String(ANALYSIS_MAX_SECONDS), "-ac", "1"];
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
      const w = new Worker(workerUrl);
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
