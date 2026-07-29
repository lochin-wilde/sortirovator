"use strict";
/*
 * dsp.js -- browser port of the librosa-based analysis used by the Python
 * version of Музыкальный сортир.
 *
 * The spectral features and the genre centroids still mirror librosa's defaults
 * (n_fft=2048, hop_length=512, periodic Hann, center=True, Slaney mel scale),
 * because the centroid distances were calibrated against those exact numbers.
 *
 * Tempo and key no longer follow librosa. Both were re-derived against 1334
 * tracks labelled by Rekordbox after the ported versions measured poorly on
 * real music; the reasoning is recorded at each of them.
 *
 * Runs inside a Web Worker. No external dependencies.
 */

/* ------------------------------------------------------------------ */
/* FFT                                                                 */
/* ------------------------------------------------------------------ */

class FFT {
  constructor(n) {
    if ((n & (n - 1)) !== 0) throw new Error("FFT size must be a power of two: " + n);
    this.n = n;
    this.levels = Math.round(Math.log2(n));
    const half = n >> 1;
    this.cos = new Float64Array(half);
    this.sin = new Float64Array(half);
    for (let i = 0; i < half; i++) {
      this.cos[i] = Math.cos((2 * Math.PI * i) / n);
      this.sin[i] = Math.sin((2 * Math.PI * i) / n);
    }
    this.rev = new Uint32Array(n);
    for (let i = 0; i < n; i++) {
      let x = i;
      let r = 0;
      for (let j = 0; j < this.levels; j++) {
        r = (r << 1) | (x & 1);
        x >>= 1;
      }
      this.rev[i] = r >>> 0;
    }
    this.scratchRe = new Float64Array(n);
    this.scratchIm = new Float64Array(n);
  }

  // In-place forward DFT. Pass inverse=true for the unnormalized inverse.
  transform(re, im, inverse) {
    const n = this.n;
    const rev = this.rev;
    for (let i = 0; i < n; i++) {
      const j = rev[i];
      if (j > i) {
        let t = re[i]; re[i] = re[j]; re[j] = t;
        t = im[i]; im[i] = im[j]; im[j] = t;
      }
    }
    const sign = inverse ? 1 : -1;
    for (let size = 2; size <= n; size <<= 1) {
      const halfSize = size >> 1;
      const step = n / size;
      for (let i = 0; i < n; i += size) {
        for (let j = i, k = 0; j < i + halfSize; j++, k += step) {
          const wr = this.cos[k];
          const wi = sign * this.sin[k];
          const l = j + halfSize;
          const tr = re[l] * wr - im[l] * wi;
          const ti = re[l] * wi + im[l] * wr;
          re[l] = re[j] - tr;
          im[l] = im[j] - ti;
          re[j] += tr;
          im[j] += ti;
        }
      }
    }
  }
}

const _fftCache = new Map();
function getFFT(n) {
  let f = _fftCache.get(n);
  if (!f) {
    f = new FFT(n);
    _fftCache.set(n, f);
  }
  return f;
}

function nextPow2(n) {
  let p = 1;
  while (p < n) p <<= 1;
  return p;
}

/* ------------------------------------------------------------------ */
/* Framing / windowing (librosa-compatible)                            */
/* ------------------------------------------------------------------ */

// scipy.signal.get_window("hann", n, fftbins=True) -- the periodic variant.
function hannPeriodic(n) {
  const w = new Float64Array(n);
  for (let i = 0; i < n; i++) w[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / n);
  return w;
}

// With center=True librosa pads by n_fft//2 on both sides, so frame t is
// centered on sample t*hop. Out-of-range samples read as zero, matching
// librosa's default pad_mode="constant".
function frameCountCentered(numSamples, hop) {
  return 1 + Math.floor(numSamples / hop);
}

function readFrameCentered(y, frameIndex, frameLen, hop, out) {
  const start = frameIndex * hop - (frameLen >> 1);
  const n = y.length;
  for (let i = 0; i < frameLen; i++) {
    const idx = start + i;
    out[i] = idx >= 0 && idx < n ? y[idx] : 0;
  }
}

// librosa.feature.zero_crossing_rate pads with mode="edge" instead of zeros.
function readFrameCenteredEdge(y, frameIndex, frameLen, hop, out) {
  const start = frameIndex * hop - (frameLen >> 1);
  const n = y.length;
  if (n === 0) {
    out.fill(0);
    return;
  }
  for (let i = 0; i < frameLen; i++) {
    let idx = start + i;
    if (idx < 0) idx = 0;
    else if (idx >= n) idx = n - 1;
    out[i] = y[idx];
  }
}

/* ------------------------------------------------------------------ */
/* Mel filterbank (Slaney scale + Slaney normalization)                */
/* ------------------------------------------------------------------ */

const MEL_F_SP = 200.0 / 3.0;
const MEL_MIN_LOG_HZ = 1000.0;
const MEL_MIN_LOG_MEL = MEL_MIN_LOG_HZ / MEL_F_SP;
const MEL_LOGSTEP = Math.log(6.4) / 27.0;

function hzToMel(hz) {
  if (hz < MEL_MIN_LOG_HZ) return hz / MEL_F_SP;
  return MEL_MIN_LOG_MEL + Math.log(hz / MEL_MIN_LOG_HZ) / MEL_LOGSTEP;
}

function melToHz(mel) {
  if (mel < MEL_MIN_LOG_MEL) return mel * MEL_F_SP;
  return MEL_MIN_LOG_HZ * Math.exp(MEL_LOGSTEP * (mel - MEL_MIN_LOG_MEL));
}

/*
 * Sparse mel filterbank: each triangular filter only touches a contiguous run
 * of FFT bins, so we store (start, weights) per filter instead of a dense
 * nMels x (nFft/2+1) matrix. That turns the mel projection from ~2.7 GFLOP into
 * ~20 MFLOP on a 4-minute track, which is the difference between usable and not.
 */
function buildMelFilterbank(sr, nFft, nMels) {
  const nBins = (nFft >> 1) + 1;
  const fftFreqs = new Float64Array(nBins);
  for (let i = 0; i < nBins; i++) fftFreqs[i] = (i * sr) / nFft;

  const fMax = sr / 2;
  const melMin = hzToMel(0);
  const melMax = hzToMel(fMax);
  const melPoints = new Float64Array(nMels + 2);
  for (let i = 0; i < nMels + 2; i++) {
    melPoints[i] = melToHz(melMin + ((melMax - melMin) * i) / (nMels + 1));
  }

  const filters = [];
  for (let m = 0; m < nMels; m++) {
    const lower = melPoints[m];
    const center = melPoints[m + 1];
    const upper = melPoints[m + 2];
    // Slaney normalization: unit area rather than unit peak.
    const enorm = 2.0 / (upper - lower);

    let start = -1;
    let end = -1;
    for (let k = 0; k < nBins; k++) {
      const f = fftFreqs[k];
      if (f > lower && f < upper) {
        if (start < 0) start = k;
        end = k;
      }
    }
    if (start < 0) {
      filters.push({ start: 0, weights: new Float64Array(0) });
      continue;
    }
    const weights = new Float64Array(end - start + 1);
    for (let k = start; k <= end; k++) {
      const f = fftFreqs[k];
      const w = f <= center ? (f - lower) / (center - lower) : (upper - f) / (upper - center);
      weights[k - start] = Math.max(0, w) * enorm;
    }
    filters.push({ start, weights });
  }
  return filters;
}

/* ------------------------------------------------------------------ */
/* Spectral features for the nearest-centroid genre fallback           */
/* ------------------------------------------------------------------ */

/*
 * Mean spectral centroid, spectral bandwidth (p=2) and zero-crossing rate,
 * matching librosa.feature.* defaults. The Python version calls these on a
 * 22050 Hz mono signal truncated to the first 60 seconds, so the caller must
 * pass exactly that signal for the centroid distances to stay comparable to
 * _GENRE_CENTROIDS.
 */
function spectralFeatures(y, sr, onProgress) {
  const nFft = 2048;
  const hop = 512;
  const nBins = (nFft >> 1) + 1;
  const frames = frameCountCentered(y.length, hop);
  if (frames <= 0) return { centroid: 0, bandwidth: 0, zcr: 0 };

  const window = hannPeriodic(nFft);
  const fft = getFFT(nFft);
  const re = new Float64Array(nFft);
  const im = new Float64Array(nFft);
  const frame = new Float64Array(nFft);
  const mag = new Float64Array(nBins);
  const freqs = new Float64Array(nBins);
  for (let i = 0; i < nBins; i++) freqs[i] = (i * sr) / nFft;

  let centroidSum = 0;
  let bandwidthSum = 0;

  for (let t = 0; t < frames; t++) {
    readFrameCentered(y, t, nFft, hop, frame);
    for (let i = 0; i < nFft; i++) {
      re[i] = frame[i] * window[i];
      im[i] = 0;
    }
    fft.transform(re, im, false);

    let magSum = 0;
    for (let k = 0; k < nBins; k++) {
      const m = Math.hypot(re[k], im[k]);
      mag[k] = m;
      magSum += m;
    }
    if (magSum <= 1e-20) continue; // silent frame contributes 0, as in librosa

    let c = 0;
    for (let k = 0; k < nBins; k++) c += freqs[k] * (mag[k] / magSum);
    let variance = 0;
    for (let k = 0; k < nBins; k++) {
      const d = freqs[k] - c;
      variance += (mag[k] / magSum) * d * d;
    }
    centroidSum += c;
    bandwidthSum += Math.sqrt(variance);

    if (onProgress && (t & 511) === 0) onProgress(t / frames);
  }

  // Zero-crossing rate uses its own framing with edge padding.
  const zcrFrameLen = 2048;
  const zcrFrames = frameCountCentered(y.length, hop);
  const zframe = new Float64Array(zcrFrameLen);
  let zcrSum = 0;
  for (let t = 0; t < zcrFrames; t++) {
    readFrameCenteredEdge(y, t, zcrFrameLen, hop, zframe);
    let crossings = 0;
    // librosa's zero_crossings(pad=True) compares the first sample against 0.
    let prevNeg = zframe[0] < 0;
    if (prevNeg) crossings++;
    for (let i = 1; i < zcrFrameLen; i++) {
      const neg = zframe[i] < 0;
      if (neg !== prevNeg) crossings++;
      prevNeg = neg;
    }
    zcrSum += crossings / zcrFrameLen;
  }

  return {
    centroid: centroidSum / frames,
    bandwidth: bandwidthSum / frames,
    zcr: zcrSum / zcrFrames,
  };
}

/* ------------------------------------------------------------------ */
/* Onset strength envelope                                             */
/* ------------------------------------------------------------------ */

/*
 * librosa.onset.onset_strength: mel power spectrogram -> power_to_db(ref=max,
 * top_db=80) -> first-order difference -> half-wave rectify -> mean across mel
 * bands -> left-pad by (lag + n_fft // (2*hop)) zeros and truncate.
 */
function onsetStrength(y, sr, onProgress) {
  const nFft = 2048;
  const hop = 512;
  const nMels = 128;
  const nBins = (nFft >> 1) + 1;
  const frames = frameCountCentered(y.length, hop);
  if (frames < 2) return new Float64Array(Math.max(0, frames));

  const filters = buildMelFilterbank(sr, nFft, nMels);
  const window = hannPeriodic(nFft);
  const fft = getFFT(nFft);
  const re = new Float64Array(nFft);
  const im = new Float64Array(nFft);
  const frame = new Float64Array(nFft);
  const power = new Float64Array(nBins);

  const melDb = new Float32Array(nMels * frames);
  let globalMax = 1e-10;

  for (let t = 0; t < frames; t++) {
    readFrameCentered(y, t, nFft, hop, frame);
    for (let i = 0; i < nFft; i++) {
      re[i] = frame[i] * window[i];
      im[i] = 0;
    }
    fft.transform(re, im, false);
    for (let k = 0; k < nBins; k++) power[k] = re[k] * re[k] + im[k] * im[k];

    for (let m = 0; m < nMels; m++) {
      const f = filters[m];
      let acc = 0;
      const w = f.weights;
      for (let i = 0; i < w.length; i++) acc += w[i] * power[f.start + i];
      if (acc > globalMax) globalMax = acc;
      melDb[m * frames + t] = acc;
    }
    if (onProgress && (t & 1023) === 0) onProgress(t / frames);
  }

  // power_to_db with ref=max and top_db=80.
  const refDb = 10 * Math.log10(Math.max(1e-10, globalMax));
  let maxDb = -Infinity;
  for (let i = 0; i < melDb.length; i++) {
    const db = 10 * Math.log10(Math.max(1e-10, melDb[i])) - refDb;
    melDb[i] = db;
    if (db > maxDb) maxDb = db;
  }
  const floor = maxDb - 80;
  for (let i = 0; i < melDb.length; i++) {
    if (melDb[i] < floor) melDb[i] = floor;
  }

  const lag = 1;
  const raw = new Float64Array(frames);
  for (let t = lag; t < frames; t++) {
    let acc = 0;
    for (let m = 0; m < nMels; m++) {
      const d = melDb[m * frames + t] - melDb[m * frames + (t - lag)];
      if (d > 0) acc += d;
    }
    raw[t - lag] = acc / nMels;
  }

  const padWidth = lag + Math.floor(nFft / (2 * hop));
  const env = new Float64Array(frames);
  for (let t = 0; t < frames; t++) {
    const src = t - padWidth;
    env[t] = src >= 0 && src < frames - lag ? raw[src] : 0;
  }
  return env;
}

/* ------------------------------------------------------------------ */
/* Tempogram + BPM                                                     */
/* ------------------------------------------------------------------ */

const BPM_MIN = 40;
// Matches the Python constant: 200 covers drum & bass without opening the door
// to the octave errors that showed up above it during testing.
const BPM_MAX = 200;

/*
 * librosa.autocorrelate uses an unpadded FFT, i.e. a *circular* autocorrelation
 * of the frame. Computing the linear autocorrelation with a zero-padded FFT and
 * folding it (r_circ[k] = r_lin[k] + r_lin[N-k]) reproduces that exactly while
 * letting us stay on a power-of-two FFT.
 */
/*
 * Mean tempogram over one or more frame ranges, computed in a single pass.
 *
 * The per-frame autocorrelation is the expensive part -- two FFTs per frame,
 * and there are thousands of frames in a track. Asking for the whole track and
 * then for seven overlapping windows separately, which is what the constant vs
 * dynamic tempo check needs, recomputed all of it roughly twice over. Since
 * every range is a slice of the same envelope, each frame can instead be
 * computed once and added to whichever accumulators contain it.
 *
 * Ranges are [startFrame, endFrame) pairs. Returns one mean tempogram each.
 */
function tempogramRanges(onsetEnv, sr, hop, winLength, ranges, onProgress) {
  const n = onsetEnv.length;
  if (n === 0) return null;

  const acWindow = hannPeriodic(winLength); // max is exactly 1.0, so norm=inf is a no-op

  // center=True pads the envelope by win_length//2 on each side with a linear
  // ramp down to zero.
  const pad = winLength >> 1;
  const padded = new Float64Array(n + 2 * pad);
  for (let i = 0; i < pad; i++) {
    const ramp = pad > 1 ? i / (pad - 1) : 1;
    padded[i] = onsetEnv[0] * ramp;
  }
  padded.set(onsetEnv, pad);
  for (let i = 0; i < pad; i++) {
    const ramp = pad > 1 ? 1 - i / (pad - 1) : 1;
    padded[pad + n + i] = onsetEnv[n - 1] * ramp;
  }

  const fftSize = nextPow2(winLength * 2);
  const fft = getFFT(fftSize);
  const re = new Float64Array(fftSize);
  const im = new Float64Array(fftSize);
  const accumulators = ranges.map(() => new Float64Array(winLength));
  const counts = ranges.map(() => 0);

  for (let t = 0; t < n; t++) {
    re.fill(0);
    im.fill(0);
    for (let i = 0; i < winLength; i++) re[i] = padded[t + i] * acWindow[i];

    fft.transform(re, im, false);
    for (let k = 0; k < fftSize; k++) {
      const p = re[k] * re[k] + im[k] * im[k];
      re[k] = p;
      im[k] = 0;
    }
    fft.transform(re, im, true);

    // Fold the linear autocorrelation back into a circular one of length
    // winLength, then normalize by the peak (librosa's norm=inf).
    let peak = 0;
    for (let k = 0; k < winLength; k++) {
      const wrap = k === 0 ? 0 : re[winLength - k];
      const v = (re[k] + wrap) / fftSize;
      im[k] = v;
      const a = Math.abs(v);
      if (a > peak) peak = a;
    }
    if (peak > 1e-20) {
      for (let rangeIndex = 0; rangeIndex < ranges.length; rangeIndex++) {
        const range = ranges[rangeIndex];
        if (t < range[0] || t >= range[1]) continue;
        const target = accumulators[rangeIndex];
        for (let k = 0; k < winLength; k++) target[k] += im[k] / peak;
        counts[rangeIndex]++;
      }
    }
    if (onProgress && (t & 1023) === 0) onProgress(t / n);
  }

  return accumulators.map((acc, i) => {
    if (counts[i] === 0) return null;
    const span = Math.max(1, ranges[i][1] - ranges[i][0]);
    for (let k = 0; k < winLength; k++) acc[k] /= span;
    return acc;
  });
}

/*
 * Tempo estimation.
 *
 * The prior is centred at 140 BPM, not at the 120 a listener would guess. That
 * is a deliberate match to Rekordbox rather than to musical intuition: measured
 * across 1334 labelled tracks, Rekordbox labels old-school hip hop at double
 * time -- the median of a 305-track 90s rap set is 176 BPM, not 88. Since these
 * numbers exist to line up with the user's library, matching that convention is
 * the point.
 *
 * Centring at 140 is worth 103 tracks overall (1155/1334 against 1052) and
 * costs 10 on afro house, which sits near 120 and is pulled upward by it. That
 * trade was taken knowingly; a house-only library is better served by 125.
 */
const BPM_PRIOR_CENTER = 140;
const BPM_PRIOR_OCTAVES = 0.4;
const ONSET_HOP = 512;
const TEMPOGRAM_WIN = 384;

/*
 * Picks a tempo from a tempogram.
 *
 * Two peaks are seeded from the strongest raw candidates, and only their
 * *octave* relatives are considered -- x4, x2, x1, /2, /4. That restriction is
 * the important part.
 *
 * Weighting every peak by a tempo prior, which is what this did before, has a
 * failure mode that only shows up outside the 120-130 BPM shelf. Measured over
 * 450 tracks spanning 18 genres, 45 of 64 errors were not halvings at all but
 * triplet subdivisions: 115 BPM reported for a 172 BPM drum & bass track, 136
 * for a 102 BPM moombahton one. The prior caused them. For that 172 BPM track
 * it scores the 115 BPM triplet peak at 0.999 and the truth at 0.874, so the
 * triplet wins outright.
 *
 * Restricting to octaves makes a 3:2 relative unreachable. Tempo ambiguity is
 * fundamentally 2:1 -- the same pulse counted twice as fast or twice as slow --
 * whereas a triplet is a different pulse, and no listener would call it the
 * tempo. Seeding from two peaks rather than one covers the case where the
 * strongest peak is itself the triplet.
 *
 * The prior stays, but only to choose within an octave family, so its spread is
 * narrow. Measured against the previous approach: 392/450 on the multi-genre
 * set against 383, and 339/343 against 337 across the three Rekordbox exports.
 *
 * Peak positions are refined by fitting a parabola through each peak and its
 * neighbours. Lag bins are integers, so the raw candidates are 60*sr/hop/k --
 * around 130 BPM that grid steps in jumps of 3.5 BPM and cannot represent 128
 * or 134 at all, which is why a Rekordbox-verified 134 once came back as 133.
 */
const TEMPO_SEEDS = 2;

function tempoFromTempogram(meanTg, sr, hop) {
  if (!meanTg) return null;
  const scale = (60 * sr) / hop;

  const peaks = [];
  for (let k = 2; k < meanTg.length - 1; k++) {
    const bpm = scale / k;
    if (bpm < BPM_MIN / 4 || bpm > BPM_MAX * 2) continue;
    if (!(meanTg[k] > meanTg[k - 1] && meanTg[k] > meanTg[k + 1])) continue;
    const a = meanTg[k - 1], b = meanTg[k], c = meanTg[k + 1];
    const denom = a - 2 * b + c;
    let refined = k;
    if (denom !== 0) {
      const delta = (0.5 * (a - c)) / denom;
      if (Math.abs(delta) <= 1) refined = k + delta;
    }
    peaks.push({ bpm: scale / refined, value: b });
  }
  if (peaks.length === 0) return null;

  const priorWeight = (bpm) =>
    Math.exp(-0.5 * Math.pow(Math.log2(bpm / BPM_PRIOR_CENTER) / BPM_PRIOR_OCTAVES, 2));

  const seeds = peaks.slice().sort((x, z) => z.value - x.value).slice(0, TEMPO_SEEDS);
  let best = null;
  for (const seed of seeds) {
    for (let octave = -2; octave <= 2; octave++) {
      const bpm = seed.bpm * Math.pow(2, octave);
      if (bpm < BPM_MIN || bpm > BPM_MAX) continue;
      // Credit the octave with whatever tempogram support it actually has; an
      // octave nothing peaks at gets only a fraction of the seed's strength.
      let support = 0;
      for (const p of peaks) {
        if (Math.abs(Math.log2(p.bpm / bpm)) < 0.03 && p.value > support) support = p.value;
      }
      const score = (support || seed.value * 0.5) * priorWeight(bpm);
      if (!best || score > best.score) best = { score, bpm };
    }
  }
  return best ? best.bpm : null;
}

/*
 * Plain whole-track tempo, without the sliding-window analysis.
 *
 * The genre fallback wants a single number and nothing else. Routing it through
 * analyzeTempo made it pay for every window as well, which is pure waste on
 * that path.
 */
function detectBpm(y, sr, onProgress) {
  const env = onsetStrength(y, sr, onProgress ? (p) => onProgress(p * 0.6) : null);
  let any = false;
  for (let i = 0; i < env.length; i++) if (env[i] !== 0) { any = true; break; }
  if (!any) return null;
  const tempograms = tempogramRanges(env, sr, ONSET_HOP, TEMPOGRAM_WIN, [[0, env.length]],
    onProgress ? (p) => onProgress(0.6 + p * 0.4) : null);
  const bpm = tempoFromTempogram(tempograms[0], sr, ONSET_HOP);
  return bpm === null ? null : Math.round(bpm);
}

/*
 * Tempo analysis that also reports whether the tempo holds still -- the "auto"
 * behaviour of a high-precision beatgrid analysis.
 *
 * The tempo is measured in overlapping windows across the track and the
 * description is chosen from what they say. A record produced to a grid gives
 * the same answer in every window and gets a single precise number. A live
 * take, a DJ edit, or anything with a tempo ramp does not, and gets a range
 * instead, where one number would be a fiction.
 *
 * The onset envelope is computed once and sliced, so the windows cost little
 * beyond their own tempograms.
 */
const TEMPO_WINDOW_SECONDS = 30;
const TEMPO_WINDOW_HOP_SECONDS = 15;
// Below this spread the tempo counts as fixed: wider than any grid-locked track
// drifts, narrower than a real tempo change.
const TEMPO_CONSTANT_TOLERANCE = 2.0;

function analyzeTempo(y, sr, onProgress) {
  const env = onsetStrength(y, sr, onProgress ? (p) => onProgress(p * 0.6) : null);
  let any = false;
  for (let i = 0; i < env.length; i++) if (env[i] !== 0) { any = true; break; }
  if (!any) return { bpm: null, mode: null, min: null, max: null, windows: [] };

  // Build every range up front -- the whole track first, then the sliding
  // windows -- so the autocorrelations are computed once for all of them.
  const framesPerWindow = Math.floor((TEMPO_WINDOW_SECONDS * sr) / ONSET_HOP);
  const framesPerHop = Math.floor((TEMPO_WINDOW_HOP_SECONDS * sr) / ONSET_HOP);
  const ranges = [[0, env.length]];
  if (env.length >= framesPerWindow * 2) {
    for (let start = 0; start + framesPerWindow <= env.length; start += framesPerHop) {
      ranges.push([start, start + framesPerWindow]);
    }
  }

  const tempograms = tempogramRanges(env, sr, ONSET_HOP, TEMPOGRAM_WIN, ranges,
    onProgress ? (p) => onProgress(0.6 + p * 0.4) : null);

  const overall = tempoFromTempogram(tempograms[0], sr, ONSET_HOP);
  const windows = [];
  for (let i = 1; i < tempograms.length; i++) {
    const bpm = tempoFromTempogram(tempograms[i], sr, ONSET_HOP);
    if (bpm !== null) windows.push(Math.round(bpm * 100) / 100);
  }

  if (windows.length < 2) {
    return {
      bpm: overall === null ? null : Math.round(overall),
      mode: "constant", min: null, max: null, windows,
    };
  }

  /*
   * Windows that landed on a different tempo octave are folded back before the
   * spread is measured. One window hearing 62 instead of 124 is a halving
   * artefact, not a tempo change, and would otherwise label every track dynamic.
   */
  const reference = overall || windows[0];
  const folded = windows.map((bpm) => {
    let v = bpm;
    while (v < reference * 0.75) v *= 2;
    while (v > reference * 1.5) v /= 2;
    return v;
  });

  const min = Math.min.apply(null, folded);
  const max = Math.max.apply(null, folded);
  const sorted = folded.slice().sort((x, z) => x - z);
  const mid = sorted.length >> 1;
  const median = sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
  const constant = max - min <= TEMPO_CONSTANT_TOLERANCE;

  return {
    // A steady track is best described by the whole-track tempogram, which has
    // every bar to work with; a drifting one by the median of its windows.
    bpm: Math.round(constant ? (overall || median) : median),
    mode: constant ? "constant" : "dynamic",
    min: Math.round(min * 10) / 10,
    max: Math.round(max * 10) / 10,
    windows,
  };
}

/* ------------------------------------------------------------------ */
/* Chroma + Krumhansl-Schmuckler key detection                         */
/* ------------------------------------------------------------------ */

/*
 * Key profiles: root and fifth at full weight, third slightly under.
 *
 * Every weighted profile from the literature -- Krumhansl-Schmuckler,
 * Temperley, the KeyFinder/Shaath weights -- measured worse than this on 165
 * real tracks labelled by Rekordbox. They encode how often each scale degree
 * appears in notated classical and pop music, which is not what a chroma of
 * loop-based dance music looks like: there the profile is dominated by a
 * bassline on the root and fifth plus a chord stab, and the finer weights are
 * noise. Scores on that set: this 94/165, Shaath 85, Krumhansl 84.
 */
const KEY_MAJOR_PROFILE = [1, 0, 0, 0, 1, 0, 0, 1, 0, 0, 0.3, 0];
const KEY_MINOR_PROFILE = [1, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0.3, 0];

/*
 * Preference for minor when the two readings are close.
 *
 * Tuned across 428 labelled tracks spanning four genres -- funky/disco house,
 * dubstep/bass, afro house and jersey club, 98 to 195 BPM -- so it is not a fit
 * to one shelf of the library. All four are around 90% minor, which is normal
 * for dance music.
 *
 * It has to be read honestly. Most of the gain comes from exploiting that base
 * rate rather than from telling the modes apart: major/minor discrimination
 * here is weak. 1.3 is the point where the detector predicts 31 major keys
 * against the 33 the sets actually contain, so it is calibrated rather than
 * degenerate -- pushing further would score higher only by refusing to call
 * anything major.
 *
 * A library that is not overwhelmingly minor should set this to 1.0.
 */
const KEY_MINOR_BIAS = 1.3;

const CAMELOT_MAJOR = { 0: "8B", 7: "9B", 2: "10B", 9: "11B", 4: "12B", 11: "1B", 6: "2B", 1: "3B", 8: "4B", 3: "5B", 10: "6B", 5: "7B" };
const CAMELOT_MINOR = { 9: "8A", 4: "9A", 11: "10A", 6: "11A", 1: "12A", 8: "1A", 3: "2A", 10: "3A", 5: "4A", 0: "5A", 7: "6A", 2: "7A" };

/*
 * Confidence gate, calibrated on 165 real tracks labelled by Rekordbox.
 *
 * Correct answers average 0.687 and wrong ones 0.492, so the score does carry
 * real information -- but the distributions overlap and no threshold separates
 * them cleanly. Measured trade-offs: 0.45 keeps 95 of 103 correct answers but
 * also waves through 15 of 27 wrong ones; 0.60 demotes 5 of 27 wrong answers
 * but sacrifices 32 correct ones.
 *
 * 0.50 sits at the knee: 90 of 103 correct answers are marked confident, and 19
 * of 27 wrong ones are demoted to a labelled guess. Nothing is discarded either
 * way -- detectKey always returns its best guess, and the caller shows a weak
 * one as "8A?".
 */
const KEY_MIN_CONFIDENCE = 0.50;

/*
 * Constant-Q geometry, settled by ablation against 165 real tracks labelled by
 * Rekordbox -- not against synthetic audio, which actively misled an earlier
 * pass here.
 *
 * The filterbank spans C1 to B6, but only the semitones from C3 upward are
 * folded into the chroma. Those two facts have to go together. Computing the
 * bank from C3 directly looks equivalent and is not: with no filters below it,
 * the lowest bin becomes a catch-all for every kick and bassline under 130 Hz,
 * and the chroma comes out with C dominant no matter what key the track is in.
 * That was measured -- G major and D# major both reported C as the loudest
 * pitch class. Analysing the low octaves and then discarding them throws that
 * energy away properly.
 *
 * One bin per semitone, raw magnitudes, per-frame normalized, mean over frames.
 * Every intuitive alternative measured worse on the real set.
 */
const CQT_FMIN = 32.703195662574829; // C1
const CQT_BINS_PER_SEMITONE = 1;
const CQT_BINS_PER_OCTAVE = 12 * CQT_BINS_PER_SEMITONE;
const CQT_OCTAVES = 6;
// Semitones below this index are analysed but excluded from the chroma: C3 is
// 24 semitones above C1.
const CHROMA_LOWEST_SEMITONE = 24;

/*
 * The signal is high-passed at C3 before the transform, on top of discarding
 * the low semitones afterwards. Both are needed and they do different jobs.
 *
 * Discarding bins stops sub-bass being *counted*; the high-pass stops it being
 * *heard* by the lowest surviving filter. Without the filter a 110 Hz A came
 * out as a C, because the C3 filter's skirt still responds well below its
 * centre and there is nothing below it to absorb the energy. On the 165-track
 * Rekordbox set the filter is worth 9 tracks: 103/165 with it, 94/165 without.
 */
const CHROMA_HIGHPASS_HZ = 130.8127826502993; // C3
const CQT_HOP = 4096;

let _cqtKernelCache = null;

/*
 * Direct time-domain constant-Q kernels, one complex exponential per semitone
 * windowed to a constant Q of 1/(2^(1/B)-1). Kernels are built once per sample
 * rate and reused across the batch.
 */
/*
 * Second-order Butterworth high-pass, run twice for a steeper skirt. Two
 * cascaded biquads are enough here: the aim is to keep kick and sub-bass out of
 * the lowest chroma filter, not to build a brick wall.
 */
function highPass(y, sr, cutoffHz) {
  let out = Float32Array.from(y);
  for (let pass = 0; pass < 2; pass++) {
    const w0 = (2 * Math.PI * cutoffHz) / sr;
    const cw = Math.cos(w0), sw = Math.sin(w0);
    const alpha = sw / (2 * 0.7071);
    const b0 = (1 + cw) / 2, b1 = -(1 + cw), b2 = (1 + cw) / 2;
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
  return out;
}

function buildCqtKernels(sr) {
  if (_cqtKernelCache && _cqtKernelCache.sr === sr) return _cqtKernelCache.kernels;
  const Q = 1.0 / (Math.pow(2, 1 / 12) - 1);
  const nBins = CQT_BINS_PER_OCTAVE * CQT_OCTAVES;
  const kernels = [];
  for (let k = 0; k < nBins; k++) {
    const freq = CQT_FMIN * Math.pow(2, k / CQT_BINS_PER_OCTAVE);
    if (freq >= sr / 2) break;
    const len = Math.max(4, Math.ceil((Q * sr) / freq));
    const cos = new Float32Array(len);
    const sin = new Float32Array(len);
    let wsum = 0;
    const w = new Float64Array(len);
    for (let i = 0; i < len; i++) {
      w[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / len);
      wsum += w[i];
    }
    if (wsum <= 0) wsum = 1;
    for (let i = 0; i < len; i++) {
      const phase = (2 * Math.PI * freq * i) / sr;
      const g = w[i] / wsum; // librosa's norm=1 filter normalization
      cos[i] = Math.cos(phase) * g;
      sin[i] = Math.sin(phase) * g;
    }
    kernels.push({ semitone: Math.floor(k / CQT_BINS_PER_SEMITONE), len, cos, sin });
  }
  _cqtKernelCache = { sr, kernels };
  return kernels;
}

/*
 * Mean chroma -> correlation against all 24 key profiles ->
 * all 24 keys -> Camelot code.
 *
 * Returns { key, confidence, confident }. The key is the best guess whether or
 * not it cleared the confidence gate; `confident` reports whether it did, so
 * callers can present a weak result as a guess instead of discarding it.
 */
function detectKey(rawY, sr, onProgress) {
  const y = highPass(rawY, sr, CHROMA_HIGHPASS_HZ);
  const kernels = buildCqtKernels(sr);
  if (kernels.length === 0) return { key: null, confidence: null, confident: false };

  const maxLen = kernels[0].len;
  const n = y.length;
  if (n < maxLen) return { key: null, confidence: null, confident: false };

  const semitones = new Float64Array(12 * CQT_OCTAVES);
  const frameChroma = new Float64Array(12);
  const perClassFrames = [];
  for (let i = 0; i < 12; i++) perClassFrames.push([]);

  for (let start = 0; start + maxLen <= n; start += CQT_HOP) {
    semitones.fill(0);
    for (let b = 0; b < kernels.length; b++) {
      const kern = kernels[b];
      // Centre each kernel inside the widest one so all bins describe the same
      // instant, the way a proper multi-resolution CQT does.
      const off = start + ((maxLen - kern.len) >> 1);
      let sumRe = 0;
      let sumIm = 0;
      const kc = kern.cos;
      const ks = kern.sin;
      for (let i = 0; i < kern.len; i++) {
        const s = y[off + i];
        sumRe += s * kc[i];
        sumIm += s * ks[i];
      }
      const magnitude = Math.hypot(sumRe, sumIm);
      const semitone = kern.semitone;
      if (magnitude > semitones[semitone]) semitones[semitone] = magnitude;
    }

    frameChroma.fill(0);
    for (let s = CHROMA_LOWEST_SEMITONE; s < semitones.length; s++) {
      frameChroma[(s - CHROMA_LOWEST_SEMITONE) % 12] += semitones[s];
    }

    // Normalized per frame, so a loud bar does not outweigh a quiet one. On
    // real tracks this measured better than leaving the frames raw.
    let peak = 0;
    for (let i = 0; i < 12; i++) if (frameChroma[i] > peak) peak = frameChroma[i];
    if (peak > 1e-20) {
      for (let i = 0; i < 12; i++) perClassFrames[i].push(frameChroma[i] / peak);
    }
    if (onProgress) onProgress(Math.min(1, start / Math.max(1, n - maxLen)));
  }

  if (perClassFrames[0].length === 0) return { key: null, confidence: null, confident: false };

  const chroma = new Float64Array(12);
  for (let i = 0; i < 12; i++) {
    let acc = 0;
    for (const v of perClassFrames[i]) acc += v;
    chroma[i] = acc / perClassFrames[i].length;
  }

  let allZero = true;
  for (let i = 0; i < 12; i++) if (chroma[i] !== 0) { allZero = false; break; }
  if (allZero) return { key: null, confidence: null, confident: false };

  let bestScore = -Infinity;
  let bestPitch = 0;
  let bestMode = "major";
  const rotated = new Float64Array(12);
  for (let shift = 0; shift < 12; shift++) {
    for (let i = 0; i < 12; i++) rotated[i] = chroma[(i + shift) % 12]; // np.roll(chroma, -shift)
    const majorScore = pearson(rotated, KEY_MAJOR_PROFILE);
    const minorScore = pearson(rotated, KEY_MINOR_PROFILE) * KEY_MINOR_BIAS;
    if (Number.isFinite(majorScore) && majorScore > bestScore) {
      bestScore = majorScore; bestPitch = shift; bestMode = "major";
    }
    if (Number.isFinite(minorScore) && minorScore > bestScore) {
      bestScore = minorScore; bestPitch = shift; bestMode = "minor";
    }
  }

  /*
   * The best guess is always returned, with `confident` saying whether it
   * cleared the gate. Reporting nothing at all throws away real information:
   * for a DJ checking a set, "probably 8A" is worth having, and a guess that is
   * labelled as a guess costs far less than a blank field.
   */
  const confidence = Math.round(bestScore * 1000) / 1000;
  const table = bestMode === "major" ? CAMELOT_MAJOR : CAMELOT_MINOR;
  return {
    key: table[bestPitch] || null,
    confidence,
    confident: bestScore >= KEY_MIN_CONFIDENCE,
  };
}

function pearson(a, b) {
  const n = a.length;
  let ma = 0;
  let mb = 0;
  for (let i = 0; i < n; i++) { ma += a[i]; mb += b[i]; }
  ma /= n; mb /= n;
  let num = 0;
  let da = 0;
  let db = 0;
  for (let i = 0; i < n; i++) {
    const xa = a[i] - ma;
    const xb = b[i] - mb;
    num += xa * xb;
    da += xa * xa;
    db += xb * xb;
  }
  const den = Math.sqrt(da * db);
  return den === 0 ? NaN : num / den;
}

/* ------------------------------------------------------------------ */
/* Nearest-centroid genre classification                               */
/* ------------------------------------------------------------------ */

// Verbatim from the Python version -- these are hand-tuned reference points,
// not a trained model, so they port across exactly.
const GENRE_CENTROIDS = {
  "Hip-Hop": { tempo: 90, centroid: 2200, bandwidth: 2200, zcr: 0.07 },
  Electronic: { tempo: 135, centroid: 3100, bandwidth: 2600, zcr: 0.13 },
  Rock: { tempo: 130, centroid: 2600, bandwidth: 2500, zcr: 0.11 },
  Pop: { tempo: 105, centroid: 2300, bandwidth: 2300, zcr: 0.09 },
  Jazz: { tempo: 110, centroid: 1900, bandwidth: 1900, zcr: 0.05 },
  Classical: { tempo: 90, centroid: 1500, bandwidth: 1600, zcr: 0.03 },
};
const GENRE_FEATURE_SCALES = { tempo: 40, centroid: 700, bandwidth: 600, zcr: 0.05 };

function classifyByCentroid(features) {
  let bestGenre = "Unknown";
  let bestDistance = Infinity;
  for (const genre of Object.keys(GENRE_CENTROIDS)) {
    const centroid = GENRE_CENTROIDS[genre];
    let distance = 0;
    for (const key of Object.keys(centroid)) {
      const d = (features[key] - centroid[key]) / GENRE_FEATURE_SCALES[key];
      distance += d * d;
    }
    if (distance < bestDistance) {
      bestDistance = distance;
      bestGenre = genre;
    }
  }
  return { genre: bestGenre, distance: bestDistance };
}
