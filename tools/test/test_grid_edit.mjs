/*
 * Checks the beat grid edits behind the grid editor (views.js): every edit
 * keeps the grid's form -- firstBeat inside the first beat, the bar start as
 * one of the first four beats -- and moves only what it says it moves.
 *
 *   node tools/test/test_grid_edit.mjs
 */
import { readFileSync } from "node:fs";

const results = [];
const check = (label, cond) => results.push(`  ${cond ? "OK  " : "МИМО"} ${label}`);

const v = new Function(readFileSync("web/js/views.js", "utf8") +
  "\nreturn { wrapGrid, gridBeatsBetween, nudgeGrid, shiftGridBar, setGridTempo, nearestGridBeat, gridBeatAt, gridBarAt, gridBarPosition, deckBandColors, deckVolumes };")();

const near = (a, b, eps = 1e-4) => Math.abs(a - b) < eps;
// Bar starts between 5 and 15 s, to the millisecond.
const bars = (g) => v.gridBeatsBetween(g, 5, 15).filter((b) => b.beat === 1).map((b) => b.time.toFixed(3));
// Every bar of `b` is a bar of `a` moved by `by` seconds.
const barsMoved = (a, b, by) => {
  const want = new Set(v.gridBeatsBetween(a, 0, 30).filter((x) => x.beat === 1).map((x) => (x.time + by).toFixed(3)));
  const got = bars(b);
  return got.length >= 2 && got.every((t) => want.has(t));
};

const g = { bpm: 120, firstBeat: 0.1, downbeat: 2 };

{
  const beats = v.gridBeatsBetween(g, 0, 2.2);
  check("доли по 0.5 с, номер в такте по downbeat", beats.length === 5 && near(beats[1].time, 0.6)
    && beats.map((b) => b.beat).join("") === "34123");
}
{
  const n = v.nudgeGrid(g, 0.01);
  check("сдвиг на 10 мс двигает долю", near(n.firstBeat, 0.11) && n.downbeat === 2);
  const back = v.nudgeGrid(g, -0.2);
  check("сдвиг раньше начала трека — первая доля переходит на следующую", near(back.firstBeat, 0.4));
  for (const by of [0.01, -0.2, 0.5, 1.3, -1.7]) {
    check(`сдвиг на ${by} с двигает и такты на ${by} с`, barsMoved(g, v.nudgeGrid(g, by), by));
  }
}
{
  const raw = { bpm: 120, firstBeat: 1.1, downbeat: 0 };
  const w = v.wrapGrid(raw);
  check("wrapGrid: 1.1 с при периоде 0.5 → 0.1 с, такты на тех же секундах", near(w.firstBeat, 0.1) && barsMoved(raw, w, 0));
}
{
  const s = v.shiftGridBar(g, 1);
  check("такт на долю позже, доли на месте", s.downbeat === 3 && s.firstBeat === g.firstBeat && barsMoved(g, s, 0.5));
  check("такт: 3 + 1 → 0, 0 − 1 → 3", v.shiftGridBar({ ...g, downbeat: 3 }, 1).downbeat === 0
    && v.shiftGridBar({ ...g, downbeat: 0 }, -1).downbeat === 3);
}
{
  const anchor = 60.3;
  const before = v.gridBeatsBetween(g, anchor - 0.25, anchor + 0.25)[0];
  const t = v.setGridTempo(g, 120.5, anchor);
  const after = v.gridBeatsBetween(t, before.time - 0.01, before.time + 0.01)[0];
  check(`новый темп поворачивает сетку вокруг доли у курсора (${after && after.time.toFixed(4)} с)`,
    t.bpm === 120.5 && after && near(after.time, before.time, 1e-3) && after.beat === before.beat);
  check("первая доля остаётся внутри первой доли", t.firstBeat >= 0 && t.firstBeat < 60 / 120.5);
  check("темп округляется до сотых", v.setGridTempo(g, 128.004, 0).bpm === 128);
  check("невозможный темп не принимается", v.setGridTempo(g, 0, 10) === g && v.setGridTempo(g, NaN, 10) === g && v.setGridTempo(g, 999, 10) === g);
}
{
  const d = v.setGridTempo(g, 240, 30);
  const old = v.gridBeatsBetween(g, 0, 60).map((b) => b.time);
  const now = new Set(v.gridBeatsBetween(d, 0, 60).map((b) => b.time.toFixed(4)));
  check("×2: все прежние доли остаются долями", old.every((t) => now.has(t.toFixed(4))));
}

{
  // g: beats at 0.1, 0.6, 1.1 ... ; 1.1 s starts a bar (downbeat 2).
  const here = v.gridBeatAt(g, 30.62);
  const hit = v.nearestGridBeat(here, 30.62);
  check(`«доля здесь»: ближайшая доля встаёт на курсор (${hit.time.toFixed(4)} с)`, near(hit.time, 30.62));
  check("«доля здесь»: сдвиг меньше половины доли", Math.abs(here.firstBeat - g.firstBeat) < 0.25);
  const bar = v.gridBarAt(g, 30.62);
  check("«такт здесь»: доля у курсора становится первой", v.nearestGridBeat(bar, 30.62).beat === 1 && bar.firstBeat === g.firstBeat);
  check("«такт здесь» на уже первой доле ничего не меняет", v.gridBarAt(g, 1.1).downbeat === g.downbeat);
}
{
  const at = (t) => { const p = v.gridBarPosition(g, t); return p.bar + "." + p.beat; };
  check("позиция: первая доля такта 1 — 1.1", at(1.1) === "1.1" && at(1.3) === "1.1");
  check("позиция: через долю 1.2, через такт 2.1", at(1.6) === "1.2" && at(3.1) === "2.1");
  check("позиция: доли до первого такта — такт 0", at(0.1) === "0.3" && at(0.6) === "0.4");
}

{
  const theme = { low: "#5b8cff", mid: "#e0b341", high: "#e7e9ee" };
  const c = v.deckBandColors({ low: "#FF0000", mid: "red", high: "#00ff00;background:url(x)" }, theme);
  check("цвета волны: свой #rrggbb принят, остальное — цвет темы", c.low === "#ff0000" && c.mid === theme.mid && c.high === theme.high);
  check("цвета волны: ничего не сохранено — цвета темы", JSON.stringify(v.deckBandColors(null, theme)) === JSON.stringify(theme));
}

{
  const d = v.deckVolumes(null);
  check("громкость: по умолчанию трек 0.7, щелчок 0.8", d.music === 0.7 && d.click === 0.8);
  const c = v.deckVolumes({ music: 0, click: "1.7" });
  check("громкость: ноль остаётся нулём, лишнее обрезается до 1", c.music === 0 && c.click === 1);
  check("громкость: мусор из хранилища — значение по умолчанию", v.deckVolumes({ music: "громко", click: null }).music === 0.7
    && v.deckVolumes({ music: "громко", click: null }).click === 0.8);
}

const failed = results.filter((line) => line.includes("МИМО"));
console.log(results.join("\n"));
console.log(`\nпройдено ${results.length - failed.length}/${results.length}`);
process.exit(failed.length > 0 ? 1 : 0);
