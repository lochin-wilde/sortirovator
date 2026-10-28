/*
 * A remix's genre (identify.js, resolveGenreFrom): only the remix's own
 * release on Discogs answers, never what the remixer is generally known for.
 *
 * Measured on 375 folder-filed tracks, the remixer's Last.fm and MusicBrainz
 * artist tags answered 40 times, right 7 and wrong 24 -- Ghast filed as
 * dubstep in a grime folder, Philia as visual kei. The owner's call was a
 * blank genre over a guessed one.
 *
 * The lookups are replaced with stubs, so nothing goes online.
 *
 *   node tools/test/test_remix_genre.mjs
 */
import { readFileSync } from "node:fs";

const results = [];
const check = (label, cond) => results.push(`  ${cond ? "OK  " : "МИМО"} ${label}`);

// Every lookup answers unless a case says otherwise, so a stage that should
// stay silent shows up as a wrong genre.
const stubs = `
  discogsGenre = async (artist, track) => globalThis.stub.discogs(artist, track);
  lastfmArtistGenre = async (artist) => globalThis.stub.call("lastfm artist " + artist, { genre: "Dubstep", tag: "dubstep" });
  musicbrainzArtistGenre = async (artist) => globalThis.stub.call("mb artist " + artist, { genre: "Drum & Bass", tag: "drum and bass" });
  musicbrainzGenre = async () => globalThis.stub.call("mb recording", null);
  lastfmGenre = async () => globalThis.stub.call("lastfm track", null);
  musicbrainzEarliestYear = async () => null;
`;
const identify = new Function(readFileSync("web/js/identify.js", "utf8") + stubs + "return { resolveGenreFrom };")();
const genresMap = JSON.parse(readFileSync("web/data/genres_map.json", "utf8"));

const online = { useDiscogs: true, useMusicbrainz: true, lastfmKey: "key" };
const deps = { correctionFor: () => null, t: (key) => key };
async function resolve(track, { discogs = () => null, tags = {} } = {}) {
  const calls = [];
  globalThis.stub = { discogs, call: (name, answer) => (calls.push(name), answer) };
  const r = await identify.resolveGenreFrom({
    tags, artist: "Aerosmith", track, genresMap, options: online, recordingId: null, itunesGenre: null,
  }, deps);
  return { ...r, calls };
}

{
  const r = await resolve("Dream On (Ghast Remix)");
  check(`ремикс, в Discogs нет — пусто, а не жанр ремиксера (${r.genre})`, r.genre === "Unknown");
  check("теги ремиксера в Last.fm и MusicBrainz не запрашиваются",
    !r.calls.some((c) => /artist Ghast/.test(c)));
  check("исполнитель оригинала тоже не спрашивается", !r.calls.some((c) => /Aerosmith/.test(c)));
}
{
  const r = await resolve("Dream On (Yultron Remix)", {
    discogs: (artist) => (artist === "Yultron" ? { genre: "Dubstep", tag: "dubstep" } : null),
  });
  check(`релиз ремикса в Discogs отвечает (${r.genre}, ${r.source})`, r.genre === "Dubstep" && /Yultron remix/.test(r.source));
}
{
  const r = await resolve("Dream On (Ghast Remix)", { tags: { genre: "Grime" } });
  check(`ремикс без ответа Discogs — тег файла (${r.genre})`, r.genre === "Grime" && /file tag/.test(r.source));
}
{
  const r = await resolve("Dream On");
  check(`не ремикс — тег исполнителя по-прежнему работает, с «?» (${r.genre})`, r.genre === "Dubstep" && r.weak === true);
}

const failed = results.filter((line) => line.includes("МИМО"));
console.log(results.join("\n"));
console.log(`\nпройдено ${results.length - failed.length}/${results.length}`);
process.exit(failed.length > 0 ? 1 : 0);
