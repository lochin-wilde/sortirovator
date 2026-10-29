/*
 * Checks the deck's three-band waveform (web/js/waveform.js) on synthetic
 * sounds: a kick goes to the lows, a snare to the mids and highs, a hat to the
 * highs, and as drawn -- each band to its own scale, nested lows widest -- the
 * kick shows and the snare does not tower over it. The first version failed
 * the last two: the kick was covered and the snare stood tallest.
 *
 *   node tools/test/test_waveform.mjs
 */
import { readFileSync } from "node:fs";

const results = [];
const check = (label, cond) => results.push(`  ${cond ? "OK  " : "МИМО"} ${label}`);

const w = new Function(readFileSync("web/js/waveform.js", "utf8") +
  "\nreturn { waveformBands, computeWaveform, waveformColumn, WAVEFORM_LAYER_SCALE, WAVEFORM_HOP };")();

const RATE = 44100;
// A deterministic noise source, so the test gives the same numbers every run.
let seed = 12345;
const noise = () => { seed = (Math.imul(seed, 1103515245) + 12345) >>> 0; return seed / 2147483648 - 1; };

function kick(out, at, level = 0.8) {
  const s0 = Math.round(at * RATE);
  for (let i = 0; i < RATE * 0.35 && s0 + i < out.length; i++) {
    const t = i / RATE;
    out[s0 + i] += Math.sin(2 * Math.PI * 50 * t) * Math.exp(-t * 9) * level;
  }
}
function snare(out, at, level = 0.6) {
  const s0 = Math.round(at * RATE);
  for (let i = 0; i < RATE * 0.12 && s0 + i < out.length; i++) out[s0 + i] += noise() * Math.exp(-i / RATE * 30) * level;
}
// Noise above about 6 kHz: white noise through a few first differences.
function hat(out, at, level = 0.3) {
  const s0 = Math.round(at * RATE);
  const burst = Float32Array.from({ length: Math.round(RATE * 0.04) }, () => noise());
  for (let k = 0; k < 3; k++) for (let i = burst.length - 1; i > 0; i--) burst[i] = (burst[i] - burst[i - 1]) * 0.5;
  for (let i = 0; i < burst.length && s0 + i < out.length; i++) out[s0 + i] += burst[i] * Math.exp(-i / RATE * 60) * level * 4;
}
const silence = (seconds) => new Float32Array(Math.round(RATE * seconds));

// Share of each band in the total energy of a sound, before any scaling.
function shares(signal) {
  const b = w.waveformBands([signal], RATE);
  const e = { low: 0, mid: 0, high: 0 };
  for (const band of Object.keys(e)) for (const v of b[band]) e[band] += v * v;
  const total = e.low + e.mid + e.high;
  return { low: e.low / total, mid: e.mid / total, high: e.high / total };
}

{
  const x = silence(2); kick(x, 0.2); kick(x, 1.0);
  const s = shares(x);
  check(`кик (50 Гц с затуханием): ${(s.low * 100).toFixed(0)}% энергии в низах`, s.low > 0.85);
}
{
  const x = silence(2); snare(x, 0.2); snare(x, 1.0);
  const s = shares(x);
  check(`снейр (белый шум): низ ${(s.low * 100).toFixed(1)}%, середина и верх ${((s.mid + s.high) * 100).toFixed(0)}%`, s.low < 0.03 && s.mid + s.high > 0.95);
}
{
  const x = silence(2); hat(x, 0.2); hat(x, 1.0);
  const s = shares(x);
  check(`хэт (шум выше 6 кГц): ${(s.high * 100).toFixed(0)}% в верхах`, s.high > 0.9);
}

/*
 * As drawn: a loop at 125 BPM, a kick on every beat and a snare on two and
 * four as loud as a mastered track has them, the snare's peak above the
 * kick's level once mixed. Heights are what the canvas gets: each band's
 * value times its layer's scale.
 */
const period = 60 / 125;
const loop = silence(16);
for (let k = 0; k * period < 15.5; k++) {
  kick(loop, 0.1 + k * period);
  if (k % 2 === 1) snare(loop, 0.1 + k * period + 0.02, 0.9);
  hat(loop, 0.1 + (k + 0.5) * period);
}
const drawn = (wave, t) => {
  const f = Math.floor((t * RATE) / w.WAVEFORM_HOP);
  const c = w.waveformColumn(wave, f, f + 3);
  const L = w.WAVEFORM_LAYER_SCALE;
  return { low: c.low * L.low, mid: c.mid * L.mid, high: c.high * L.high };
};
{
  const wave = w.computeWaveform([loop], RATE);
  const at = (k) => 0.1 + k * period + 0.03;
  const kicks = [4, 6, 8, 10].map((k) => drawn(wave, at(k)));       // beats 1 and 3: kick alone
  const snares = [5, 7, 9, 11].map((k) => drawn(wave, at(k)));      // beats 2 and 4: kick and snare
  const visibleLow = Math.min(...kicks.map((d) => d.low - Math.max(d.mid, d.high)));
  check(`кик виден: низ выступает из-под середины и верха на ${(visibleLow * 100).toFixed(0)}% высоты`, visibleLow > 0.3);
  const tallest = (d) => Math.max(d.low, d.mid, d.high);
  const snareTop = Math.max(...snares.map((d) => Math.max(d.mid, d.high)));
  const kickTop = Math.min(...kicks.map(tallest));
  check(`снейр не выше кика (${snareTop.toFixed(2)} против ${kickTop.toFixed(2)})`, snareTop <= kickTop + 1e-9);
  const values = ["low", "mid", "high"].flatMap((b) => Array.from(wave[b]));
  check("значения от 0 до 1", values.every((v) => v >= 0 && v <= 1 && Number.isFinite(v)));
}

/*
 * A dense house loop, as the deck shows real tracks: a bass line that keeps
 * the lows busy between kicks, and chords that keep the mids busy all the
 * time. On the owner's tracks the first draft of this file drew the mids at
 * their ceiling and the lows barely above them, so the kicks did not stand
 * out; synthetic kicks over silence did not show it.
 */
{
  const dense = silence(16);
  for (let k = 0; k * period < 15.5; k++) {
    kick(dense, 0.1 + k * period);
    hat(dense, 0.1 + (k + 0.5) * period);
  }
  for (let i = 0; i < dense.length; i++) {
    const t = i / RATE;
    // The bass ducks under each kick, as house is mixed (sidechain); a bass at
    // full level would beat against the kick and cancel it in places.
    const sinceKick = ((t - 0.1) % period + period) % period;
    const duck = 1 - 0.85 * Math.exp(-sinceKick * 10);
    dense[i] += Math.sin(2 * Math.PI * 55 * t) * 0.25 * duck                                  // bass line
      + (Math.sin(2 * Math.PI * 330 * t) + Math.sin(2 * Math.PI * 415 * t) + Math.sin(2 * Math.PI * 988 * t)) * 0.06; // chords
  }
  const wave = w.computeWaveform([dense], RATE);
  const onKick = [8, 9, 10, 11].map((k) => drawn(wave, 0.1 + k * period + 0.03));
  const between = [8, 9, 10, 11].map((k) => drawn(wave, 0.1 + k * period + period * 0.75));
  const rise = Math.min(...onKick.map((d, i) => d.low - between[i].low));
  check(`плотный хаус: на ударе низ выше, чем между ударами, на ${(rise * 100).toFixed(0)}% высоты`, rise > 0.25);
  const stand = Math.min(...onKick.map((d) => d.low - Math.max(d.mid, d.high)));
  check(`плотный хаус: на ударе низ выступает из-под середины на ${(stand * 100).toFixed(0)}%`, stand > 0.25);
}

// Edge cases.
{
  const quiet = loop.map((v) => v * 0.01);
  const a = w.computeWaveform([loop], RATE), b = w.computeWaveform([quiet], RATE);
  const f = Math.floor((2.0 * RATE) / w.WAVEFORM_HOP);
  check("очень тихий трек выглядит как громкий (каждая полоса — к своему масштабу)",
    ["low", "mid", "high"].every((band) => Math.abs(a[band][f] - b[band][f]) < 0.02));
}
{
  const mono = w.computeWaveform([loop], RATE), stereo = w.computeWaveform([loop, loop], RATE);
  check("моно и стерео из одного сигнала — одна волна", ["low", "mid", "high"].every((band) => mono[band].every((v, i) => Math.abs(v - stereo[band][i]) < 1e-6)));
}
{
  const noBass = silence(8);
  for (let k = 0; k * period < 7.5; k++) { if (k % 2) snare(noBass, 0.1 + k * period); hat(noBass, 0.1 + (k + 0.5) * period); }
  const wave = w.computeWaveform([noBass], RATE);
  // What would show is the low layer standing out from under the others.
  const L = w.WAVEFORM_LAYER_SCALE;
  let phantom = 0;
  for (let f = 0; f < wave.low.length; f++) {
    phantom = Math.max(phantom, wave.low[f] * L.low - Math.max(wave.mid[f] * L.mid, wave.high[f] * L.high));
  }
  check(`трек без баса: низа из-под середины и верха не видно (выступает на ${(phantom * 100).toFixed(0)}%)`, phantom < 0.05);
}
{
  const clipped = loop.map((v) => Math.max(-0.3, Math.min(0.3, v * 3)));
  const wave = w.computeWaveform([clipped], RATE);
  const d = drawn(wave, 0.1 + 4 * period + 0.03);
  check("сильный клиппинг: волна конечна, кик всё ещё виден", Object.values(d).every(Number.isFinite) && d.low - Math.max(d.mid, d.high) > 0.1);
}

const failed = results.filter((line) => line.includes("МИМО"));
console.log(results.join("\n"));
console.log(`\nпройдено ${results.length - failed.length}/${results.length}`);
process.exit(failed.length > 0 ? 1 : 0);
