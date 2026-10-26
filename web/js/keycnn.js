"use strict";
/*
 * keycnn.js -- key detection with a convolutional network.
 *
 * The network is Korzeniowski & Widmer, "Genre-Agnostic Key Classification
 * with Convolutional Neural Networks" (ISMIR 2018), trained by its authors and
 * shipped in madmom (key/2018/key_cnn.pkl). The weights live in
 * data/key_cnn.bin, converted by tools/build/convert_key_cnn.py, and are
 * licensed CC BY-NC-SA 4.0 -- see data/KEY_CNN_LICENSE.txt. This file is a
 * port of the inference only; nothing is trained here.
 *
 * It runs in the worker after dsp.js, whose FFT and Camelot tables it uses.
 *
 * The input has to be the one the network was trained on, or its answers mean
 * nothing, so every step below follows madmom's CNNKeyRecognitionProcessor:
 *
 *   mono at 44.1 kHz
 *   frames of 8192 samples, 5 per second, each centred on its hop position
 *   symmetric Hann window, magnitude spectrum without the Nyquist bin
 *   triangular filters, 24 per octave from 65 Hz to 2100 Hz, each normalized
 *   log10(1 + x)
 *
 * then the network: zero padding, valid convolutions, batch norm with ELU,
 * 2x2 max pooling, a mean over time and frequency, and softmax over 24 keys.
 * The port was checked against madmom's own reference outputs for its test
 * files (tools/test/test_key_cnn.mjs says how).
 */

const KEY_CNN_RATE = 44100;
const KEY_CNN_FRAME = 8192;
const KEY_CNN_HOP = 8820; // 44100 / 5 frames per second
const KEY_CNN_BANDS_PER_OCTAVE = 24;
const KEY_CNN_FMIN = 65;
const KEY_CNN_FMAX = 2100;

/*
 * madmom reads 16-bit audio as integers and divides its window by 32767 to
 * compensate. Decoded audio here is already float in [-1, 1), i.e. the
 * integer over 32768, so the same spectrum needs this factor.
 */
const KEY_CNN_INT_SCALE = 32768 / 32767;

/*
 * Below this probability the answer is shown as a guess ("8A?"). The
 * network's top probability is calibrated on the owner's library -- see
 * tools/measure for how it was chosen.
 */
const KEY_CNN_MIN_CONFIDENCE = 0.5;

// madmom's class order: A major .. Ab major, then A minor .. G# minor. Class k
// has its tonic (k % 12) semitones above A.
function keyCnnClassToCamelot(k) {
  const pitch = (9 + (k % 12)) % 12; // pitch class from C
  return k < 12 ? CAMELOT_MAJOR[pitch] : CAMELOT_MINOR[pitch];
}

/* ------------------------------------------------------------------ */
/* Model file                                                          */
/* ------------------------------------------------------------------ */

// The layers, with each one's parameters as Float32Array views into `buffer`.
function parseKeyCnnModel(buffer) {
  const bytes = new Uint8Array(buffer);
  const magic = String.fromCharCode(bytes[0], bytes[1], bytes[2], bytes[3]);
  if (magic !== "KCN1") throw new Error("not a key model file");
  const headerLength = new DataView(buffer).getUint32(4, true);
  const header = JSON.parse(new TextDecoder().decode(bytes.subarray(8, 8 + headerLength)));
  const data = new Float32Array(buffer, 8 + headerLength, header.floats);
  const view = (offset, length) => data.subarray(offset, offset + length);
  return header.layers.map((layer) => {
    if (layer.type === "conv") {
      // Stored as madmom keeps them, (in, out, kh, kw). Rearranged once so
      // the inner loop reads one contiguous run of output channels, and
      // flipped: madmom convolves, it does not correlate.
      const { in: cin, out: cout, kh, kw } = layer;
      const src = view(layer.weights, cin * cout * kh * kw);
      const w = new Float32Array(kh * kw * cin * cout);
      for (let c = 0; c < cin; c++) {
        for (let o = 0; o < cout; o++) {
          for (let i = 0; i < kh; i++) {
            for (let j = 0; j < kw; j++) {
              const from = ((c * cout + o) * kh + (kh - 1 - i)) * kw + (kw - 1 - j);
              w[((i * kw + j) * cin + c) * cout + o] = src[from];
            }
          }
        }
      }
      return { type: "conv", cin, cout, kh, kw, w };
    }
    if (layer.type === "bn_elu") {
      return { type: "bn_elu", scale: view(layer.scale, layer.n), shift: view(layer.shift, layer.n) };
    }
    return { ...layer };
  });
}

/* ------------------------------------------------------------------ */
/* Spectrogram                                                         */
/* ------------------------------------------------------------------ */

let _keyCnnFilterbankCache = null;

/*
 * madmom's LogarithmicFilterbank: centre frequencies 24 per octave relative
 * to A4, snapped to the nearest FFT bin, duplicates dropped, and a triangle
 * over every three consecutive bins, normalized to sum to one.
 */
function keyCnnFilterbank() {
  if (_keyCnnFilterbankCache) return _keyCnnFilterbankCache;
  const numBins = KEY_CNN_FRAME >> 1;
  const binHz = KEY_CNN_RATE / KEY_CNN_FRAME;

  const perOctave = KEY_CNN_BANDS_PER_OCTAVE;
  const left = Math.floor(Math.log2(KEY_CNN_FMIN / 440) * perOctave);
  const right = Math.ceil(Math.log2(KEY_CNN_FMAX / 440) * perOctave);
  const freqs = [];
  for (let k = left; k < right; k++) {
    const f = 440 * Math.pow(2, k / perOctave);
    if (f >= KEY_CNN_FMIN && f <= KEY_CNN_FMAX) freqs.push(f);
  }

  const bins = [];
  for (const f of freqs) {
    // numpy searchsorted (left) over k * binHz, clipped, then the nearer
    // neighbour -- ties go to the upper bin, as in madmom.
    let idx = Math.ceil(f / binHz - 1e-12);
    idx = Math.min(Math.max(idx, 1), numBins - 1);
    const below = (idx - 1) * binHz;
    const above = idx * binHz;
    if (f - below < above - f) idx -= 1;
    if (bins.length === 0 || bins[bins.length - 1] !== idx) bins.push(idx);
  }

  const filters = [];
  for (let b = 0; b + 3 <= bins.length; b++) {
    let start = bins[b];
    let center = bins[b + 1];
    let stop = bins[b + 2];
    if (stop - start < 2) { center = start; stop = start + 1; }
    const len = stop - start;
    const c = center - start;
    const weights = new Float64Array(len);
    for (let j = 0; j < c; j++) weights[j] = j / c;
    for (let j = c; j < len; j++) weights[j] = 1 - (j - c) / (len - c);
    let sum = 0;
    for (let j = 0; j < len; j++) sum += weights[j];
    for (let j = 0; j < len; j++) weights[j] /= sum;
    filters.push({ start, weights });
  }
  _keyCnnFilterbankCache = filters;
  return filters;
}

// Mono 44.1 kHz in; log-filtered spectrogram out, frames x bands, row-major.
function keyCnnSpectrogram(y) {
  const n = KEY_CNN_FRAME;
  const frames = Math.ceil(y.length / KEY_CNN_HOP);
  const filters = keyCnnFilterbank();
  const bands = filters.length;
  const out = new Float32Array(frames * bands);
  const fft = getFFT(n);
  const window = new Float64Array(n);
  for (let i = 0; i < n; i++) window[i] = (0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (n - 1))) * KEY_CNN_INT_SCALE;
  const re = new Float64Array(n);
  const im = new Float64Array(n);
  const mag = new Float64Array(n >> 1);
  for (let t = 0; t < frames; t++) {
    const start = t * KEY_CNN_HOP - (n >> 1);
    for (let i = 0; i < n; i++) {
      const idx = start + i;
      re[i] = idx >= 0 && idx < y.length ? y[idx] * window[i] : 0;
      im[i] = 0;
    }
    fft.transform(re, im, false);
    for (let k = 0; k < mag.length; k++) mag[k] = Math.hypot(re[k], im[k]);
    for (let b = 0; b < bands; b++) {
      const { start: s, weights } = filters[b];
      let acc = 0;
      for (let j = 0; j < weights.length; j++) acc += mag[s + j] * weights[j];
      out[t * bands + b] = Math.log10(1 + acc);
    }
  }
  return { frames, bands, data: out };
}

/* ------------------------------------------------------------------ */
/* Network                                                             */
/* ------------------------------------------------------------------ */

// Tensors are { t, f, c, data } with data indexed [(time * f + freq) * c + channel].

function keyCnnPad(x, width) {
  const t = x.t + 2 * width;
  const f = x.f + 2 * width;
  const data = new Float32Array(t * f * x.c);
  for (let i = 0; i < x.t; i++) {
    const src = i * x.f * x.c;
    const dst = ((i + width) * f + width) * x.c;
    data.set(x.data.subarray(src, src + x.f * x.c), dst);
  }
  return { t, f, c: x.c, data };
}

function keyCnnConv(x, layer) {
  const { cin, cout, kh, kw, w } = layer;
  const t = x.t - kh + 1;
  const f = x.f - kw + 1;
  const out = new Float32Array(Math.max(0, t * f * cout));
  const acc = new Float32Array(cout);
  const xd = x.data;
  for (let ti = 0; ti < t; ti++) {
    for (let fi = 0; fi < f; fi++) {
      acc.fill(0);
      for (let i = 0; i < kh; i++) {
        for (let j = 0; j < kw; j++) {
          const inBase = ((ti + i) * x.f + (fi + j)) * cin;
          const wBase = (i * kw + j) * cin * cout;
          for (let c = 0; c < cin; c++) {
            const v = xd[inBase + c];
            if (v === 0) continue;
            const wRow = wBase + c * cout;
            for (let o = 0; o < cout; o++) acc[o] += v * w[wRow + o];
          }
        }
      }
      out.set(acc, (ti * f + fi) * cout);
    }
  }
  return { t: Math.max(0, t), f: Math.max(0, f), c: cout, data: out };
}

function keyCnnBatchNormElu(x, layer) {
  const { scale, shift } = layer;
  const d = x.data;
  const c = x.c;
  for (let i = 0; i < d.length; i++) {
    const v = d[i] * scale[i % c] + shift[i % c];
    d[i] = v > 0 ? v : Math.exp(v) - 1;
  }
  return x;
}

function keyCnnMaxPool(x) {
  const t = x.t >> 1;
  const f = x.f >> 1;
  const c = x.c;
  const out = new Float32Array(t * f * c);
  const d = x.data;
  for (let ti = 0; ti < t; ti++) {
    for (let fi = 0; fi < f; fi++) {
      const a = ((2 * ti) * x.f + 2 * fi) * c;
      const b = ((2 * ti + 1) * x.f + 2 * fi) * c;
      const dst = (ti * f + fi) * c;
      for (let ch = 0; ch < c; ch++) {
        out[dst + ch] = Math.max(d[a + ch], d[a + c + ch], d[b + ch], d[b + c + ch]);
      }
    }
  }
  return { t, f, c, data: out };
}

// The 24 class probabilities for a spectrogram.
function keyCnnForward(model, spec) {
  let x = { t: spec.frames, f: spec.bands, c: 1, data: spec.data };
  let mean = null;
  for (const layer of model) {
    if (layer.type === "pad") x = keyCnnPad(x, layer.width);
    else if (layer.type === "conv") x = keyCnnConv(x, layer);
    else if (layer.type === "bn_elu") x = keyCnnBatchNormElu(x, layer);
    else if (layer.type === "maxpool2") x = keyCnnMaxPool(x);
    else if (layer.type === "mean") {
      mean = new Float64Array(x.c);
      const cells = x.t * x.f;
      for (let i = 0; i < x.data.length; i++) mean[i % x.c] += x.data[i];
      for (let ch = 0; ch < x.c; ch++) mean[ch] /= cells;
    } else throw new Error("unknown layer " + layer.type);
  }
  if (!mean || mean.length !== 24) throw new Error("model did not end in 24 classes");
  let max = -Infinity;
  for (const v of mean) if (v > max) max = v;
  const probs = new Float64Array(24);
  let sum = 0;
  for (let k = 0; k < 24; k++) { probs[k] = Math.exp(mean[k] - max); sum += probs[k]; }
  for (let k = 0; k < 24; k++) probs[k] /= sum;
  return probs;
}

/*
 * Mono 44.1 kHz audio -> { key, confidence, confident, second, probs }.
 * `second` is the runner-up key, useful when the two are close.
 */
function detectKeyCnn(y, model) {
  if (!model || y.length < KEY_CNN_FRAME) return { key: null, confidence: null, confident: false, second: null, probs: null };
  const probs = keyCnnForward(model, keyCnnSpectrogram(y));
  let best = 0;
  for (let k = 1; k < 24; k++) if (probs[k] > probs[best]) best = k;
  let second = best === 0 ? 1 : 0;
  for (let k = 0; k < 24; k++) if (k !== best && probs[k] > probs[second]) second = k;
  const confidence = Math.round(probs[best] * 1000) / 1000;
  return {
    key: keyCnnClassToCamelot(best),
    confidence,
    confident: probs[best] >= KEY_CNN_MIN_CONFIDENCE,
    second: keyCnnClassToCamelot(second),
    probs,
  };
}
