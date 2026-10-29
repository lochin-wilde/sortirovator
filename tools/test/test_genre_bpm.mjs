/*
 * Checks tools/build/build_genre_bpm.mjs: the genre from the folder, the
 * tempo range per genre with double- and half-time tracks folded in and
 * counted, small genres kept out, and the tempo scoring and tie-break the
 * held-out check runs on.
 *
 *   node tools/test/test_genre_bpm.mjs
 */
import {
  folderGenre, locationPath, percentile, foldTempo, genreRow, buildTable, tempoScores, pickByTempo, half, readTracks, MIN_TRACKS,
} from "../build/build_genre_bpm.mjs";

const results = [];
const check = (label, cond) => results.push(`  ${cond ? "OK  " : "МИМО"} ${label}`);
const near = (a, b, eps = 0.05) => Math.abs(a - b) < eps;

check("папка «раскидать/DnB» — Drum & Bass", folderGenre("/Volumes/HomeSSD/Lochin/раскидать/DnB/A - B.mp3") === "Drum & Bass");
check("смешанная папка UKG/House — UK Garage, как решил владелец",
  folderGenre("/Volumes/HomeSSD/Lochin/Latest Garage Vibes  UKG  House/UKG  House/A - B.mp3") === "UK Garage");
check("датированная папка жанра не называет", folderGenre("/Volumes/HomeSSD/Lochin/06.05/A - B.mp3") === null);
check("файл вне фонотеки — без жанра", folderGenre("/Users/x/Desktop/A - B.mp3") === null && folderGenre(null) === null);
check("Location из XML раскодирован", locationPath("file://localhost/Volumes/HomeSSD/Lochin/NuDisco%202026%20/A%20%26%20B.mp3")
  === "/Volumes/HomeSSD/Lochin/NuDisco 2026 /A & B.mp3");

check("перцентиль с интерполяцией", percentile([1, 2, 3, 4], 0.5) === 2.5 && percentile([10, 20], 0.1) === 11);
check("180 у хип-хопа с центром 90 сворачивается в 90 и помечается",
  foldTempo(180, 90).bpm === 90 && foldTempo(180, 90).folded && !foldTempo(95, 90).folded && foldTempo(44, 90).bpm === 88);

{
  // 90s hip-hop the way Rekordbox counts it: most at double time, a third at normal time.
  const bpms = [...Array(20).fill(184), ...Array(10).fill(92), 176, 190];
  const row = genreRow(bpms);
  check(`хип-хоп в двух октавах: медиана в основной (${row.median}), доля другой — ${row.alt_tempo_share}`,
    near(row.median, 184) && near(row.alt_tempo_share, 10 / 32, 0.001) && row.p10 >= 176 && row.p90 <= 190);
}
{
  const tracks = [
    ...Array.from({ length: 25 }, (_, i) => ({ genre: "Drum & Bass", bpm: 172 + (i % 5) })),
    ...Array.from({ length: 30 }, (_, i) => ({ genre: "House", bpm: 122 + (i % 6) })),
    ...Array.from({ length: MIN_TRACKS - 1 }, () => ({ genre: "Moombahton", bpm: 108 })),
  ];
  const { table, small } = buildTable(tracks);
  check(`жанр меньше ${MIN_TRACKS} треков — не в таблице, а в списке «мало данных»`, !table.Moombahton && small.Moombahton === MIN_TRACKS - 1);
  check("в таблице n, медиана, p10, p90, доля другого темпа",
    table.House.n === 30 && ["median", "p10", "p90", "alt_tempo_share"].every((k) => typeof table.House[k] === "number"));
  const scores = tempoScores(table, 174);
  check("174 BPM — драм-н-бейс, а не хаус", scores[0].genre === "Drum & Bass" && near(scores.reduce((s, x) => s + x.score, 0), 1, 1e-9));
  check("87 BPM — драм-н-бейс в половинном темпе, а не хаус", tempoScores(table, 87)[0].genre === "Drum & Bass");
  check("подсказка: другой кандидат при явном несовпадении темпа", pickByTempo(table, 174, "House", ["House", "Drum & Bass"], 2) === "Drum & Bass");
  check("подсказка: темп подходит текущему — ответ не меняется", pickByTempo(table, 124, "House", ["House", "Drum & Bass"], 2) === "House");
  check("подсказка: жанр без строки в таблице не выбирается и не вытесняется",
    pickByTempo(table, 174, "House", ["House", "Jungle"], 2) === "House" && pickByTempo(table, 174, "Jungle", ["Jungle", "Drum & Bass"], 2) === "Jungle");
  check("подсказка: ответа нет — темп ответа не придумывает", pickByTempo(table, 174, null, ["Drum & Bass"], 2) === null);
}
check("половина по пути — одна и та же при каждом запуске", half("/a/b.mp3") === half("/a/b.mp3")
  && ["train", "test"].includes(half("/a/b.mp3")));
{
  const xml = '<DJ_PLAYLISTS><COLLECTION>' +
    '<TRACK TrackID="1" Name="x" Location="file://localhost/Volumes/HomeSSD/Lochin/раскидать/House/x.mp3" AverageBpm="124.00" Tonality="8A" Genre="Other"/>' +
    '<TRACK TrackID="2" Name="y" Location="file://localhost/Volumes/HomeSSD/Lochin/раскидать/House/y.mp3" AverageBpm="0.00"/>' +
    '<TRACK TrackID="3" Name="z" Location="file://localhost/Volumes/HomeSSD/Lochin/New%20Music/z.mp3" AverageBpm="128.00"/>' +
    '</COLLECTION></DJ_PLAYLISTS>';
  const tracks = readTracks(xml);
  check("из XML: жанр из папки, а не из поля Genre; BPM 0 и папка без жанра отброшены",
    tracks.length === 1 && tracks[0].genre === "House" && tracks[0].bpm === 124);
}

const failed = results.filter((line) => line.includes("МИМО"));
console.log(results.join("\n"));
console.log(`\nпройдено ${results.length - failed.length}/${results.length}`);
process.exit(failed.length > 0 ? 1 : 0);
