/*
 * Which beat starts the bar (web/js/downbeat.js), against Rekordbox's bars.
 *
 * Rekordbox numbers every beat of its grid 1-4 in the analysis files
 * (tools/groundtruth/rekordbox_anlz.py --grids keeps the first sixteen; a
 * one-tempo 4/4 grid continues the count). For each track our grid's first
 * beat is matched to Rekordbox's nearest beat, within 70 ms; that beat's
 * number says which of our first four beats is the downbeat. Tracks whose
 * grid is off Rekordbox's, or at another tempo octave, carry no label.
 *
 * The baseline is what the Rekordbox XML writes without this: the first beat
 * is a downbeat (phase 0). The model is fitted on the train half and scored
 * on the test half only, with McNemar against the baseline on the same
 * tracks.
 *
 * Usage
 * -----
 *   node tools/measure/measure_downbeat.mjs [--limit N] [--out FILE]   # decode, features, report
 *   node tools/measure/measure_downbeat.mjs --rescore [--out FILE]     # refit and report from saved features
 *
 * Features are saved to ground-truth/ (never committed), so the model can be
 * refitted without decoding the library again.
 */

import { isMainThread, parentPort } from "node:worker_threads";
import { readFileSync, existsSync, openSync, readSync, closeSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { ROOT, loadDsp, decodeMono, arg, pickSample, runPool, writeResults, ANALYSIS_MAX_SECONDS, WHOLE_TRACK_MAX_SECONDS } from "./lib/measure.mjs";
import { halfOf } from "./key_report.mjs";

const RATE = 44100;
const TOLERANCE_MS = 70;
const VARIABLE_BPM = 0.5;

/* ------------------------------------------------------------------ */
/* Labels and the model -- exported for tools/test/test_downbeat.mjs  */
/* ------------------------------------------------------------------ */

/*
 * Which of our first four beats is a downbeat by Rekordbox's count, or null.
 * ms: Rekordbox's beat times; firstBarBeat: the number (1-4) of its first beat.
 */
export function downbeatLabel(firstBeatMs, ms, firstBarBeat) {
  let best = -1;
  let bestDistance = Infinity;
  for (let i = 0; i < ms.length; i++) {
    const d = Math.abs(ms[i] - firstBeatMs);
    if (d < bestDistance) { bestDistance = d; best = i; }
  }
  if (best < 0 || bestDistance > TOLERANCE_MS) return null;
  const number = ((firstBarBeat - 1 + best) % 4) + 1;
  return (5 - number) % 4;
}

export function phaseScores(candidates, weights) {
  return candidates.map((x, p) => x.reduce((s, v, j) => s + weights[j] * v, 0) + (p === 0 ? weights[x.length] : 0));
}

const argmax = (xs) => xs.indexOf(Math.max(...xs));

/*
 * Softmax regression over the four phases with one weight vector shared by
 * all of them, plus a bias for phase 0. Plain gradient descent: the data is a
 * few thousand tracks and eleven weights.
 */
export function fitDownbeat(rows, { iterations = 3000, rate = 0.5, l2 = 1e-3 } = {}) {
  const dims = rows[0].candidates[0].length + 1;
  const w = new Float64Array(dims);
  for (let it = 0; it < iterations; it++) {
    const grad = new Float64Array(dims);
    for (const { candidates, label } of rows) {
      const scores = phaseScores(candidates, w);
      const max = Math.max(...scores);
      const exps = scores.map((s) => Math.exp(s - max));
      const total = exps.reduce((a, b) => a + b, 0);
      for (let p = 0; p < 4; p++) {
        const g = exps[p] / total - (p === label ? 1 : 0);
        for (let j = 0; j < dims - 1; j++) grad[j] += g * candidates[p][j];
        if (p === 0) grad[dims - 1] += g;
      }
    }
    for (let j = 0; j < dims; j++) w[j] -= rate * (grad[j] / rows.length + l2 * w[j]);
  }
  return Array.from(w, (v) => Math.round(v * 1000) / 1000);
}

/* ------------------------------------------------------------------ */
/* Worker                                                              */
/* ------------------------------------------------------------------ */

if (!isMainThread) {
  const dsp = loadDsp(["analyzeTempo", "estimateBeatGrid", "beatSyncFeatures", "downbeatCandidates", "mp3HeaderKind", "gridOffsetFor", "id3v2Length"],
    readFileSync(join(ROOT, "web/js/beatgrid.js"), "utf8") + readFileSync(join(ROOT, "web/js/downbeat.js"), "utf8")
    + readFileSync(join(ROOT, "web/js/tags.js"), "utf8"));
  parentPort.on("message", (task) => {
    if (task === null) process.exit(0);
    try {
      const whole = decodeMono(task.file, RATE, WHOLE_TRACK_MAX_SECONDS).y;
      const y = whole.subarray(0, Math.min(whole.length, ANALYSIS_MAX_SECONDS * RATE));
      const tempo = dsp.analyzeTempo(y, RATE);
      const grid = tempo.bpm ? dsp.estimateBeatGrid(y, RATE, tempo.bpm, tempo.mode) : null;
      if (!grid) { parentPort.postMessage({ name: task.name, file: task.file, grid: null }); return; }
      const started = performance.now();
      const candidates = dsp.downbeatCandidates(dsp.beatSyncFeatures(y, RATE, grid.bpm, grid.firstBeat));
      const ms = Math.round(performance.now() - started);
      const fd = openSync(task.file, "r");
      const buf = Buffer.alloc(4 * 1024 * 1024);
      const got = readSync(fd, buf, 0, buf.length, 0);
      closeSync(fd);
      const head = new Uint8Array(buf.buffer, buf.byteOffset, got);
      const kind = task.file.toLowerCase().endsWith(".wav") ? "wav" : dsp.mp3HeaderKind(head);
      const rekordboxFirstBeat = grid.firstBeat + dsp.gridOffsetFor("rekordbox", kind, RATE, dsp.id3v2Length(head));
      parentPort.postMessage({ name: task.name, file: task.file, grid, kind, rekordboxFirstBeat, candidates, ms });
    } catch (e) {
      parentPort.postMessage({ name: task.name, file: task.file, error: String(e.message || e) });
    }
  });
}

/* ------------------------------------------------------------------ */
/* Main                                                                */
/* ------------------------------------------------------------------ */

function mcnemar(rows, a, b) {
  let fixed = 0, broken = 0;
  for (const r of rows) {
    const x = a(r), y = b(r);
    if (!x && y) fixed++;
    if (x && !y) broken++;
  }
  const chi = fixed + broken ? ((Math.abs(fixed - broken) - 1) ** 2) / (fixed + broken) : 0;
  return { fixed, broken, chi };
}

function report(label, rows, weights) {
  const pct = (k, n) => (n ? ((100 * k) / n).toFixed(1) + "%" : "-");
  const predict = (r) => argmax(phaseScores(r.candidates, weights));
  const base = rows.filter((r) => r.label === 0).length;
  const model = rows.filter((r) => predict(r) === r.label).length;
  const m = mcnemar(rows, (r) => r.label === 0, (r) => predict(r) === r.label);
  const byLabel = [0, 1, 2, 3].map((p) => `${p}: ${rows.filter((r) => r.label === p).length}`).join("  ");
  console.log(`\n${label}: ${rows.length} tracks (Rekordbox's downbeat at our beat ${byLabel})`);
  console.log(`  first beat is the downbeat (now)  ${pct(base, rows.length)}`);
  console.log(`  downbeat.js                       ${pct(model, rows.length)}`);
  console.log(`  McNemar: fixed ${m.fixed}, broken ${m.broken}, chi2 ${m.chi.toFixed(1)} (3.84 = p 0.05)`);
}

async function main() {
  const outPath = arg("--out", join(ROOT, "ground-truth/downbeat_features.json"));
  const grids = JSON.parse(readFileSync(join(ROOT, "ground-truth/rekordbox_grids.json"), "utf8")).byName;
  const byPath = JSON.parse(readFileSync(join(ROOT, "ground-truth/rekordbox_db.json"), "utf8")).byPath;
  const pathOf = {};
  for (const p of Object.keys(byPath)) {
    const base = p.slice(p.lastIndexOf("/") + 1);
    pathOf[base] = pathOf[base] === undefined ? p : null;
  }
  const refs = {};
  for (const [name, g] of Object.entries(grids)) {
    const path = pathOf[name];
    if (!path || !g.ms || g.ms.length < 64 || !g.bars || !existsSync(path)) continue;
    const tempos = g.tempos.map(([, t]) => t / 100);
    if (Math.max(...tempos) - Math.min(...tempos) > VARIABLE_BPM) continue;
    refs[path] = { ms: g.ms, bpm: tempos[0], firstBarBeat: g.bars[0] };
  }

  let rows;
  if (process.argv.includes("--rescore")) {
    rows = JSON.parse(readFileSync(outPath, "utf8")).results;
  } else {
    rows = [];
    await runPool(fileURLToPath(import.meta.url), pickSample(Object.keys(refs)).map((p) => ({ name: p, file: p })), (r) => rows.push(r));
    writeResults(outPath, { results: rows });
    const unreadable = rows.filter((r) => r.error).length;
    if (unreadable > Math.max(5, rows.length * 0.01)) {
      console.log("%d tracks could not be read -- is the music drive connected? Not a measurement.", unreadable);
      process.exitCode = 2;
      return;
    }
  }

  const labelled = [];
  for (const r of rows) {
    const ref = refs[r.name];
    if (!ref || r.error || !r.grid || !r.candidates) continue;
    if (Math.abs(r.grid.bpm - ref.bpm) > VARIABLE_BPM) continue;
    const label = downbeatLabel(r.rekordboxFirstBeat * 1000, ref.ms, ref.firstBarBeat);
    if (label === null) continue;
    labelled.push({ ...r, label, half: halfOf(r.name) });
  }
  const train = labelled.filter((r) => r.half === "train");
  const test = labelled.filter((r) => r.half === "test");
  console.log("labelled %d of %d tracks (train %d, test %d)", labelled.length, rows.length, train.length, test.length);
  const weights = fitDownbeat(train);
  console.log("weights (paste into DOWNBEAT_WEIGHTS):", JSON.stringify(weights));
  report("train half (fitted on)", train, weights);
  report("test half, every grid", test, weights);
  report("test half, grids it would write", test.filter((r) => r.grid.place), weights);
  const times = rows.filter((r) => r.ms).map((r) => r.ms).sort((a, b) => a - b);
  console.log(`\ntime per track (features), median ${times[times.length >> 1]} ms`);
}

if (isMainThread && process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main();
