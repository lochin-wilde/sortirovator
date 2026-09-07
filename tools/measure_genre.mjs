/*
 * Scores the app's genre decision against the owner's own filing.
 *
 * Ground truth
 * ------------
 * Not the Rekordbox database. Its genre field is filled in on 495 of 2764
 * tracks and most of what is there came from whatever stamped the ID3 tag --
 * "RUSSIAN", "Other", "UNDERGROUND", "Electro, Dance". That is not a judgement
 * about the music.
 *
 * The folder tree is. A DJ who put a track in "Funky Disco House" decided that
 * it belongs there, which is exactly the question the app is trying to answer.
 * Only folders that map onto one of our 53 categories are used; the rest are
 * listed at the end as gaps in the vocabulary rather than quietly dropped.
 *
 * What is actually run
 * --------------------
 * resolveGenreFrom, from identify.js -- the same function the page calls, with
 * real network lookups. The two things it takes from the page are supplied
 * here: no user corrections and untranslated labels. Artist and title come from
 * the file's tags with the filename parse behind them, matching app.js:550.
 *
 * Rate limits make this slow, not heavy: Discogs is held to one request every
 * 2.5 seconds inside identify.js, so the run is sequential by nature and a
 * couple of hundred tracks take tens of minutes. Sample rather than sweep.
 *
 * Filename orientation
 * --------------------
 * Every result still records which way round the filename reads, because it is
 * the fallback whenever a file has no usable tags -- 12% of this library. The
 * column is what showed the problem in the first place: before parseFilename
 * learned to detect an inverted name, tracks in that group scored 0 of 50.
 *
 * Usage
 * -----
 *   node tools/measure_genre.mjs [--per-folder N] [--seed N] [--out FILE]
 */

import { readFileSync, existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { basename, dirname, join, relative } from "node:path";
import { ROOT, arg, writeResults } from "./lib/measure.mjs";

const LIBRARY_ROOT = "/Volumes/HomeSSD/Lochin";

/*
 * Folders whose name states a genre plainly, mapped to our vocabulary.
 *
 * Deliberately conservative. Dated dumps ("New Music", "06.05") say nothing
 * about genre, and a folder whose genre we have no category for is listed as a
 * gap instead of being forced into the nearest one -- scoring a Nu Disco track
 * against "Disco" would measure the mapping, not the detector.
 */
const FOLDER_GENRE = {
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
};

// Folders that describe a genre we have no category for.
const VOCABULARY_GAPS = {
  "UKDub": "Dub",
};

/*
 * Give the requests a User-Agent.
 *
 * This restores parity rather than changing behaviour: a browser attaches a
 * User-Agent to every request and cannot be stopped from doing so, while Node
 * sends none. MusicBrainz answers 403 to a request without one, so without this
 * the harness would report MusicBrainz as useless and send every track to the
 * audio fallback -- measuring the harness instead of the app. Their guidelines
 * ask that the agent identify the application and give a contact address.
 */
const realFetch = globalThis.fetch;
globalThis.fetch = (url, init = {}) => realFetch(url, {
  ...init,
  headers: {
    "User-Agent": "MuzykalnySortir-measurement/1.0 (https://sortirovator.pages.dev)",
    ...(init.headers || {}),
  },
});

const identify = (() => {
  const code = readFileSync(join(ROOT, "web/js/identify.js"), "utf8");
  // eslint-disable-next-line no-new-func
  return new Function(code
    + "\nreturn { resolveGenreFrom, parseFilename, usableTag, GENRE_PARENTS };")();
})();

// The app reads the ID3 genre with tags.js, which needs an ArrayBuffer and a
// browser's decoders. ffprobe reads the same field and is enough here: the tag
// only matters as a last resort, after every lookup has come back empty.
function fileTags(file) {
  try {
    const out = execFileSync("ffprobe", ["-v", "quiet", "-show_entries",
      "format_tags=genre,artist,title", "-of", "default=nw=1", file],
      { encoding: "utf8", timeout: 20000 });
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

const norm = (s) => String(s || "").toLowerCase().replace(/[^\p{L}\p{N}]/gu, "");

/*
 * Which side of the " - " actually holds the artist, decided by the database
 * rather than by guessing -- this is the yardstick the parser is judged against,
 * so it must not come from the parser.
 */
function orientation(file, meta) {
  if (!meta || !meta.artist || !meta.title) return "unknown";
  const { artist } = identify.parseFilename(basename(file));
  if (!artist) return "no separator";
  const left = norm(artist);
  const a = norm(meta.artist);
  const t = norm(meta.title);
  const looksArtist = a.includes(left) || left.includes(a);
  const looksTitle = t.includes(left) || left.includes(t);
  if (looksArtist && !looksTitle) return "artist first";
  if (looksTitle && !looksArtist) return "title first";
  return "ambiguous";
}

// Old School Hip-Hop is produced by applyEra rather than by the parent map, so
// the two halves of the era split have to be related explicitly.
const ERA_SIBLINGS = { "Old School Hip-Hop": "Hip-Hop", "Hip-Hop": "Old School Hip-Hop" };

function classify(ours, truth) {
  if (!ours || ours === "Unknown") return "unknown";
  if (ours === truth) return "exact";
  if (ERA_SIBLINGS[truth] === ours) return "era";
  if (identify.GENRE_PARENTS[ours] === truth) return "too specific";
  if (identify.GENRE_PARENTS[truth] === ours) return "too broad";
  if (identify.GENRE_PARENTS[ours]
    && identify.GENRE_PARENTS[ours] === identify.GENRE_PARENTS[truth]) return "sibling";
  return "wrong";
}

const CATEGORIES = ["exact", "era", "too broad", "too specific", "sibling", "wrong", "unknown"];

function mulberry32(seed) {
  return function () {
    seed |= 0; seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

async function main() {
  const db = JSON.parse(readFileSync(join(ROOT, "ground-truth/rekordbox_db.json"), "utf8")).byPath;
  const genresMap = JSON.parse(readFileSync(join(ROOT, "web/data/genres_map.json"), "utf8"));
  const perFolder = parseInt(arg("--per-folder", "30"), 10);
  const outPath = arg("--out", join(ROOT, "ground-truth/genre_results.json"));
  const seed = parseInt(arg("--seed", "1"), 10);

  const buckets = {};
  for (const path of Object.keys(db)) {
    if (!existsSync(path)) continue;
    const folder = dirname(relative(LIBRARY_ROOT, path));
    const truth = FOLDER_GENRE[folder];
    if (!truth) continue;
    (buckets[folder] ||= []).push(path);
  }

  const tasks = [];
  for (const [folder, paths] of Object.entries(buckets)) {
    /*
     * Seeded per folder, not once for the whole run.
     *
     * A single stream shared across folders means adding a folder shifts every
     * draw after it, so two runs cannot be compared track by track -- which is
     * exactly what happened between the first two runs here, and it left a
     * change in Discogs precision impossible to separate from a change of
     * sample. Folding the folder name into the seed keeps each folder's draw
     * fixed no matter what else is measured alongside it.
     */
    let h = seed;
    for (let i = 0; i < folder.length; i++) h = Math.imul(h ^ folder.charCodeAt(i), 16777619);
    const rnd = mulberry32(h);
    const shuffled = paths.slice().sort();
    for (let i = shuffled.length - 1; i > 0; i--) {
      const j = Math.floor(rnd() * (i + 1));
      [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
    }
    for (const p of shuffled.slice(0, perFolder)) {
      tasks.push({ file: p, folder, truth: FOLDER_GENRE[folder] });
    }
  }

  /*
   * Stop rather than report on nothing.
   *
   * The library lives on an external drive. With it unmounted every path fails
   * existsSync, the buckets come out empty, and the run happily prints a table
   * of NaN% -- which looks like a measurement and is not one. An empty sample is
   * a broken setup, so it is an error.
   */
  if (tasks.length === 0) {
    console.error("no tracks found under " + LIBRARY_ROOT
      + "\nIs the drive mounted? Nothing was measured.");
    process.exit(1);
  }

  process.stderr.write(`${tasks.length} tracks across ${Object.keys(buckets).length} folders\n`);

  /*
   * Two configurations, run over the same tracks in the same process.
   *
   * Comparing against an earlier run cannot answer "did Last.fm help?", because
   * the sample moves between runs and the difference is then part source, part
   * draw -- that mistake already cost one comparison here. Resolving each track
   * twice removes the question: the only thing that differs is the key.
   *
   * It is affordable because identify.js caches Discogs and both artist-level
   * lookups, so the second pass mostly re-reads memory. The baseline runs first
   * on purpose: it walks the full chain down to the artist sources and leaves
   * their caches warm for the pass that follows.
   *
   * The key comes from the environment. It is a credential and does not belong
   * in a file that gets committed.
   */
  const lastfmKey = process.env.LASTFM_KEY || "";
  const baseOptions = { useDiscogs: true, useMusicbrainz: true, lastfmKey: "" };
  const lastfmOptions = { useDiscogs: true, useMusicbrainz: true, lastfmKey };
  if (lastfmKey) process.stderr.write("Last.fm key present -- running paired A/B\n");
  const results = [];
  let done = 0;

  for (const task of tasks) {
    // app.js:550 -- tags first, the filename parse as the fallback.
    const tags = fileTags(task.file);
    const parsed = identify.parseFilename(basename(task.file));
    const artist = identify.usableTag(tags.artist) || parsed.artist;
    const track = identify.usableTag(tags.title) || parsed.track;
    const run = async (opts) => {
      try {
        return await identify.resolveGenreFrom({
          tags: { genre: tags.genre || null },
          artist, track, genresMap, options: opts, recordingId: null,
        }, { correctionFor: () => null, t: (key) => key });
      } catch (e) {
        return { genre: null, source: "error: " + (e.message || e) };
      }
    };

    const base = await run(baseOptions);
    const withLastfm = lastfmKey ? await run(lastfmOptions) : base;

    results.push({
      file: task.file, folder: task.folder, truth: task.truth,
      ours: withLastfm.genre, source: withLastfm.source,
      baseGenre: base.genre, baseSource: base.source,
      baseVerdict: classify(base.genre, task.truth),
      parsedArtist: artist, parsedTrack: track,
      orientation: orientation(task.file, db[task.file]),
      verdict: classify(withLastfm.genre, task.truth),
    });
    process.stderr.write(`\r  ${++done}/${tasks.length}`);
  }
  process.stderr.write("\n");

  const counts = {};
  for (const r of results) counts[r.verdict] = (counts[r.verdict] || 0) + 1;
  const n = results.length;
  const pad = (s, w) => String(s).padStart(w);

  console.log("\n=== genre vs your folders, %d tracks ===\n", n);
  for (const k of CATEGORIES) {
    if (counts[k]) {
      console.log("  " + k.padEnd(13) + pad(((100 * counts[k]) / n).toFixed(1) + "%", 7)
        + pad(counts[k], 6));
    }
  }

  // The comparison the whole run exists for.
  console.log("\n  by how the filename parsed");
  for (const o of ["artist first", "title first", "ambiguous", "no separator", "unknown"]) {
    const group = results.filter((r) => r.orientation === o);
    if (!group.length) continue;
    const ex = group.filter((r) => r.verdict === "exact").length;
    console.log("    " + o.padEnd(14) + pad("n=" + group.length, 7)
      + pad("exact " + ((100 * ex) / group.length).toFixed(1) + "%", 14));
  }

  console.log("\n  by folder");
  const byFolder = {};
  for (const r of results) (byFolder[r.folder] ||= []).push(r);
  const rows = Object.entries(byFolder).map(([f, v]) => ({
    f, n: v.length,
    ex: (100 * v.filter((r) => r.verdict === "exact").length) / v.length,
    unk: (100 * v.filter((r) => r.verdict === "unknown").length) / v.length,
  })).sort((a, b) => a.ex - b.ex);
  console.log("    " + "folder".padEnd(36) + pad("n", 5) + pad("exact", 9) + pad("unknown", 9));
  for (const r of rows) {
    console.log("    " + r.f.slice(0, 36).padEnd(36) + pad(r.n, 5)
      + pad(r.ex.toFixed(1) + "%", 9) + pad(r.unk.toFixed(1) + "%", 9));
  }

  // Which source answered, and how often it was right when it did.
  console.log("\n  by source");
  const bySource = {};
  for (const r of results) {
    // "Discogs style \"deep house\"" and the audio fallback's feature dump both
    // carry per-track detail; the group is the source, not the answer.
    const raw = String(r.source || "none");
    const key = raw.startsWith("audio analysis") ? "audio analysis"
      : raw.split('"')[0].trim() || "none";
    (bySource[key] ||= []).push(r);
  }
  for (const [src, v] of Object.entries(bySource).sort((a, b) => b[1].length - a[1].length)) {
    const ex = v.filter((r) => r.verdict === "exact").length;
    console.log("    " + src.slice(0, 40).padEnd(40) + pad("n=" + v.length, 7)
      + pad("exact " + ((100 * ex) / v.length).toFixed(1) + "%", 14));
  }

  console.log("\n  folders we have no category for");
  for (const [folder, name] of Object.entries(VOCABULARY_GAPS)) {
    const count = Object.keys(db)
      .filter((p) => dirname(relative(LIBRARY_ROOT, p)) === folder).length;
    console.log("    " + name.padEnd(22) + pad(count + " tracks", 12) + "   " + folder);
  }

  if (lastfmKey) {
    const onlyBase = results.filter((r) => r.baseVerdict === "exact" && r.verdict !== "exact");
    const onlyLastfm = results.filter((r) => r.baseVerdict !== "exact" && r.verdict === "exact");
    const baseExact = results.filter((r) => r.baseVerdict === "exact").length;
    const baseUnknown = results.filter((r) => r.baseVerdict === "unknown").length;
    const swing = onlyLastfm.length + onlyBase.length;
    console.log("\n  === with Last.fm against without, same %d tracks ===", n);
    console.log("    without   exact %s%%   unknown %s%%",
      ((100 * baseExact) / n).toFixed(1), ((100 * baseUnknown) / n).toFixed(1));
    console.log("    with      exact %s%%   unknown %s%%",
      ((100 * (counts.exact || 0)) / n).toFixed(1), ((100 * (counts.unknown || 0)) / n).toFixed(1));
    console.log("    Last.fm right where the baseline was wrong  %d", onlyLastfm.length);
    console.log("    baseline right where Last.fm is wrong       %d", onlyBase.length);
    // Same paired test as the key sweep: only the disagreements carry
    // information, and a run of a few hundred tracks turns up a handful either
    // way by chance alone.
    const z = swing ? (onlyLastfm.length - onlyBase.length) / Math.sqrt(swing) : 0;
    console.log("    McNemar z = %s  ->  %s", z.toFixed(2),
      Math.abs(z) > 1.96 ? "a real difference" : "indistinguishable from chance");
  }

  writeResults(outPath, { counts, results });
}

main();
