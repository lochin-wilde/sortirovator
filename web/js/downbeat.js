"use strict";
/*
 * downbeat.js -- which beat of the grid starts a bar.
 *
 * The grid (beatgrid.js) knows where the beats are, not which of every four is
 * the one. Rekordbox's grid -- what CDJs show as bar lines and phrase marks --
 * starts its bar on the first beat of the file in 78% of the owner's library,
 * and on the grid's first beat in 69% of the tracks given one: that is what
 * writing Battito="1" gets right without looking.
 *
 * Dance music changes on the bar. Chords move on the downbeat, a new loop or
 * section starts there, a crash marks it. So each of the four candidate phases
 * is scored by how much the music changes across the beats it would make
 * downbeats, compared with the other three:
 *
 *   per beat, the energy in eight bands and a 12-bin chroma, averaged over
 *   the beat; then for each phase, how far those move from the beat before
 *   and from the bar before, on average and at its largest changes (where
 *   sections meet), and how hard the kick and the top end hit on it.
 *
 * Each feature is taken relative to its mean over the four phases, so only
 * the contrast between them counts, not how busy the track is. A linear score
 * per phase, softmax over the four, weights fitted on the train half against
 * Rekordbox's bars (tools/measure/measure_downbeat.mjs).
 *
 * Needs getFFT and hannPeriodic from dsp.js.
 */

const DOWNBEAT_FFT = 4096;
const DOWNBEAT_HOP = 1024;
const DOWNBEAT_BANDS = [[30, 90], [90, 180], [180, 360], [360, 720], [720, 1440], [1440, 2880], [2880, 5760], [5760, 11520]];
const DOWNBEAT_CHROMA_HZ = [110, 1760];
const DOWNBEAT_MIN_BEATS = 24;
// Features per candidate phase (downbeatCandidates).
const DOWNBEAT_FEATURES = 10;

/*
 * Band energies and chroma per STFT frame: what beatSyncFeatures averages
 * over beats. Computed once per track and shared by every grid tried on it.
 */
function downbeatFrames(y, sr) {
  const n = DOWNBEAT_FFT;
  const frames = Math.floor(y.length / DOWNBEAT_HOP);
  const fft = getFFT(n);
  const window = hannPeriodic(n);
  const re = new Float64Array(n);
  const im = new Float64Array(n);
  const binHz = sr / n;
  const bandRanges = DOWNBEAT_BANDS.map(([lo, hi]) => [Math.max(1, Math.round(lo / binHz)), Math.min((n >> 1) - 1, Math.round(hi / binHz))]);
  const chromaLo = Math.ceil(DOWNBEAT_CHROMA_HZ[0] / binHz);
  const chromaHi = Math.floor(DOWNBEAT_CHROMA_HZ[1] / binHz);
  const pitchOf = new Int8Array(chromaHi + 1);
  for (let k = chromaLo; k <= chromaHi; k++) pitchOf[k] = ((Math.round(12 * Math.log2((k * binHz) / 440)) % 12) + 12 + 9) % 12;

  const bands = [];
  const chroma = [];
  for (let t = 0; t < frames; t++) {
    const start = t * DOWNBEAT_HOP + (DOWNBEAT_HOP >> 1) - (n >> 1);
    for (let i = 0; i < n; i++) {
      const idx = start + i;
      re[i] = idx >= 0 && idx < y.length ? y[idx] * window[i] : 0;
      im[i] = 0;
    }
    fft.transform(re, im, false);
    const b = new Float64Array(DOWNBEAT_BANDS.length);
    for (let j = 0; j < bandRanges.length; j++) {
      const [lo, hi] = bandRanges[j];
      let e = 0;
      for (let k = lo; k <= hi; k++) e += re[k] * re[k] + im[k] * im[k];
      b[j] = e / (hi - lo + 1);
    }
    const c = new Float64Array(12);
    for (let k = chromaLo; k <= chromaHi; k++) c[pitchOf[k]] += Math.hypot(re[k], im[k]);
    bands.push(b);
    chroma.push(c);
  }
  return { bands, chroma };
}

/*
 * Per-beat band energies (log) and chroma (unit length) for the beats of a
 * grid, plus the kick and top-band energy in the first quarter of each beat.
 * Beat k spans firstBeat + k*period to the next; only whole beats inside the
 * audio are kept. `frames` is downbeatFrames(y, sr), passed in when several
 * grids are tried on one track.
 */
function beatSyncFeatures(y, sr, bpm, firstBeat, frames = downbeatFrames(y, sr)) {
  const { bands, chroma } = frames;
  const count = bands.length;

  // Frame t covers the hop starting at t * DOWNBEAT_HOP samples.
  const frameAt = (sec) => Math.floor((sec * sr) / DOWNBEAT_HOP);
  const period = 60 / bpm;
  const beats = [];
  for (let k = 0; ; k++) {
    const from = frameAt(firstBeat + k * period);
    const to = frameAt(firstBeat + (k + 1) * period);
    if (to > count || to <= from) break;
    const quarter = Math.max(from + 1, frameAt(firstBeat + (k + 0.25) * period));
    const e = new Float64Array(DOWNBEAT_BANDS.length);
    const c = new Float64Array(12);
    let kick = 0;
    let top = 0;
    for (let t = from; t < to; t++) {
      for (let j = 0; j < e.length; j++) e[j] += bands[t][j];
      for (let j = 0; j < 12; j++) c[j] += chroma[t][j];
      if (t < quarter) { kick += bands[t][0]; top += bands[t][DOWNBEAT_BANDS.length - 1]; }
    }
    for (let j = 0; j < e.length; j++) e[j] = Math.log(1e-10 + e[j] / (to - from));
    const norm = Math.hypot(...c) || 1;
    for (let j = 0; j < 12; j++) c[j] /= norm;
    beats.push({ e, c, kick: Math.log(1e-10 + kick / (quarter - from)), top: Math.log(1e-10 + top / (quarter - from)) });
  }
  return beats;
}

function meanOf(vectors) {
  const out = new Float64Array(vectors[0].length);
  for (const v of vectors) for (let j = 0; j < out.length; j++) out[j] += v[j] / vectors.length;
  return out;
}

const distance = (a, b) => { let s = 0; for (let j = 0; j < a.length; j++) s += (a[j] - b[j]) ** 2; return Math.sqrt(s); };
const cosineGap = (a, b) => { let s = 0, na = 0, nb = 0; for (let j = 0; j < a.length; j++) { s += a[j] * b[j]; na += a[j] * a[j]; nb += b[j] * b[j]; } return 1 - s / (Math.sqrt(na * nb) || 1); };

// Mean of the largest fifth of the values: where sections change, not the
// average beat.
function topMean(values) {
  const sorted = values.slice().sort((a, b) => b - a);
  const keep = Math.max(1, Math.round(sorted.length / 5));
  return sorted.slice(0, keep).reduce((a, b) => a + b, 0) / keep;
}

/*
 * One feature vector per candidate phase p (0..3): beats p, p+4, p+8... would
 * be downbeats. Each feature is divided by its mean over the four phases and
 * logged, so 0 means "no different from the others". Null when the stretch
 * is too short to compare bars.
 */
function downbeatCandidates(beats) {
  if (!beats || beats.length < DOWNBEAT_MIN_BEATS) return null;
  const raw = [0, 1, 2, 3].map((p) => {
    const beatE = [], barE = [], beatC = [], barC = [], kick = [], top = [];
    for (let k = p; k < beats.length; k += 4) {
      if (k >= 1) {
        beatE.push(distance(beats[k].e, beats[k - 1].e));
        beatC.push(cosineGap(beats[k].c, beats[k - 1].c));
      }
      if (k >= 4 && k + 4 <= beats.length) {
        const before = beats.slice(k - 4, k);
        const after = beats.slice(k, k + 4);
        barE.push(distance(meanOf(before.map((b) => b.e)), meanOf(after.map((b) => b.e))));
        barC.push(cosineGap(meanOf(before.map((b) => b.c)), meanOf(after.map((b) => b.c))));
      }
      kick.push(beats[k].kick);
      top.push(beats[k].top);
    }
    const avg = (a) => (a.length ? a.reduce((s, v) => s + v, 0) / a.length : 0);
    return [avg(beatE), topMean(beatE), avg(barE), topMean(barE), avg(beatC), topMean(beatC), avg(barC), topMean(barC),
      Math.exp(avg(kick)), Math.exp(avg(top))];
  });
  const features = raw[0].length;
  const out = raw.map(() => []);
  for (let j = 0; j < features; j++) {
    const mean = raw.reduce((s, r) => s + r[j], 0) / 4;
    for (let p = 0; p < 4; p++) out[p].push(mean > 0 ? Math.log(Math.max(1e-6, raw[p][j]) / mean) : 0);
  }
  return out;
}

// Fitted by tools/measure/measure_downbeat.mjs on the train half; the last
// weight is for phase 0 itself, the prior that a grid starts on a bar.
//
// Measured on the held-out half against Rekordbox's bars: on the grids the
// app writes, the bar now starts where Rekordbox's does on 88.3% of tracks,
// against 68.2% for "the first beat starts a bar" (McNemar 188 fixed, 14
// broken; 85.2% against 69.1% over every grid). About 0.6 s per track.
const DOWNBEAT_WEIGHTS = [0.412, 2.127, -0.2, 2.294, 1.747, -0.798, -0.134, 0.706, 0.85, -0.531, 1.308];

const downbeatScores = (candidates, weights) =>
  candidates.map((x, p) => x.reduce((s, v, j) => s + weights[j] * v, 0) + (p === 0 ? weights[x.length] : 0));

/*
 * Which of the grid's first four beats is a downbeat, from downbeatCandidates:
 * { phase, probs }, phase 0 meaning the first beat. Falls back to phase 0 --
 * what a grid without this says -- when there is too little audio or no
 * fitted model.
 */
function downbeatPhase(candidates, weights = DOWNBEAT_WEIGHTS) {
  if (!candidates || !weights) return { phase: 0, probs: [1, 0, 0, 0] };
  const scores = downbeatScores(candidates, weights);
  const max = Math.max(...scores);
  const exps = scores.map((s) => Math.exp(s - max));
  const total = exps.reduce((a, b) => a + b, 0);
  const probs = exps.map((e) => Math.round((1000 * e) / total) / 1000);
  return { phase: scores.indexOf(max), probs };
}

function estimateDownbeat(y, sr, bpm, firstBeat, weights = DOWNBEAT_WEIGHTS) {
  return downbeatPhase(weights ? downbeatCandidates(beatSyncFeatures(y, sr, bpm, firstBeat)) : null, weights);
}

/*
 * How much more bar-like the grid half a beat later is than this one: a bar
 * starts on a beat, so on the off-beat grid no phase should look like a
 * downbeat as clearly. [best bar score there minus here, then per feature the
 * largest value over the four phases there minus here]; zeros when either is
 * too short to compare. Input to the half-beat choice in beatgrid.js.
 *
 * Clamped to a little beyond what the library shows (score within 4.6, each
 * feature within 1.3, over 4350 tracks): a band with next to no energy -- no
 * treble at all -- gives ratios of rounding noise, and those must not move a
 * grid on their own.
 */
const BAR_CONTRAST_MAX = [5, 1.5];
function barContrast(here, away, weights = DOWNBEAT_WEIGHTS) {
  if (!here || !away) return new Array(DOWNBEAT_FEATURES + 1).fill(0);
  const best = (c) => Math.max(...downbeatScores(c, weights));
  const top = (c, j) => Math.max(...c.map((x) => x[j]));
  const clamp = (v, max) => Math.max(-max, Math.min(max, v));
  return [clamp(best(away) - best(here), BAR_CONTRAST_MAX[0]),
    ...here[0].map((_, j) => clamp(top(away, j) - top(here, j), BAR_CONTRAST_MAX[1]))];
}
