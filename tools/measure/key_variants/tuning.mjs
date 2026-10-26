/*
 * Variant: estimate the track's tuning and shift the constant-Q filters to
 * match before folding them into chroma.
 *
 * A track mastered at A = 446 Hz, or a vinyl rip played a little fast, puts
 * every note about a quarter-tone off the 440 Hz grid the filters sit on, and
 * energy that belongs to one pitch class leaks into its neighbour.
 *
 * The estimate: spectral peaks between C3 and C7, each placed by parabolic
 * interpolation on log magnitude, its offset from the nearest equal-tempered
 * pitch taken in cents (-50..+50) and averaged on a circle weighted by peak
 * magnitude -- so a track at +49 and one at -49 are seen as neighbours, not
 * opposites. Essentia and librosa estimate tuning the same way in spirit.
 *
 *   node tools/measure/measure_key.mjs --patch tools/measure/key_variants/tuning.mjs
 *
 * Result, 2026-10-26: rejected. Exact matches, fixed/broken against the
 * shipped detector: GiantSteps 8/16 (p = 0.15), library held-out half 37/46
 * (p = 0.38). Not even the tracks the estimate calls detuned gained: of those
 * more than 15 cents off, GiantSteps fixed 4 and broke 8, a 900-track library
 * sample 9 and 9. They are fewer than one in seven, and they do score worse
 * (about 40% exact against 60-74%), but tuning is not why -- a large estimated
 * offset mostly marks a spectrum with little stable pitch in it. One filter per
 * semitone is already wide enough to absorb a quarter-tone.
 */
export const TUNING_CODE = `
const TUNING_FFT = 8192;
const TUNING_HOP = 8192;
const TUNING_MIN_HZ = 130.8127826502993; // C3, the bottom of the chroma
const TUNING_MAX_HZ = 2093.004522404789; // C7
// Peaks under this share of the frame's loudest are noise for this purpose.
const TUNING_PEAK_FLOOR = 0.1;

/*
 * Offset of the track from A = 440 Hz equal temperament, in cents, -50..+50.
 * 0 when there is nothing to measure.
 */
function estimateTuningCents(y, sr) {
  const n = TUNING_FFT;
  const fft = getFFT(n);
  const window = hannPeriodic(n);
  const re = new Float64Array(n);
  const im = new Float64Array(n);
  const mag = new Float64Array(n >> 1);
  const lo = Math.max(2, Math.floor((TUNING_MIN_HZ * n) / sr));
  const hi = Math.min((n >> 1) - 2, Math.ceil((TUNING_MAX_HZ * n) / sr));
  let sx = 0;
  let sy = 0;
  for (let start = 0; start + n <= y.length; start += TUNING_HOP) {
    for (let i = 0; i < n; i++) { re[i] = y[start + i] * window[i]; im[i] = 0; }
    fft.transform(re, im, false);
    let peak = 0;
    for (let k = lo - 1; k <= hi + 1; k++) {
      mag[k] = Math.hypot(re[k], im[k]);
      if (mag[k] > peak) peak = mag[k];
    }
    if (peak <= 0) continue;
    for (let k = lo; k <= hi; k++) {
      const b = mag[k];
      if (b < peak * TUNING_PEAK_FLOOR || b <= mag[k - 1] || b < mag[k + 1]) continue;
      const a = Math.log(mag[k - 1] + 1e-20);
      const lb = Math.log(b + 1e-20);
      const c = Math.log(mag[k + 1] + 1e-20);
      const denom = a - 2 * lb + c;
      const delta = denom < 0 ? (0.5 * (a - c)) / denom : 0;
      const freq = ((k + delta) * sr) / n;
      const cents = 1200 * Math.log2(freq / 440);
      const off = cents - 100 * Math.round(cents / 100);
      const angle = (2 * Math.PI * off) / 100;
      sx += b * Math.cos(angle);
      sy += b * Math.sin(angle);
    }
  }
  if (sx === 0 && sy === 0) return 0;
  return (100 * Math.atan2(sy, sx)) / (2 * Math.PI);
}

function buildCqtKernels(sr, fmin = CQT_FMIN) {
  if (_cqtKernelCache && _cqtKernelCache.sr === sr && _cqtKernelCache.fmin === fmin) return _cqtKernelCache.kernels;`;

export default [
  ["function buildCqtKernels(sr) {\n  if (_cqtKernelCache && _cqtKernelCache.sr === sr) return _cqtKernelCache.kernels;", TUNING_CODE],
  ["const freq = CQT_FMIN * Math.pow(2, k / CQT_BINS_PER_OCTAVE);", "const freq = fmin * Math.pow(2, k / CQT_BINS_PER_OCTAVE);"],
  ["_cqtKernelCache = { sr, kernels };", "_cqtKernelCache = { sr, fmin, kernels };"],
  ["const kernels = buildCqtKernels(sr);", "const kernels = buildCqtKernels(sr, CQT_FMIN * Math.pow(2, estimateTuningCents(y, sr) / 1200));"],
];
