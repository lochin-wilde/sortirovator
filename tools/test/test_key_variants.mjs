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

/* ---------- report ---------- */

const failed = results.filter((line) => line.includes("МИМО"));
console.log(results.join("\n"));
console.log(`\nпройдено ${results.length - failed.length}/${results.length}`);
process.exit(failed.length > 0 ? 1 : 0);
