/*
 * Checks the .m3u8 playlists written alongside the sorted folders.
 *
 * A playlist is the one output nothing else validates: the archive builds and
 * the download works whether or not the paths inside resolve, and the mistake
 * only shows up when Rekordbox refuses to import, by which point the batch is
 * long finished. The relative prefix and the CRLF line endings are exactly the
 * kind of detail that survives review and fails in the wild.
 *
 *   node tools/test_playlists.mjs
 */
import { readFileSync } from "node:fs";

const results = [];
const check = (label, cond) => results.push(`  ${cond ? "OK  " : "МИМО"} ${label}`);

// app.js is a plain script and assumes a browser, so the pieces under test are
// lifted out by name rather than by loading the whole file.
const src = readFileSync("web/js/app.js", "utf8");
const cut = (name) => {
  const start = src.indexOf(`function ${name}(`);
  if (start < 0) throw new Error(`не найдена функция ${name} в web/js/app.js`);
  let depth = 0;
  for (let i = src.indexOf("{", start); i < src.length; i++) {
    if (src[i] === "{") depth++;
    else if (src[i] === "}" && --depth === 0) return src.slice(start, i + 1);
  }
  throw new Error(`не удалось выделить ${name}`);
};
const constant = (name) => {
  const line = src.match(new RegExp(`^const ${name} = .*$`, "m"));
  if (!line) throw new Error(`не найдена константа ${name} в web/js/app.js`);
  return line[0];
};

const scope = [
  constant("PLAYLIST_FOLDER"),
  constant("CAMELOT_KEY"),
  cut("camelotOrder"),
  cut("playlistEntry"),
  cut("playlistBody"),
  cut("writePlaylists"),
  "return { PLAYLIST_FOLDER, camelotOrder, playlistEntry, playlistBody, writePlaylists };",
].join("\n");

// The three things writePlaylists reaches for that live elsewhere in app.js.
const zip = { files: new Map() };
const state = { zip: { file: (path, body) => zip.files.set(path, body) } };
const resultRows = [];
const genreFolderName = (g) => String(g).replace(/\s*\/\s*/g, " & ");

const pl = new Function("state", "resultRows", "genreFolderName", scope)(
  state, resultRows, genreFolderName);

/* ---------- Camelot ordering ---------- */

check("1A идёт первым", pl.camelotOrder("1A") === 0);
check("1B сразу за 1A", pl.camelotOrder("1B") === 1);
check("2A следует за 1B", pl.camelotOrder("2A") === 2);
check("12B замыкает круг", pl.camelotOrder("12B") === 23);
check("10A стоит после 2A, а не перед",
  pl.camelotOrder("10A") > pl.camelotOrder("2A"));
check("нижний регистр разбирается", pl.camelotOrder("8a") === pl.camelotOrder("8A"));
check("несуществующий номер отбрасывается", pl.camelotOrder("13A") === Infinity);
check("мусор отбрасывается", pl.camelotOrder("Am") === Infinity);
check("пустое значение отбрасывается", pl.camelotOrder(null) === Infinity);

/* ---------- одна строка плейлиста ---------- */

const track = (over = {}) => Object.assign({
  outputPath: "Afro House/Black Coffee - Drive.mp3",
  duration: 372.4, bpm: 121, key: "8A",
  feedbackArtist: "Black Coffee", feedbackTitle: "Drive", error: null, genre: "Afro House",
}, over);

const entry = pl.playlistEntry(track());
check("путь относительный, на уровень выше папки плейлистов",
  entry.endsWith("\r\n../Afro House/Black Coffee - Drive.mp3"));
check("длительность округляется до секунд", entry.startsWith("#EXTINF:372,"));
check("подпись собирается как «артист - название»",
  entry.includes(",Black Coffee - Drive"));
check("без длительности пишется -1",
  pl.playlistEntry(track({ duration: null })).startsWith("#EXTINF:-1,"));
check("без артиста и названия подставляется имя файла",
  pl.playlistEntry(track({ feedbackArtist: null, feedbackTitle: null }))
    .includes(",Black Coffee - Drive.mp3") === false
  && pl.playlistEntry(track({ feedbackArtist: null, feedbackTitle: null }))
    .includes(",Black Coffee - Drive\r\n"));
check("перенос строки в пути отбрасывает трек",
  pl.playlistEntry(track({ outputPath: "Afro\nHouse/x.mp3" })) === null);
check("перенос строки в подписи не рвёт строку",
  pl.playlistEntry(track({ feedbackTitle: "Drive\nPart 2" })).split("\r\n").length === 2);
check("трек без пути отбрасывается",
  pl.playlistEntry(track({ outputPath: null })) === null);

/* ---------- тело файла ---------- */

const body = pl.playlistBody([track(), track({ outputPath: "House/B.mp3" })]);
check("файл начинается с заголовка #EXTM3U", body.startsWith("#EXTM3U\r\n"));
check("строки разделены CRLF", !/[^\r]\n/.test(body));
check("файл заканчивается переводом строки", body.endsWith("\r\n"));
check("две записи дают четыре содержательные строки",
  body.trimEnd().split("\r\n").length === 5);
check("пустой список не создаёт файл", pl.playlistBody([]) === null);
check("список из одних битых треков не создаёт файл",
  pl.playlistBody([track({ outputPath: null })]) === null);

/* ---------- какие файлы попадают в архив ---------- */

const run = (rows, sort = true) => {
  zip.files.clear();
  resultRows.length = 0;
  resultRows.push(...rows);
  const count = pl.writePlaylists({ steps: { sort } });
  return { count, names: [...zip.files.keys()].sort() };
};

const mixed = [
  track({ genre: "Afro House", key: "8A", bpm: 121, outputPath: "Afro House/a.mp3" }),
  track({ genre: "UK Garage", key: "5A", bpm: 134, outputPath: "UK Garage/b.mp3" }),
  track({ genre: "UK Garage", key: "12B", bpm: 138, outputPath: "UK Garage/c.mp3" }),
];

const full = run(mixed);
check("пишутся общий список, по темпу, по тональности и по жанрам",
  full.names.join("|") === [
    "Playlists/Afro House.m3u8", "Playlists/All tracks.m3u8",
    "Playlists/By BPM.m3u8", "Playlists/By key.m3u8", "Playlists/UK Garage.m3u8",
  ].join("|"));
check("счётчик совпадает с числом файлов", full.count === full.names.length);

const noSort = run(mixed, false);
check("без раскладки по жанрам жанровых плейлистов нет",
  noSort.names.every((n) => !n.includes("Afro House") && !n.includes("UK Garage")));
check("без раскладки общий список всё равно пишется",
  noSort.names.includes("Playlists/All tracks.m3u8"));

const single = run([mixed[0], track({ genre: "Afro House", outputPath: "Afro House/d.mp3" })]);
check("один жанр не порождает дублирующий жанровый плейлист",
  !single.names.includes("Playlists/Afro House.m3u8"));

const broken = run([track({ error: "не удалось декодировать", outputPath: null }), mixed[0], mixed[1]]);
check("сломанные треки в плейлисты не попадают",
  !zip.files.get("Playlists/All tracks.m3u8").includes("undefined"));
check("пустая пачка не пишет ничего", run([]).count === 0);

const keyed = run(mixed);
// Paths contain spaces, so the lines are split rather than matched with \S+.
const pathsIn = (name) => zip.files.get(name).split("\r\n").filter((l) => l.startsWith("../"));
const keyOrder = pathsIn("Playlists/By key.m3u8");
check("по тональности порядок идёт по кругу Camelot: 5A, 8A, 12B",
  keyOrder.join(" ") === "../UK Garage/b.mp3 ../Afro House/a.mp3 ../UK Garage/c.mp3");
const bpmOrder = pathsIn("Playlists/By BPM.m3u8");
check("по темпу порядок от медленного к быстрому",
  bpmOrder.join(" ") === "../Afro House/a.mp3 ../UK Garage/b.mp3 ../UK Garage/c.mp3");

/* ---------- итог ---------- */

const failed = results.filter((line) => line.includes("МИМО"));
for (const line of results) if (line.includes("МИМО")) console.log(line);
console.log(`пройдено ${results.length - failed.length}/${results.length}`);
process.exit(failed.length === 0 ? 0 : 1);
