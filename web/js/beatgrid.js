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
 * `hop` samples (GRID_HOP, an n = GRID_FFT window, unless given). Frames are
 * centred, so value t describes time t * hop / sr. GRID_BANDS[0] is the kick
 * band the grid is fitted on; the others only help decide which of two
 * half-beat phases is the beat. With `withLevel`, returns { flux, level }:
 * the envelopes and, per band, the mean log-compressed magnitude itself.
 */
const GRID_BANDS = [[GRID_BASS_MIN_HZ, GRID_BASS_MAX_HZ],
  [30, 60], [60, 120], [120, 250], [250, 500], [500, 1000], [1000, 2000], [2000, 4000], [4000, 8000]];

function bandOnsetEnvelopes(y, sr, bands = GRID_BANDS, n = GRID_FFT, hop = GRID_HOP, withLevel = false) {
  const frames = Math.floor(y.length / hop) + 1;
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
  const levels = withLevel ? bands.map(() => new Float64Array(frames)) : null;
  for (let t = 0; t < frames; t++) {
    const start = t * hop - (n >> 1);
    for (let i = 0; i < n; i++) {
      const idx = start + i;
      re[i] = idx >= 0 && idx < y.length ? y[idx] * window[i] : 0;
      im[i] = 0;
    }
    fft.transform(re, im, false);
    for (let k = 1; k <= top; k++) cur[k] = Math.log1p(100 * Math.hypot(re[k], im[k]));
    if (levels) {
      for (let b = 0; b < ranges.length; b++) {
        const [lo, hi] = ranges[b];
        let level = 0;
        for (let k = lo; k <= hi; k++) level += cur[k];
        levels[b][t] = level / (hi - lo + 1);
      }
    }
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
  return levels ? { flux: envs, level: levels } : envs;
}

/*
 * The shape of the beat: an envelope averaged by where in the beat each frame
 * falls, `bins` bins from `phase` on (both in frames). Hundreds of beats
 * averaged show what happens on the beat and between -- the kick's click and
 * the sidechain dip after it, an off-beat bass or hat, a clap on every other
 * beat -- which tells the beat from the off-beat where the kick band alone
 * cannot (gridDecision).
 */
const GRID_PROFILE_BINS = 16;
function beatProfile(env, period, phase, bins = GRID_PROFILE_BINS) {
  const sums = new Float64Array(bins);
  const counts = new Float64Array(bins);
  for (let f = 0; f < env.length; f++) {
    let pos = ((f - phase) / period) % 1;
    if (pos < 0) pos += 1;
    const b = Math.min(bins - 1, Math.floor(pos * bins));
    sums[b] += env[f];
    counts[b]++;
  }
  return Array.from(sums, (s, b) => (counts[b] ? s / counts[b] : 0));
}

/*
 * Evidence from the beat's shape ({ flux, level }, beatProfile per band) that
 * the beat is half a beat later: per band, how much bigger each bin is half a
 * beat on, after merging to `bins` bins. Flux as a log ratio to its mean,
 * level (already a log) as a difference, so a loud band counts no more than a
 * quiet one.
 *
 * Clamped near the library's 99.9th to 99.99th percentile (flux within 2,
 * level within 4, over 4350 tracks): a band silent between hits gives flux
 * ratios of -5, which a linear model would follow wherever they point.
 */
const GRID_SHAPE_BINS = 8;
const GRID_SHAPE_MAX = { flux: 2, level: 4 };
function beatShapeContrast(shape, bins = GRID_SHAPE_BINS) {
  const out = [];
  for (const kind of ["flux", "level"]) {
    for (const p of shape[kind]) {
      const k = p.length / bins;
      const merged = [];
      for (let b = 0; b < bins; b++) merged.push(p.slice(b * k, (b + 1) * k).reduce((a, v) => a + v, 0) / k);
      const mean = merged.reduce((a, v) => a + v, 0) / bins;
      const n = kind === "flux" ? merged.map((v) => Math.log((v + 0.01 * mean + 1e-9) / (mean + 1e-9))) : merged.map((v) => v - mean);
      const max = GRID_SHAPE_MAX[kind];
      for (let j = 0; j < bins / 2; j++) out.push(Math.max(-max, Math.min(max, n[j + bins / 2] - n[j])));
    }
  }
  return out;
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
 * Returns { bpm, firstBeat, deviationMs, constant, ... } -- bpm to 0.01,
 * firstBeat in seconds (the earliest grid beat at or after 0), deviationMs the
 * largest local disagreement found, constant whether that stayed within
 * tolerance; local, halfBeat, kick and shape (beatProfile of each band's flux
 * and level from firstBeat on) are the evidence gridDecision reads -- or null
 * when there is nothing to fit.
 */
function fitBeatGrid(y, sr, bpmHint) {
  const fps = sr / GRID_HOP;
  if (!(bpmHint > 0) || y.length < sr * 4) return null;
  const { flux: envs, level } = bandOnsetEnvelopes(y, sr, GRID_BANDS, GRID_FFT, GRID_HOP, true);
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
  const shape = { flux: envs.map((e) => beatProfile(e, period, phase)), level: level.map((e) => beatProfile(e, period, phase)) };

  return {
    bpm,
    firstBeat: phase / fps,
    period: period / fps,
    deviationMs,
    deviations,
    local,
    halfBeat,
    kick,
    shape,
    constant: deviationMs <= GRID_MAX_DEVIATION_MS,
  };
}

/*
 * The tempo, refined over the whole track.
 *
 * fitBeatGrid sees the first two minutes, and two minutes are a short lever:
 * 127.96 and 128.00 BPM put the beats there at most 40 ms apart, while by the
 * end of a six-minute track the gap is 110 ms. Rekordbox fits the whole track.
 * So the kick-band comb is run once more over all of it, for tempos within
 * GRID_TEMPO_SEARCH_BPM of the fit at 0.01 BPM, each with its best phase, and
 * the best tempo wins. Only the tempo is taken: the phase, and every decision
 * about it, stay with the first two minutes -- the phase the whole track
 * prefers lost more grids than it fixed.
 *
 * The kick band ends at GRID_BASS_MAX_HZ, so the app sends the whole track at
 * GRID_TEMPO_RATE, and the window and hop shrink with it: the same bin width
 * and the same 6 ms frames as the 44.1 kHz fit, at a quarter of the work.
 *
 *   whole   the whole track, mono, at `sr` (GRID_TEMPO_RATE in the app)
 *   bpm     fitBeatGrid's tempo
 *
 * Returns the tempo to 0.01 BPM.
 */
const GRID_TEMPO_RATE = 11025;
const GRID_TEMPO_FFT = 512;
const GRID_TEMPO_HOP = 64;
const GRID_TEMPO_SEARCH_BPM = 0.1;

function wholeTrackTempo(whole, sr, bpm) {
  const fps = sr / GRID_TEMPO_HOP;
  const env = bandOnsetEnvelopes(whole, sr, [GRID_BANDS[0]], GRID_TEMPO_FFT, GRID_TEMPO_HOP)[0];
  const peaks = onsetPeaks(env, fps);
  let best = { bpm, score: -Infinity };
  const steps = Math.round(GRID_TEMPO_SEARCH_BPM * 100);
  for (let k = -steps; k <= steps; k++) {
    const candidate = Math.round(bpm * 100 + k) / 100;
    const period = (60 * fps) / candidate;
    const coarse = bestPhase(peaks, period, GRID_COARSE_PHASE_STEP, 0, peaks.length);
    const fine = bestPhase(peaks, period, GRID_FINE_PHASE_STEP, 0, peaks.length,
      coarse.phase - 2 * GRID_COARSE_PHASE_STEP, coarse.phase + 2 * GRID_COARSE_PHASE_STEP);
    if (fine.score > best.score) best = { bpm: candidate, score: fine.score };
  }
  return best.bpm;
}

/* ------------------------------------------------------------------ */
/* The grid the app uses                                               */
/* ------------------------------------------------------------------ */

/*
 * Which of two half-beat phases is the beat, and whether the grid is worth
 * writing at all. Small logistic models fitted on the train half of the
 * owner's library against Rekordbox's grids, variable-tempo tracks included,
 * and reported on the held-out half.
 *
 *   kick flip   features: each band's on/off share minus 0.5 (GRID_BANDS),
 *            and log of the averaged kick's on/off peak ratio / 5. Positive:
 *            the beat is half a beat later than the kick fit says. On its own
 *            right on 85.2% of tracks where one phase is good and the other
 *            not. Fitted by tools/measure/grid_models.mjs; now one input of
 *            the phase model.
 *   phase    the kick flip score, barContrast (downbeat.js) between the
 *            fit's grid and the one half a beat later -- the beat is where
 *            the bars are -- and beatShapeContrast of the fit's beat shape.
 *            Positive: the beat is half a beat later. Fitted by
 *            tools/measure/grid_halfbeat.mjs.
 *   confidence  features: |kick flip score| / 3, the flip features'
 *            magnitudes, median local contrast / 5, drifting stretches / 3,
 *            the tempo detector's "dynamic" verdict, share of stretches with
 *            a clear beat, (BPM - 130) / 30, |phase score| / 3, log(1 + the
 *            tempo detector's range in BPM), "dynamic" again. Probability
 *            that the grid matches Rekordbox's within 70 ms on at least 80%
 *            of beats. A moving tempo is evidence here, not a veto: the old
 *            veto withheld as many good grids as bad ones. Fitted by
 *            tools/measure/grid_halfbeat.mjs.
 */
const GRID_FLIP_WEIGHTS = [-0.681, -0.843, -0.269, -1.943, -0.812, -0.686, -1.114, -0.263, 1.502, -3.438];
const GRID_FLIP_BIAS = -0.555;
// z, barContrast (11), beatShapeContrast: flux then level, per band four
// bins from the beat on.
const GRID_PHASE_WEIGHTS = [0.09, 0.161, 0, -0.216, 0.276, -1.236, 1.132, 0.278, -0.135, 1.237, 0.615, 0.097, 0.247, 0.751, -0.612, -0.505, 0.405, 0.099, 0.006, -0.247, 0.197, 0.08, -0.833, 0.014, 0.249, 0.739, 0.164, -1.181, 0.84, 1.541, -2.225, -0.994, 1.566, 1.177, -0.706, -1.59, 0.469, 0.037, -3, -1.309, 0.335, 0.423, 1.022, -1.134, -0.284, -1.362, -0.311, 0.207, 0.021, -0.063, -0.1, -0.081, 0.205, 0.055, -0.012, -0.089, -0.017, -0.111, -0.096, -0.15, 0.149, -0.293, -0.392, -0.193, 0.122, -0.912, -0.197, -0.386, 0.519, -0.469, 0.492, -0.194, 0.355, -0.553, -0.236, -0.54, 0.372, -0.213, -0.081, 0.033, 0.099, 0.067, -0.306, 0.145];
const GRID_PHASE_BIAS = -0.081;
const GRID_CONFIDENCE_WEIGHTS = [0.465, -0.907, -0.486, -0.87, -0.947, -0.398, 0.168, -0.014, -0.821, -0.03, -0.032, 0.277, -1.263, -0.181, 0.977, 0.013, 2.088, 0.008, -0.181];
const GRID_CONFIDENCE_BIAS = -0.386;
// Kept where it was. The rule used before -- the lowest threshold that keeps
// the train half's accuracy (0.76 here) -- wrote grids for 73.8% of the
// held-out half but only 88.5% of them good; the owner prefers fewer wrong
// grids. At 0.82: grids for 60.7% of the held-out half against 49.8%, 90.5%
// of them good against 90.7%.
const GRID_MIN_CONFIDENCE = 0.82;
// The onset envelope fires about this much before the beat Rekordbox marks,
// measured on WAV files, where no MP3 decoder offset is involved.
const GRID_LATENCY_SEC = 0.005;

/*
 * The confidence model's base inputs and the kick flip score, from
 * fitBeatGrid's output alone, so the measurement tools can refit them from
 * saved fits.
 */
function gridEvidence(fit, tempoMode) {
  const x = [...fit.halfBeat.map((v) => v - 0.5), Math.log(Math.max(1e-6, fit.kick.peakRatio || 1e-6)) / 5];
  const z = GRID_FLIP_BIAS + GRID_FLIP_WEIGHTS.reduce((acc, w, j) => acc + w * x[j], 0);
  const period = fit.period * 1000;
  const contrasts = fit.local.map(([, c]) => c).sort((a, b) => a - b);
  const medianContrast = contrasts.length ? contrasts[contrasts.length >> 1] : 0;
  const clear = fit.local.filter(([, c]) => c >= GRID_CHECK_MIN_CONTRAST);
  const drifting = clear.filter(([d]) => Math.abs(d) > 40 && Math.abs(d) < period / 2 - 40).length;
  const features = [Math.abs(z) / 3, ...x.map(Math.abs), medianContrast / 5, drifting / 3,
    tempoMode === "dynamic" ? 1 : 0, clear.length / Math.max(1, fit.local.length), (fit.bpm - 130) / 30];
  return { x, z, features };
}

const wrapPhase = (t, period) => ((t % period) + period) % period;

// The first beat the kick flip alone picks, latency included, within one
// period: what tools/measure/grid_features.mjs dumps bars for.
function kickFirstBeat(fit) {
  const { z } = gridEvidence(fit, "constant");
  return wrapPhase(fit.firstBeat + (z > 0 ? fit.period / 2 : 0) + GRID_LATENCY_SEC, fit.period);
}

/*
 * The two decisions, from fitBeatGrid's output, the tempo analysis
 * ({ mode, min, max }) and downbeatCandidates for the fit's grid (`here`) and
 * the one half a beat later (`away`), either null when too short. Returns
 * { switched, confidence, place, reason }: switched means the beat is half a
 * beat after the fit's firstBeat.
 */
function gridDecision(fit, tempo, here, away) {
  const { z, features } = gridEvidence(fit, tempo.mode);
  const s = [z, ...barContrast(here, away), ...beatShapeContrast(fit.shape)];
  const k = GRID_PHASE_BIAS + GRID_PHASE_WEIGHTS.reduce((acc, w, j) => acc + w * s[j], 0);
  const range = Math.max(0, (tempo.max || 0) - (tempo.min || 0));
  const v = [...features, Math.abs(k) / 3, Math.log(1 + range), tempo.mode === "dynamic" ? 1 : 0];
  const c = GRID_CONFIDENCE_BIAS + GRID_CONFIDENCE_WEIGHTS.reduce((acc, w, j) => acc + w * v[j], 0);
  const confidence = Math.round(1000 / (1 + Math.exp(-c))) / 1000;
  const place = confidence >= GRID_MIN_CONFIDENCE;
  return { switched: k > 0, confidence, place, reason: place ? null : tempo.mode === "dynamic" ? "dynamic" : "unsure" };
}

/*
 * The beat grid for a track, ready to show or write. `tempo` is analyzeTempo's
 * result. Needs downbeat.js.
 *
 * `whole` is the whole track at `wholeRate` (wholeTrackTempo); without it, or
 * when it is no longer than `y`, the tempo is the first two minutes' own.
 *
 * Returns { bpm, firstBeat, downbeat, confidence, place, reason } or null.
 * firstBeat is in seconds on the decoded audio's own timeline (what the
 * browser and ffmpeg both produce); writing it for another program needs that
 * program's offset (gridOffsetFor in tags.js). downbeat is which of the first
 * four beats starts a bar (downbeat.js). `place` is false, with a reason,
 * when the grid should not be written: "unsure" when the confidence model is
 * below GRID_MIN_CONFIDENCE, "dynamic" when that is so and the tempo moves.
 */
function estimateBeatGrid(y, sr, bpmHint, tempo, whole = null, wholeRate = GRID_TEMPO_RATE) {
  const fit = fitBeatGrid(y, sr, bpmHint);
  if (!fit) return null;
  const frames = downbeatFrames(y, sr);
  const bars = (t) => downbeatCandidates(beatSyncFeatures(y, sr, fit.bpm, t, frames));
  const half = fit.period / 2;
  const decision = gridDecision(fit, tempo, bars(fit.firstBeat), bars(fit.firstBeat + half));
  const bpm = whole && whole.length / wholeRate > y.length / sr + 1 ? wholeTrackTempo(whole, wholeRate, fit.bpm) : fit.bpm;
  const start = fit.firstBeat + GRID_LATENCY_SEC + (decision.switched ? half : 0);
  const firstBeat = Math.round(wrapPhase(start, 60 / bpm) * 10000) / 10000;
  return {
    bpm, firstBeat, downbeat: downbeatPhase(bars(firstBeat)).phase,
    confidence: decision.confidence, place: decision.place, reason: decision.reason,
  };
}
