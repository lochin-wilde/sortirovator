/*
 * Which of two half-beat phases is the beat, and whether to write the grid:
 * fits gridDecision's phase and confidence models in beatgrid.js.
 *
 * The kick-band comb lands half a beat out on about 15% of tracks: an
 * off-beat bass has as much onset energy below 150 Hz as the kick. What tells
 * them apart is the shape of the whole beat -- the click above 1 kHz on the
 * kick, the sidechain dip after it, the open hat on the off-beat, a clap on
 * every other beat. So per track this saves, for the grid fitBeatGrid finds
 * (phase 0) and the one half a beat later (phase 1):
 *
 *   profiles   per band, the onset envelope (flux) and the log magnitude
 *              (level), averaged by where in the beat each frame falls
 *              (beatProfile): over the two minutes at the file's rate
 *              (fitBeatGrid's shape), and over the whole track at
 *              GRID_TEMPO_RATE with the whole-track tempo (the bands that fit
 *              below its Nyquist). Phase 1's profile is phase 0's rotated by
 *              half, so only phase 0's is stored.
 *   bars       downbeatCandidates on both phases (what barContrast reads).
 *
 * plus the fit itself (gridEvidence), the tempo and the grid the code that
 * made the dump chose ("before"). --fit compares phase models on the train
 * half and scores them on the held-out half, fits the confidence model for
 * the chosen one with the threshold rule used before, and scores the shipped
 * gridDecision on the same rows. Results are in web/README.md, "Beat grid".
 *
 *   node tools/measure/grid_halfbeat.mjs [--limit N] [--out FILE]
 *   node tools/measure/grid_halfbeat.mjs --fit [--in FILE] [--phase LABEL]
 *
 * Writes ground-truth/grid_halfbeat.json (never committed).
 */

import { isMainThread, parentPort } from "node:worker_threads";
import { readFileSync, existsSync, openSync, readSync, closeSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { ROOT, loadDsp, decodeMono, arg, pickSample, runPool, writeResults, ANALYSIS_MAX_SECONDS, WHOLE_TRACK_MAX_SECONDS } from "./lib/measure.mjs";
import { scoreGrid } from "./measure_grid.mjs";
import { halfOf } from "./key_report.mjs";
import { fitLogistic, logit } from "./grid_models.mjs";

const RATE = 44100;
const round = (v) => Math.round(v * 10000) / 10000;

if (!isMainThread) {
  const dsp = loadDsp(["analyzeTempo", "fitBeatGrid", "estimateBeatGrid", "wholeTrackTempo", "downbeatFrames", "beatSyncFeatures", "downbeatCandidates",
    "bandOnsetEnvelopes", "beatProfile", "GRID_BANDS", "GRID_TEMPO_RATE", "GRID_TEMPO_FFT", "GRID_TEMPO_HOP", "mp3HeaderKind", "gridOffsetFor", "id3v2Length"],
  readFileSync(join(ROOT, "web/js/beatgrid.js"), "utf8") + readFileSync(join(ROOT, "web/js/downbeat.js"), "utf8")
    + readFileSync(join(ROOT, "web/js/tags.js"), "utf8"));
  const rounded = (shape) => ({ flux: shape.flux.map((p) => p.map(round)), level: shape.level.map((p) => p.map(round)) });

  parentPort.on("message", (task) => {
    if (task === null) process.exit(0);
    try {
      const y = decodeMono(task.file, RATE, ANALYSIS_MAX_SECONDS).y;
      const whole = decodeMono(task.file, dsp.GRID_TEMPO_RATE, WHOLE_TRACK_MAX_SECONDS).y;
      const seconds = whole.length / dsp.GRID_TEMPO_RATE;
      const tempo = dsp.analyzeTempo(y, RATE);
      const out = { name: task.name, seconds, tempo: { bpm: tempo.bpm, mode: tempo.mode, min: tempo.min, max: tempo.max } };
      const fit = tempo.bpm ? dsp.fitBeatGrid(y, RATE, tempo.bpm) : null;
      if (fit) {
        const longer = seconds > y.length / RATE + 1;
        const bpm = longer ? dsp.wholeTrackTempo(whole, dsp.GRID_TEMPO_RATE, fit.bpm) : fit.bpm;
        const final = dsp.estimateBeatGrid(y, RATE, tempo.bpm, tempo, longer ? whole : null, dsp.GRID_TEMPO_RATE);
        const frames = dsp.downbeatFrames(y, RATE);
        const bars = (t) => dsp.downbeatCandidates(dsp.beatSyncFeatures(y, RATE, fit.bpm, t, frames));
        out.fit = { bpm: fit.bpm, firstBeat: fit.firstBeat, period: fit.period, local: fit.local, halfBeat: fit.halfBeat, kick: fit.kick };
        out.bpm = bpm;
        out.final = { firstBeat: final.firstBeat, confidence: final.confidence, place: final.place };
        out.bars = [bars(fit.firstBeat), bars(fit.firstBeat + fit.period / 2)];
        out.short = rounded(fit.shape);

        const wfps = dsp.GRID_TEMPO_RATE / dsp.GRID_TEMPO_HOP;
        const wbands = dsp.GRID_BANDS.filter(([, hi]) => hi <= dsp.GRID_TEMPO_RATE / 2);
        const long = dsp.bandOnsetEnvelopes(whole, dsp.GRID_TEMPO_RATE, wbands, dsp.GRID_TEMPO_FFT, dsp.GRID_TEMPO_HOP, true);
        const wperiod = (60 * wfps) / bpm;
        const at = (e) => dsp.beatProfile(e, wperiod, fit.firstBeat * wfps);
        out.long = rounded({ flux: long.flux.map(at), level: long.level.map(at) });
      }
      const fd = openSync(task.file, "r");
      const buf = Buffer.alloc(4 * 1024 * 1024);
      const got = readSync(fd, buf, 0, buf.length, 0);
      closeSync(fd);
      const head = new Uint8Array(buf.buffer, buf.byteOffset, got);
      const kind = task.file.toLowerCase().endsWith(".wav") ? "wav" : dsp.mp3HeaderKind(head);
      out.rekordboxOffset = dsp.gridOffsetFor("rekordbox", kind, RATE, dsp.id3v2Length(head));
      parentPort.postMessage(out);
    } catch (e) {
      parentPort.postMessage({ name: task.name, error: String(e.message || e) });
    }
  });
}

async function dump() {
  const outPath = arg("--out", join(ROOT, "ground-truth/grid_halfbeat.json"));
  const grids = JSON.parse(readFileSync(join(ROOT, "ground-truth/rekordbox_grids.json"), "utf8")).byName;
  const byPath = JSON.parse(readFileSync(join(ROOT, "ground-truth/rekordbox_db.json"), "utf8")).byPath;
  const pathOf = {};
  for (const p of Object.keys(byPath)) {
    const base = p.slice(p.lastIndexOf("/") + 1);
    pathOf[base] = pathOf[base] === undefined ? p : null;
  }
  const paths = [];
  for (const [name, g] of Object.entries(grids)) {
    const path = pathOf[name];
    if (path && g.ms && g.ms.length >= 64 && existsSync(path)) paths.push(path);
  }
  const rows = [];
  await runPool(fileURLToPath(import.meta.url), pickSample(paths).map((p) => ({ name: p, file: p })), (r) => rows.push(r));
  writeResults(outPath, { results: rows });
  const unreadable = rows.filter((r) => r.error).length;
  console.log("%d tracks, %d unreadable", rows.length, unreadable);
  if (unreadable > Math.max(5, rows.length * 0.01)) process.exitCode = 2;
}

/* ------------------------------------------------------------------ */
/* Models                                                              */
/* ------------------------------------------------------------------ */

const GOOD_F = 0.8;
const pct = (k, n) => (n ? ((100 * k) / n).toFixed(1) + "%" : "-");

function mcnemar(rows, a, b) {
  let fixed = 0, broken = 0;
  for (const r of rows) { const x = a(r), y = b(r); if (!x && y) fixed++; if (x && !y) broken++; }
  return { fixed, broken, chi: fixed + broken ? ((Math.abs(fixed - broken) - 1) ** 2) / (fixed + broken) : 0 };
}

// Features scaled by their spread on the training rows, not centred: a
// feature that flips sign with the phases must keep 0 at "no evidence".
function scaler(X) {
  const d = X[0].length;
  const s = new Float64Array(d);
  for (const x of X) for (let j = 0; j < d; j++) s[j] += x[j] * x[j];
  for (let j = 0; j < d; j++) s[j] = Math.sqrt(s[j] / X.length) || 1;
  return s;
}

// Weights on the features as they are, scaling folded in, rounded as shipped.
function trainModel(rows, feat, l2) {
  const X = rows.map(feat);
  const s = scaler(X);
  const w = fitLogistic(X.map((x) => x.map((v, j) => v / s[j])), rows.map((r) => (r.good1 ? 1 : 0)), { l2, iterations: 3000 });
  return [...Array.from(s, (sj, j) => Math.round((1000 * w[j]) / sj) / 1000), w[s.length]];
}

// The L2 strength with the best 5-fold accuracy on the training rows.
function chooseL2(rows, feat) {
  let best = null;
  for (const l2 of [1e-4, 1e-3, 1e-2, 3e-2, 0.1]) {
    let right = 0;
    for (let f = 0; f < 5; f++) {
      const fold = rows.filter((_, i) => i % 5 === f);
      const w = trainModel(rows.filter((_, i) => i % 5 !== f), feat, l2);
      right += fold.filter((r) => (logit(w, feat(r)) > 0 ? r.good1 : r.good0)).length;
    }
    if (!best || right > best.right) best = { l2, right };
  }
  return best.l2;
}

function fit() {
  const dsp = loadDsp(["gridEvidence", "gridDecision", "barContrast", "beatShapeContrast", "GRID_LATENCY_SEC", "GRID_MIN_CONFIDENCE"],
    readFileSync(join(ROOT, "web/js/beatgrid.js"), "utf8") + readFileSync(join(ROOT, "web/js/downbeat.js"), "utf8"));
  // Rows with a `file` are measure_grid.mjs's, from dumps made before its
  // worker kept to its own workers.
  const results = JSON.parse(readFileSync(arg("--in", join(ROOT, "ground-truth/grid_halfbeat.json")), "utf8")).results.filter((r) => !("file" in r));
  const grids = JSON.parse(readFileSync(join(ROOT, "ground-truth/rekordbox_grids.json"), "utf8")).byName;
  const base = (p) => p.slice(p.lastIndexOf("/") + 1);
  const tracks = { train: 0, test: 0 };
  const rows = [];
  for (const r of results) {
    const g = grids[base(r.name)];
    if (!g || !g.ms) continue;
    tracks[halfOf(r.name)]++;
    if (r.error || !r.fit) continue;
    const first = r.fit.firstBeat + dsp.GRID_LATENCY_SEC + r.rekordboxOffset;
    const half = 30 / r.bpm;
    const good0 = scoreGrid(g.ms, r.bpm, first, 0).f >= GOOD_F;
    const good1 = scoreGrid(g.ms, r.bpm, first + half, 0).f >= GOOD_F;
    // Which phase the code that made the dump chose.
    let shift = (r.final.firstBeat - dsp.GRID_LATENCY_SEC - r.fit.firstBeat) % (2 * half);
    if (shift < 0) shift += 2 * half;
    const before1 = Math.abs(shift - half) < half / 2;
    const ev = dsp.gridEvidence(r.fit, r.tempo.mode);
    const fit = { ...r.fit, shape: r.short };
    rows.push({
      part: halfOf(r.name), good0, good1, beforeGood: before1 ? good1 : good0, beforePlace: r.final.place,
      z: ev.z, evidence: ev.features, tempo: r.tempo, bars: dsp.barContrast(r.bars[0], r.bars[1]),
      short: dsp.beatShapeContrast(r.short, 16), short8: dsp.beatShapeContrast(r.short),
      long: dsp.beatShapeContrast(r.long, 16), long8: dsp.beatShapeContrast(r.long),
      shipped: dsp.gridDecision(fit, r.tempo, r.bars[0], r.bars[1]),
    });
  }
  const matters = (r) => r.good0 !== r.good1;
  const train = rows.filter((r) => r.part === "train");
  const test = rows.filter((r) => r.part === "test");
  console.log(`graded: train ${train.length} (one phase good: ${train.filter(matters).length}), test ${test.length} (${test.filter(matters).length})`);

  /* ---------- 1. which phase ---------- */

  const variants = {
    "kick + bars": (r) => [r.z, ...r.bars],
    "+ two-minute profiles, 8 bins": (r) => [r.z, ...r.bars, ...r.short8],
    "+ two-minute profiles, 16 bins": (r) => [r.z, ...r.bars, ...r.short],
    "+ whole-track profiles, 8 bins": (r) => [r.z, ...r.bars, ...r.long8],
    "+ whole-track profiles, 16 bins": (r) => [r.z, ...r.bars, ...r.long],
    "+ both, 8 bins": (r) => [r.z, ...r.bars, ...r.short8, ...r.long8],
    "profiles alone, both, 8 bins": (r) => [...r.short8, ...r.long8],
  };
  const tm = train.filter(matters);
  const m = test.filter(matters);
  console.log(`\n1. WHICH PHASE (where one is good and the other not)`);
  console.log(`   before: right on ${pct(m.filter((r) => r.beforeGood).length, m.length)}; good ${pct(test.filter((r) => r.beforeGood).length, test.length)} of all (test)`);
  const models = {};
  for (const [label, feat] of Object.entries(variants)) {
    const l2 = chooseL2(tm, feat);
    const w = trainModel(tm, feat, l2);
    models[label] = { w, feat };
    const good = (r) => (logit(w, feat(r)) > 0 ? r.good1 : r.good0);
    const mc = mcnemar(test, (r) => r.beforeGood, good);
    console.log(`   ${label.padEnd(34)} l2 ${l2}: train ${pct(tm.filter(good).length, tm.length)}, test ${pct(m.filter(good).length, m.length)}; good ${pct(test.filter(good).length, test.length)} of all; vs before fixed ${mc.fixed} broken ${mc.broken} chi2 ${mc.chi.toFixed(1)}`);
  }
  const chosen = models[arg("--phase", "+ two-minute profiles, 8 bins")];
  console.log(`   GRID_PHASE_WEIGHTS = ${JSON.stringify(chosen.w.slice(0, -1))}`);
  console.log(`   GRID_PHASE_BIAS = ${chosen.w[chosen.w.length - 1]}`);

  /* ---------- 2. write it or not ---------- */

  const graded = rows.map((r) => {
    const k = logit(chosen.w, chosen.feat(r));
    const range = Math.max(0, (r.tempo.max || 0) - (r.tempo.min || 0));
    return { ...r, good: k > 0 ? r.good1 : r.good0, x: [...r.evidence, Math.abs(k) / 3, Math.log(1 + range), r.tempo.mode === "dynamic" ? 1 : 0] };
  });
  const trG = graded.filter((r) => r.part === "train");
  const wc = fitLogistic(trG.map((r) => r.x), trG.map((r) => (r.good ? 1 : 0)));
  const p = (r) => 1 / (1 + Math.exp(-logit(wc, r.x)));
  // The lowest threshold that keeps the train half's written grids as good
  // as before.
  const target = trG.filter((r) => r.beforePlace && r.beforeGood).length / trG.filter((r) => r.beforePlace).length;
  let threshold = 0.99;
  for (let t = 0.99; t >= 0.3; t -= 0.01) {
    const w = trG.filter((r) => p(r) >= t);
    if (w.length && w.filter((r) => r.good).length / w.length >= target) threshold = Math.round(t * 100) / 100;
  }
  console.log(`\n2. WRITE IT OR NOT`);
  console.log(`   GRID_CONFIDENCE_WEIGHTS = ${JSON.stringify(wc.slice(0, -1))}`);
  console.log(`   GRID_CONFIDENCE_BIAS = ${wc[wc.length - 1]}`);
  console.log(`   GRID_MIN_CONFIDENCE = ${threshold} (train accuracy kept at ${pct(Math.round(target * 1000), 1000)})`);
  for (const t of [threshold, 0.8, 0.82, 0.85, 0.88, 0.9]) {
    const line = ["train", "test"].map((part) => {
      const w = graded.filter((r) => r.part === part && p(r) >= t);
      return `${part} ${pct(w.length, tracks[part])} written, ${pct(w.filter((r) => r.good).length, w.length)} good`;
    });
    console.log(`   at ${t.toFixed(2)}: ${line.join("; ")}`);
  }

  /* ---------- 3. as shipped ---------- */

  // Coverage: written grids among all tracks of the half with a Rekordbox
  // grid; accuracy: good among those written.
  console.log(`\n3. AS SHIPPED (beatgrid.js gridDecision on the same rows, GRID_MIN_CONFIDENCE ${dsp.GRID_MIN_CONFIDENCE})`);
  for (const [label, part] of [["train", train], ["test", test]]) {
    const after = (r) => (r.shipped.switched ? r.good1 : r.good0);
    const wb = part.filter((r) => r.beforePlace);
    const wa = part.filter((r) => r.shipped.place);
    console.log(`   ${label}: written ${pct(wb.length, tracks[label])} -> ${pct(wa.length, tracks[label])} of ${tracks[label]}, good among them ${pct(wb.filter((r) => r.beforeGood).length, wb.length)} -> ${pct(wa.filter(after).length, wa.length)}`);
    const mc = mcnemar(part, (r) => r.beforeGood, after);
    console.log(`   ${label}: every grid good ${pct(part.filter((r) => r.beforeGood).length, part.length)} -> ${pct(part.filter(after).length, part.length)} (McNemar fixed ${mc.fixed} broken ${mc.broken} chi2 ${mc.chi.toFixed(1)})`);
    const both = part.filter((r) => r.beforePlace || r.shipped.place);
    const mw = mcnemar(both, (r) => r.beforePlace && r.beforeGood, (r) => r.shipped.place && after(r));
    console.log(`   ${label}: written and good, McNemar fixed ${mw.fixed} broken ${mw.broken} chi2 ${mw.chi.toFixed(1)}`);
  }
}

if (isMainThread && process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  if (process.argv.includes("--fit")) fit(); else dump();
}
