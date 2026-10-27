/*
 * Scores the beat grid (web/js/beatgrid.js) against Rekordbox's own grids.
 *
 * The reference is every beat Rekordbox placed, read from its analysis files
 * by tools/groundtruth/rekordbox_anlz.py --grids. A grid is judged the way it
 * is used: laid over the whole track, not just the two minutes analysed.
 *
 *   F-measure   share of beats matched within 70 ms, both ways (MIREX)
 *   start/end   median distance to the reference over the first and last 16
 *               beats -- a grid that starts right and slides off by the end
 *               shows up here and nowhere else
 *   octave      our tempo against Rekordbox's: same, double, half, other
 *
 * Two grids are scored per track:
 *
 *   before   the tempo the app already shows (whole BPM) with the best phase
 *            for it -- what a grid would be without this work
 *   after    estimateBeatGrid as the app runs it: tempo to 0.01 BPM, refined
 *            over the whole track, phase refined, and a "no grid" verdict
 *            when the track does not hold one tempo
 *
 * Tracks whose Rekordbox grid changes tempo by more than 0.5 BPM are kept
 * apart: there the question is whether we said "no grid".
 *
 * Usage
 * -----
 *   python3 tools/groundtruth/rekordbox_anlz.py --grids ground-truth/rekordbox_grids.json
 *   node tools/measure/measure_grid.mjs [--limit N] [--half train|test] [--offset MS] [--out FILE]
 *   node tools/measure/measure_grid.mjs --rescore [--offset MS] [--out FILE]
 *
 * --offset shifts every grid by MS milliseconds before scoring -- an onset
 * envelope peaks a little after the beat it marks, and that latency is fitted
 * on the train half, never on the half it is reported on.
 */

import { isMainThread, parentPort } from "node:worker_threads";
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { ROOT, loadDsp, decodeMono, arg, pickSample, runPool, writeResults, ANALYSIS_MAX_SECONDS, WHOLE_TRACK_MAX_SECONDS } from "./lib/measure.mjs";
import { halfOf } from "./key_report.mjs";

const RATE = 44100;
const TOLERANCE_MS = 70;
const EDGE_BEATS = 16;
const VARIABLE_BPM = 0.5;

/* ------------------------------------------------------------------ */
/* Scoring -- exported for tools/test/test_grid_score.mjs              */
/* ------------------------------------------------------------------ */

// Beats of a constant grid, in ms, covering [fromMs, toMs].
export function gridBeats(bpm, firstBeatSec, fromMs, toMs) {
  const period = 60000 / bpm;
  const first = firstBeatSec * 1000;
  const out = [];
  let k = Math.ceil((fromMs - first) / period);
  for (let t = first + k * period; t <= toMs; t = first + ++k * period) out.push(t);
  return out;
}

// Distance from t to the nearest value of a sorted array.
function nearest(sorted, t) {
  let lo = 0;
  let hi = sorted.length - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (sorted[mid] < t) lo = mid; else hi = mid;
  }
  return Math.min(Math.abs(sorted[lo] - t), Math.abs(sorted[hi] - t));
}

function signedNearest(sorted, t) {
  let best = Infinity;
  for (const s of sorted) if (Math.abs(s - t) < Math.abs(best)) best = s - t;
  return best;
}

const median = (xs) => {
  const s = xs.slice().sort((a, b) => a - b);
  return s.length ? (s.length % 2 ? s[s.length >> 1] : (s[(s.length >> 1) - 1] + s[s.length >> 1]) / 2) : null;
};

/*
 * F-measure of a predicted beat list against a reference one, each beat used
 * at most once. Both lists are near-regular here and the tolerance is well
 * under half a period, so nearest-neighbour matching is one-to-one.
 */
export function fMeasure(reference, predicted, tolerance = TOLERANCE_MS) {
  if (!reference.length || !predicted.length) return 0;
  const used = new Set();
  let hits = 0;
  for (const r of reference) {
    let lo = 0;
    let hi = predicted.length - 1;
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (predicted[mid] < r) lo = mid; else hi = mid;
    }
    const j = Math.abs(predicted[lo] - r) <= Math.abs(predicted[hi] - r) ? lo : hi;
    if (Math.abs(predicted[j] - r) <= tolerance && !used.has(j)) {
      used.add(j);
      hits++;
    }
  }
  const precision = hits / predicted.length;
  const recall = hits / reference.length;
  return precision + recall ? (2 * precision * recall) / (precision + recall) : 0;
}

export function octaveOf(ours, truth) {
  const r = ours / truth;
  if (Math.abs(r - 1) < 0.02) return "same";
  if (Math.abs(r - 2) < 0.04) return "double";
  if (Math.abs(r - 0.5) < 0.01) return "half";
  return "other";
}

// Every measure for one grid against one reference.
export function scoreGrid(refMs, bpm, firstBeatSec, offsetMs = 0) {
  const from = refMs[0] - TOLERANCE_MS;
  const to = refMs[refMs.length - 1] + TOLERANCE_MS;
  const pred = gridBeats(bpm, firstBeatSec + offsetMs / 1000, from, to);
  const edge = (beats) => median(beats.map((t) => nearest(pred, t)));
  return {
    f: fMeasure(refMs, pred),
    startMs: edge(refMs.slice(0, EDGE_BEATS)),
    endMs: edge(refMs.slice(-EDGE_BEATS)),
    // Signed, at the start: positive when our beats come late. This is what
    // the latency offset is fitted on.
    leadMs: median(refMs.slice(0, 64).map((t) => -signedNearest(pred, t))),
  };
}

/* ------------------------------------------------------------------ */
/* Worker                                                              */
/* ------------------------------------------------------------------ */

if (!isMainThread) {
  const dsp = loadDsp(["analyzeTempo", "onsetStrength", "fitBeatGrid", "estimateBeatGrid", "mp3HeaderKind", "gridOffsetFor", "id3v2Length", "bestPhase", "onsetPeaks", "ONSET_HOP", "GRID_TEMPO_RATE"],
    readFileSync(join(ROOT, "web/js/beatgrid.js"), "utf8") + readFileSync(join(ROOT, "web/js/downbeat.js"), "utf8")
    + readFileSync(join(ROOT, "web/js/tags.js"), "utf8"));
  parentPort.on("message", (task) => {
    if (task === null) process.exit(0);
    try {
      const whole = decodeMono(task.file, RATE, WHOLE_TRACK_MAX_SECONDS).y;
      const y = whole.subarray(0, Math.min(whole.length, ANALYSIS_MAX_SECONDS * RATE));
      // What the app sends for the grid's tempo: the whole track, resampled.
      const forTempo = whole.length > y.length ? decodeMono(task.file, dsp.GRID_TEMPO_RATE, WHOLE_TRACK_MAX_SECONDS).y : null;
      const started = performance.now();
      const tempo = dsp.analyzeTempo(y, RATE);
      const grid = tempo.bpm ? dsp.fitBeatGrid(y, RATE, tempo.bpm) : null;
      const final = tempo.bpm ? dsp.estimateBeatGrid(y, RATE, tempo.bpm, tempo, forTempo, dsp.GRID_TEMPO_RATE) : null;
      // The whole ID3 tag has to be skipped to find the MP3 header, and cover
      // art can make the tag hundreds of kilobytes long.
      const head = new Uint8Array(readFileSync(task.file).subarray(0, 4 * 1024 * 1024));
      const kind = task.file.toLowerCase().endsWith(".wav") ? "wav" : dsp.mp3HeaderKind(head);
      const tagBytes = dsp.id3v2Length(head);
      if (final) final.rekordboxFirstBeat = final.firstBeat + dsp.gridOffsetFor("rekordbox", kind, RATE, tagBytes);
      const env = dsp.onsetStrength(y, RATE);
      const fps = RATE / dsp.ONSET_HOP;
      const ms = Math.round(performance.now() - started);
      // Before: the whole BPM the app shows, with its best phase.
      let before = null;
      if (tempo.bpm) {
        const period = (60 * fps) / tempo.bpm;
        const p = dsp.bestPhase(dsp.onsetPeaks(env, fps), period, 0.5, 0, env.length);
        before = { bpm: tempo.bpm, firstBeat: p.phase / fps };
      }
      parentPort.postMessage({
        name: task.name, file: task.file, seconds: whole.length / RATE,
        bpmHint: tempo.bpm, mode: tempo.mode, before, grid, final, kind, tagBytes, ms,
      });
    } catch (e) {
      parentPort.postMessage({ name: task.name, file: task.file, error: String(e.message || e) });
    }
  });
}

/* ------------------------------------------------------------------ */
/* Main                                                                */
/* ------------------------------------------------------------------ */

function report(rows, refs, offsetMs) {
  const constant = rows.filter((r) => refs[r.name].variable === false);
  const variable = rows.filter((r) => refs[r.name].variable === true);
  const pct = (k, n) => (n ? ((100 * k) / n).toFixed(1) + "%" : "-");
  const mean = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);

  const variants = [
    ["before (whole BPM, best phase, no offset)", (r) => r.before],
    ["after, every grid (estimateBeatGrid, Rekordbox offset)", (r) => r.final && { ...r.final, firstBeat: r.final.rekordboxFirstBeat, place: true }],
    ["after, only grids it would write", (r) => r.final && { ...r.final, firstBeat: r.final.rekordboxFirstBeat }],
  ];
  for (const [label, pick] of variants) {
    const scored = constant.filter((r) => pick(r)).map((r) => {
      const g = pick(r);
      const ref = refs[r.name];
      return { ...scoreGrid(ref.ms, g.bpm, g.firstBeat, offsetMs), octave: octaveOf(g.bpm, ref.bpm), noGrid: g.place === false, bpmError: Math.abs(g.bpm - ref.bpm) };
    });
    const placed = scored.filter((s) => !s.noGrid);
    const sameOctave = placed.filter((s) => s.octave === "same");
    console.log(`\n${label}: ${constant.length} tracks with a one-tempo Rekordbox grid`);
    console.log(`  grid placed       ${placed.length}   (said "no grid": ${scored.length - placed.length}, no tempo: ${constant.length - scored.length})`);
    console.log(`  tempo octave      same ${pct(sameOctave.length, placed.length)}  double ${pct(placed.filter((s) => s.octave === "double").length, placed.length)}  half ${pct(placed.filter((s) => s.octave === "half").length, placed.length)}  other ${pct(placed.filter((s) => s.octave === "other").length, placed.length)}`);
      console.log(`  F-measure (70 ms) mean ${mean(placed.map((s) => s.f)).toFixed(3)}   >= 0.8: ${pct(placed.filter((s) => s.f >= 0.8).length, placed.length)}   >= 0.9: ${pct(placed.filter((s) => s.f >= 0.9).length, placed.length)}   same-octave mean ${mean(sameOctave.map((s) => s.f)).toFixed(3)}`);
    console.log(`  same octave: BPM within 0.01 of Rekordbox ${pct(sameOctave.filter((s) => s.bpmError <= 0.0101).length, sameOctave.length)}, within 0.05 ${pct(sameOctave.filter((s) => s.bpmError <= 0.0501).length, sameOctave.length)}`);
    console.log(`  same octave: start error median ${median(sameOctave.map((s) => s.startMs))?.toFixed(1)} ms, end error median ${median(sameOctave.map((s) => s.endMs))?.toFixed(1)} ms, end > 70 ms ${pct(sameOctave.filter((s) => s.endMs > 70).length, sameOctave.length)}`);
    console.log(`  signed lead at start, median ${median(sameOctave.map((s) => s.leadMs))?.toFixed(1)} ms (positive: our beats late)`);
  }
  const said = variable.filter((r) => r.final && r.final.place === false).length;
  const constSaid = constant.filter((r) => r.final && r.final.place === false).length;
  console.log(`\nno-grid verdict: on ${variable.length} tracks whose Rekordbox grid changes tempo, said "no grid" on ${said} (${pct(said, variable.length)});`);
  console.log(`                 on ${constant.length} one-tempo tracks, withheld on ${constSaid} (${pct(constSaid, constant.length)}) -- "unsure" or "dynamic"`);
  const times = rows.filter((r) => r.ms).map((r) => r.ms);
  console.log(`\ntime per track (tempo + grid), median ${median(times)} ms`);
}

async function main() {
  const outPath = arg("--out", join(ROOT, "ground-truth/grid_results.json"));
  const offsetMs = parseFloat(arg("--offset", "0"));
  const grids = JSON.parse(readFileSync(join(ROOT, "ground-truth/rekordbox_grids.json"), "utf8")).byName;
  // ANLZ files name their track only as "?/<file name>"; the full path comes
  // from the database export, by file name. A name that two folders share is
  // ambiguous and left out.
  const byPath = JSON.parse(readFileSync(join(ROOT, "ground-truth/rekordbox_db.json"), "utf8")).byPath;
  const pathOf = {};
  for (const p of Object.keys(byPath)) {
    const base = p.slice(p.lastIndexOf("/") + 1);
    pathOf[base] = pathOf[base] === undefined ? p : null;
  }
  const refs = {};
  for (const [name, g] of Object.entries(grids)) {
    const path = pathOf[name];
    if (!path || !g.ms || g.ms.length < 64 || !existsSync(path)) continue;
    const tempos = g.tempos.map(([, t]) => t / 100);
    refs[path] = {
      ms: g.ms,
      bpm: g.tempos[0][1] / 100,
      variable: Math.max(...tempos) - Math.min(...tempos) > VARIABLE_BPM,
      firstBeatInBar: g.firstBeatInBar,
    };
  }

  let rows;
  if (process.argv.includes("--rescore")) {
    rows = JSON.parse(readFileSync(outPath, "utf8")).results;
  } else {
    const half = arg("--half", null);
    const names = Object.keys(refs).filter((p) => !half || halfOf(p) === half);
    rows = [];
    await runPool(fileURLToPath(import.meta.url), pickSample(names).map((p) => ({ name: p, file: p })), (r) => rows.push(r));
    const unreadable = rows.filter((r) => r.error).length;
    writeResults(outPath, { results: rows });
    if (unreadable > Math.max(5, rows.length * 0.01)) {
      console.log("%d tracks could not be read -- is the music drive connected? Not a measurement.", unreadable);
      process.exitCode = 2;
      return;
    }
  }
  const half = arg("--half", null);
  rows = rows.filter((r) => !r.error && refs[r.name] && (!half || halfOf(r.name) === half));
  console.log("tracks %d%s, offset %s ms", rows.length, half ? ` [${half} half]` : "", offsetMs);
  report(rows, refs, offsetMs);
}

if (isMainThread && process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main();
