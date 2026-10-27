/*
 * Everything the grid's decisions could be made from, saved per track, so the
 * half-beat choice and the "write it or not" verdict can be refitted and
 * scored without decoding the library again.
 *
 * Per track: the tempo analysis (mode, range), fitBeatGrid's output, the
 * first beat the kick flip picks (kickFirstBeat), downbeat.js's per-phase
 * features for that grid and for the same grid half a beat later -- a bar
 * starts on a beat, so the grid on the beat should show sharper bar
 * boundaries than the one on the off-beat -- and the grid estimateBeatGrid
 * settles on. Rekordbox's grids, variable ones included, are matched by
 * grid_models.mjs.
 *
 *   node tools/measure/grid_features.mjs [--limit N] [--out FILE]
 *
 * Writes ground-truth/grid_features.json (never committed). Experiments read
 * that file; see tools/measure/grid_models.mjs.
 */

import { isMainThread, parentPort } from "node:worker_threads";
import { readFileSync, existsSync, openSync, readSync, closeSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { ROOT, loadDsp, decodeMono, arg, pickSample, runPool, writeResults, ANALYSIS_MAX_SECONDS, WHOLE_TRACK_MAX_SECONDS } from "./lib/measure.mjs";

const RATE = 44100;

if (!isMainThread) {
  const dsp = loadDsp(["analyzeTempo", "fitBeatGrid", "estimateBeatGrid", "kickFirstBeat", "downbeatFrames", "beatSyncFeatures", "downbeatCandidates", "mp3HeaderKind", "gridOffsetFor", "id3v2Length"],
    readFileSync(join(ROOT, "web/js/beatgrid.js"), "utf8") + readFileSync(join(ROOT, "web/js/downbeat.js"), "utf8")
    + readFileSync(join(ROOT, "web/js/tags.js"), "utf8"));
  parentPort.on("message", (task) => {
    if (task === null) process.exit(0);
    try {
      const whole = decodeMono(task.file, RATE, WHOLE_TRACK_MAX_SECONDS).y;
      const y = whole.subarray(0, Math.min(whole.length, ANALYSIS_MAX_SECONDS * RATE));
      const tempo = dsp.analyzeTempo(y, RATE);
      const out = { name: task.name, file: task.file, seconds: whole.length / RATE, tempo: { bpm: tempo.bpm, mode: tempo.mode, min: tempo.min, max: tempo.max } };
      if (tempo.bpm) {
        const fit = dsp.fitBeatGrid(y, RATE, tempo.bpm);
        const final = dsp.estimateBeatGrid(y, RATE, tempo.bpm, tempo);
        if (fit && final) {
          const frames = dsp.downbeatFrames(y, RATE);
          const start = dsp.kickFirstBeat(fit);
          out.fit = fit;
          out.final = final;
          out.onBeat = dsp.downbeatCandidates(dsp.beatSyncFeatures(y, RATE, fit.bpm, start, frames));
          out.offBeat = dsp.downbeatCandidates(dsp.beatSyncFeatures(y, RATE, fit.bpm, start + fit.period / 2, frames));
        }
      }
      const fd = openSync(task.file, "r");
      const buf = Buffer.alloc(4 * 1024 * 1024);
      const got = readSync(fd, buf, 0, buf.length, 0);
      closeSync(fd);
      const head = new Uint8Array(buf.buffer, buf.byteOffset, got);
      out.kind = task.file.toLowerCase().endsWith(".wav") ? "wav" : dsp.mp3HeaderKind(head);
      out.rekordboxOffset = dsp.gridOffsetFor("rekordbox", out.kind, RATE, dsp.id3v2Length(head));
      parentPort.postMessage(out);
    } catch (e) {
      parentPort.postMessage({ name: task.name, file: task.file, error: String(e.message || e) });
    }
  });
}

async function main() {
  const outPath = arg("--out", join(ROOT, "ground-truth/grid_features.json"));
  const grids = JSON.parse(readFileSync(join(ROOT, "ground-truth/rekordbox_grids.json"), "utf8")).byName;
  const byPath = JSON.parse(readFileSync(join(ROOT, "ground-truth/rekordbox_db.json"), "utf8")).byPath;
  const pathOf = {};
  for (const p of Object.keys(byPath)) {
    const base = p.slice(p.lastIndexOf("/") + 1);
    pathOf[base] = pathOf[base] === undefined ? p : null;
  }
  const tasks = [];
  for (const [name, g] of Object.entries(grids)) {
    const path = pathOf[name];
    if (path && g.ms && g.ms.length >= 64 && existsSync(path)) tasks.push({ name: path, file: path });
  }
  const rows = [];
  await runPool(fileURLToPath(import.meta.url), pickSample(tasks.map((t) => t.name)).map((p) => ({ name: p, file: p })), (r) => rows.push(r));
  writeResults(outPath, { results: rows });
  const unreadable = rows.filter((r) => r.error).length;
  console.log("%d tracks, %d unreadable", rows.length, unreadable);
  if (unreadable > Math.max(5, rows.length * 0.01)) process.exitCode = 2;
}

if (isMainThread && process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main();
