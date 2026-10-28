/*
 * Checks how tools/measure/compare_beat_this.mjs turns a beat tracker's beats
 * into a constant grid (fitGrid), on beats shaped like the ones Beat This!
 * returns: on a 20 ms frame grid, with a silent stretch where it reports
 * nothing, and a stretch where it slips onto the off-beat. The two fits tried
 * before this one each failed on one of those; this test is what they fail.
 *
 *   node tools/test/test_beat_this_fit.mjs
 */
import { fitGrid, toOctave } from "../measure/compare_beat_this.mjs";

const results = [];
const check = (label, cond) => results.push(`  ${cond ? "OK  " : "МИМО"} ${label}`);

const BPM = 128, FIRST = 0.31, PERIOD = 60 / BPM;
const frame = (t) => Math.round(t / 0.02) * 0.02;
// Beat circular distance from the true grid, in ms.
const phaseError = (g) => {
  const r = (((g.firstBeat - FIRST) % PERIOD) + PERIOD) % PERIOD;
  return Math.min(r, PERIOD - r) * 1000;
};

{
  const beats = Array.from({ length: 400 }, (_, i) => frame(FIRST + i * PERIOD));
  const g = fitGrid(beats);
  check(`ровные доли на сетке 20 мс: ${g.bpm.toFixed(3)} BPM`, Math.abs(g.bpm - BPM) < 0.02 && phaseError(g) < 10);
}
{
  // A 32-beat breakdown with no beats, then 32 beats on the off-beat.
  const beats = [];
  for (let i = 0; i < 400; i++) {
    if (i >= 100 && i < 132) continue;
    beats.push(frame(FIRST + i * PERIOD + (i >= 200 && i < 232 ? PERIOD / 2 : 0)));
  }
  const g = fitGrid(beats);
  check(`пропуск в брейке и уход в слабую долю: ${g.bpm.toFixed(3)} BPM, фаза ±${phaseError(g).toFixed(1)} мс`,
    Math.abs(g.bpm - BPM) < 0.02 && phaseError(g) < 10);
}
{
  // A long stretch a third of a beat late: a mean over every beat is pulled
  // toward it, a mean over the beats on the grid is not.
  const beats = Array.from({ length: 400 }, (_, i) => frame(FIRST + i * PERIOD + (i >= 150 && i < 250 ? PERIOD / 3 : 0)));
  const g = fitGrid(beats);
  check(`сотня долей на треть доли позже: фаза ±${phaseError(g).toFixed(1)} мс`, Math.abs(g.bpm - BPM) < 0.02 && phaseError(g) < 10);
}
check("меньше восьми долей — сетки нет", fitGrid([0.1, 0.5, 0.9]) === null);

check("трекер считал через долю (64 при наших 128) — период вдвое короче", Math.abs(toOctave(60 / 64, 128) - 60 / 128) < 1e-12);
check("трекер считал полдоли (256 при наших 128) — период вдвое длиннее", Math.abs(toOctave(60 / 256, 128) - 60 / 128) < 1e-12);
check("та же октава — период не трогаем", toOctave(60 / 127.9, 128) === 60 / 127.9);

console.log(results.join("\n"));
console.log(`\n  пройдено ${results.filter((x) => x.startsWith("  OK")).length}/${results.length}`);
