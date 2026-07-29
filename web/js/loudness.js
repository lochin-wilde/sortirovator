"use strict";
/*
 * loudness.js -- ITU-R BS.1770-4 loudness measurement plus the rendering stage
 * that replaces the ffmpeg call in the Python version (gain, safe limiter,
 * silence trim, resampling, WAV/MP3 encoding).
 *
 * The measurement side is a direct port of what pyloudnorm does, including its
 * parametric K-weighting filter design, so LUFS numbers line up with the
 * desktop app rather than merely being "close".
 *
 * Runs inside a Web Worker. No external dependencies except optional lamejs
 * for MP3 output.
 */

const SAFE_LIMITER_TP_DB = -1.0;
const SILENCE_THRESHOLD_DB = -80;

/* ------------------------------------------------------------------ */
/* K-weighting                                                         */
/* ------------------------------------------------------------------ */

// pyloudnorm designs both stages parametrically so they track the sample rate,
// rather than hardcoding the 48 kHz coefficients from the spec.
function highShelfCoefficients(fs) {
  const db = 3.999843853973347;
  const f0 = 1681.974450955533;
  const Q = 0.7071752369554196;
  const K = Math.tan((Math.PI * f0) / fs);
  const Vh = Math.pow(10, db / 20);
  const Vb = Math.pow(Vh, 0.4996667741545416);
  const a0 = 1 + K / Q + K * K;
  return {
    b0: (Vh + (Vb * K) / Q + K * K) / a0,
    b1: (2 * (K * K - Vh)) / a0,
    b2: (Vh - (Vb * K) / Q + K * K) / a0,
    a1: (2 * (K * K - 1)) / a0,
    a2: (1 - K / Q + K * K) / a0,
  };
}

function highPassCoefficients(fs) {
  const f0 = 38.13547087602444;
  const Q = 0.5003270373238773;
  const K = Math.tan((Math.PI * f0) / fs);
  const denom = 1 + K / Q + K * K;
  return {
    b0: 1.0,
    b1: -2.0,
    b2: 1.0,
    a1: (2 * (K * K - 1)) / denom,
    a2: (1 - K / Q + K * K) / denom,
  };
}

function biquad(input, c) {
  const n = input.length;
  const out = new Float32Array(n);
  let x1 = 0, x2 = 0, y1 = 0, y2 = 0;
  for (let i = 0; i < n; i++) {
    const x0 = input[i];
    const y0 = c.b0 * x0 + c.b1 * x1 + c.b2 * x2 - c.a1 * y1 - c.a2 * y2;
    out[i] = y0;
    x2 = x1; x1 = x0;
    y2 = y1; y1 = y0;
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* Block powers + gating                                               */
/* ------------------------------------------------------------------ */

const CHANNEL_GAINS = [1.0, 1.0, 1.0, 1.41, 1.41];

/*
 * Mean square of the K-weighted signal over 400 ms blocks with 75% overlap.
 * These are computed once for the whole file and then reused for both the
 * integrated measurement and every short-term window, which is what makes the
 * 3-second sliding measurement cheap enough to run in the browser.
 */
function computeBlockPowers(channels, sr) {
  const blockSamples = Math.round(0.4 * sr);
  const stepSamples = Math.round(0.1 * sr);
  const numSamples = channels[0].length;
  if (numSamples < blockSamples) return { blocks: [], blockSamples, stepSamples };

  const shelf = highShelfCoefficients(sr);
  const hp = highPassCoefficients(sr);
  const filtered = channels.map((ch) => biquad(biquad(ch, shelf), hp));

  const numBlocks = 1 + Math.floor((numSamples - blockSamples) / stepSamples);
  const blocks = [];
  for (let b = 0; b < numBlocks; b++) {
    const start = b * stepSamples;
    const z = new Float64Array(filtered.length);
    for (let c = 0; c < filtered.length; c++) {
      const data = filtered[c];
      let acc = 0;
      for (let i = start; i < start + blockSamples; i++) acc += data[i] * data[i];
      z[c] = acc / blockSamples;
    }
    blocks.push({ start, z });
  }
  return { blocks, blockSamples, stepSamples };
}

function blockLoudness(z) {
  let sum = 0;
  for (let c = 0; c < z.length; c++) sum += (CHANNEL_GAINS[c] !== undefined ? CHANNEL_GAINS[c] : 1.0) * z[c];
  if (sum <= 0) return -Infinity;
  return -0.691 + 10 * Math.log10(sum);
}

/*
 * Two-stage gating: absolute at -70 LUFS, then relative at 10 LU below the mean
 * of everything that survived the absolute gate.
 *
 * Operates on the half-open block range [from, to) so the short-term sliding
 * window can reuse the same array instead of slicing a fresh one per position.
 * Both passes accumulate in place rather than building intermediate arrays --
 * this runs once per window, of which there are over a hundred per track.
 */
function gatedLoudness(blocks, from, to) {
  const start = from === undefined ? 0 : from;
  const end = to === undefined ? blocks.length : to;
  if (end - start <= 0) return null;
  const numChannels = blocks[start].z.length;

  const meanZ = new Float64Array(numChannels);
  let aboveCount = 0;
  for (let i = start; i < end; i++) {
    if (blockLoudness(blocks[i].z) <= -70.0) continue;
    const z = blocks[i].z;
    for (let c = 0; c < numChannels; c++) meanZ[c] += z[c];
    aboveCount++;
  }
  if (aboveCount === 0) return null;
  for (let c = 0; c < numChannels; c++) meanZ[c] /= aboveCount;

  const relativeThreshold = blockLoudness(meanZ) - 10.0;
  const finalZ = new Float64Array(numChannels);
  let gatedCount = 0;
  for (let i = start; i < end; i++) {
    const loudness = blockLoudness(blocks[i].z);
    if (loudness <= -70.0 || loudness <= relativeThreshold) continue;
    const z = blocks[i].z;
    for (let c = 0; c < numChannels; c++) finalZ[c] += z[c];
    gatedCount++;
  }
  if (gatedCount === 0) return null;
  for (let c = 0; c < numChannels; c++) finalZ[c] /= gatedCount;

  const result = blockLoudness(finalZ);
  return Number.isFinite(result) ? result : null;
}

/* ------------------------------------------------------------------ */
/* True peak                                                           */
/* ------------------------------------------------------------------ */

/*
 * 4x oversampled peak via a polyphase windowed-sinc interpolator, matching the
 * scipy.signal.resample_poly(up=4) approach used on the Python side.
 *
 * The naive form -- interpolate every sample at every phase -- measured at 2.5
 * seconds for a two-minute track, roughly half the entire analysis. It was
 * doing 524 million multiply-accumulates to find a single maximum.
 *
 * Two changes, neither of which alters the result:
 *
 * Interior samples are handled without per-tap bounds checks, with the first
 * and last few samples split off into their own guarded loop.
 *
 * A position is skipped entirely when it cannot possibly beat the peak found so
 * far. An interpolated value is bounded by the largest input sample in its
 * filter window times the kernel's L1 norm, so if that bound is already below
 * the running peak, the convolution is pointless. Most music spends most of its
 * time well below peak, so this prunes the great majority of positions.
 */
function truePeakDb(channels) {
  const factor = 4;
  const halfTaps = 16;
  const tapsPerPhase = 2 * halfTaps + 1;
  const phases = [];
  let maxL1 = 0;
  for (let p = 0; p < factor; p++) {
    const kernel = new Float64Array(tapsPerPhase);
    let sum = 0;
    for (let i = 0; i < tapsPerPhase; i++) {
      const t = i - halfTaps - p / factor;
      const sinc = t === 0 ? 1 : Math.sin(Math.PI * t) / (Math.PI * t);
      // Blackman window keeps the interpolator well behaved near the edges.
      const wpos = (i + 0.5) / tapsPerPhase;
      const w = 0.42 - 0.5 * Math.cos(2 * Math.PI * wpos) + 0.08 * Math.cos(4 * Math.PI * wpos);
      kernel[i] = sinc * w;
      sum += kernel[i];
    }
    if (sum !== 0) for (let i = 0; i < tapsPerPhase; i++) kernel[i] /= sum;
    let l1 = 0;
    for (let i = 0; i < tapsPerPhase; i++) l1 += Math.abs(kernel[i]);
    if (l1 > maxL1) maxL1 = l1;
    phases.push(kernel);
  }

  let peak = 0;
  for (const data of channels) {
    const n = data.length;
    if (n === 0) continue;

    // Rolling maximum of |x| over each filter window, used for the bound.
    // Computed in blocks: the exact per-position maximum is not needed, only an
    // upper bound, and a block maximum is a valid one.
    const blockSize = 64;
    const numBlocks = Math.ceil(n / blockSize);
    const blockMax = new Float64Array(numBlocks);
    for (let i = 0; i < n; i++) {
      const a = Math.abs(data[i]);
      const b = (i / blockSize) | 0;
      if (a > blockMax[b]) blockMax[b] = a;
      if (a > peak) peak = a;
    }

    for (let i = 0; i < n; i++) {
      // Windows span [i-halfTaps, i+halfTaps]; take the max over the blocks it
      // touches as the bound.
      const firstBlock = Math.max(0, ((i - halfTaps) / blockSize) | 0);
      const lastBlock = Math.min(numBlocks - 1, ((i + halfTaps) / blockSize) | 0);
      let localMax = 0;
      for (let b = firstBlock; b <= lastBlock; b++) {
        if (blockMax[b] > localMax) localMax = blockMax[b];
      }
      if (localMax * maxL1 <= peak) continue;

      const interior = i >= halfTaps && i + halfTaps < n;
      for (let p = 1; p < factor; p++) {
        const kernel = phases[p];
        let acc = 0;
        if (interior) {
          const base = i - halfTaps;
          for (let k = 0; k < tapsPerPhase; k++) acc += data[base + k] * kernel[k];
        } else {
          for (let k = 0; k < tapsPerPhase; k++) {
            const idx = i + k - halfTaps;
            if (idx >= 0 && idx < n) acc += data[idx] * kernel[k];
          }
        }
        const av = acc < 0 ? -acc : acc;
        if (av > peak) peak = av;
      }
    }
  }
  return peak > 0 ? 20 * Math.log10(peak) : -120.0;
}

/* ------------------------------------------------------------------ */
/* Public measurement entry point                                      */
/* ------------------------------------------------------------------ */

/*
 * Returns { integrated, shortTermMax, truePeak } in LUFS / dBFS.
 * shortTermMax slides an ungated 3-second window with a 1-second hop and takes
 * the loudest result, matching measure_loudness() in the Python version.
 */
/*
 * `withTruePeak` is off by default because the true-peak scan costs about 1.3 s
 * per track while the LUFS figures cost 80 ms. Loudness normalization needs the
 * peak; sorting a library by level does not, and that distinction is what makes
 * it affordable to measure loudness on every track.
 */
function measureLoudness(channels, sr, withTruePeak) {
  const { blocks, blockSamples } = computeBlockPowers(channels, sr);
  const integrated = gatedLoudness(blocks);

  let shortTermMax = integrated;
  const windowSamples = Math.round(3.0 * sr);
  const hopSamples = Math.round(1.0 * sr);
  const numSamples = channels[0].length;
  if (numSamples >= windowSamples && blocks.length > 0) {
    /*
     * Blocks are already in start order, so each 3-second window is a
     * contiguous run of them and can be tracked with two moving indices.
     * Filtering the whole block list per window instead -- which is what this
     * did -- rescanned about 1200 blocks for each of ~118 windows on a
     * two-minute track and allocated an array every time. That single change
     * accounted for most of the loudness stage's cost.
     */
    let best = -Infinity;
    let lo = 0;
    let hi = 0;
    for (let start = 0; start + windowSamples <= numSamples; start += hopSamples) {
      const end = start + windowSamples;
      while (lo < blocks.length && blocks[lo].start < start) lo++;
      if (hi < lo) hi = lo;
      while (hi < blocks.length && blocks[hi].start + blockSamples <= end) hi++;
      if (hi > lo) {
        const value = gatedLoudness(blocks, lo, hi);
        if (value !== null && value > best) best = value;
      }
    }
    if (Number.isFinite(best)) shortTermMax = best;
  }

  return {
    integrated: integrated,
    shortTermMax: shortTermMax,
    truePeak: withTruePeak ? truePeakDb(channels) : null,
  };
}

/* ------------------------------------------------------------------ */
/* Rendering: gain, limiter, silence trim, resample, encode            */
/* ------------------------------------------------------------------ */

function applyGain(channels, gainDb) {
  if (Math.abs(gainDb) <= 0.01) return channels;
  const factor = Math.pow(10, gainDb / 20);
  return channels.map((ch) => {
    const out = new Float32Array(ch.length);
    for (let i = 0; i < ch.length; i++) out[i] = ch[i] * factor;
    return out;
  });
}

/*
 * Look-ahead peak limiter standing in for ffmpeg's alimiter. Gain reduction is
 * computed from the linked peak across channels, then smoothed with a 5 ms
 * attack and 50 ms release so it ducks transients instead of clipping them.
 */
function applyLimiter(channels, sr) {
  const ceiling = Math.pow(10, SAFE_LIMITER_TP_DB / 20);
  const n = channels[0].length;
  const lookahead = Math.max(1, Math.round(0.005 * sr));
  const releaseSamples = Math.max(1, Math.round(0.05 * sr));
  const releaseCoeff = Math.exp(-1 / releaseSamples);

  const target = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    let peak = 0;
    for (let c = 0; c < channels.length; c++) {
      const a = Math.abs(channels[c][i]);
      if (a > peak) peak = a;
    }
    target[i] = peak > ceiling ? ceiling / peak : 1.0;
  }

  // Propagate each reduction backwards over the look-ahead window so the
  // limiter is already at the required gain when the transient arrives.
  const envelope = new Float32Array(n);
  envelope.fill(1.0);
  for (let i = n - 1; i >= 0; i--) {
    let minGain = target[i];
    const stop = Math.min(n - 1, i + lookahead);
    for (let j = i; j <= stop; j++) if (target[j] < minGain) minGain = target[j];
    envelope[i] = minGain;
  }

  let current = 1.0;
  const smoothed = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const desired = envelope[i];
    current = desired < current ? desired : desired + (current - desired) * releaseCoeff;
    smoothed[i] = current;
  }

  return channels.map((ch) => {
    const out = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      let v = ch[i] * smoothed[i];
      if (v > ceiling) v = ceiling;
      else if (v < -ceiling) v = -ceiling;
      out[i] = v;
    }
    return out;
  });
}

// Equivalent of ffmpeg's silenceremove with the margins used in the Python
// version: a short lead-in margin, a longer tail margin to preserve decay.
function trimSilence(channels, sr) {
  const threshold = Math.pow(10, SILENCE_THRESHOLD_DB / 20);
  const n = channels[0].length;

  let first = 0;
  outerStart: for (; first < n; first++) {
    for (let c = 0; c < channels.length; c++) {
      if (Math.abs(channels[c][first]) > threshold) break outerStart;
    }
  }
  let last = n - 1;
  outerEnd: for (; last > first; last--) {
    for (let c = 0; c < channels.length; c++) {
      if (Math.abs(channels[c][last]) > threshold) break outerEnd;
    }
  }
  if (first >= last) return channels;

  const start = Math.max(0, first - Math.round(0.05 * sr));
  const end = Math.min(n, last + Math.round(0.3 * sr));
  if (start === 0 && end === n) return channels;
  return channels.map((ch) => ch.slice(start, end));
}

/*
 * Windowed-sinc resampler, used when the user forces an output sample rate
 * different from the source.
 *
 * The filter is precomputed into a table of sub-sample phases rather than
 * evaluated inline. The obvious inline version calls sin() and cos() once per
 * tap per output sample, which measured at 11.8 seconds to convert 30 seconds
 * of audio -- roughly 65 million transcendental calls, and over 200x the cost
 * of the actual spectral analysis it was feeding. Tabulating the phases makes
 * the inner loop pure multiply-accumulate.
 */
const RESAMPLE_PHASES = 512;
const RESAMPLE_HALF_TAPS = 16;

function buildResampleTable(cutoff) {
  const taps = 2 * RESAMPLE_HALF_TAPS + 1;
  const table = new Float32Array(RESAMPLE_PHASES * taps);
  for (let p = 0; p < RESAMPLE_PHASES; p++) {
    const frac = p / RESAMPLE_PHASES;
    let sum = 0;
    const base = p * taps;
    for (let k = 0; k < taps; k++) {
      const t = (k - RESAMPLE_HALF_TAPS - frac) * cutoff;
      const sinc = Math.abs(t) < 1e-9 ? 1 : Math.sin(Math.PI * t) / (Math.PI * t);
      const wpos = k / (taps - 1);
      const w = 0.42 - 0.5 * Math.cos(2 * Math.PI * wpos) + 0.08 * Math.cos(4 * Math.PI * wpos);
      const weight = sinc * w;
      table[base + k] = weight;
      sum += weight;
    }
    // Normalize each phase so a constant signal keeps its level.
    if (sum !== 0) {
      for (let k = 0; k < taps; k++) table[base + k] /= sum;
    }
  }
  return table;
}

function resampleChannels(channels, fromRate, toRate) {
  if (fromRate === toRate) return channels;
  const ratio = toRate / fromRate;
  const inLength = channels[0].length;
  const outLength = Math.max(1, Math.round(inLength * ratio));
  const taps = 2 * RESAMPLE_HALF_TAPS + 1;
  // When downsampling, widen the kernel so it also acts as the anti-alias filter.
  const table = buildResampleTable(Math.min(1, ratio));
  const step = fromRate / toRate;

  return channels.map((ch) => {
    const out = new Float32Array(outLength);
    for (let i = 0; i < outLength; i++) {
      const center = i * step;
      const base = Math.floor(center);
      let phase = ((center - base) * RESAMPLE_PHASES) | 0;
      if (phase >= RESAMPLE_PHASES) phase = RESAMPLE_PHASES - 1;
      const t0 = phase * taps;
      const start = base - RESAMPLE_HALF_TAPS;
      let acc = 0;
      if (start >= 0 && start + taps <= inLength) {
        for (let k = 0; k < taps; k++) acc += ch[start + k] * table[t0 + k];
      } else {
        for (let k = 0; k < taps; k++) {
          const idx = start + k;
          if (idx >= 0 && idx < inLength) acc += ch[idx] * table[t0 + k];
        }
      }
      out[i] = acc;
    }
    return out;
  });
}

function encodeWav(channels, sr) {
  const numChannels = channels.length;
  const numFrames = channels[0].length;
  const bytesPerSample = 2;
  const dataSize = numFrames * numChannels * bytesPerSample;
  const buffer = new ArrayBuffer(44 + dataSize);
  const view = new DataView(buffer);

  const writeString = (offset, text) => {
    for (let i = 0; i < text.length; i++) view.setUint8(offset + i, text.charCodeAt(i));
  };

  writeString(0, "RIFF");
  view.setUint32(4, 36 + dataSize, true);
  writeString(8, "WAVE");
  writeString(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, numChannels, true);
  view.setUint32(24, sr, true);
  view.setUint32(28, sr * numChannels * bytesPerSample, true);
  view.setUint16(32, numChannels * bytesPerSample, true);
  view.setUint16(34, 16, true);
  writeString(36, "data");
  view.setUint32(40, dataSize, true);

  let offset = 44;
  for (let i = 0; i < numFrames; i++) {
    for (let c = 0; c < numChannels; c++) {
      let s = channels[c][i];
      if (s > 1) s = 1;
      else if (s < -1) s = -1;
      view.setInt16(offset, Math.round(s * 32767), true);
      offset += 2;
    }
  }
  return buffer;
}

/*
 * MP3 export needs lamejs, loaded lazily so that WAV-only runs never pay for it.
 *
 * It is served from our own origin rather than a CDN. This code runs in the
 * worker that holds the user's decoded audio, so whoever serves it can read
 * that audio -- that is not a decision to delegate to a third party who can
 * change the file at any time. Same-origin also means MP3 export keeps working
 * offline. Update by replacing js/lib/lame.min.js (lamejs 1.2.1) and bumping
 * the app version.
 *
 * If the file is missing the caller falls back to WAV rather than failing.
 */
let _lameStatus = "unknown";
function ensureLame() {
  if (_lameStatus !== "unknown") return _lameStatus === "ready";
  try {
    self.importScripts("lib/lame.min.js?v=" + WORKER_VERSION);
    _lameStatus = typeof self.lamejs !== "undefined" ? "ready" : "missing";
  } catch (e) {
    _lameStatus = "missing";
  }
  return _lameStatus === "ready";
}

function encodeMp3(channels, sr, kbps) {
  if (!ensureLame()) return null;
  const numChannels = Math.min(2, channels.length);
  const encoder = new self.lamejs.Mp3Encoder(numChannels, sr, kbps || 320);
  const numFrames = channels[0].length;
  const blockSize = 1152;
  const chunks = [];

  const toInt16 = (data, start, length) => {
    const out = new Int16Array(length);
    for (let i = 0; i < length; i++) {
      let s = data[start + i];
      if (s > 1) s = 1;
      else if (s < -1) s = -1;
      out[i] = Math.round(s * 32767);
    }
    return out;
  };

  for (let i = 0; i < numFrames; i += blockSize) {
    const length = Math.min(blockSize, numFrames - i);
    const left = toInt16(channels[0], i, length);
    const right = numChannels === 2 ? toInt16(channels[1], i, length) : null;
    const buf = numChannels === 2 ? encoder.encodeBuffer(left, right) : encoder.encodeBuffer(left);
    if (buf.length > 0) chunks.push(new Uint8Array(buf));
  }
  const tail = encoder.flush();
  if (tail.length > 0) chunks.push(new Uint8Array(tail));

  let total = 0;
  for (const c of chunks) total += c.length;
  const merged = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    merged.set(c, offset);
    offset += c.length;
  }
  return merged.buffer;
}
