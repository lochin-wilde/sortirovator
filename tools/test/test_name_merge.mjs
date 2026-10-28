/*
 * Checks the three ways the name lookup turned a right name wrong, found by
 * tools/measure/measure_names.mjs on 200 tracks of the owner's library
 * (identify.js):
 *
 *   - a featured artist that the store credits in the title was dropped along
 *     with the store's version marker (mergeTitleVersion), 5 tracks;
 *   - "(Intro Clean)" was not read as a version and was lost (VERSION_MARKERS);
 *   - an artist only as similar as chance allows was accepted, "Phloem" taken
 *     for "AP Dhillon" (artistsShareWord).
 *
 *   node tools/test/test_name_merge.mjs
 */
import { readFileSync } from "node:fs";

const results = [];
const check = (label, cond) => results.push(`  ${cond ? "OK  " : "МИМО"} ${label}`);

const id = new Function(readFileSync("web/js/identify.js", "utf8")
  + "\nreturn { mergeTitleVersion, artistsShareWord, splitTitle };")();
const merge = id.mergeTitleVersion;

check("feat. из найденного названия сохраняется рядом с версией файла",
  merge("Come Back - Art Of Tones Remix", "Come Back (feat. Eider) [Art of Tones Remix]") === "Come Back (feat. Eider) (Art Of Tones Remix)");
check("feat. сохраняется и после названия в скобках",
  merge("Out The Fire (At The Hotel) - Radio Edit", "Out the Fire (At the Hotel) [feat. Eunice Collins] [Radio Edit]")
    === "Out the Fire (At the Hotel) (feat. Eunice Collins) (Radio Edit)");
check("feat. без скобок тоже", merge("Track (Extended Mix)", "Track feat. Someone") === "Track (feat. Someone) (Extended Mix)");
check("если файл уже называет приглашённого, второй раз не добавляется",
  !/feat.*feat|ft.*feat/i.test(merge("Devotion (ft. Cameron Hayes) (VIP)", "Devotion (feat. Cameron Hayes)")));
check("без приглашённого — как было", merge("Track (Original Mix)", "Track") === "Track (Original Mix)");

check("(Intro Clean) — версия, остаётся в имени", merge("Русская Девушка (Intro Clean)", "Русская девушка") === "Русская девушка (Intro Clean)");
check("(Dirty) — версия", id.splitTitle("Song (Dirty)").core === "Song");

check("Phloem и AP Dhillon — разные исполнители", !id.artistsShareWord("Phloem", "AP Dhillon"));
check("Sub:liminal и SubLiminal & KVR — одно", id.artistsShareWord("Sub:liminal kVR", "SubLiminal & KVR"));
check("исполнитель и он же с гостем — одно", id.artistsShareWord("Mikey B", "Mikey B & Sammy Virji"));
check("латиница и кириллица одного имени — одно", id.artistsShareWord("Khaski", "Хаски"));

const failed = results.filter((line) => line.includes("МИМО"));
console.log(results.join("\n"));
console.log(`\nпройдено ${results.length - failed.length}/${results.length}`);
process.exit(failed.length > 0 ? 1 : 0);
