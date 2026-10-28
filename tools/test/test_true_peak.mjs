/*
 * Checks the true peak in web/js/loudness.js against the slow way: every
 * position, every phase, no skipping. The fast one may only skip work, never
 * change an answer, so the two must agree to the last bit.
 *
 * The signals are the ones where skipping goes wrong: a peak between samples,
 * a loud ending after a long quiet stretch (the order in which positions are
 * visited), a peak at the very first and last samples (the edge path), a peak
 * in the second channel, and a window built so that most of the interpolated
 * value comes from the far taps, which the four-tap pre-check has to bound
 * rather than see.
 *
 *   node tools/test/test_true_peak.mjs
 */
import { readFileSync } from "node:fs";

const results = [];
const check = (label, cond) => results.push(`  ${cond ? "OK  " : "МИМО"} ${label}`);

const lib = new Function("WORKER_VERSION", readFileSync("web/js/loudness.js", "utf8")
  + "return { truePeakDb, truePeakKernels, TRUE_PEAK_HALF_TAPS, TRUE_PEAK_CENTRAL_TAPS };")("test");

// The scan as it was before any skipping: each phase summed over all taps in
// tap order, with out-of-range taps left out.
function slowTruePeakDb(channels) {
  const phases = lib.truePeakKernels(), half = lib.TRUE_PEAK_HALF_TAPS, taps = 2 * half + 1;
  let peak = 0;
  for (const data of channels) {
    for (let i = 0; i < data.length; i++) {
      peak = Math.max(peak, Math.abs(data[i]));
      for (let p = 1; p < phases.length; p++) {
        let acc = 0;
        for (let k = 0; k < taps; k++) {
          const idx = i + k - half;
          if (idx >= 0 && idx < data.length) acc += data[idx] * phases[p][k];
        }
        peak = Math.max(peak, Math.abs(acc));
      }
    }
  }
  return peak > 0 ? 20 * Math.log10(peak) : -120.0;
}

let seed = 5;
const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff - 0.5; };
const same = (label, channels) => {
  const fast = lib.truePeakDb(channels), slow = slowTruePeakDb(channels);
  check(`${label}: ${fast.toFixed(4)} дБ`, fast === slow);
  return fast;
};

// A quarter-rate sine sampled 45° off its crests: every sample is at 0.707 and
// the waveform peaks at 1.0 between them, 3 dB above the sample peak. The
// interpolator itself overshoots by about 0.1 dB at this frequency.
const sine = Float32Array.from({ length: 4000 }, (_, i) => Math.sin(Math.PI / 2 * i + Math.PI / 4));
const tp = same("пик между отсчётами", [sine]);
check("и он на 3 дБ выше пика отсчётов", tp > -0.05 && tp < 0.2);

// A minute of quiet noise, then a loud second: the loud part decides.
const late = Float32Array.from({ length: 44100 * 61 }, (_, i) => rnd() * (i > 44100 * 60 ? 1.6 : 0.05));
same("громкий конец после тихой минуты", [late]);

// Peaks within the first and last few samples, where the window runs off the edge.
const edges = Float32Array.from({ length: 3000 }, () => rnd() * 0.1);
edges.set([0.9, -0.9, 0.9], 0);
edges.set([-0.95, 0.95, -0.95], edges.length - 3);
same("пик у самого начала и конца", [edges]);

// Second channel louder than the first.
same("пик во втором канале", [Float32Array.from({ length: 20000 }, () => rnd() * 0.3), Float32Array.from(sine.subarray(0, 3000), (x) => x * 0.9)]);

// One window whose far taps carry the sign of the kernel and whose near taps
// are small: the four near taps alone stay under the sample peak, the whole
// sum does not. Without the far taps' bound this window would be skipped.
{
  const phases = lib.truePeakKernels(), half = lib.TRUE_PEAK_HALF_TAPS, near = lib.TRUE_PEAK_CENTRAL_TAPS / 2;
  const kernel = phases[2];
  const sig = Float32Array.from({ length: 2000 }, () => rnd() * 0.01);
  const at = 1000;
  for (let k = 0; k < kernel.length; k++) {
    const far = k < half - near + 1 || k > half + near;
    sig[at - half + k] = Math.sign(kernel[k]) * (far ? 1 : 0.35);
  }
  let nearSum = 0, full = 0;
  for (let k = 0; k < kernel.length; k++) {
    full += sig[at - half + k] * kernel[k];
    if (k >= half - near + 1 && k <= half + near) nearSum += sig[at - half + k] * kernel[k];
  }
  check(`окно собрано как задумано (ближние ${nearSum.toFixed(2)} < 1 < всё ${full.toFixed(2)})`, Math.abs(nearSum) < 1 && full > 1);
  same("пик, набранный дальними отсчётами окна", [sig]);
}

same("клиппированный шум", [Float32Array.from({ length: 50000 }, () => Math.max(-0.8, Math.min(0.8, rnd() * 3)))]);
check("тишина: -120 дБ", lib.truePeakDb([new Float32Array(1000)]) === -120 && lib.truePeakDb([new Float32Array(0)]) === -120);

console.log(results.join("\n"));
console.log(`\n  пройдено ${results.filter((x) => x.startsWith("  OK")).length}/${results.length}`);
