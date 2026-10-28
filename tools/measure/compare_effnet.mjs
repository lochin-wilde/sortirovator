/*
 * Discogs-EffNet (MTG) as a genre source, against the owner's folders and
 * against the app's own saved answers on the same tracks.
 *
 * The tracks and the yardstick are tools/measure/measure_genre.mjs's: folders
 * that name a genre, 25 tracks a folder, and its verdicts (exact, a related
 * genre, wrong, blank). The app's answers are read from that script's saved
 * run rather than fetched again, so nothing here goes online.
 *
 * The model answers in Discogs' 400 styles ("Electronic---Dubstep"). They are
 * put into our categories the way the app puts a Discogs lookup there, through
 * data/genres_map.json (categoryOf).
 *
 * Usage
 * -----
 *   node tools/measure/measure_genre.mjs --per-folder 25      # the saved run, network-bound
 *   node -e 'console.log(JSON.stringify(require("./ground-truth/genre_results.json").results.map((r) => r.file)))' > ground-truth/effnet_list.json
 *   .venv-effnet/bin/python tools/measure/effnet_run.py ground-truth/effnet_list.json ground-truth/effnet.jsonl MODEL.onnx MODEL.json
 *   node tools/measure/compare_effnet.mjs ground-truth/effnet.jsonl
 *
 * The result, October 2026, is in web/README.md under "Genre resolution".
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { ROOT } from "./lib/measure.mjs";

const identify = new Function(readFileSync(join(ROOT, "web/js/identify.js"), "utf8") + "\nreturn { normalizeGenre, GENRE_PARENTS };")();

/*
 * Our category for the model's answer: the most likely of its top styles that
 * names one of our categories, and only when none of them does, the top
 * style's parent genre ("Electronic", "Hip Hop"). Falling back to a style's
 * parent before looking further down the list turned 24 of 25 drum and bass
 * tracks into Electronic, because the style above Drum & Bass had no category.
 */
export function categoryOf(top, genresMap, depth = 15) {
  const map = (name) => identify.normalizeGenre(name, genresMap);
  for (const [cls, p] of top.slice(0, depth)) {
    const genre = map(cls.split("---")[1]);
    if (genre !== "Unknown") return { genre, style: cls, p };
  }
  const [cls, p] = top[0];
  return { genre: map(cls.split("---")[0]), style: cls, p };
}

// measure_genre.mjs's verdicts.
const ERA_SIBLINGS = { "Old School Hip-Hop": "Hip-Hop", "Hip-Hop": "Old School Hip-Hop" };
function classify(genre, truth) {
  const P = identify.GENRE_PARENTS;
  if (!genre || genre === "Unknown") return "unknown";
  if (genre === truth) return "exact";
  if (ERA_SIBLINGS[truth] === genre) return "era";
  if (P[genre] === truth) return "too specific";
  if (P[truth] === genre) return "too broad";
  if (P[genre] && P[genre] === P[truth]) return "sibling";
  return "wrong";
}

function main() {
  const genresMap = JSON.parse(readFileSync(join(ROOT, "web/data/genres_map.json"), "utf8"));
  const ours = JSON.parse(readFileSync(join(ROOT, "ground-truth/genre_results.json"), "utf8")).results;
  const eff = Object.fromEntries(process.argv.slice(2).flatMap((f) => readFileSync(f, "utf8").trim().split("\n").map((l) => JSON.parse(l))).map((r) => [r.file, r]));

  const rows = ours.filter((r) => eff[r.file] && !eff[r.file].error).map((r) => {
    const e = eff[r.file];
    const whole = categoryOf(e.whole, genresMap);
    return { ...r, eff: whole.genre, effP: whole.p, effV: classify(whole.genre, r.truth),
      eff120V: classify(categoryOf(e.first120, genresMap).genre, r.truth), ms: e.ms };
  });
  const n = rows.length;
  const pct = (k, m = n) => (m ? ((100 * k) / m).toFixed(1) + "%" : "-");
  const related = new Set(["era", "too broad", "too specific", "sibling"]);
  const line = (label, v) => {
    const count = (want) => rows.filter((r) => (typeof want === "string" ? v(r) === want : want.has(v(r)))).length;
    console.log(`  ${label.padEnd(44)} exact ${pct(count("exact")).padStart(6)}  related ${pct(count(related)).padStart(6)}  wrong ${pct(count("wrong")).padStart(6)}  blank ${pct(count("unknown")).padStart(6)}`);
  };
  console.log(`${n} tracks, each in a folder that names its genre\n`);
  line("ours (saved run)", (r) => r.verdict);
  line("Discogs-EffNet, whole track", (r) => r.effV);
  line("Discogs-EffNet, first two minutes", (r) => r.eff120V);
  line("ours, Discogs-EffNet where ours is blank", (r) => (r.verdict === "unknown" ? r.effV : r.verdict));
  const a = rows.filter((r) => r.verdict === "exact" && r.effV !== "exact").length;
  const b = rows.filter((r) => r.verdict !== "exact" && r.effV === "exact").length;
  console.log(`\n  exact: only ours ${a}, only Discogs-EffNet ${b}; McNemar chi2 ${(((Math.abs(a - b) - 1) ** 2) / Math.max(1, a + b)).toFixed(2)} (3.84 = p 0.05)`);

  console.log("\nper folder, exact: ours / Discogs-EffNet, and what the model says most");
  for (const truth of [...new Set(rows.map((r) => r.truth))]) {
    const g = rows.filter((r) => r.truth === truth);
    const said = {};
    for (const r of g) said[r.eff] = (said[r.eff] || 0) + 1;
    const common = Object.entries(said).sort((x, y) => y[1] - x[1]).slice(0, 2).map(([k, v]) => `${k} ${v}`).join(", ");
    console.log(`  ${truth.padEnd(20)} ${String(g.filter((r) => r.verdict === "exact").length).padStart(3)} / ${String(g.filter((r) => r.effV === "exact").length).padEnd(3)} of ${g.length}   ${common}`);
  }
  console.log("\nexact by the chosen style's activation:");
  for (const [lo, hi] of [[0, 0.2], [0.2, 0.4], [0.4, 0.6], [0.6, 1.01]]) {
    const g = rows.filter((r) => r.effP >= lo && r.effP < hi);
    console.log(`  ${lo}-${hi}: ${g.length} tracks, exact ${pct(g.filter((r) => r.effV === "exact").length, g.length)}`);
  }
  const ms = rows.map((r) => r.ms).sort((x, y) => x - y);
  console.log(`\ntime per track, median ${ms[ms.length >> 1]} ms (decode and model, whole track, onnxruntime on the CPU)`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main();
