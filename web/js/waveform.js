"use strict";
/*
 * waveform.js -- the deck's three-band waveform: lows, mids and highs of a
 * decoded track, reduced to one value per band every WAVEFORM_HOP samples.
 *
 * Pure, so it runs under the test suite in Node (tools/test/test_waveform.mjs);
 * app.js draws it.
 *
 * The first version took each band's peak per block, divided all three by the
 * one loudest peak in the track, lifted the mids 1.3x and the highs 1.8x, and
 * drew mids and highs over the lows at the same scale. A kick is low and
 * round, a snare broadband and spiky: the snare's peaks set the picture, the
 * lifts made it brighter still, and wherever the mids were as tall as the
 * lows they covered them, so the kick -- what a grid sits on -- barely showed.
 * Each step below undoes one of those.
 */

// Crossovers, Hz. Linkwitz-Riley 4th order: two Butterworth sections each,
// -6 dB at the crossover on both sides, so the bands meet without a dip.
const WAVEFORM_LOW_HZ = 150;
const WAVEFORM_HIGH_HZ = 2500;
// One value per this many samples at the source rate: 2.9 ms at 44.1 kHz.
const WAVEFORM_HOP = 128;
// RMS window, then a level that rises at once and falls slowly, so a kick
// reads as one solid shape rather than every cycle of its sine.
const WAVEFORM_RMS_SECONDS = 0.015;
const WAVEFORM_RELEASE_SECONDS = 0.06;
// Each band to its own high percentile over the track, not its maximum: one
// snare hit or click must not set the scale for the rest.
const WAVEFORM_NORM_PERCENTILE = 0.995;
// A band far below the strongest stays small: without this a track with no
// bass would show its low band's leakage at full height. Per band, because
// the bands' normal levels differ: in dance music the lows are the strongest
// and the highs sit 15-25 dB under them, so lows 10 dB down already mean no
// bass, while highs need a floor far lower not to be flattened.
const WAVEFORM_BAND_FLOOR = { low: 0.3, mid: 0.1, high: 0.05 };
// Shape compression: quiet passages stay visible, loud ones do not fill it all.
const WAVEFORM_GAMMA = 0.8;
// Drawn nested, lows widest: equal levels leave a ring of each band visible,
// and a snare can never stand taller than a kick at full level.
const WAVEFORM_LAYER_SCALE = { low: 1, mid: 0.6, high: 0.35 };

// A second-order Butterworth section's coefficients (the RBJ cookbook's).
function butterworth(type, hz, rate) {
  const w = (2 * Math.PI * hz) / rate;
  const cos = Math.cos(w);
  const alpha = Math.sin(w) / (2 * Math.SQRT1_2);
  const a0 = 1 + alpha;
  return {
    b0: (type === "low" ? (1 - cos) / 2 : (1 + cos) / 2) / a0,
    b1: (type === "low" ? 1 - cos : -(1 + cos)) / a0,
    a1: (-2 * cos) / a0,
    a2: (1 - alpha) / a0,
  };
}

/*
 * Linkwitz-Riley 4th order, in place: the same Butterworth section twice
 * over the whole array. A plain loop over a typed array, not a function per
 * sample: closures per sample made the first draft of this file 1.7x slower
 * than the waveform it replaced.
 */
function linkwitzRiley(x, type, hz, rate) {
  const { b0, b1, a1, a2 } = butterworth(type, hz, rate);
  for (let pass = 0; pass < 2; pass++) {
    let x1 = 0, x2 = 0, y1 = 0, y2 = 0;
    for (let i = 0; i < x.length; i++) {
      const v = x[i];
      const y = b0 * v + b1 * x1 + b0 * x2 - a1 * y1 - a2 * y2;
      x2 = x1; x1 = v; y2 = y1; y1 = y;
      x[i] = y;
    }
  }
  return x;
}

// Every `factor`-th sample.
function decimate(x, factor) {
  const out = new Float32Array(Math.ceil(x.length / factor));
  for (let i = 0, j = 0; i < x.length; i += factor, j++) out[j] = x[i];
  return out;
}

// RMS over `window` samples, read at the end of every `hop` samples: `frames` values.
function rmsFrames(x, window, hop, frames) {
  const out = new Float32Array(frames);
  const w = Math.max(1, Math.round(window));
  let sum = 0;
  for (let i = 0; i < x.length; i++) {
    sum += x[i] * x[i];
    if (i >= w) sum -= x[i - w] * x[i - w];
    if ((i + 1) % hop === 0 || i === x.length - 1) {
      const f = Math.floor(i / hop);
      if (f < frames) out[f] = Math.sqrt(Math.max(0, sum) / Math.min(w, i + 1));
    }
  }
  return out;
}

/*
 * Per-band RMS over WAVEFORM_RMS_SECONDS, one value per hop, before any
 * scaling. The bands run at the lowest rate they can: highs at the source
 * rate, mids at a quarter of it (11 kHz, room for 2.5 kHz), lows at a
 * sixteenth (2.8 kHz, room for 150 Hz), each after its own anti-alias
 * filter, so four filter sections run at the source rate, as before.
 *
 * `channels` are Float32Arrays of one length; stereo is mixed to mono.
 */
function waveformBands(channels, rate) {
  const length = channels[0].length;
  const frames = Math.ceil(length / WAVEFORM_HOP);
  const mono = new Float32Array(length);
  if (channels.length > 1) {
    const left = channels[0], right = channels[1];
    for (let i = 0; i < length; i++) mono[i] = (left[i] + right[i]) * 0.5;
  } else {
    mono.set(channels[0]);
  }
  const high = linkwitzRiley(Float32Array.from(mono), "high", WAVEFORM_HIGH_HZ, rate);
  const quarterRate = rate / 4;
  const quarter = decimate(linkwitzRiley(mono, "low", rate / 10, rate), 4);
  const lowRate = quarterRate / 4;
  const sixteenth = decimate(linkwitzRiley(Float32Array.from(quarter), "low", quarterRate / 10, quarterRate), 4);
  const mid = linkwitzRiley(linkwitzRiley(quarter, "high", WAVEFORM_LOW_HZ, quarterRate), "low", WAVEFORM_HIGH_HZ, quarterRate);
  const low = linkwitzRiley(sixteenth, "low", WAVEFORM_LOW_HZ, lowRate);
  return {
    high: rmsFrames(high, WAVEFORM_RMS_SECONDS * rate, WAVEFORM_HOP, frames),
    mid: rmsFrames(mid, WAVEFORM_RMS_SECONDS * quarterRate, WAVEFORM_HOP / 4, frames),
    low: rmsFrames(low, WAVEFORM_RMS_SECONDS * lowRate, WAVEFORM_HOP / 16, frames),
  };
}

function waveformPercentile(values, q) {
  const sorted = Array.from(values).filter((v) => v > 1e-7).sort((a, b) => a - b);
  if (sorted.length === 0) return 0;
  return sorted[Math.min(sorted.length - 1, Math.floor(q * (sorted.length - 1)))];
}

/*
 * The waveform as drawn: each band's level held with an instant attack and a
 * WAVEFORM_RELEASE_SECONDS release, divided by its own percentile (floored at
 * its WAVEFORM_BAND_FLOOR share of the strongest band's), compressed by WAVEFORM_GAMMA,
 * 0 to 1. Returns { low, mid, high, framesPerSecond }.
 */
function computeWaveform(channels, rate) {
  const bands = waveformBands(channels, rate);
  const release = Math.exp(-WAVEFORM_HOP / (WAVEFORM_RELEASE_SECONDS * rate));
  const held = {};
  for (const band of ["low", "mid", "high"]) {
    const src = bands[band], dst = new Float32Array(src.length);
    let level = 0;
    for (let f = 0; f < src.length; f++) {
      level = Math.max(src[f], level * release);
      dst[f] = level;
    }
    held[band] = dst;
  }
  const norms = {};
  for (const band of ["low", "mid", "high"]) norms[band] = waveformPercentile(held[band], WAVEFORM_NORM_PERCENTILE);
  const strongest = Math.max(norms.low, norms.mid, norms.high, 1e-9);
  const out = { framesPerSecond: rate / WAVEFORM_HOP };
  for (const band of ["low", "mid", "high"]) {
    const norm = Math.max(norms[band], strongest * WAVEFORM_BAND_FLOOR[band]);
    out[band] = held[band].map((v) => Math.pow(Math.min(1, v / norm), WAVEFORM_GAMMA));
  }
  return out;
}

// The bands over frames [from, to), the highest of each.
function waveformColumn(wave, from, to) {
  let low = 0, mid = 0, high = 0;
  for (let f = Math.max(0, from), end = Math.min(wave.low.length, Math.max(to, from + 1)); f < end; f++) {
    if (wave.low[f] > low) low = wave.low[f];
    if (wave.mid[f] > mid) mid = wave.mid[f];
    if (wave.high[f] > high) high = wave.high[f];
  }
  return { low, mid, high };
}
