/*
 * Why a grid's tempo drifts from Rekordbox's, and what would hold it.
 *
 * The grid is fitted on the first two minutes the app analyses. A tempo
 * 0.04 BPM out puts the last beat of a six-minute track 70 ms off, and two
 * minutes are a short lever to tell 128.00 from 127.96. Rekordbox analyses
 * the whole track, and 83% of its one-tempo grids in the owner's library sit
 * on a whole BPM -- tracks made in a DAW at 128, not 127.96.
 *
 * Per track this saves the comb's fit on the two minutes and, for a few
 * candidate tempos, the comb score (kick-band onset peaks, the same as
 * fitBeatGrid) on the two minutes and on the whole track:
 *
 *   fit      fitBeatGrid's tempo and phase
 *   int      the nearest whole BPM, phase refitted
 *   whole    the best tempo within +-0.1 BPM of fit (0.01 steps) on the
 *            whole track, phase refitted
 *
 * plus whether estimateBeatGrid moved the grid half a beat from the fit, so a
 * candidate is scored on the same half-beat phase as the shipped grid.
 *
 *   node tools/measure/grid_tempo.mjs [--limit N] [--out FILE]
 *   node tools/measure/grid_tempo.mjs --rescore [--in FILE]
 *
 * Rules are chosen on the train half and reported on the held-out half.
 * Writes ground-truth/grid_tempo.json (never committed).
 *
 * What it showed (one-tempo tracks, held-out half): snapping to a whole BPM
 * does nothing useful, whatever the comb score gate -- the tempos it moves
 * are mostly right already. The whole-track tempo is closer to Rekordbox's
 * (tempo alone drifting past 70 ms by the end: 131 -> 57 tracks), but taking
 * the whole track's phase with it fixes 44 grids and breaks 46. Keeping the
 * two-minute phase and taking only the tempo fixes 28 and breaks 4 -- the
 * rule beatgrid.js ships (wholeTrackTempo).
 */

import { isMainThread, parentPort } from "node:worker_threads";
import { readFileSync, existsSync, openSync, readSync, closeSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { ROOT, loadDsp, decodeMono, arg, pickSample, runPool, writeResults, ANALYSIS_MAX_SECONDS, WHOLE_TRACK_MAX_SECONDS } from "./lib/measure.mjs";
import { scoreGrid } from "./measure_grid.mjs";
import { halfOf } from "./key_report.mjs";

const RATE = 44100;
const WHOLE_SEARCH_BPM = 0.1;

if (!isMainThread) {
  const dsp = loadDsp(["analyzeTempo", "fitBeatGrid", "estimateBeatGrid", "bandOnsetEnvelopes", "onsetPeaks", "bestPhase",
    "GRID_BANDS", "GRID_HOP", "GRID_LATENCY_SEC", "mp3HeaderKind", "gridOffsetFor", "id3v2Length"],
  readFileSync(join(ROOT, "web/js/beatgrid.js"), "utf8") + readFileSync(join(ROOT, "web/js/downbeat.js"), "utf8")
    + readFileSync(join(ROOT, "web/js/tags.js"), "utf8"));
  const fps = RATE / dsp.GRID_HOP;
  const periodOf = (bpm) => (60 * fps) / bpm;
  // Best phase for one tempo: coarse over a whole period, then fine.
  const fitAt = (peaks, bpm) => {
    const period = periodOf(bpm);
    const coarse = dsp.bestPhase(peaks, period, 0.5, 0, peaks.length);
    const fine = dsp.bestPhase(peaks, period, 0.05, 0, peaks.length, coarse.phase - 1, coarse.phase + 1);
    const phase = ((fine.phase % period) + period) % period;
    return { bpm, firstBeat: Math.round((phase / fps) * 10000) / 10000, score: fine.score };
  };
  const scoreAt = (peaks, bpm, firstBeat) => {
    const period = periodOf(bpm);
    const p = dsp.bestPhase(peaks, period, 0.05, 0, peaks.length, firstBeat * fps - 0.5, firstBeat * fps + 0.5);
    return p.score;
  };
  parentPort.on("message", (task) => {
    if (task === null) process.exit(0);
    try {
      const whole = decodeMono(task.file, RATE, WHOLE_TRACK_MAX_SECONDS).y;
      const y = whole.subarray(0, Math.min(whole.length, ANALYSIS_MAX_SECONDS * RATE));
      const tempo = dsp.analyzeTempo(y, RATE);
      const out = { name: task.name, seconds: whole.length / RATE, tempo: { bpm: tempo.bpm, mode: tempo.mode, min: tempo.min, max: tempo.max } };
      const fit = tempo.bpm ? dsp.fitBeatGrid(y, RATE, tempo.bpm) : null;
      if (fit) {
        const final = dsp.estimateBeatGrid(y, RATE, tempo.bpm, tempo);
        let shift = (final.firstBeat - dsp.GRID_LATENCY_SEC - fit.firstBeat) % fit.period;
        shift = ((shift % fit.period) + fit.period) % fit.period;
        out.halfBeat = Math.abs(shift - fit.period / 2) < fit.period / 4;
        out.final = { confidence: final.confidence, place: final.place };
        const kick = [dsp.GRID_BANDS[0]];
        const short = dsp.onsetPeaks(dsp.bandOnsetEnvelopes(y, RATE, kick)[0], fps);
        const long = dsp.onsetPeaks(dsp.bandOnsetEnvelopes(whole, RATE, kick)[0], fps);
        const cand = { fit: { bpm: fit.bpm, firstBeat: fit.firstBeat } };
        cand.int = fitAt(short, Math.round(fit.bpm));
        let best = null;
        for (let k = -WHOLE_SEARCH_BPM * 100; k <= WHOLE_SEARCH_BPM * 100; k++) {
          const c = fitAt(long, Math.round(fit.bpm * 100 + k) / 100);
          if (!best || c.score > best.score) best = c;
        }
        cand.whole = { bpm: best.bpm, firstBeat: best.firstBeat };
        cand.intWhole = fitAt(long, Math.round(fit.bpm));
        for (const c of Object.values(cand)) {
          c.short = scoreAt(short, c.bpm, c.firstBeat);
          c.long = scoreAt(long, c.bpm, c.firstBeat);
          delete c.score;
        }
        out.cand = cand;
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

/* ------------------------------------------------------------------ */
/* Rules                                                               */
/* ------------------------------------------------------------------ */

/*
 * A rule picks one candidate per track. Each is scored as the shipped grid
 * would be: the candidate's phase, moved half a beat when estimateBeatGrid
 * moved the fit, plus the Rekordbox offset.
 */
export const RULES = {
  "now (two minutes)": () => "fit",
  "nearest whole BPM within 0.05": (r) => (Math.abs(r.cand.fit.bpm - r.cand.int.bpm) <= 0.05 ? "int" : "fit"),
  // The whole BPM when the comb, on the stretch named, likes it nearly as well.
  ...Object.fromEntries([0.98, 0.99, 0.995].flatMap((k) => [
    [`whole BPM if two-minute score >= ${k} of fit's`, (r) => (Math.abs(r.cand.fit.bpm - r.cand.int.bpm) <= 0.25 && r.cand.int.short >= k * r.cand.fit.short ? "int" : "fit")],
    [`whole BPM if whole-track score >= ${k} of best`, (r) => (Math.abs(r.cand.fit.bpm - r.cand.int.bpm) <= 0.25 && r.cand.intWhole.long >= k * r.cand.whole.long ? "intWhole" : "fit")],
  ])),
  "whole track": () => "whole",
  "whole-track tempo, two-minute phase (shipped)": () => "wholeTempo",
  "whole track, then whole BPM if >= 0.99": (r) => (Math.abs(r.cand.whole.bpm - r.cand.intWhole.bpm) <= 0.25 && r.cand.intWhole.long >= 0.99 * r.cand.whole.long ? "intWhole" : "whole"),
  "whole track, then whole BPM if >= 0.995": (r) => (Math.abs(r.cand.whole.bpm - r.cand.intWhole.bpm) <= 0.25 && r.cand.intWhole.long >= 0.995 * r.cand.whole.long ? "intWhole" : "whole"),
};

function rescore(path) {
  const { results } = JSON.parse(readFileSync(path, "utf8"));
  const grids = JSON.parse(readFileSync(join(ROOT, "ground-truth/rekordbox_grids.json"), "utf8")).byName;
  const base = (p) => p.slice(p.lastIndexOf("/") + 1);
  const rows = [];
  for (const r of results) {
    const g = grids[base(r.name)];
    if (r.error || !r.cand || !g || !g.ms) continue;
    const tempos = g.tempos.map(([, t]) => t / 100);
    const wholeTempo = { bpm: r.cand.whole.bpm, firstBeat: r.cand.fit.firstBeat };
    rows.push({ ...r, cand: { ...r.cand, wholeTempo }, part: halfOf(r.name), ms: g.ms, oneTempo: Math.max(...tempos) - Math.min(...tempos) <= 0.005 });
  }
  const { GRID_LATENCY_SEC } = loadDsp(["GRID_LATENCY_SEC"], readFileSync(join(ROOT, "web/js/beatgrid.js"), "utf8"));
  const scored = (r, key) => {
    const c = r.cand[key];
    return scoreGrid(r.ms, c.bpm, c.firstBeat + (r.halfBeat ? 30 / c.bpm : 0) + GRID_LATENCY_SEC + r.rekordboxOffset, 0);
  };
  const pct = (k, n) => (n ? ((100 * k) / n).toFixed(1) + "%" : "-");
  for (const part of ["train", "test"]) {
    const set = rows.filter((r) => r.part === part && r.oneTempo);
    const written = set.filter((r) => r.final.place);
    console.log(`\n${part}: ${set.length} one-tempo tracks (${written.length} given a grid now)`);
    const now = new Map(set.map((r) => [r.name, scored(r, "fit")]));
    for (const [label, rule] of Object.entries(RULES)) {
      let good = 0, goodW = 0, end = 0, fixed = 0, broken = 0;
      for (const r of set) {
        const s = scored(r, rule(r));
        const was = now.get(r.name);
        if (s.f >= 0.8) good++;
        if (r.final.place && s.f >= 0.8) goodW++;
        if (s.endMs > 70) end++;
        if (was.f < 0.8 && s.f >= 0.8) fixed++;
        if (was.f >= 0.8 && s.f < 0.8) broken++;
      }
      console.log(`  ${label.padEnd(48)} good ${pct(good, set.length)}, of written ${pct(goodW, written.length)}, end > 70 ms ${pct(end, set.length)}; McNemar fixed ${fixed} broken ${broken}`);
    }
  }
}

async function main() {
  if (process.argv.includes("--rescore")) { rescore(arg("--in", join(ROOT, "ground-truth/grid_tempo.json"))); return; }
  const outPath = arg("--out", join(ROOT, "ground-truth/grid_tempo.json"));
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

if (isMainThread && process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main();
