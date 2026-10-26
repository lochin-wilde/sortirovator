/*
 * Checks the key-detector variants kept under tools/measure/key_variants/:
 * each still applies to the current dsp.js, and the parts that compute
 * something do it correctly. A variant that drifted from dsp.js would make a
 * later re-measurement fail loudly; one that computed wrongly would have made
 * its recorded result meaningless.
 *
 *   node tools/test/test_key_variants.mjs
 */
import { readFileSync, readdirSync } from "node:fs";
import { patchSource } from "../measure/lib/measure.mjs";

const results = [];
const check = (label, cond) => results.push(`  ${cond ? "OK  " : "МИМО"} ${label}`);

const source = readFileSync("web/js/dsp.js", "utf8");
const variants = {};
for (const f of readdirSync("tools/measure/key_variants").filter((f) => f.endsWith(".mjs")).sort()) {
  const patches = (await import(`../measure/key_variants/${f}`)).default;
  let ok = true;
  try { patchSource(source, patches); } catch { ok = false; }
  check(`${f} применяется к текущему dsp.js`, ok);
  variants[f] = patches;
}

/* ---------- tuning.mjs ---------- */

{
  const dsp = new Function(patchSource(source, variants["tuning.mjs"])
    + "return { estimateTuningCents, detectKey };")();
  const sr = 22050;
  // A chord with four harmonics per note, `cents` off A = 440.
  const chord = (cents, notes, seconds = 10) => {
    const y = new Float32Array(sr * seconds);
    for (const midi of notes) {
      const f = 440 * Math.pow(2, (midi - 69 + cents / 100) / 12);
      for (let h = 1; h <= 4; h++) {
        for (let i = 0; i < y.length; i++) y[i] += Math.sin((2 * Math.PI * f * h * i) / sr) / (h * notes.length);
      }
    }
    return y;
  };
  for (const cents of [0, 17, -33, 45]) {
    const est = dsp.estimateTuningCents(chord(cents, [57, 60, 64]), sr);
    check(`строй ${cents} центов оценён как ${est.toFixed(1)} (±2)`, Math.abs(est - cents) <= 2);
  }
  {
    // +49 and -49 are two cents apart on the circle, not 98.
    const est = dsp.estimateTuningCents(chord(-49, [57, 60, 64]), sr);
    check(`-49 центов не путается с серединой (${est.toFixed(1)})`, Math.abs(Math.abs(est) - 49) <= 2);
  }
  check("тишина — 0 центов, а не случайное число", dsp.estimateTuningCents(new Float32Array(sr * 3), sr) === 0);
  check("ля минор на -45 центов всё ещё 8A", dsp.detectKey(chord(-45, [45, 57, 60, 64, 69, 72]), sr).key === "8A");
}

/* ---------- hpss.mjs ---------- */

{
  const dsp = new Function(patchSource(source, variants["hpss.mjs"])
    + "return { harmonicPart, detectKey };")();
  // 20 frames x 24 bins: a steady note in bin 5, and in frame 10 a click in
  // every bin.
  const frames = Array.from({ length: 20 }, (_, t) =>
    Float64Array.from({ length: 24 }, (_, b) => (b === 5 ? 1 : 0) + (t === 10 ? 1 : 0)));
  const out = dsp.harmonicPart(frames, 9, 7);
  check(`устойчивая нота остаётся (${out[3][5].toFixed(2)})`, out[3][5] > 0.95);
  check(`щелчок по всем частотам убран (${out[10][15].toFixed(2)})`, out[10][15] < 0.05);
  check(`нота в кадре со щелчком не потеряна (${out[10][5].toFixed(2)})`, out[10][5] > 0.3);
  check("форма не меняется", out.length === 20 && out.every((r) => r.length === 24));
  check("пустой вход -> пустой выход", dsp.harmonicPart([], 9, 7).length === 0);

  const sr = 22050;
  // A minor, with a broadband click every half second on top.
  const y = new Float32Array(sr * 12);
  for (const midi of [45, 57, 60, 64]) {
    const f = 440 * Math.pow(2, (midi - 69) / 12);
    for (let i = 0; i < y.length; i++) y[i] += 0.2 * Math.sin((2 * Math.PI * f * i) / sr);
  }
  for (let k = 0; k < y.length; k += sr / 2) for (let i = 0; i < 200 && k + i < y.length; i++) y[k + i] += (i % 2 ? 1 : -1) * (1 - i / 200);
  check("ля минор со щелчками -> 8A", dsp.detectKey(y, sr).key === "8A");
}

/* ---------- report ---------- */

const failed = results.filter((line) => line.includes("МИМО"));
console.log(results.join("\n"));
console.log(`\nпройдено ${results.length - failed.length}/${results.length}`);
process.exit(failed.length > 0 ? 1 : 0);
