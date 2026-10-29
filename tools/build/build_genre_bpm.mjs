/*
 * Genre -> tempo range, from the owner's Rekordbox collection export, and a
 * check of whether that range helps tell genres apart.
 *
 * The genre of a track is the folder it was filed into by hand, not the
 * export's Genre field: in the October 2026 export that field is empty on 76%
 * of tracks and the rest is whatever the file's tag said ("Other", "RUSSIAN",
 * "Nu Disco / Indie Dance,Deep House"). The folders are the same ones
 * tools/measure/measure_genre.mjs scores against, plus the ones the owner
 * mapped for this table (FOLDER_GENRE). The tempo is the export's AverageBpm,
 * which is what the DJ sees. Only the XML export is read, never master.db.
 *
 * Usage
 * -----
 *   node tools/build/build_genre_bpm.mjs EXPORT.xml                # writes web/data/genre_bpm.json
 *   node tools/build/build_genre_bpm.mjs EXPORT.xml --evaluate     # held-out check, writes nothing
 *
 * --evaluate builds the table on one half of the tracks (a fixed hash of the
 * path) and scores the other half: genre from the tempo alone, and the tempo
 * as a tie-break between the genres the online sources returned, replayed
 * from ground-truth/genre_sources.json.
 */
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join, dirname } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../..");
const LIBRARY_ROOT = "/Volumes/HomeSSD/Lochin/";

/*
 * Folders that name a genre, mapped to our categories. The first block is
 * measure_genre.mjs's; the second is the owner's call for this table
 * (October 2026), including the two mixed UK garage / house and bassline
 * folders counted as UK Garage.
 */
export const FOLDER_GENRE = {
  "Funky Disco House": "Funky / Disco House",
  "раскидать/Afro": "Afro House",
  "раскидать/JerseyClub": "Jersey Club",
  "раскидать/DnB": "Drum & Bass",
  "раскидать/Dubstep 2": "Dubstep",
  "Dubstep": "Dubstep",
  "раскидать/Moombahton": "Moombahton",
  "PS1 Jungle": "Jungle",
  "Hip-Hop:Rap/Old Eng/90 Hip Hop": "Old School Hip-Hop",
  "раскидать/Hip-Hop": "Hip-Hop",
  "31.07/UKG/mp3": "UK Garage",
  "NuDisco 2026 ": "Nu Disco",
  "раскидать/Soulful House": "Soulful House",
  "раскидать/140 _ Deep Dubstep _ Grime": "Grime",
  "Garage": "UK Garage",

  "раскидать/House": "House",
  "House/House": "House",
  "раскидать/Pop": "Pop",
  "Liquid Drum and Bass Vocal Female": "Liquid DnB",
  "Liquid Drum and Bass Mix 2026": "Liquid DnB",
  "Liquid Drum and Bass": "Liquid DnB",
  "раскидать/Nu Disco:Indie Dance": "Nu Disco",
  "раскидать/Dubstep": "Dubstep",
  "Latest Garage Vibes  UKG  House/UKG  House": "UK Garage",
  "bASSline & UKG/bASSline & UKG": "UK Garage",
  "bASSline & UKG": "UK Garage",
};

// A genre with fewer tracks than this is reported, not written.
export const MIN_TRACKS = 20;

// The genre a track's folder names, or null.
export function folderGenre(path) {
  if (typeof path !== "string" || !path.startsWith(LIBRARY_ROOT)) return null;
  const rest = path.slice(LIBRARY_ROOT.length);
  return FOLDER_GENRE[rest.slice(0, rest.lastIndexOf("/"))] || null;
}

// "file://localhost/Volumes/..." -> "/Volumes/..."
export function locationPath(location) {
  try {
    return decodeURIComponent(String(location || "").replace(/^file:\/\/localhost/, "")).replace(/^\/\//, "/");
  } catch (e) {
    return "";
  }
}

// Linear-interpolated percentile of a sorted array, q in [0, 1].
export function percentile(sorted, q) {
  if (sorted.length === 0) return NaN;
  const at = (sorted.length - 1) * q;
  const lo = Math.floor(at), hi = Math.ceil(at);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (at - lo);
}

/*
 * A tempo brought into the octave around `centre`: halved or doubled until it
 * is within a factor of √2 of it. Rekordbox counts much 90s hip-hop at double
 * time (median 176) and some at normal time; a range over both would span an
 * octave and say nothing. Returns { bpm, folded }.
 */
export function foldTempo(bpm, centre) {
  let value = bpm, folded = false;
  while (value > centre * Math.SQRT2) { value /= 2; folded = true; }
  while (value < centre / Math.SQRT2) { value *= 2; folded = true; }
  return { bpm: value, folded };
}

/*
 * One genre's row: count, median and the 10th and 90th percentiles of the
 * tempo after folding into the octave of the raw median, and the share of
 * tracks that needed folding -- kept, not thrown away, because a genre where
 * a third of the tracks are counted at double time is told apart by that too.
 */
export function genreRow(bpms) {
  const raw = bpms.slice().sort((a, b) => a - b);
  const centre = percentile(raw, 0.5);
  const folded = bpms.map((b) => foldTempo(b, centre));
  const values = folded.map((f) => f.bpm).sort((a, b) => a - b);
  const round = (x) => Math.round(x * 10) / 10;
  return {
    n: bpms.length,
    median: round(percentile(values, 0.5)),
    p10: round(percentile(values, 0.1)),
    p90: round(percentile(values, 0.9)),
    alt_tempo_share: Math.round((folded.filter((f) => f.folded).length / bpms.length) * 1000) / 1000,
  };
}

// { genre: row } for genres with at least MIN_TRACKS tracks, and the rest apart.
export function buildTable(tracks) {
  const byGenre = {};
  for (const t of tracks) (byGenre[t.genre] = byGenre[t.genre] || []).push(t.bpm);
  const table = {}, small = {};
  for (const genre of Object.keys(byGenre).sort()) {
    if (byGenre[genre].length >= MIN_TRACKS) table[genre] = genreRow(byGenre[genre]);
    else small[genre] = byGenre[genre].length;
  }
  return { table, small };
}

/*
 * How well a tempo fits each genre: a log-normal around the median with the
 * spread of the 10th-90th range, at whichever of bpm, bpm/2 and bpm*2 fits
 * best -- weighted by how often that genre's tracks sit at the other octave
 * when it is not bpm itself -- times the genre's share of the table. Returns
 * [{ genre, score }] best first, the scores summing to 1.
 */
export function tempoScores(table, bpm) {
  const total = Object.values(table).reduce((s, r) => s + r.n, 0);
  const out = [];
  for (const [genre, row] of Object.entries(table)) {
    const sigma = Math.max(0.01, (Math.log(row.p90) - Math.log(row.p10)) / 2.563);
    let best = 0;
    for (const [value, alt] of [[bpm, false], [bpm / 2, true], [bpm * 2, true]]) {
      const z = (Math.log(value) - Math.log(row.median)) / sigma;
      const octave = alt ? row.alt_tempo_share + 0.01 : 1 - row.alt_tempo_share;
      best = Math.max(best, Math.exp(-0.5 * z * z) * octave);
    }
    out.push({ genre, score: best * (row.n / total) });
  }
  const sum = out.reduce((s, x) => s + x.score, 0) || 1;
  return out.map((x) => ({ ...x, score: x.score / sum })).sort((a, b) => b.score - a.score);
}

/*
 * The tempo as a weak tie-break between the genres the sources returned:
 * keep `current` unless another candidate the table knows fits the tempo
 * `margin` times better. A candidate the table does not know is never chosen
 * by tempo, and the current answer is kept when the table does not know it.
 */
export function pickByTempo(table, bpm, current, candidates, margin) {
  if (!current || !table[current]) return current;
  const scores = Object.fromEntries(tempoScores(table, bpm).map((x) => [x.genre, x.score]));
  let best = current;
  for (const genre of candidates) {
    if (table[genre] && scores[genre] > scores[best] * margin) best = genre;
  }
  return best;
}

// Which half a track is in: a fixed hash of its path, so reruns agree.
export function half(path, seed = 1) {
  let h = 2166136261 ^ seed;
  for (let i = 0; i < path.length; i++) h = Math.imul(h ^ path.charCodeAt(i), 16777619);
  return (h >>> 0) % 2 === 0 ? "train" : "test";
}

// The collection's tracks with a folder genre and a tempo.
export function readTracks(xml) {
  const tracks = [];
  for (const m of xml.matchAll(/<TRACK\s[^>]*?Location="([^"]*)"[^>]*>/g)) {
    const tag = m[0];
    const attr = (name) => { const a = tag.match(new RegExp("\\s" + name + "=\"([^\"]*)\"")); return a ? a[1] : ""; };
    const path = locationPath(m[1]);
    const bpm = Number(attr("AverageBpm"));
    const genre = folderGenre(path);
    if (genre && bpm > 0) tracks.push({ path, bpm, genre, tonality: attr("Tonality") });
  }
  return tracks;
}

function mcnemar(pairs) {
  const b = pairs.filter(([a, n]) => a && !n).length;
  const c = pairs.filter(([a, n]) => !a && n).length;
  return { onlyBefore: b, onlyAfter: c, chi2: b + c ? ((Math.abs(b - c) - 1) ** 2) / (b + c) : 0 };
}

function evaluate(tracks) {
  const train = tracks.filter((t) => half(t.path) === "train");
  const test = tracks.filter((t) => half(t.path) === "test");
  const { table } = buildTable(train);
  const pct = (k, n) => (n ? ((100 * k) / n).toFixed(1) + "%" : "-");
  console.log(`train ${train.length}, test ${test.length} tracks; table on train: ${Object.keys(table).length} genres\n`);

  // 1. The genre from the tempo alone.
  const majority = Object.entries(table).sort((a, b) => b[1].n - a[1].n)[0][0];
  const scored = test.filter((t) => table[t.genre]);
  const top = (t, k) => tempoScores(table, t.bpm).slice(0, k).map((x) => x.genre);
  console.log("1. GENRE FROM TEMPO ALONE (test half, genres in the table)");
  console.log(`   always "${majority}": ${pct(scored.filter((t) => t.genre === majority).length, scored.length)} exact`);
  console.log(`   tempo, top 1: ${pct(scored.filter((t) => top(t, 1)[0] === t.genre).length, scored.length)}   top 3: ${pct(scored.filter((t) => top(t, 3).includes(t.genre)).length, scored.length)}   (${scored.length} tracks)`);
  console.log("   per genre: n, top-1, top-3, what it says most");
  for (const genre of Object.keys(table)) {
    const g = scored.filter((t) => t.genre === genre);
    if (!g.length) continue;
    const said = {};
    for (const t of g) said[top(t, 1)[0]] = (said[top(t, 1)[0]] || 0) + 1;
    const common = Object.entries(said).sort((a, b) => b[1] - a[1]).slice(0, 2).map(([k, v]) => `${k} ${v}`).join(", ");
    console.log(`   ${genre.padEnd(22)} ${String(g.length).padStart(4)}  ${pct(g.filter((t) => top(t, 1)[0] === genre).length, g.length).padStart(6)}  ${pct(g.filter((t) => top(t, 3).includes(genre)).length, g.length).padStart(6)}   ${common}`);
  }

  // 2. The tempo between the sources' candidates, replayed.
  const sourcesFile = join(ROOT, "ground-truth/genre_sources.json");
  if (!existsSync(sourcesFile)) {
    console.log("\n2. skipped: ground-truth/genre_sources.json (the sources' saved answers) is missing");
    return;
  }
  const bpmOf = new Map(tracks.map((t) => [t.path, t.bpm]));
  const rows = JSON.parse(readFileSync(sourcesFile, "utf8")).rows
    .map((r) => ({ ...r, truth: folderGenre(r.file), bpm: bpmOf.get(r.file) }))
    .filter((r) => r.truth && r.bpm);
  const candidatesOf = (r) => [...new Set(Object.values(r.answers).filter((a) => a && a.genre && a.genre !== "Unknown").map((a) => a.genre))];
  const appOf = (r) => (r.answers.app && r.answers.app.genre !== "Unknown" ? r.answers.app.genre : null);
  const run = (set, margin) => set.map((r) => ({ r, before: appOf(r), after: pickByTempo(table, r.bpm, appOf(r), candidatesOf(r), margin) }));

  console.log(`\n2. TEMPO BETWEEN THE SOURCES' CANDIDATES (ground-truth/genre_sources.json, ${rows.length} tracks with a folder genre)`);
  console.log("   candidates = every genre Discogs, MusicBrainz, iTunes or the app returned; current = the app's answer");
  const trainRows = rows.filter((r) => half(r.file) === "train"), testRows = rows.filter((r) => half(r.file) === "test");
  // The margin is chosen on the train half and only then scored on the test half.
  let margin = 1, bestGain = -Infinity;
  for (const m of [1, 1.5, 2, 3, 5, 10]) {
    const res = run(trainRows, m);
    const gain = res.filter((x) => x.after === x.r.truth).length - res.filter((x) => x.before === x.r.truth).length;
    console.log(`   train, margin ${String(m).padEnd(4)}: exact ${res.filter((x) => x.after === x.r.truth).length} vs ${res.filter((x) => x.before === x.r.truth).length}, changed ${res.filter((x) => x.after !== x.before).length}`);
    if (gain > bestGain) { bestGain = gain; margin = m; }
  }
  const res = run(testRows, margin);
  const multi = res.filter((x) => candidatesOf(x.r).length > 1);
  console.log(`   test (${testRows.length} tracks, ${multi.length} with more than one candidate), margin ${margin}:`);
  console.log(`     exact: before ${res.filter((x) => x.before === x.r.truth).length}, after ${res.filter((x) => x.after === x.r.truth).length}; answered before ${res.filter((x) => x.before).length}, after ${res.filter((x) => x.after).length}`);
  const t = mcnemar(res.map((x) => [x.before === x.r.truth, x.after === x.r.truth]));
  console.log(`     McNemar: right only before ${t.onlyBefore}, only after ${t.onlyAfter}, chi2 ${t.chi2.toFixed(2)} (3.84 = p 0.05)`);
  for (const x of res.filter((x) => x.after !== x.before)) {
    console.log(`     changed: ${x.before} -> ${x.after} at ${x.r.bpm} BPM (folder: ${x.r.truth})`);
  }

  // 3. A tempo guess where the app said Unknown, marked weak.
  const unknown = testRows.filter((r) => !appOf(r));
  const guess = unknown.map((r) => ({ r, g: tempoScores(table, r.bpm)[0].genre }));
  console.log(`\n3. A TEMPO GUESS WITH "?" INSTEAD OF UNKNOWN (test half, ${unknown.length} tracks the app left Unknown)`);
  console.log(`   right ${guess.filter((x) => x.g === x.r.truth).length}, wrong ${guess.filter((x) => x.g !== x.r.truth).length}`);
  const conf = {};
  for (const x of guess) conf[x.g] = (conf[x.g] || 0) + 1;
  console.log(`   what it guesses: ${Object.entries(conf).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k} ${v}`).join(", ")}`);
}

function main() {
  const file = process.argv[2];
  if (!file || !existsSync(file)) {
    console.error("usage: node tools/build/build_genre_bpm.mjs EXPORT.xml [--evaluate] [--out PATH]");
    process.exit(2);
  }
  const tracks = readTracks(readFileSync(file, "utf8"));
  if (process.argv.includes("--evaluate")) return evaluate(tracks);
  const { table, small } = buildTable(tracks);
  const i = process.argv.indexOf("--out");
  const out = i > 0 ? process.argv[i + 1] : join(ROOT, "web/data/genre_bpm.json");
  writeFileSync(out, JSON.stringify(table, null, 1) + "\n");
  console.log(`${tracks.length} tracks with a folder genre and a tempo -> ${out}`);
  console.log("genre                    n   median   p10    p90   alt");
  for (const [genre, r] of Object.entries(table)) {
    console.log(`${genre.padEnd(22)} ${String(r.n).padStart(4)}  ${String(r.median).padStart(6)}  ${String(r.p10).padStart(5)}  ${String(r.p90).padStart(5)}  ${(r.alt_tempo_share * 100).toFixed(1)}%`);
  }
  if (Object.keys(small).length) console.log("too few tracks, left out: " + Object.entries(small).map(([g, n]) => `${g} ${n}`).join(", "));
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main();
