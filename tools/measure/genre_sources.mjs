/*
 * Which genre sources are right, and where they disagree -- measured without
 * treating the owner's folders as the truth.
 *
 * Why not the folders
 * -------------------
 * measure_genre.mjs scores the app against the folders tracks were filed in.
 * Those are one DJ's shelves, not a reference: a folder called "House" holds
 * whatever was played in house sets. So this script asks the sources against
 * each other instead.
 *
 * What is asked
 * -------------
 * Every source identify.js uses, each on its own, for the same tracks:
 *
 *   discogs      the style Discogs' releases carry (track-level)
 *   mbRecording  MusicBrainz tags on the matched recording (track-level)
 *   itunes       iTunes' primaryGenreName for the matched song (track-level)
 *   mbArtist     MusicBrainz tags on the artist (artist-level, weaker)
 *   app          what resolveGenreFrom decides from all of them, in its order
 *
 * Each answer is mapped onto the app's 53 categories by genres_map.json, as
 * the app maps it. A lookup that failed (network, rate limit) is recorded as a
 * failure, not as "no match" -- the two mean different things.
 *
 * The reference
 * -------------
 * A track's genre counts as known when two track-level sources independently
 * name the same category. Each source is then scored against the agreement of
 * the OTHER two, so no source is judged by a reference it helped make.
 *
 * Testers' corrections from the admin page are a second, weak signal: few, and
 * from few people. With --feedback FILE (a JSON array of {artist, title,
 * corrected} rows, exported from D1 into ground-truth/, never committed) each
 * corrected track is asked of the sources too.
 *
 * Nothing in identify.js is changed or reordered by this; it only measures.
 *
 * Result (2026-10-27, 309 library tracks, 12 per folder, 10 corrections)
 * ---------------------------------------------------------------------
 * Coverage is the problem, not disagreement. Discogs answered 31%, iTunes 48%,
 * MusicBrainz recording tags 7%, artist tags 45%; the app 54%. Two track-level
 * sources agreed on only 20 tracks (6.5%) -- too few to rank the sources by.
 * Where Discogs and iTunes both answered they conflict 72% of the time, mostly
 * because iTunes says "Dance"/"Electronic" where Discogs names the style (UK
 * Garage, Dubstep, House). Artist-level tags matched the agreed genre 4 times
 * in 14, and lookups by remixer name hit namesakes ("power metal" for a remix).
 * On 142 tracks the app said Unknown; iTunes had a genre for 50 of them, a
 * specific one (not Dance/Electronic/Pop) for 21 -- iTunes is used to identify
 * the track but its genre is not used. Testers: 7 of 10 corrections are to
 * Breakbeat; iTunes said Breakbeat on 3 of them, no other source on any.
 *
 * Usage
 * -----
 *   node tools/measure/genre_sources.mjs [--per-folder N] [--seed N] [--feedback FILE] [--out FILE]
 *   node tools/measure/genre_sources.mjs --rescore [--out FILE]
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { basename, dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { ROOT, arg } from "./lib/measure.mjs";

const LIBRARY_ROOT = "/Volumes/HomeSSD/Lochin";
export const SOURCES = ["discogs", "mbRecording", "itunes", "mbArtist"];
export const TRACK_SOURCES = ["discogs", "mbRecording", "itunes"];

/* ------------------------------------------------------------------ */
/* Scoring -- exported for tools/test/test_genre_sources.mjs           */
/* ------------------------------------------------------------------ */

/*
 * How two categories relate: "same", "related" (one is the other's parent, or
 * they share one), or "conflict". `parents` is identify.js's GENRE_PARENTS.
 */
export function relate(a, b, parents) {
  if (!a || !b) return null;
  if (a === b) return "same";
  if (parents[a] === b || parents[b] === a) return "related";
  if (parents[a] && parents[a] === parents[b]) return "related";
  return "conflict";
}

// The category two of the other track-level sources agree on, or null.
export function consensusWithout(answers, excluded) {
  const others = TRACK_SOURCES.filter((s) => s !== excluded)
    .map((s) => answers[s] && answers[s].genre)
    .filter((g) => g && g !== "Unknown");
  if (others.length < 2) return null;
  return others[0] === others[1] ? others[0] : null;
}

// The category at least two track-level sources agree on, or null.
export function consensus(answers) {
  const votes = {};
  for (const s of TRACK_SOURCES) {
    const g = answers[s] && answers[s].genre;
    if (g && g !== "Unknown") votes[g] = (votes[g] || 0) + 1;
  }
  const top = Object.entries(votes).sort((a, b) => b[1] - a[1])[0];
  return top && top[1] >= 2 ? top[0] : null;
}

/* ------------------------------------------------------------------ */
/* Lookups                                                             */
/* ------------------------------------------------------------------ */

// Same User-Agent as measure_genre.mjs: MusicBrainz refuses requests without one.
const realFetch = globalThis.fetch;
globalThis.fetch = (url, init = {}) => realFetch(url, {
  ...init,
  headers: { "User-Agent": "MuzykalnySortir-measurement/1.0 (https://sortirovator.pages.dev)", ...(init.headers || {}) },
});

function loadIdentify() {
  const code = readFileSync(join(ROOT, "web/js/identify.js"), "utf8");
  // eslint-disable-next-line no-new-func
  return new Function(code + `
return { resolveGenreFrom, parseFilename, usableTag, GENRE_PARENTS, discogsGenre, musicbrainzGenre,
  musicbrainzArtistGenre, searchItunes, textSimilarity, coreTitle, firstMappedGenre, takeLookupError,
  IDENTIFY_MIN_CORE_TITLE_SIMILARITY, IDENTIFY_MIN_TITLE_SIMILARITY, IDENTIFY_MIN_ARTIST_SIMILARITY };`)();
}

function fileTags(file) {
  try {
    const out = execFileSync("ffprobe", ["-v", "quiet", "-show_entries", "format_tags=genre,artist,title",
      "-of", "default=nw=1", file], { encoding: "utf8", timeout: 20000 });
    const tags = {};
    for (const line of out.trim().split("\n")) {
      const at = line.indexOf("=");
      if (at > 0) tags[line.slice(0, at).replace(/^TAG:/, "").toLowerCase()] = line.slice(at + 1);
    }
    return tags;
  } catch {
    return {};
  }
}

/*
 * iTunes' genre for the song identify.js would match. tryIdentifyItunes keeps
 * the match but drops primaryGenreName, so its acceptance test is repeated here
 * with the same thresholds.
 */
async function itunesGenre(id, artist, track, genresMap) {
  const results = await id.searchItunes(artist, track, 8);
  let best = null;
  let bestScore = -1;
  for (const r of results) {
    if (!r.trackName || !r.artistName) continue;
    const t = id.textSimilarity(track, r.trackName);
    const a = id.textSimilarity(artist, r.artistName);
    const c = id.textSimilarity(id.coreTitle(track), id.coreTitle(r.trackName));
    if (c < id.IDENTIFY_MIN_CORE_TITLE_SIMILARITY || t < id.IDENTIFY_MIN_TITLE_SIMILARITY
      || a < id.IDENTIFY_MIN_ARTIST_SIMILARITY) continue;
    if (c * 2 + t + a > bestScore) { bestScore = c * 2 + t + a; best = r; }
  }
  if (!best || !best.primaryGenreName) return null;
  const found = id.firstMappedGenre([best.primaryGenreName], genresMap, true);
  return found ? { genre: found.genre, tag: best.primaryGenreName } : { genre: null, tag: best.primaryGenreName };
}

async function ask(id, fn) {
  id.takeLookupError();
  try {
    const answer = await fn();
    const error = id.takeLookupError();
    if (error && !answer) return { failed: error };
    return answer || null;
  } catch (e) {
    return { failed: String(e.message || e) };
  }
}

async function lookupAll(id, genresMap, artist, track, fileGenre) {
  const answers = {};
  answers.discogs = await ask(id, () => id.discogsGenre(artist, track, genresMap));
  answers.mbRecording = await ask(id, () => id.musicbrainzGenre(artist, track, genresMap, null));
  answers.itunes = await ask(id, () => itunesGenre(id, artist, track, genresMap));
  answers.mbArtist = await ask(id, () => id.musicbrainzArtistGenre(artist, genresMap));
  try {
    const app = await id.resolveGenreFrom({
      tags: { genre: fileGenre || null }, artist, track, genresMap,
      options: { useDiscogs: true, useMusicbrainz: true, lastfmKey: "" }, recordingId: null,
      itunesGenre: answers.itunes && answers.itunes.tag || null,
    }, { correctionFor: () => null, t: (key) => key });
    answers.app = { genre: app.genre, tag: app.source };
  } catch (e) {
    answers.app = { failed: String(e.message || e) };
  }
  return answers;
}

/* ------------------------------------------------------------------ */
/* Report                                                              */
/* ------------------------------------------------------------------ */

function report(rows, parents) {
  const pct = (k, n) => (n ? ((100 * k) / n).toFixed(1) + "%" : "-");
  const library = rows.filter((r) => !r.corrected);
  console.log(`\n=== ${library.length} library tracks ===`);

  console.log("\nanswers per source:");
  for (const s of [...SOURCES, "app"]) {
    const a = library.map((r) => r.answers[s]);
    const answered = a.filter((x) => x && x.genre && x.genre !== "Unknown").length;
    const failed = a.filter((x) => x && x.failed).length;
    const unmapped = a.filter((x) => x && !x.failed && !x.genre && x.tag).length;
    console.log(`  ${s.padEnd(12)} answered ${pct(answered, a.length).padStart(6)}   lookup failed ${pct(failed, a.length).padStart(6)}   tag with no category ${unmapped}`);
  }

  const known = library.filter((r) => consensus(r.answers));
  console.log(`\nreference: ${known.length} tracks (${pct(known.length, library.length)}) where two track-level sources agree`);

  console.log("\neach source against the agreement of the other two:");
  for (const s of [...SOURCES, "app"]) {
    let n = 0, same = 0, related = 0;
    for (const r of library) {
      const ref = s === "app" || s === "mbArtist" ? consensus(r.answers) : consensusWithout(r.answers, s);
      const g = r.answers[s] && r.answers[s].genre;
      if (!ref || !g || g === "Unknown") continue;
      n++;
      const rel = relate(g, ref, parents);
      if (rel === "same") same++;
      if (rel === "related") related++;
    }
    const note = s === "app" || s === "mbArtist" ? " (reference uses all three track sources)" : "";
    console.log(`  ${s.padEnd(12)} n=${String(n).padStart(4)}   same ${pct(same, n).padStart(6)}   related ${pct(related, n).padStart(6)}   conflict ${pct(n - same - related, n).padStart(6)}${note}`);
  }

  console.log("\npairwise, where both answered (same / related / conflict):");
  for (let i = 0; i < SOURCES.length; i++) {
    for (let j = i + 1; j < SOURCES.length; j++) {
      const [a, b] = [SOURCES[i], SOURCES[j]];
      const counts = { same: 0, related: 0, conflict: 0 };
      for (const r of library) {
        const rel = relate(r.answers[a] && r.answers[a].genre, r.answers[b] && r.answers[b].genre, parents);
        if (rel) counts[rel]++;
      }
      const n = counts.same + counts.related + counts.conflict;
      console.log(`  ${(a + " / " + b).padEnd(26)} n=${String(n).padStart(4)}   ${pct(counts.same, n)} / ${pct(counts.related, n)} / ${pct(counts.conflict, n)}`);
    }
  }

  const conflicts = {};
  for (const r of library) {
    const d = r.answers.discogs && r.answers.discogs.genre;
    for (const s of ["mbRecording", "itunes"]) {
      const g = r.answers[s] && r.answers[s].genre;
      if (relate(d, g, parents) === "conflict") {
        const k = `Discogs ${d}  vs  ${s} ${g}`;
        conflicts[k] = (conflicts[k] || 0) + 1;
      }
    }
  }
  console.log("\ncommonest conflicts with Discogs:");
  for (const [k, n] of Object.entries(conflicts).sort((a, b) => b[1] - a[1]).slice(0, 12)) console.log(`  ${String(n).padStart(3)}  ${k}`);

  const itunesTags = {};
  for (const r of library) {
    const x = r.answers.itunes;
    if (x && x.tag) itunesTags[x.tag + " -> " + (x.genre || "(none)")] = (itunesTags[x.tag + " -> " + (x.genre || "(none)")] || 0) + 1;
  }
  console.log("\niTunes genres seen and where they map:");
  console.log("  " + Object.entries(itunesTags).sort((a, b) => b[1] - a[1]).slice(0, 15).map(([k, n]) => `${k} (${n})`).join("; "));

  const fb = rows.filter((r) => r.corrected);
  if (fb.length) {
    console.log(`\n=== ${fb.length} testers' corrections ===`);
    for (const s of [...SOURCES, "app"]) {
      const a = fb.filter((r) => r.answers[s] && r.answers[s].genre);
      const same = a.filter((r) => relate(r.answers[s].genre, r.corrected, parents) === "same").length;
      console.log(`  ${s.padEnd(12)} answered ${a.length}/${fb.length}, agrees with the correction ${same}`);
    }
  }
}

/* ------------------------------------------------------------------ */
/* Main                                                                */
/* ------------------------------------------------------------------ */

function mulberry32(seed) {
  return function () {
    seed |= 0; seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

async function main() {
  const outPath = arg("--out", join(ROOT, "ground-truth/genre_sources.json"));
  const id = loadIdentify();
  if (process.argv.includes("--rescore")) {
    report(JSON.parse(readFileSync(outPath, "utf8")).rows, id.GENRE_PARENTS);
    return;
  }
  const genresMap = JSON.parse(readFileSync(join(ROOT, "web/data/genres_map.json"), "utf8"));
  const db = JSON.parse(readFileSync(join(ROOT, "ground-truth/rekordbox_db.json"), "utf8")).byPath;
  const perFolder = parseInt(arg("--per-folder", "4"), 10);
  const seed = parseInt(arg("--seed", "1"), 10);

  // A few tracks from every folder, seeded per folder (see measure_genre.mjs).
  const buckets = {};
  for (const p of Object.keys(db)) {
    if (!existsSync(p)) continue;
    (buckets[dirname(relative(LIBRARY_ROOT, p))] ||= []).push(p);
  }
  const tasks = [];
  for (const [folder, paths] of Object.entries(buckets)) {
    let h = seed;
    for (let i = 0; i < folder.length; i++) h = Math.imul(h ^ folder.charCodeAt(i), 16777619);
    const rnd = mulberry32(h);
    const shuffled = paths.slice().sort();
    for (let i = shuffled.length - 1; i > 0; i--) {
      const j = Math.floor(rnd() * (i + 1));
      [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
    }
    for (const p of shuffled.slice(0, perFolder)) tasks.push({ file: p, folder });
  }
  if (tasks.length === 0) {
    console.error("no tracks found under " + LIBRARY_ROOT + " -- is the drive mounted? Nothing was measured.");
    process.exit(1);
  }
  const feedbackFile = arg("--feedback", null);
  if (feedbackFile) {
    for (const f of JSON.parse(readFileSync(feedbackFile, "utf8"))) {
      if (f.artist && f.title && f.corrected) tasks.push({ artist: f.artist, title: f.title, corrected: f.corrected });
    }
  }
  process.stderr.write(`${tasks.length} tracks\n`);

  const rows = [];
  const save = () => {
    mkdirSync(dirname(outPath), { recursive: true });
    writeFileSync(outPath, JSON.stringify({ rows }, null, 1));
  };
  for (const task of tasks) {
    let artist = task.artist;
    let track = task.title;
    let fileGenre = null;
    if (task.file) {
      const tags = fileTags(task.file);
      const parsed = id.parseFilename(basename(task.file));
      artist = id.usableTag(tags.artist) || parsed.artist;
      track = id.usableTag(tags.title) || parsed.track;
      fileGenre = tags.genre || null;
    }
    const answers = artist && track ? await lookupAll(id, genresMap, artist, track, fileGenre) : {};
    rows.push({ file: task.file || null, folder: task.folder || null, artist, track, corrected: task.corrected || null, answers });
    if (rows.length % 10 === 0) save();
    process.stderr.write(`\r  ${rows.length}/${tasks.length}`);
  }
  process.stderr.write("\n");
  save();
  console.log("written to %s", outPath);
  report(rows, id.GENRE_PARENTS);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main();
