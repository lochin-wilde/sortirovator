/*
 * Checks the beat grid (web/js/beatgrid.js) and the measures it is judged by
 * (tools/measure/measure_grid.mjs).
 *
 * Synthetic audio cannot say whether the grid is good on real music -- the
 * measurement against Rekordbox does that -- but it can say whether the
 * arithmetic is right: a track built at a known tempo and phase must come
 * back at that tempo and phase, and an off-beat that is louder than the beat
 * in the treble must not pull the grid half a beat out. The decisions on top
 * (gridDecision) are checked for direction: sharper bars, or the beat's shape,
 * half a beat later move the grid there, and a moving tempo lowers the
 * confidence. The tempo
 * refined over the whole track must find a tempo the first two minutes
 * cannot tell apart, and leave the phase where those two minutes put it.
 *
 *   node tools/test/test_beatgrid.mjs
 */
import { readFileSync } from "node:fs";
import { gridBeats, fMeasure, octaveOf, scoreGrid } from "../measure/measure_grid.mjs";

const results = [];
const check = (label, cond) => results.push(`  ${cond ? "OK  " : "МИМО"} ${label}`);

const dsp = new Function(readFileSync("web/js/dsp.js", "utf8") + readFileSync("web/js/beatgrid.js", "utf8")
  + readFileSync("web/js/downbeat.js", "utf8")
  + "return { fitBeatGrid, estimateBeatGrid, gridDecision, beatShapeContrast, wholeTrackTempo, analyzeTempo, gridScore, onsetPeaks, GRID_LATENCY_SEC, GRID_TEMPO_RATE };")();

/* ---------- Measures ---------- */

{
  const beats = gridBeats(120, 0.25, 0, 2000);
  check(`сетка 120 BPM с 0.25 с: 250, 750, 1250, 1750 мс (${beats.map(Math.round)})`,
    beats.length === 4 && Math.round(beats[0]) === 250 && Math.round(beats[3]) === 1750);
  const ref = [250, 750, 1250, 1750];
  check("F-мера точной сетки = 1", fMeasure(ref, [250, 750, 1250, 1750]) === 1);
  check("сдвиг на 60 мс ещё попадает в 70 мс", fMeasure(ref, ref.map((t) => t + 60)) === 1);
  check("сдвиг на полдоли — 0", fMeasure(ref, ref.map((t) => t + 250)) === 0);
  // 240 BPM over the reference span +-70 ms, as scoreGrid takes it: 7 beats,
  // 4 of them on the reference.
  check("двойной темп — точность 4/7, полнота 1, F = 8/11", Math.abs(fMeasure(ref, gridBeats(240, 0.25, 180, 1820)) - 8 / 11) < 1e-9);
  check("октавы: 128 vs 64 — double, 64 vs 128 — half", octaveOf(128, 64) === "double" && octaveOf(64, 128) === "half");
  const drift = scoreGrid(gridBeats(128, 0.1, 0, 300000), 128.05, 0.1);
  check(`ошибка 0.05 BPM видна к концу трека (${Math.round(drift.endMs)} мс), а не в начале (${Math.round(drift.startMs)} мс)`,
    drift.startMs < 10 && drift.endMs > 70);
}

/* ---------- Grid on synthetic audio ---------- */

const sr = 44100;
// Kick on every beat, open hat and a bass stab on every off-beat. The hat is
// far louder than the kick above 2 kHz -- the trap for a full-band envelope --
// and only there: noise twice differenced, as a hat is, not a clap across the
// mids (which would mark the beat, as gridDecision has learned).
function track(bpm, firstBeat, seconds, offbeatBass = true, rate = sr) {
  const y = new Float32Array(rate * seconds);
  const period = 60 / bpm;
  let seed = 7;
  const noise = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff - 0.5; };
  for (let t = firstBeat; t < seconds; t += period) {
    const k = Math.round(t * rate);
    // Rung out to silence: a kick cut short clicks across every band.
    for (let i = 0; i < 0.4 * rate && k + i < y.length; i++) {
      const f = 55 + 90 * Math.exp(-i / (0.02 * rate)); // pitch-dropping kick
      y[k + i] += 0.8 * Math.sin((2 * Math.PI * f * i) / rate) * Math.exp(-i / (0.05 * rate));
    }
    const h = Math.round((t + period / 2) * rate);
    let n1 = 0, n2 = 0;
    for (let i = 0; i < 0.05 * rate && h + i < y.length; i++) {
      const n0 = noise();
      y[h + i] += 0.6 * (n0 - 2 * n1 + n2) * Math.exp(-i / (0.01 * rate));
      n2 = n1; n1 = n0;
      if (offbeatBass) y[h + i] += 0.25 * Math.sin((2 * Math.PI * 110 * i) / rate) * Math.exp(-i / (0.04 * rate));
    }
  }
  return y;
}

for (const [bpm, first] of [[128.37, 0.215], [174.0, 0.05], [122.5, 0.4]]) {
  const grid = dsp.fitBeatGrid(track(bpm, first, 60), sr, Math.round(bpm));
  const period = 60 / bpm;
  // Distance of our first beat from the true one, folded into one period.
  let diff = ((grid.firstBeat - first) % period + period) % period;
  if (diff > period / 2) diff -= period;
  const ms = diff * 1000;
  check(`${bpm} BPM: темп ${grid.bpm} (до 0.02)`, Math.abs(grid.bpm - bpm) <= 0.02);
  check(`${bpm} BPM: фаза на бочке, не на слабой доле (${ms.toFixed(1)} мс от истинной, допуск 25)`, Math.abs(ms) <= 25);
  check(`${bpm} BPM: сетка постоянная`, grid.constant === true);
}
{
  const steady = { mode: "constant", min: 126, max: 126 };
  const g = dsp.estimateBeatGrid(track(126, 0.3, 40), sr, 126, steady);
  const period = 60 / 126;
  let diff = ((g.firstBeat - 0.3 - dsp.GRID_LATENCY_SEC) % period + period) % period;
  if (diff > period / 2) diff -= period;
  check(`итоговая сетка: ${g.bpm} BPM, фаза в ${Math.round(diff * 1000)} мс от истинной (допуск 25)`, Math.abs(g.bpm - 126) <= 0.02 && Math.abs(diff) <= 0.025);
  check(`уверенность от 0 до 1 (${g.confidence}), решение и причина согласованы`,
    g.confidence >= 0 && g.confidence <= 1 && (g.place ? g.reason === null : ["unsure", "dynamic"].includes(g.reason)));
  check(`начало такта — одна из четырёх долей (${g.downbeat})`, [0, 1, 2, 3].includes(g.downbeat));
  const moving = dsp.estimateBeatGrid(track(126, 0.3, 40), sr, 126, { mode: "dynamic", min: 118, max: 134 });
  check(`плавающий темп снижает уверенность (${moving.confidence} < ${g.confidence}), сетка та же`,
    moving.confidence < g.confidence && moving.firstBeat === g.firstBeat);
  check(`без сетки из-за плавающего темпа — причина dynamic (${moving.place}, ${moving.reason})`,
    moving.place ? moving.reason === null : moving.reason === "dynamic");

  // Bars: the same fit, with candidate features that make one of the two
  // half-beat grids look like it has bars and the other flat.
  const fit = dsp.fitBeatGrid(track(126, 0.3, 40), sr, 126);
  const flat = [0, 1, 2, 3].map(() => new Array(10).fill(0));
  const bars = [0, 1, 2, 3].map((p) => new Array(10).fill(p === 0 ? 1.5 : -0.5));
  const there = dsp.gridDecision(fit, steady, flat, bars);
  const here = dsp.gridDecision(fit, steady, bars, flat);
  check(`такты яснее на полдоли позже — сетка переезжает туда (${there.switched}); яснее здесь — остаётся (${here.switched})`,
    there.switched === true && here.switched === false);
  const none = dsp.gridDecision(fit, steady, null, null);
  check(`без признаков тактов — решает бочка, как раньше (${none.switched})`, none.switched === false);

  // The beat's shape as it would be measured half a beat later: every
  // profile turned by half. The kick fit is the same, so only the shape says
  // the beat moved.
  const turn = (p) => [...p.slice(p.length / 2), ...p.slice(0, p.length / 2)];
  const turned = { ...fit, shape: { flux: fit.shape.flux.map(turn), level: fit.shape.level.map(turn) } };
  const moved = dsp.gridDecision(turned, steady, null, null);
  check(`форма доли на полдоли позже — сетка переезжает туда (${moved.switched})`, moved.switched === true);
  const c = dsp.beatShapeContrast(fit.shape);
  check(`признаки формы: 9 полос × 4 × (поток, уровень) = ${c.length}, в пределах обрезки (${Math.min(...c).toFixed(2)}…${Math.max(...c).toFixed(2)})`,
    c.length === 72 && c.slice(0, 36).every((v) => Math.abs(v) <= 2) && c.slice(36).every((v) => Math.abs(v) <= 4));
  const silent = dsp.beatShapeContrast({ flux: [[1, 0, 0, 0, 0, 0, 0, 0]], level: [[0, 0, 0, 0, 0, 0, 0, 9]] });
  check(`пустая между ударами полоса не уводит признак за предел (${silent.join(", ")})`,
    silent[0] === -2 && silent[7] === 4);
}
{
  // Six minutes at the rate the app sends: the comb over all of it tells
  // 127.93 from the 128.00 it is started at, and from 127.92 and 127.94.
  const rate = dsp.GRID_TEMPO_RATE;
  const whole = track(127.93, 0.2, 360, true, rate);
  const found = dsp.wholeTrackTempo(whole, rate, 128);
  check(`темп по всему треку: 127.93 из подсказки 128.00 (${found})`, found === 127.93);
  check(`дальше 0.1 BPM не ищет: из 127.70 — не 127.93 (${dsp.wholeTrackTempo(whole, rate, 127.7)})`,
    dsp.wholeTrackTempo(whole, rate, 127.7) <= 127.8);

  // The first two minutes at 127.93, the whole track (as sent) at 128.00: the
  // tempo comes from the whole track, the phase from the two minutes.
  const steady = { mode: "constant", min: 128, max: 128 };
  const y = track(127.93, 0.2, 120);
  const alone = dsp.estimateBeatGrid(y, sr, 128, steady);
  const refined = dsp.estimateBeatGrid(y, sr, 128, steady, track(128, 0.2, 360, true, rate), rate);
  check(`без всего трека темп — двух минут (${alone.bpm}), с ним — всего трека (${refined.bpm})`,
    Math.abs(alone.bpm - 127.93) <= 0.011 && refined.bpm === 128);
  check(`фаза остаётся от двух минут (${alone.firstBeat} и ${refined.firstBeat})`, Math.abs(alone.firstBeat - refined.firstBeat) < 0.001);
  const short = dsp.estimateBeatGrid(y, sr, 128, steady, track(128, 0.2, 100, true, rate), rate);
  check(`трек не длиннее двух минут — темп не трогается (${short.bpm})`, short.bpm === alone.bpm);
}
check("тишина — нет сетки, а не выдумка", dsp.fitBeatGrid(new Float32Array(sr * 10), sr, 128) === null);
check("без темпа — нет сетки", dsp.fitBeatGrid(track(128, 0.1, 10), sr, null) === null);

/* ---------- report ---------- */

const failed = results.filter((line) => line.includes("МИМО"));
console.log(results.join("\n"));
console.log(`\nпройдено ${results.length - failed.length}/${results.length}`);
process.exit(failed.length > 0 ? 1 : 0);
