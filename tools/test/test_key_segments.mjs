/*
 * Checks the segment voting used to test the Mixed In Key idea. A slip in
 * how blocks are grouped or how votes are weighted would credit or blame the
 * idea for something it does not do.
 *
 *   node tools/test/test_key_segments.mjs
 */
import { readFileSync } from "node:fs";
import { segmentsFromBlocks, keyScores, vote } from "../measure/try_key_segments.mjs";

const results = [];
const check = (label, cond) => results.push(`  ${cond ? "OK  " : "МИМО"} ${label}`);

const dsp = new Function(readFileSync("web/js/dsp.js", "utf8")
  + "return { pearson, KEY_MAJOR_PROFILE, KEY_MINOR_PROFILE, KEY_MINOR_BIAS };")();
const profile = { major: dsp.KEY_MAJOR_PROFILE, minor: dsp.KEY_MINOR_PROFILE };
const scores = (chroma) => keyScores(chroma, profile, dsp.KEY_MINOR_BIAS, dsp.pearson);
const chord = (...pcs) => Array.from({ length: 12 }, (_, i) => (pcs.includes(i) ? 1 : 0.05));
const block = (chroma, n = 27) => ({ n, chroma });

/* ---------- Grouping blocks ---------- */

{
  const blocks = [block(chord(0, 4, 7), 10), block(chord(9, 0, 4), 30)];
  const [whole] = segmentsFromBlocks(blocks, 2);
  check("сегмент — среднее с весом по числу кадров", whole.n === 40
    && Math.abs(whole.chroma[9] - (10 * 0.05 + 30 * 1) / 40) < 1e-12);
}
{
  const blocks = Array.from({ length: 7 }, () => block(chord(0)));
  const segs = segmentsFromBlocks(blocks, 3);
  check(`7 кусков по 3 -> 2 сегмента, короткий хвост приклеен (${segs.map((s) => s.n / 27).join("+")})`,
    segs.length === 2 && segs[1].n === 4 * 27);
}
{
  const segs = segmentsFromBlocks(Array.from({ length: 8 }, () => block(chord(0))), 3);
  check("хвост из половины сегмента и больше голосует сам", segs.length === 3 && segs[2].n === 2 * 27);
}
check("один кусок — один сегмент", segmentsFromBlocks([block(chord(0))], 4).length === 1);

/* ---------- Scores ---------- */

{
  const s = scores(chord(9, 0, 4)); // A minor
  const best = s.indexOf(Math.max(...s));
  check(`ля минор: лучший индекс 12 + 9 (${best})`, best === 21);
  check("плоская хрома -> -Infinity, а не NaN", scores(new Array(12).fill(1)).every((v) => v === -Infinity));
}

/* ---------- Voting ---------- */

const A_MIN = scores(chord(9, 0, 4));
const E_MIN = scores(chord(4, 7, 11));
const FLAT = scores(new Array(12).fill(1));
const C_MAJ_WEAK = scores(chord(0, 4, 7, 1, 3, 6, 8, 10)); // C major buried in noise

check("большинство решает: 2 ля минора против 1 ми минора", vote([A_MIN, A_MIN, E_MIN], "count", 4) === 21);
check("ничья уходит к ответу по всему треку", vote([A_MIN, E_MIN], "count", 16) === 16 && vote([A_MIN, E_MIN], "count", 21) === 21);
check("плоские сегменты не голосуют", vote([FLAT, FLAT, E_MIN], "count", 21) === 16);
check("все плоские -> ответ по треку, а не выдуманная тональность", vote([FLAT, FLAT], "soft", -1) === -1 && vote([FLAT], "count", 5) === 5);
{
  // Two noisy segments for C major, one clean A minor: with weights by margin
  // the clean one should outvote them; with plain counting it must not.
  const noisy = [C_MAJ_WEAK, C_MAJ_WEAK, A_MIN];
  const marginOf = (s) => { const t = [...s].sort((a, b) => b - a); return t[0] - t[1]; };
  const cleanWins = marginOf(A_MIN) > 2 * marginOf(C_MAJ_WEAK);
  check("по числу голосов шум побеждает", vote(noisy, "count", -1) !== 21);
  check(`по отрыву чистый сегмент перевешивает шум (${cleanWins ? "отрыв чистого больше" : "условие теста не выполнено"})`,
    cleanWins && vote(noisy, "margin", -1) === 21);
}
check("мягкое голосование складывает все 24 оценки", vote([A_MIN, A_MIN], "soft", -1) === 21);

/* ---------- report ---------- */

const failed = results.filter((line) => line.includes("МИМО"));
console.log(results.join("\n"));
console.log(`\nпройдено ${results.length - failed.length}/${results.length}`);
process.exit(failed.length > 0 ? 1 : 0);
