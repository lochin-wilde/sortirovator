/*
 * Checks how "Fix names" uses the file's tags: the online lookup is fed the
 * tags (with the filename behind them), and a file the lookup did not find is
 * named from its tags (identify.js, nameFromTags) instead of keeping a name
 * that may be the wrong way round.
 *
 * Measured on the owner's library before the change: of 200 files whose name
 * did not read as Rekordbox's artist and title, the lookup fed from the
 * filename fixed 1; fed from the tags, 177.
 *
 *   node tools/test/test_name_from_tags.mjs
 */
import { readFileSync } from "node:fs";

const results = [];
const check = (label, cond) => results.push(`  ${cond ? "OK  " : "МИМО"} ${label}`);

const id = new Function(readFileSync("web/js/identify.js", "utf8") + "\nreturn { nameFromTags };")();

check("теги есть — «Исполнитель - Название»", id.nameFromTags("Alexander IV", "Honest") === "Alexander IV - Honest");
check("перевёрнутое имя файла не мешает: берутся теги", id.nameFromTags("Macross 82-99", "F.I.L.A") === "Macross 82-99 - F.I.L.A");
check("заглушка вместо исполнителя — имени нет", id.nameFromTags("Unknown Artist", "Honest") === null);
check("нет названия — имени нет", id.nameFromTags("Alexander IV", "") === null && id.nameFromTags("Alexander IV", undefined) === null);
check("название с исполнителем впереди — без повтора", id.nameFromTags("KASHIN", "KASHIN - HEY DJ DUB") === "KASHIN - HEY DJ DUB");
check("недопустимые в имени файла знаки убраны", !/[\\/:*?"<>|]/.test(id.nameFromTags("AC/DC", "Back: In Black?")));

// The wiring in processFile, read from the source: what is sent to the lookup,
// and when the tags name the file.
const app = readFileSync("web/js/app.js", "utf8");
const start = app.indexOf("async function processFile(");
const body = app.slice(start, app.indexOf("\n}\n", start));
check("поиск получает исполнителя и название из тегов, а не разбор имени файла",
  /identifyTrack\(artist, track\)/.test(body) && !/identifyTrack\(parsed\.artist, parsed\.track\)/.test(body));
check("исполнитель и название для поиска — сначала теги", /let artist = usableTag\(tags\.artist\) \|\| parsed\.artist;/.test(body));
check("имя из тегов — только если поиск ничего не нашёл и шаг включён",
  /if \(options\.steps\.fixNames && !match\) \{\s*const fromTags = nameFromTags\(tags\.artist, tags\.title\);/.test(body));
check("попытка поиска отмечается, чтобы в подробностях было видно, что не найдено",
  /result\.identifyAttempted = true;/.test(body));

console.log(results.join("\n"));
console.log(`\n  пройдено ${results.filter((x) => x.startsWith("  OK")).length}/${results.length}`);
