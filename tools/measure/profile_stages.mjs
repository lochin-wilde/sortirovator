/*
 * Where the worker's time goes, per stage, on real tracks.
 *
 * Runs what worker.js runs for one file -- tempo, grid, key, the browse
 * loudness and, when normalization is on, the full loudness with true peak --
 * on the same inputs the app sends (two minutes mono at the file's rate, the
 * whole track mono at GRID_TEMPO_RATE, every channel of the whole track), and
 * times each. The grid and the key are also taken apart into the pieces they
 * call, timed on their own: those rows overlap their parent and say where the
 * parent's time goes.
 *
 * One track at a time on the main thread, so stages do not compete for cores.
 * Decoding is ffmpeg's and is not timed: the browser decodes on the main thread
 * with its own decoder (see web/README.md, "Speed").
 *
 *   node tools/measure/profile_stages.mjs [--limit N] [--seed S]
 *
 * Reads tracks named in ground-truth/rekordbox_db.json from wherever they are
 * on disk; needs the music drive connected.
 */
import { readFileSync, existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { ROOT, loadDsp, decodeMono, pickSample, arg, ANALYSIS_MAX_SECONDS, WHOLE_TRACK_MAX_SECONDS } from "./lib/measure.mjs";

const RATE = 44100;

const dsp = loadDsp(["analyzeTempo", "onsetStrength", "estimateBeatGrid", "fitBeatGrid", "bandOnsetEnvelopes", "kickProfiles",
  "wholeTrackTempo", "downbeatFrames", "beatSyncFeatures", "downbeatCandidates", "GRID_TEMPO_RATE",
  "parseKeyCnnModel", "detectKeyCnn", "keyCnnSpectrogram", "keyCnnForward", "measureLoudness"],
  ["beatgrid.js", "downbeat.js", "keycnn.js", "loudness.js"].map((f) => readFileSync(join(ROOT, "web/js", f), "utf8")).join("\n"));
const modelFile = readFileSync(join(ROOT, "web/data/key_cnn.bin"));
const keyModel = dsp.parseKeyCnnModel(modelFile.buffer.slice(modelFile.byteOffset, modelFile.byteOffset + modelFile.byteLength));

// Every channel of the whole track at the file's own rate, as app.js hands
// the worker for normalization.
function decodeChannels(file) {
  const probe = execFileSync("ffprobe", ["-v", "error", "-select_streams", "a:0", "-show_entries", "stream=channels",
    "-of", "csv=p=0", file]).toString().trim();
  const channels = Math.max(1, parseInt(probe, 10) || 1);
  const raw = execFileSync("ffmpeg", ["-v", "quiet", "-i", file, "-t", String(WHOLE_TRACK_MAX_SECONDS), "-ar", String(RATE),
    "-c:a", "pcm_f32le", "-f", "f32le", "-"], { maxBuffer: 1024 * 1024 * 1024 });
  const all = new Float32Array(raw.buffer, raw.byteOffset, Math.floor(raw.length / 4));
  const length = Math.floor(all.length / channels);
  return Array.from({ length: channels }, (_, c) => {
    const out = new Float32Array(length);
    for (let i = 0; i < length; i++) out[i] = all[i * channels + c];
    return out;
  });
}

const stages = {};
function time(name, fn) {
  const t0 = performance.now();
  const out = fn();
  (stages[name] ||= []).push(performance.now() - t0);
  return out;
}

const byPath = JSON.parse(readFileSync(join(ROOT, "ground-truth/rekordbox_db.json"), "utf8")).byPath;
const files = pickSample(Object.keys(byPath).filter((p) => existsSync(p)));
if (!arg("--limit", null)) console.error("no --limit: profiling every track on disk");
let seconds = 0;
for (const [i, file] of files.entries()) {
  let y, whole, channels;
  try {
    y = decodeMono(file, RATE, ANALYSIS_MAX_SECONDS).y;
    whole = decodeMono(file, dsp.GRID_TEMPO_RATE, WHOLE_TRACK_MAX_SECONDS).y;
    channels = decodeChannels(file);
  } catch (e) {
    console.error("unreadable:", file);
    continue;
  }
  seconds += channels[0].length / RATE;
  const tempo = time("tempo", () => dsp.analyzeTempo(y, RATE));
  time("  tempo: onset envelope", () => dsp.onsetStrength(y, RATE));
  if (tempo.bpm) {
    const longer = whole.length / dsp.GRID_TEMPO_RATE > y.length / RATE + 1;
    time("grid", () => dsp.estimateBeatGrid(y, RATE, tempo.bpm, tempo, longer ? whole : null, dsp.GRID_TEMPO_RATE));
    const fit = time("  grid: comb fit (fitBeatGrid)", () => dsp.fitBeatGrid(y, RATE, tempo.bpm));
    time("    fit: band envelopes (STFT 2048/256)", () => dsp.bandOnsetEnvelopes(y, RATE, undefined, undefined, undefined, true));
    if (fit) {
      time("    fit: averaged kick", () => dsp.kickProfiles(y, RATE, fit.period, fit.firstBeat));
      const frames = time("  grid: bar frames (STFT 4096/1024)", () => dsp.downbeatFrames(y, RATE));
      time("  grid: bar features x3", () => {
        for (const t of [fit.firstBeat, fit.firstBeat + fit.period / 2, fit.firstBeat]) {
          dsp.downbeatCandidates(dsp.beatSyncFeatures(y, RATE, fit.bpm, t, frames));
        }
      });
      if (longer) time("  grid: whole-track tempo", () => dsp.wholeTrackTempo(whole, dsp.GRID_TEMPO_RATE, fit.bpm));
    }
  }
  time("key", () => dsp.detectKeyCnn(y, keyModel));
  const spec = time("  key: spectrogram", () => dsp.keyCnnSpectrogram(y));
  time("  key: network", () => dsp.keyCnnForward(keyModel, spec));
  time("browse loudness", () => dsp.measureLoudness([y], RATE, false));
  time("full loudness (normalization)", () => dsp.measureLoudness(channels, RATE, true));
  process.stderr.write(`\r  ${i + 1}/${files.length}`);
}
process.stderr.write("\n");

const median = (v) => { const s = v.slice().sort((a, b) => a - b); return s[s.length >> 1]; };
const mean = (v) => v.reduce((a, b) => a + b, 0) / v.length;
const n = stages.tempo ? stages.tempo.length : 0;
console.log(`${n} tracks, ${(seconds / Math.max(1, n) / 60).toFixed(1)} min on average\n`);
console.log("stage".padEnd(42) + "median ms".padStart(10) + "mean ms".padStart(10) + "tracks".padStart(8));
const top = ["tempo", "grid", "key", "browse loudness", "full loudness (normalization)"];
for (const [name, v] of Object.entries(stages)) {
  console.log(name.padEnd(42) + String(Math.round(median(v))).padStart(10) + String(Math.round(mean(v))).padStart(10) + String(v.length).padStart(8));
}
const without = top.slice(0, 4).reduce((a, k) => a + (stages[k] ? mean(stages[k]) : 0), 0);
const withNorm = without + (stages[top[4]] ? mean(stages[top[4]]) : 0);
console.log(`\nper track, mean: ${Math.round(without)} ms without normalization, ${Math.round(withNorm)} ms with it`);
