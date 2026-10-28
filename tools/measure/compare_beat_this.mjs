/*
 * Beat This! (CPJKU, ISMIR 2024) against our beat grid, on the same held-out
 * tracks and by the same measure: Rekordbox's own grids, F >= 0.8 within 70 ms
 * over the whole track (tools/measure/measure_grid.mjs, scoreGrid).
 *
 * Beat This! is a beat tracker, not a grid: it follows the music beat by beat.
 * To compare it with a grid that gets written into a file, a constant grid is
 * fitted through its beats (fitGrid). It is also scored with its period halved
 * or doubled to our tempo's octave, since most of its misses turned out to be
 * counting every other beat of a 140 BPM track.
 *
 * Usage
 * -----
 *   node tools/measure/measure_grid.mjs --half test --out ground-truth/grid_results_test_halfbeat.json
 *   node tools/measure/compare_beat_this.mjs --pick 600            # writes ground-truth/beat_this_list.json
 *   .venv-beat-this/bin/python tools/measure/beat_this_run.py ground-truth/beat_this_list.json ground-truth/beat_this.jsonl
 *   node tools/measure/compare_beat_this.mjs ground-truth/beat_this.jsonl [more.jsonl ...]
 *
 * The result, October 2026, is in web/README.md under "Beat grid".
 */
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { ROOT, loadDsp, arg } from "./lib/measure.mjs";
import { scoreGrid, fMeasure, octaveOf, gridBeats } from "./measure_grid.mjs";
import { downbeatLabel } from "./measure_downbeat.mjs";

const OURS = join(ROOT, "ground-truth/grid_results_test_halfbeat.json");
const HIT_SEC = 0.035;

/*
 * A constant grid through a tracker's beats: the period and phase that put the
 * beats closest to its lines, each beat counting for more the closer it is
 * (1 on a line, 0 at 35 ms or further). Counting plain hits within a window
 * left a plateau of periods that scored the same on 20 ms frames, and the
 * first of them was 0.02 BPM off.
 *
 * Two simpler fits failed on real output. Beat This! reports beats on a 20 ms
 * frame grid, so a period taken from one interval counts the beats wrong
 * within a few dozen of them. And a least-squares line through the beats
 * tilts when the tracker slips onto the off-beat for a breakdown: a phase jump
 * read as a tempo change, a grid 1.3 BPM off on a track it had followed
 * almost perfectly. A search over periods near the typical interval, with the
 * phase as the circular mean of where the beats fall, has neither problem.
 */
export function fitGrid(beats) {
  if (!beats || beats.length < 8) return null;
  const d = beats.slice(1).map((b, i) => b - beats[i]);
  const sorted = d.slice().sort((a, b) => a - b);
  const mid = sorted[sorted.length >> 1];
  const near = d.filter((x) => Math.abs(x - mid) < 0.25 * mid);
  const p0 = near.reduce((a, b) => a + b, 0) / near.length;
  // Where the beats fall within one period, as their circular mean; `within`
  // limits it to beats already near a line, so off-beat stretches do not pull.
  const meanPhase = (p, within) => {
    let sx = 0, sy = 0;
    for (const b of beats) {
      if (within) {
        const r = (((b - within) % p) + p) % p;
        if (Math.min(r, p - r) >= HIT_SEC) continue;
      }
      const a = (2 * Math.PI * b) / p;
      sx += Math.cos(a);
      sy += Math.sin(a);
    }
    const phase = (Math.atan2(sy, sx) / (2 * Math.PI)) * p;
    return phase < 0 ? phase + p : phase;
  };
  const fit = (p, phase) => {
    let score = 0;
    for (const b of beats) {
      const r = (((b - phase) % p) + p) % p;
      score += Math.max(0, 1 - Math.min(r, p - r) / HIT_SEC);
    }
    return score;
  };
  let best = null;
  for (let p = p0 * 0.985; p <= p0 * 1.015; p += p0 * 0.00002) {
    let phase = meanPhase(p, null);
    phase = meanPhase(p, phase);
    const score = fit(p, phase);
    if (!best || score > best.score) best = { score, period: p, phase };
  }
  return { bpm: 60 / best.period, firstBeat: best.phase, period: best.period };
}

// The tracker's period moved to our tempo's octave: halved when it counted every
// other beat, doubled when it counted half beats.
export function toOctave(period, ourBpm) {
  const ratio = ourBpm / (60 / period);
  return ratio > 1.5 ? period / 2 : ratio < 0.75 ? period * 2 : period;
}

// References exactly as measure_grid.mjs builds them, plus Rekordbox's number
// for its first beat in the bar (bars[0]).
function loadRefs() {
  const grids = JSON.parse(readFileSync(join(ROOT, "ground-truth/rekordbox_grids.json"), "utf8")).byName;
  const byPath = JSON.parse(readFileSync(join(ROOT, "ground-truth/rekordbox_db.json"), "utf8")).byPath;
  const pathOf = {};
  for (const p of Object.keys(byPath)) {
    const base = p.slice(p.lastIndexOf("/") + 1);
    pathOf[base] = pathOf[base] === undefined ? p : null;
  }
  const refs = {};
  for (const [name, g] of Object.entries(grids)) {
    const path = pathOf[name];
    if (!path || !g.ms || g.ms.length < 64) continue;
    const tempos = g.tempos.map(([, t]) => t / 100);
    refs[path] = { ms: g.ms, bpm: g.tempos[0][1] / 100, variable: Math.max(...tempos) - Math.min(...tempos) > 0.5, firstBarBeat: g.bars[0] };
  }
  return refs;
}

// A fixed random sample of the tracks our grid run scored.
function pick(count) {
  const ours = JSON.parse(readFileSync(OURS, "utf8")).results.filter((r) => !r.error);
  let seed = 7;
  const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
  const files = ours.map((r) => r.file).sort().map((f) => [rnd(), f]).sort((a, b) => a[0] - b[0]).slice(0, count).map((x) => x[1]);
  const out = join(ROOT, "ground-truth/beat_this_list.json");
  writeFileSync(out, JSON.stringify(files));
  console.log(`${files.length} tracks -> ${out}`);
}

function main() {
  if (process.argv.includes("--pick")) return pick(parseInt(arg("--pick", "600"), 10));
  const dsp = loadDsp(["gridOffsetFor"], readFileSync(join(ROOT, "web/js/tags.js"), "utf8"));
  const refs = loadRefs();
  const ours = Object.fromEntries(JSON.parse(readFileSync(OURS, "utf8")).results.map((r) => [r.file, r]));
  const tracked = process.argv.slice(2).filter((a) => a.endsWith(".jsonl"))
    .flatMap((f) => readFileSync(f, "utf8").trim().split("\n").map((l) => JSON.parse(l)));

  const rows = [];
  for (const b of tracked) {
    const o = ours[b.file], ref = refs[b.file];
    if (b.error || !o || !ref || ref.variable || !o.final) continue;
    const off = dsp.gridOffsetFor("rekordbox", o.kind, 44100, o.tagBytes);
    const g = fitGrid(b.beats);
    let alone = 0, atOurs = 0, agree = 0;
    if (g) {
      alone = scoreGrid(ref.ms, g.bpm, g.firstBeat + off).f;
      const period = toOctave(g.period, o.final.bpm);
      atOurs = scoreGrid(ref.ms, 60 / period, g.firstBeat + off).f;
      // How well the two grids agree, scoring ours against Beat This!'s.
      agree = scoreGrid(gridBeats(60 / period, g.firstBeat + off, ref.ms[0], ref.ms[ref.ms.length - 1]),
        o.final.bpm, o.final.rekordboxFirstBeat).f;
    }
    const btBar = b.downbeats.length ? downbeatLabel((b.downbeats[0] + off) * 1000, ref.ms, ref.firstBarBeat) : null;
    const ourBar = downbeatLabel(o.final.rekordboxFirstBeat * 1000, ref.ms, ref.firstBarBeat);
    rows.push({
      raw: fMeasure(ref.ms, b.beats.map((t) => (t + off) * 1000)), alone, atOurs, agree,
      ours: scoreGrid(ref.ms, o.final.bpm, o.final.rekordboxFirstBeat).f, place: o.final.place,
      btOctave: g ? octaveOf(g.bpm, ref.bpm) : "none", ourOctave: octaveOf(o.final.bpm, ref.bpm),
      btBarOk: btBar === null ? null : btBar === 0, ourBarOk: ourBar === null ? null : ourBar === o.final.downbeat,
      btMs: b.ms,
    });
  }

  const pct = (k, n) => (n ? ((100 * k) / n).toFixed(1) + "%" : "-");
  const good = (f) => f >= 0.8;
  const mcnemar = (a, b) => {
    const x = rows.filter((r) => good(a(r)) && !good(b(r))).length, y = rows.filter((r) => !good(a(r)) && good(b(r))).length;
    return `only the first ${x}, only the second ${y}, McNemar chi2 ${((x + y) ? ((Math.abs(x - y) - 1) ** 2) / (x + y) : 0).toFixed(2)} (3.84 = p 0.05)`;
  };
  const n = rows.length;
  console.log(`${n} held-out tracks with a one-tempo Rekordbox grid (of ${tracked.length} tracked)\n`);
  console.log("grid good (F >= 0.8 within 70 ms, whole track):");
  console.log(`  ours, every grid                       ${pct(rows.filter((r) => good(r.ours)).length, n)}`);
  console.log(`  Beat This!, constant grid              ${pct(rows.filter((r) => good(r.alone)).length, n)}`);
  console.log(`  Beat This!, its own beats (no grid)    ${pct(rows.filter((r) => good(r.raw)).length, n)}`);
  console.log(`  Beat This! phase at our tempo octave   ${pct(rows.filter((r) => good(r.atOurs)).length, n)}`);
  console.log(`  ours where we write, else Beat This!   ${pct(rows.filter((r) => good(r.place ? r.ours : r.atOurs)).length, n)}`);
  console.log(`  ours vs Beat This! alone:          ${mcnemar((r) => r.ours, (r) => r.alone)}`);
  console.log(`  ours vs Beat This! at our octave:  ${mcnemar((r) => r.ours, (r) => r.atOurs)}`);
  const placed = rows.filter((r) => r.place), withheld = rows.filter((r) => !r.place);
  console.log(`\nwhere we write a grid (${placed.length}): ours ${pct(placed.filter((r) => good(r.ours)).length, placed.length)}, Beat This! at our octave ${pct(placed.filter((r) => good(r.atOurs)).length, placed.length)}`);
  console.log(`where we withhold it (${withheld.length}): ours ${pct(withheld.filter((r) => good(r.ours)).length, withheld.length)}, Beat This! at our octave ${pct(withheld.filter((r) => good(r.atOurs)).length, withheld.length)}`);
  for (const [label, set] of [["write", placed], ["withhold", withheld]]) {
    const a = set.filter((r) => r.agree >= 0.9), d = set.filter((r) => r.agree < 0.9);
    console.log(`  ${label}: the two grids agree on ${a.length}, ours good there ${pct(a.filter((r) => good(r.ours)).length, a.length)}; disagree on ${d.length}, ours good ${pct(d.filter((r) => good(r.ours)).length, d.length)}`);
  }
  console.log(`\ntempo octave as Rekordbox's: ours ${pct(rows.filter((r) => r.ourOctave === "same").length, n)}, Beat This! ${pct(rows.filter((r) => r.btOctave === "same").length, n)}`);
  const both = rows.filter((r) => good(r.ours) && good(r.atOurs) && r.btBarOk !== null && r.ourBarOk !== null);
  console.log(`bar starts right, where both grids are good (${both.length}): ours ${pct(both.filter((r) => r.ourBarOk).length, both.length)}, Beat This! ${pct(both.filter((r) => r.btBarOk).length, both.length)}`);
  const ms = rows.map((r) => r.btMs).sort((a, b) => a - b);
  console.log(`Beat This! time per track, median ${ms[ms.length >> 1]} ms (whole track, PyTorch on the CPU)`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main();
