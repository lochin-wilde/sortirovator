/*
 * Checks the paired FFT in web/js/dsp.js: two real frames through one complex
 * transform (forEachSpectrum, and the tempogram's forward and inverse pair).
 *
 * Every spectrum it hands out is compared with the same frame transformed on
 * its own, the slow way. An odd number of frames leaves the last one without a
 * partner, which is where a pairing most easily drops or doubles a frame; a
 * silent frame next to a loud one shows how much of one leaks into the other.
 *
 *   node tools/test/test_spectra.mjs
 */
import { readFileSync } from "node:fs";

const results = [];
const check = (label, cond) => results.push(`  ${cond ? "OK  " : "МИМО"} ${label}`);

const dsp = new Function(readFileSync("web/js/dsp.js", "utf8")
  + "return { forEachSpectrum, getFFT, hannPeriodic, tempogramRanges };")();

let seed = 11;
const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff - 0.5; };

/* ---------- forEachSpectrum ---------- */
{
  const n = 256, top = 100;
  // Seven frames, so the last has no partner; frame 3 is silent, frame 2 loud.
  const frames = Array.from({ length: 7 }, (_, t) => Float64Array.from({ length: n }, () => (t === 3 ? 0 : t === 2 ? 1000 * rnd() : rnd())));
  const direct = frames.map((f) => {
    const re = Float64Array.from(f), im = new Float64Array(n);
    dsp.getFFT(n).transform(re, im, false);
    return { re: re.slice(0, top + 1), im: im.slice(0, top + 1) };
  });
  const seen = [];
  let worst = 0, silentLeak = 0;
  dsp.forEachSpectrum(frames.length, n, top, (t, out) => out.set(frames[t]), (t, re, im) => {
    seen.push(t);
    if (!direct[t]) return;
    for (let k = 0; k <= top; k++) {
      const err = Math.hypot(re[k] - direct[t].re[k], im[k] - direct[t].im[k]);
      if (t === 3) silentLeak = Math.max(silentLeak, err);
      else worst = Math.max(worst, err / Math.max(1e-300, Math.hypot(direct[t].re[k], direct[t].im[k]) + 1));
    }
  });
  check(`каждый кадр по разу и по порядку (${seen.join(",")})`, seen.join(",") === "0,1,2,3,4,5,6");
  check(`спектры совпадают с поштучным БПФ (отклонение ${worst.toExponential(1)})`, worst < 1e-12);
  check(`в тихий кадр рядом с громким почти ничего не протекает (${silentLeak.toExponential(1)})`, silentLeak < 1e-9);
}

/* ---------- Tempogram ---------- */
{
  // The tempogram as it was computed one frame at a time.
  const slow = (env, winLength, ranges) => {
    const n = env.length, w = dsp.hannPeriodic(winLength), pad = winLength >> 1;
    const padded = new Float64Array(n + 2 * pad);
    for (let i = 0; i < pad; i++) padded[i] = env[0] * (pad > 1 ? i / (pad - 1) : 1);
    padded.set(env, pad);
    for (let i = 0; i < pad; i++) padded[pad + n + i] = env[n - 1] * (pad > 1 ? 1 - i / (pad - 1) : 1);
    let size = 1;
    while (size < winLength * 2) size <<= 1;
    const fft = dsp.getFFT(size), re = new Float64Array(size), im = new Float64Array(size);
    const acc = ranges.map(() => new Float64Array(winLength)), counts = ranges.map(() => 0);
    for (let t = 0; t < n; t++) {
      re.fill(0); im.fill(0);
      for (let i = 0; i < winLength; i++) re[i] = padded[t + i] * w[i];
      fft.transform(re, im, false);
      for (let k = 0; k < size; k++) { re[k] = re[k] * re[k] + im[k] * im[k]; im[k] = 0; }
      fft.transform(re, im, true);
      const ac = new Float64Array(winLength);
      let peak = 0;
      for (let k = 0; k < winLength; k++) { ac[k] = (re[k] + (k ? re[winLength - k] : 0)) / size; peak = Math.max(peak, Math.abs(ac[k])); }
      if (peak > 1e-20) ranges.forEach(([a, b], r) => { if (t >= a && t < b) { for (let k = 0; k < winLength; k++) acc[r][k] += ac[k] / peak; counts[r]++; } });
    }
    return acc.map((a, r) => (counts[r] ? a.map((v) => v / Math.max(1, ranges[r][1] - ranges[r][0])) : null));
  };
  const env = Float64Array.from({ length: 301 }, (_, t) => Math.max(0, rnd() + (t % 24 === 0 ? 2 : 0)));
  const ranges = [[0, 301], [40, 141], [150, 151]];
  const want = slow(env, 96, ranges), got = dsp.tempogramRanges(env, 22050, 512, 96, ranges);
  let worst = 0;
  for (let r = 0; r < ranges.length; r++) for (let k = 0; k < 96; k++) worst = Math.max(worst, Math.abs(got[r][k] - want[r][k]));
  check(`темпограмма парами совпадает с покадровой, 301 кадр (отклонение ${worst.toExponential(1)})`, worst < 1e-12);
  check("окно из одного кадра считается, а не теряется", got[2] !== null && Math.abs(got[2][0] - 1) < 1e-12);
}

console.log(results.join("\n"));
console.log(`\n  пройдено ${results.filter((x) => x.startsWith("  OK")).length}/${results.length}`);
