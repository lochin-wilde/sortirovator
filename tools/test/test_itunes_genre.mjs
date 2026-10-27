/*
 * iTunes' store genre as the last answer before Unknown (identify.js).
 *
 * Measured on 309 library tracks (tools/measure/genre_sources.mjs): where the
 * app said Unknown, iTunes often had a genre, and a specific one -- House,
 * Garage, Dubstep -- for 23 of them. "Dance" and "Electronic", where most of a
 * dance library sits in the store, must not get through.
 *
 *   node tools/test/test_itunes_genre.mjs
 */
import { readFileSync } from "node:fs";

const results = [];
const check = (label, cond) => results.push(`  ${cond ? "OK  " : "МИМО"} ${label}`);

const identify = new Function(readFileSync("web/js/identify.js", "utf8") +
  "return { itunesStyle, resolveGenreFrom };")();
const genresMap = JSON.parse(readFileSync("web/data/genres_map.json", "utf8"));

/* ---------- Store genre to category ---------- */

const style = (name) => (identify.itunesStyle(name, genresMap) || {}).genre || null;
check("Garage -> UK Garage", style("Garage") === "UK Garage");
check("House -> House", style("House") === "House");
check("Breakbeat -> Breakbeat", style("Breakbeat") === "Breakbeat");
check("Dance, Electronic, Pop -- не ответ", style("Dance") === null && style("Electronic") === null && style("Pop") === null);
check("Soundtrack -- не жанр, а где звучала песня", style("Soundtrack") === null);
check("Jungle/Drum'n'bass -> Drum & Bass, а не Jungle", style("Jungle/Drum'n'bass") === "Drum & Bass");
check("Hip-Hop/Rap и R&B/Soul распознаны", style("Hip-Hop/Rap") === "Hip-Hop" && style("R&B/Soul") === "Funk / Soul");
check("пусто и мусор -- null", style(null) === null && style("") === null && style("constructor") === null);

/* ---------- Place in the decision ---------- */

// Every online source off, so nothing is fetched: only what the context holds
// can answer.
const offline = { useDiscogs: false, useMusicbrainz: false, lastfmKey: "" };
const deps = { correctionFor: () => null, t: (key) => key };
const resolve = (context, d = deps) => identify.resolveGenreFrom({
  tags: {}, artist: "Fonzo", track: "Thru The Night", genresMap, options: offline, recordingId: null, ...context,
}, d);

{
  const r = await resolve({ itunesGenre: "Garage" });
  check(`вместо Unknown -- жанр iTunes, помечен «?» (${r.genre}, ${r.source})`, r.genre === "UK Garage" && r.weak === true && /iTunes/.test(r.source));
}
{
  const r = await resolve({ itunesGenre: "Dance" });
  check("общий жанр iTunes оставляет Unknown", r.genre === "Unknown");
}
{
  const r = await resolve({ itunesGenre: "Garage", tags: { genre: "Electronic" } });
  check("общий тег файла не вытесняется (iTunes только вместо Unknown)", r.genre === "Electronic");
}
{
  const r = await resolve({ itunesGenre: "Garage" }, { ...deps, correctionFor: () => ({ genre: "Breakbeat", scope: "track" }) });
  check("правка пользователя важнее iTunes", r.genre === "Breakbeat");
}
{
  const r = await resolve({});
  check("без ответа iTunes -- Unknown, как раньше", r.genre === "Unknown" && r.source === "no match");
}

/* ---------- report ---------- */

const failed = results.filter((line) => line.includes("МИМО"));
console.log(results.join("\n"));
console.log(`\nпройдено ${results.length - failed.length}/${results.length}`);
process.exit(failed.length > 0 ? 1 : 0);
