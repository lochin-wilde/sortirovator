/*
 * Checks the downbeat (web/js/downbeat.js) and how it is measured
 * (tools/measure/measure_downbeat.mjs).
 *
 * Whether it finds the bar on real music is the measurement's question. Here
 * a synthetic track whose chords change on every fourth beat, starting from
 * the third, must come back with the third beat as the downbeat -- not the
 * first, which is what a grid says without this.
 *
 *   node tools/test/test_downbeat.mjs
 */
import { readFileSync } from "node:fs";
import { downbeatLabel, fitDownbeat, phaseScores } from "../measure/measure_downbeat.mjs";

const results = [];
const check = (label, cond) => results.push(`  ${cond ? "OK  " : "МИМО"} ${label}`);

const dsp = new Function(readFileSync("web/js/dsp.js", "utf8") + readFileSync("web/js/downbeat.js", "utf8")
  + "return { beatSyncFeatures, downbeatCandidates, estimateDownbeat, DOWNBEAT_WEIGHTS };")();

/* ---------- Labels from Rekordbox's count ---------- */

const ms = Array.from({ length: 64 }, (_, i) => 100 + i * 500);
check("первая доля Rekordbox — «1», наша на ней: фаза 0", downbeatLabel(100, ms, 1) === 0);
check("наша первая доля — «2» у Rekordbox: такт с нашей 4-й (фаза 3)", downbeatLabel(600, ms, 1) === 3);
check("Rekordbox начинает с «3»: такт с нашей 3-й (фаза 2)", downbeatLabel(100, ms, 3) === 2);
check("сдвиг в 40 мс ещё та же доля", downbeatLabel(140, ms, 1) === 0);
check("мимо долей Rekordbox больше 70 мс — без метки", downbeatLabel(350, ms, 1) === null);

/* ---------- Fitting ---------- */

{
  // Feature 0 is high on the true phase; the rest is noise.
  let seed = 3;
  const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff - 0.5; };
  const rows = Array.from({ length: 200 }, (_, i) => {
    const label = i % 4;
    return { label, candidates: [0, 1, 2, 3].map((p) => [p === label ? 1 + rnd() : rnd(), rnd()]) };
  });
  const w = fitDownbeat(rows, { iterations: 500 });
  const right = rows.filter((r) => phaseScores(r.candidates, w).indexOf(Math.max(...phaseScores(r.candidates, w))) === r.label).length;
  check(`обучение находит признак, который отличает фазу (${right}/200)`, w[0] > 1 && right > 180);
}

/* ---------- Synthetic track ---------- */

const sr = 44100;
const bpm = 128;
const period = 60 / bpm;
const first = 0.2;
const CHORDS = [[220, 277.18, 329.63], [174.61, 220, 261.63], [196, 246.94, 293.66], [164.81, 207.65, 246.94]];
function track(seconds, downbeatPhase) {
  const y = new Float32Array(sr * seconds);
  for (let k = 0; first + k * period < seconds; k++) {
    const t0 = first + k * period;
    const start = Math.round(t0 * sr);
    const bar = Math.floor((k - downbeatPhase + 4) / 4);
    const chord = CHORDS[((bar % 4) + 4) % 4];
    for (let i = 0; i < period * sr && start + i < y.length; i++) {
      const t = i / sr;
      let v = 0.7 * Math.sin(2 * Math.PI * (50 + 80 * Math.exp(-t / 0.02)) * t) * Math.exp(-t / 0.08);
      for (const f of chord) v += 0.12 * Math.sin(2 * Math.PI * f * (t0 + t));
      y[start + i] += v;
    }
  }
  return y;
}

{
  const beats = dsp.beatSyncFeatures(track(40, 2), sr, bpm, first);
  check(`доли по сетке: ${beats.length} целых долей в 40 с`, beats.length >= 80 && beats.length <= 86);
  const c = dsp.downbeatCandidates(beats);
  const barChroma = c.map((x) => x[6]);
  check(`смена аккорда за такт сильнее всего у фазы 2 (${barChroma.map((v) => v.toFixed(2))})`, barChroma.indexOf(Math.max(...barChroma)) === 2);
  check("слишком коротко — без признаков", dsp.downbeatCandidates(dsp.beatSyncFeatures(track(8, 0), sr, bpm, first)) === null);
}
{
  const none = dsp.estimateDownbeat(track(40, 2), sr, bpm, first, null);
  check("без модели — фаза 0, как раньше", none.phase === 0);
  if (dsp.DOWNBEAT_WEIGHTS) {
    const got = dsp.estimateDownbeat(track(40, 2), sr, bpm, first);
    check(`с обученной моделью — такт с 3-й доли (фаза ${got.phase}, ${got.probs})`, got.phase === 2);
    const plain = dsp.estimateDownbeat(track(40, 0), sr, bpm, first);
    check(`аккорды с первой доли — фаза 0 (фаза ${plain.phase})`, plain.phase === 0);
  }
}

/* ---------- report ---------- */

const failed = results.filter((line) => line.includes("МИМО"));
console.log(results.join("\n"));
console.log(`\nпройдено ${results.length - failed.length}/${results.length}`);
process.exit(failed.length > 0 ? 1 : 0);
