/*
 * Checks how genre sources are compared (tools/measure/genre_sources.mjs). The
 * point of that report is that no source is judged by a reference it helped
 * make; these checks hold it to that.
 *
 *   node tools/test/test_genre_sources.mjs
 */
import { relate, consensus, consensusWithout } from "../measure/genre_sources.mjs";

const results = [];
const check = (label, cond) => results.push(`  ${cond ? "OK  " : "МИМО"} ${label}`);

const parents = { "Tech House": "House", "Deep House": "House", "Liquid DnB": "Drum & Bass" };

check("одинаковые — same", relate("House", "House", parents) === "same");
check("потомок и родитель — related", relate("Tech House", "House", parents) === "related");
check("братья по родителю — related", relate("Tech House", "Deep House", parents) === "related");
check("разные ветки — conflict", relate("Tech House", "Liquid DnB", parents) === "conflict");
check("нет ответа — не сравнивается", relate(null, "House", parents) === null);

const a = (d, m, i) => ({ discogs: d && { genre: d }, mbRecording: m && { genre: m }, itunes: i && { genre: i } });
check("два из трёх согласны — эталон есть", consensus(a("House", "House", "Pop")) === "House");
check("все разные — эталона нет", consensus(a("House", "Pop", "Rock")) === null);
check("Unknown не голосует", consensus(a("Unknown", "Unknown", "House")) === null);
check("для Discogs эталон — только MusicBrainz и iTunes", consensusWithout(a("Techno", "House", "House"), "discogs") === "House");
check("источник не голосует за себя", consensusWithout(a("House", "House", "Pop"), "discogs") === null);
check("без двух других ответов эталона нет", consensusWithout(a("House", "House", null), "mbRecording") === null);

const failed = results.filter((line) => line.includes("МИМО"));
console.log(results.join("\n"));
console.log(`\nпройдено ${results.length - failed.length}/${results.length}`);
process.exit(failed.length > 0 ? 1 : 0);
