"use strict";
/*
 * beatgrid.js -- a constant beat grid: tempo to a hundredth of a BPM and the
 * time of the first beat, or an honest "no grid".
 *
 * Runs in the worker after dsp.js, whose onset envelope (onsetStrength) it
 * reads. The tempo detector there already says roughly how fast a track is;
 * a DJ grid needs more -- where every beat falls, to within a few
 * milliseconds, all the way to the end of the track.
 *
 * Method
 * ------
 * The grid is fitted to the kick, not to every onset. House and techno put
 * hats, claps and the bass on the off-beat, and an envelope of all onsets
 * locks onto those as happily as onto the beat -- half a beat out, which is
 * the worst grid there is. So the envelope here is spectral flux below
 * GRID_BASS_MAX_HZ only, on short hops (GRID_HOP samples, about 6 ms) so the
 * phase is resolved finely.
 *
 * A grid is two numbers, a period and a phase. For each candidate period
 * around the detected tempo, and each phase within one period, the onset
 * envelope is sampled at every grid position and averaged; the grid whose
 * positions land on the most onset energy wins. That is a comb filter fitted
 * over the whole analysed stretch at once, so a period that is 0.01 BPM off
 * shows up as beats sliding off their onsets towards the end, and loses.
 *
 * A search over the full grid of candidates would be wasteful, so it runs
 * twice: coarse over +-GRID_SEARCH_BPM, then fine around the winner.
 *
 * When there should be no grid
 * ----------------------------
 * A live take, a tempo ramp or an edit spliced from two tempos has no single
 * grid. Writing one anyway is worse than writing none: the DJ trusts it and
 * the mix drifts. So once the global grid is fitted, each stretch of
 * GRID_CHECK_BEATS beats is given its own best phase; if those local phases
 * wander from the global one by more than GRID_MAX_DEVIATION_MS, the track
 * is reported without a grid.
 */

const GRID_SEARCH_BPM = 1.5;
const GRID_FFT = 2048;
const GRID_HOP = 256;
const GRID_BASS_MIN_HZ = 30;
const GRID_BASS_MAX_HZ = 150;
const GRID_COARSE_BPM_STEP = 0.05;
const GRID_FINE_BPM_STEP = 0.002;
const GRID_COARSE_PHASE_STEP = 0.5; // frames of the onset envelope
const GRID_FINE_PHASE_STEP = 0.05;
const GRID_CHECK_BEATS = 32;
const GRID_MAX_DEVIATION_MS = 35;
// A stretch counts in the check only if its best phase scores this many times
// its average over all phases -- i.e. it has a beat to find.
const GRID_CHECK_MIN_CONTRAST = 2;

/*
 * Onset envelopes for several frequency bands from one pass of the STFT:
 * positive change of log-compressed magnitude within each band, one value per
 * GRID_HOP samples. Frames are centred, so value t describes time
 * t * GRID_HOP / sr. GRID_BANDS[0] is the kick band the grid is fitted on;
 * the others only help decide which of two half-beat phases is the beat.
 */
const GRID_BANDS = [[GRID_BASS_MIN_HZ, GRID_BASS_MAX_HZ],
  [30, 60], [60, 120], [120, 250], [250, 500], [500, 1000], [1000, 2000], [2000, 4000], [4000, 8000]];

function bandOnsetEnvelopes(y, sr, bands = GRID_BANDS) {
  const n = GRID_FFT;
  const frames = Math.floor(y.length / GRID_HOP) + 1;
  const ranges = bands.map(([from, to]) => [
    Math.max(1, Math.floor((from * n) / sr)),
    Math.min((n >> 1) - 1, Math.ceil((to * n) / sr)),
  ]);
  const top = Math.max(...ranges.map(([, hi]) => hi));
  const fft = getFFT(n);
  const window = hannPeriodic(n);
  const re = new Float64Array(n);
  const im = new Float64Array(n);
  let prev = new Float64Array(top + 1);
  let cur = new Float64Array(top + 1);
  const envs = bands.map(() => new Float64Array(frames));
  for (let t = 0; t < frames; t++) {
    const start = t * GRID_HOP - (n >> 1);
    for (let i = 0; i < n; i++) {
      const idx = start + i;
      re[i] = idx >= 0 && idx < y.length ? y[idx] * window[i] : 0;
      im[i] = 0;
    }
    fft.transform(re, im, false);
    for (let k = 1; k <= top; k++) cur[k] = Math.log1p(100 * Math.hypot(re[k], im[k]));
    if (t > 0) {
      for (let b = 0; b < ranges.length; b++) {
        const [lo, hi] = ranges[b];
        let flux = 0;
        for (let k = lo; k <= hi; k++) if (cur[k] > prev[k]) flux += cur[k] - prev[k];
        envs[b][t] = flux / (hi - lo + 1);
      }
    }
    const swap = prev; prev = cur; cur = swap;
  }
  return envs;
}

/*
 * The kick, averaged over every beat of the grid.
 *
 * Low-passed energy (below GRID_BASS_MAX_HZ) is sampled finely, every
 * GRID_FINE_HOP samples, in a window of +-GRID_KICK_WINDOW seconds around each
 * grid beat, and averaged across all of them. Hundreds of kicks averaged give
 * a clean shape whose onset -- the steepest rise -- is located far more
 * precisely than one onset frame can be. The same is done half a beat away,
 * so the two can be compared.
 *
 * Returns { onsetShift, onsetShiftHalf, peakRatio }: the onset's offset from
 * the grid beat in seconds, the same half a beat later, and how much taller
 * the averaged kick is on the grid beat than half a beat away.
 */
const GRID_FINE_HOP = 32;
const GRID_KICK_WINDOW = 0.06;

function lowPassEnergy(y, sr, cutoffHz) {
  let out = Float32Array.from(y);
  for (let pass = 0; pass < 2; pass++) {
    const w0 = (2 * Math.PI * cutoffHz) / sr;
    const cw = Math.cos(w0), sw = Math.sin(w0);
    const alpha = sw / (2 * 0.7071);
    const b0 = (1 - cw) / 2, b1 = 1 - cw, b2 = (1 - cw) / 2;
    const a0 = 1 + alpha, a1 = -2 * cw, a2 = 1 - alpha;
    const src = out;
    out = new Float32Array(src.length);
    let x1 = 0, x2 = 0, y1 = 0, y2 = 0;
    for (let i = 0; i < src.length; i++) {
      const x = src[i];
      const v = (b0 / a0) * x + (b1 / a0) * x1 + (b2 / a0) * x2 - (a1 / a0) * y1 - (a2 / a0) * y2;
      x2 = x1; x1 = x; y2 = y1; y1 = v;
      out[i] = v;
    }
  }
  const frames = Math.floor(out.length / GRID_FINE_HOP);
  const energy = new Float64Array(frames);
  for (let t = 0; t < frames; t++) {
    let acc = 0;
    for (let i = 0; i < GRID_FINE_HOP; i++) { const v = out[t * GRID_FINE_HOP + i]; acc += v * v; }
    energy[t] = acc;
  }
  return energy;
}

function kickProfiles(y, sr, periodSec, phaseSec) {
  const energy = lowPassEnergy(y, sr, GRID_BASS_MAX_HZ);
  const fps = sr / GRID_FINE_HOP;
  const half = Math.round(GRID_KICK_WINDOW * fps);
  const profile = (offsetSec) => {
    const acc = new Float64Array(2 * half + 1);
    let n = 0;
    for (let t = phaseSec + offsetSec; t * fps + half < energy.length; t += periodSec) {
      const centre = Math.round(t * fps);
      if (centre - half < 0) continue;
      for (let j = -half; j <= half; j++) acc[j + half] += energy[centre + j];
      n++;
    }
    if (n) for (let j = 0; j < acc.length; j++) acc[j] /= n;
    return acc;
  };
  const onsetOf = (p) => {
    let best = 1;
    for (let j = 1; j < p.length; j++) if (p[j] - p[j - 1] > p[best] - p[best - 1]) best = j;
    return (best - half) / fps;
  };
  const on = profile(0);
  const off = profile(periodSec / 2);
  const peak = (p) => Math.max(...p);
  return {
    onsetShift: Math.round(onsetOf(on) * 10000) / 10000,
    onsetShiftHalf: Math.round(onsetOf(off) * 10000) / 10000,
    peakRatio: peak(off) > 0 ? Math.round((1000 * peak(on)) / peak(off)) / 1000 : 0,
  };
}

// Linear interpolation into the onset envelope at a fractional frame.
function envelopeAt(env, frame) {
  if (frame < 0 || frame > env.length - 1) return 0;
  const i = Math.floor(frame);
  const f = frame - i;
  return i + 1 < env.length ? env[i] * (1 - f) + env[i + 1] * f : env[i];
}

// Mean envelope at phase, phase + period, ... over [from, to) frames.
function gridScore(env, period, phase, from = 0, to = env.length) {
  let k = Math.ceil((from - phase) / period);
  let acc = 0;
  let n = 0;
  for (let t = phase + k * period; t < to; t = phase + ++k * period) {
    acc += envelopeAt(env, t);
    n++;
  }
  return n ? acc / n : 0;
}

/*
 * The envelope with its slow trend removed (a one-second moving mean
 * subtracted, negatives clipped), so a loud chorus does not outvote a quiet
 * verse on where the beats are.
 */
function onsetPeaks(env, framesPerSecond) {
  const half = Math.max(1, Math.round(framesPerSecond / 2));
  const out = new Float64Array(env.length);
  let acc = 0;
  let lo = 0;
  let hi = -1;
  for (let t = 0; t < env.length; t++) {
    while (hi < Math.min(env.length - 1, t + half)) acc += env[++hi];
    while (lo < t - half) acc -= env[lo++];
    const v = env[t] - acc / (hi - lo + 1);
    out[t] = v > 0 ? v : 0;
  }
  return out;
}

function bestPhase(env, period, step, from, to, lo = 0, hi = period) {
  let best = { phase: lo, score: -Infinity };
  for (let phase = lo; phase < hi; phase += step) {
    const score = gridScore(env, period, phase, from, to);
    if (score > best.score) best = { phase, score };
  }
  return best;
}

/*
 * Fit a constant grid to mono audio.
 *
 *   y, sr      the analysed audio (the app's first two minutes)
 *   bpmHint    the detected tempo; the grid stays within +-GRID_SEARCH_BPM
 *
 * Returns { bpm, firstBeat, deviationMs, constant } -- bpm to 0.01, firstBeat
 * in seconds (the earliest grid beat at or after 0), deviationMs the largest
 * local disagreement found, constant whether that stayed within tolerance --
 * or null when there is nothing to fit.
 */
function fitBeatGrid(y, sr, bpmHint) {
  const fps = sr / GRID_HOP;
  if (!(bpmHint > 0) || y.length < sr * 4) return null;
  const envs = bandOnsetEnvelopes(y, sr);
  const env = envs[0];
  const peaks = onsetPeaks(env, fps);
  let any = false;
  for (let i = 0; i < peaks.length; i++) if (peaks[i] > 0) { any = true; break; }
  if (!any) return null;

  const periodOf = (bpm) => (60 * fps) / bpm;
  let best = { bpm: bpmHint, phase: 0, score: -Infinity };
  for (let bpm = bpmHint - GRID_SEARCH_BPM; bpm <= bpmHint + GRID_SEARCH_BPM + 1e-9; bpm += GRID_COARSE_BPM_STEP) {
    const p = bestPhase(peaks, periodOf(bpm), GRID_COARSE_PHASE_STEP, 0, peaks.length);
    if (p.score > best.score) best = { bpm, phase: p.phase, score: p.score };
  }
  const coarse = best;
  for (let bpm = coarse.bpm - GRID_COARSE_BPM_STEP; bpm <= coarse.bpm + GRID_COARSE_BPM_STEP + 1e-9; bpm += GRID_FINE_BPM_STEP) {
    const period = periodOf(bpm);
    // The phase moves with the period; search a window around the coarse one,
    // wrapped into one period.
    const p = bestPhase(peaks, period, GRID_FINE_PHASE_STEP, 0, peaks.length,
      coarse.phase - 2 * GRID_COARSE_PHASE_STEP, coarse.phase + 2 * GRID_COARSE_PHASE_STEP);
    if (p.score > best.score) best = { bpm, phase: p.phase, score: p.score };
  }

  // Rounding to 0.01 BPM -- what Rekordbox and Serato store -- moves the
  // period, so the phase is fitted once more at the rounded tempo.
  const bpm = Math.round(best.bpm * 100) / 100;
  const period = periodOf(bpm);
  const final = bestPhase(peaks, period, GRID_FINE_PHASE_STEP, 0, peaks.length,
    best.phase - 2 * GRID_COARSE_PHASE_STEP, best.phase + 2 * GRID_COARSE_PHASE_STEP);
  let phase = ((final.phase % period) + period) % period;

  // Local check: each stretch with a beat of its own, near the global phase.
  const span = GRID_CHECK_BEATS * period;
  const deviations = [];
  const local = [];
  for (let from = 0; from + span <= peaks.length; from += span) {
    let sum = 0;
    let count = 0;
    let top = { phase, score: -Infinity };
    for (let p = phase - period / 2; p < phase + period / 2; p += GRID_COARSE_PHASE_STEP) {
      const score = gridScore(peaks, period, p, from, from + span);
      sum += score;
      count++;
      if (score > top.score) top = { phase: p, score };
    }
    const mean = sum / count;
    local.push([Math.round(((top.phase - phase) / fps) * 1000), mean > 0 ? Math.round((100 * top.score) / mean) / 100 : 0]);
    if (!(mean > 0) || top.score < GRID_CHECK_MIN_CONTRAST * mean) continue;
    deviations.push(Math.round((Math.abs(top.phase - phase) / fps) * 1000));
  }
  const deviationMs = deviations.length ? Math.max(...deviations) : 0;

  // Each band's score on the chosen phase and half a beat away -- the
  // evidence for which of the two is the beat.
  const halfBeat = envs.map((e) => {
    const p = onsetPeaks(e, fps);
    const on = gridScore(p, period, phase);
    const off = gridScore(p, period, phase + period / 2);
    return on + off > 0 ? Math.round((1000 * on) / (on + off)) / 1000 : 0.5;
  });

  const kick = kickProfiles(y, sr, period / fps, phase / fps);

  return {
    bpm,
    firstBeat: phase / fps,
    period: period / fps,
    deviationMs,
    deviations,
    local,
    halfBeat,
    kick,
    constant: deviationMs <= GRID_MAX_DEVIATION_MS,
  };
}

/* ------------------------------------------------------------------ */
/* The grid the app uses                                               */
/* ------------------------------------------------------------------ */

/*
 * Which of two half-beat phases is the beat, and whether the grid is worth
 * writing at all. Both are small logistic models over what fitBeatGrid
 * measured, trained on the train half of the owner's library against
 * Rekordbox's grids and checked by five-fold cross-validation there
 * (tools/measure/measure_grid.mjs records the features; the fitting scripts
 * are described in the commit that introduced these numbers). They are
 * reported on the held-out half.
 *
 *   flip     features: each band's on/off share minus 0.5 (GRID_BANDS), and
 *            log of the averaged kick's on/off peak ratio / 5. Positive score:
 *            the beat is half a beat later than the kick fit says. Right on
 *            84.9% of tracks where it matters, against 83.7% for never
 *            flipping -- a small gain, kept because it is free.
 *   confidence  features: |flip score| / 3, the flip features' magnitudes,
 *            median local contrast / 5, drifting stretches / 3, the tempo
 *            detector's "dynamic" verdict, share of stretches with a clear
 *            beat, (BPM - 130) / 30. Probability that the grid matches
 *            Rekordbox's within 70 ms on at least 80% of beats.
 */
const GRID_FLIP_WEIGHTS = [-0.681, -0.843, -0.269, -1.943, -0.812, -0.686, -1.114, -0.263, 1.502, -3.438];
const GRID_FLIP_BIAS = -0.555;
const GRID_CONFIDENCE_WEIGHTS = [2.421, -0.802, -0.559, -1.043, -0.879, -0.211, 0.401, 0.227, -0.407, -0.142, -0.255, 0.37, -1.031, -0.258, 0.947, 0.129];
const GRID_CONFIDENCE_BIAS = -0.784;
// On the train half: grids for about half the tracks, about 85% of them good.
const GRID_MIN_CONFIDENCE = 0.75;
// The onset envelope fires about this much before the beat Rekordbox marks,
// measured on WAV files, where no MP3 decoder offset is involved.
const GRID_LATENCY_SEC = 0.005;

/*
 * The beat grid for a track, ready to show or write.
 *
 * Returns { bpm, firstBeat, confidence, place, reason } or null. firstBeat is
 * in seconds on the decoded audio's own timeline (what the browser and
 * ffmpeg both produce); writing it for another program needs that program's
 * offset (gridOffsetFor in tags.js). `place` is false, with a reason, when the grid
 * should not be written: "dynamic" for a tempo that moves, "unsure" when the
 * confidence model is below GRID_MIN_CONFIDENCE.
 */
function estimateBeatGrid(y, sr, bpmHint, tempoMode) {
  const fit = fitBeatGrid(y, sr, bpmHint);
  if (!fit) return null;
  const x = [...fit.halfBeat.map((v) => v - 0.5), Math.log(Math.max(1e-6, fit.kick.peakRatio || 1e-6)) / 5];
  const z = GRID_FLIP_BIAS + GRID_FLIP_WEIGHTS.reduce((acc, w, j) => acc + w * x[j], 0);
  const flip = z > 0;

  const period = fit.period * 1000;
  const contrasts = fit.local.map(([, c]) => c).sort((a, b) => a - b);
  const medianContrast = contrasts.length ? contrasts[contrasts.length >> 1] : 0;
  const clear = fit.local.filter(([, c]) => c >= GRID_CHECK_MIN_CONTRAST);
  const drifting = clear.filter(([d]) => Math.abs(d) > 40 && Math.abs(d) < period / 2 - 40).length;
  const features = [Math.abs(z) / 3, ...x.map(Math.abs), medianContrast / 5, drifting / 3,
    tempoMode === "dynamic" ? 1 : 0, clear.length / Math.max(1, fit.local.length), (fit.bpm - 130) / 30];
  const c = GRID_CONFIDENCE_BIAS + GRID_CONFIDENCE_WEIGHTS.reduce((acc, w, j) => acc + w * features[j], 0);
  const confidence = Math.round(1000 / (1 + Math.exp(-c))) / 1000;

  let firstBeat = fit.firstBeat + (flip ? fit.period / 2 : 0) + GRID_LATENCY_SEC;
  firstBeat = ((firstBeat % fit.period) + fit.period) % fit.period;
  let reason = null;
  if (tempoMode === "dynamic") reason = "dynamic";
  else if (confidence < GRID_MIN_CONFIDENCE) reason = "unsure";
  return { bpm: fit.bpm, firstBeat: Math.round(firstBeat * 10000) / 10000, confidence, place: reason === null, reason };
}
