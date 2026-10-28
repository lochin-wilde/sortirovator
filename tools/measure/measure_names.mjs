/*
 * "Fix names" against Rekordbox's artist and title: what name the app would
 * give each file, and where the lookup turns a right name wrong.
 *
 * The naming is app.js's processFile, step for step: the artist and title from
 * the tags (the filename parse behind them), identifyTrack on iTunes then
 * MusicBrainz, the file's version marker kept, and the tags as the name when
 * nothing is found. Rekordbox's fields match the files' tags on every track
 * checked, so a name is right when it carries every word of both.
 *
 * Lookups are network-bound (no keys) and rate-limited, about 2 s a track.
 * Their answers are saved next to the results, so --replay rescores a change
 * to the naming, going online only for tracks whose query has changed.
 *
 * Usage
 * -----
 *   node tools/measure/measure_names.mjs --limit 200 --seed 1
 *   node tools/measure/measure_names.mjs --limit 200 --seed 1 --replay
 *   node tools/measure/measure_names.mjs --broken --limit 200     # names that do not read right
 */
import { readFileSync, writeFileSync, existsSync, openSync, readSync, closeSync } from "node:fs";
import { basename, extname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { ROOT, arg, pickSample } from "./lib/measure.mjs";

const identify = new Function(readFileSync(join(ROOT, "web/js/identify.js"), "utf8")
  + "\nreturn { identifyTrack, cleanFilename, stripExtension, fileExtension, parseFilename,"
  + " usableTag, withoutArtistPrefix, mergeTitleVersion, sanitizeFilename, nameFromTags };")();

const tagReader = new Function(readFileSync(join(ROOT, "web/js/tags.js"), "utf8") + "\nreturn { readTags };")();

// The app's own reader on the same 512 KB header slice (app.js, processFile).
// ffprobe was used first and gives only the first of several artists in a
// frame, "Disclosure" for "Disclosure<NUL>Gregory Porter", which the app reads
// as "Disclosure, Gregory Porter".
function fileTags(file) {
  try {
    const fd = openSync(file, "r");
    const bytes = new Uint8Array(512 * 1024);
    const got = readSync(fd, bytes, 0, bytes.length, 0);
    closeSync(fd);
    const { artist, title } = tagReader.readTags(bytes.subarray(0, got), extname(file));
    return { artist: artist || null, title: title || null };
  } catch {
    return {};
  }
}

const words = (s) => String(s || "").toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean);

// Right when every word of Rekordbox's artist and title is in the name, read
// with spaces and punctuation gone: Rekordbox writes "Sub:liminal" where the
// store writes "SubLiminal", and drops the "&" or ";" between artists.
// Exported for tools/test/test_measure_names.mjs.
export function nameOk(stem, artist, title) {
  const have = words(stem).join("");
  const want = [...words(artist), ...words(title)];
  return want.length > 0 && want.every((w) => have.includes(w));
}

// processFile's naming, with the lookup's answer passed in.
export function appName(fileName, tags, match) {
  const tidied = identify.cleanFilename(identify.stripExtension(fileName));
  const parsed = identify.parseFilename(tidied.cleaned + identify.fileExtension(fileName));
  const artist = identify.usableTag(tags.artist) || parsed.artist;
  const track = identify.withoutArtistPrefix(identify.usableTag(tags.title) || parsed.track, artist);
  let stem = tidied.cleaned;
  if (match) {
    const finalTitle = identify.mergeTitleVersion(track, match.title);
    return { stem: identify.sanitizeFilename(match.artist + " - " + finalTitle) || stem, how: "lookup", artist, track };
  }
  const fromTags = identify.nameFromTags(tags.artist, tags.title);
  if (fromTags && fromTags !== stem) return { stem: fromTags, how: "tags", artist, track };
  return { stem, how: "kept", artist, track };
}

async function main() {
  const db = JSON.parse(readFileSync(join(ROOT, "ground-truth/rekordbox_db.json"), "utf8")).byPath;
  const replay = process.argv.includes("--replay");
  const broken = process.argv.includes("--broken");
  const out = join(ROOT, `ground-truth/names_${broken ? "broken" : "random"}_seed${arg("--seed", "1")}.json`);
  const saved = replay && existsSync(out)
    ? Object.fromEntries(JSON.parse(readFileSync(out, "utf8")).map((r) => [r.file, r])) : {};

  let paths = Object.keys(db).filter((p) => db[p].artist && db[p].title && existsSync(p));
  if (broken) paths = paths.filter((p) => !nameOk(identify.stripExtension(basename(p)), db[p].artist, db[p].title));
  const tasks = replay ? Object.keys(saved) : pickSample(paths);

  const rows = [];
  for (const file of tasks) {
    const meta = db[file];
    const tags = fileTags(file);
    const before = appName(basename(file), tags, null);
    // A replay reuses the saved answer while the lookup would be asked the same
    // thing; otherwise it asks again.
    const old = saved[file];
    const same = old && appName(basename(file), old.tags, null).artist === before.artist
      && appName(basename(file), old.tags, null).track === before.track;
    let match = same ? old.match : null;
    if (!same && before.artist && before.track) {
      try {
        match = await identify.identifyTrack(before.artist, before.track);
      } catch (e) {
        match = { error: String(e.message || e) };
      }
    }
    const usable = match && !match.error ? match : null;
    const after = appName(basename(file), tags, usable);
    rows.push({
      file, tags, match: usable && { artist: usable.artist, title: usable.title },
      want: meta.artist + " - " + meta.title,
      was: identify.stripExtension(basename(file)), now: after.stem, how: after.how,
      okBefore: nameOk(identify.stripExtension(basename(file)), meta.artist, meta.title),
      okNow: nameOk(after.stem, meta.artist, meta.title),
    });
    process.stderr.write(`\r  ${rows.length}/${tasks.length}`);
  }
  process.stderr.write("\n");
  writeFileSync(out, JSON.stringify(rows, null, 1));

  const n = rows.length;
  const pct = (k) => ((100 * k) / n).toFixed(1) + "%";
  const by = (how) => rows.filter((r) => r.how === how).length;
  console.log(`${n} tracks: right before ${pct(rows.filter((r) => r.okBefore).length)}, now ${pct(rows.filter((r) => r.okNow).length)}`
    + ` (lookup ${by("lookup")}, from tags ${by("tags")}, kept ${by("kept")})`);
  const turned = rows.filter((r) => r.okBefore && !r.okNow);
  console.log(`right names made wrong: ${turned.length}`);
  for (const r of turned) console.log(`  ${r.was}\n    -> ${r.now}   (Rekordbox: ${r.want})`);
  const missed = rows.filter((r) => !r.okNow);
  console.log(`\nwrong now: ${missed.length}`);
  for (const r of missed.slice(0, 30)) console.log(`  [${r.how}] ${r.now}   (Rekordbox: ${r.want})`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main();
