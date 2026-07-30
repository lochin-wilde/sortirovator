/*
 * Filename cleanup: what gets removed, and more importantly what does not.
 *
 * Leaving junk in is a small problem -- a lookup usually survives it. Cutting
 * into a real title is a large one, because the result is a confident wrong
 * match or a silent miss, and nobody reviews a filename that looks plausible.
 * So the second half of this file matters more than the first.
 *
 *   node tools/test_cleanup.mjs
 */
import { readFileSync } from "node:fs";

const results = [];
const check = (label, cond) => results.push(`  ${cond ? "OK  " : "МИМО"} ${label}`);

const src = readFileSync("web/js/identify.js", "utf8");
const mod = new Function(
  src.slice(src.indexOf("const SITE_DOMAIN"), src.indexOf("/*\n * Flags a Latin-script name")) +
  "; return { cleanFilename };"
)();
const clean = (s) => mod.cleanFilename(s).cleaned;

/* ---------------------------------------------------------------- */
/* Removed                                                           */
/* ---------------------------------------------------------------- */

check("подчёркивания -> пробелы",
  clean("Khaski_-_Pulya_dura") === "Khaski - Pulya dura");
check("номер закачки в конце",
  clean("Indiya by - Ona tancuet pod shadje 81415262") === "Indiya by - Ona tancuet pod shadje");
check("номер закачки в скобках",
  clean("Artist - Title (81415262)") === "Artist - Title");
check("номер закачки через дефис",
  clean("Artist - Title -81415262") === "Artist - Title");
check("адрес сайта в скобках",
  clean("Artist - Title [eu.hitmotop.com]") === "Artist - Title");
check("адрес сайта в конце через дефис",
  clean("Artist - Title - muzmo.ru") === "Artist - Title");
check("адрес сайта в начале",
  clean("zaycev.net - Artist - Title") === "Artist - Title");
check("битрейт",
  clean("Artist - Title (320kbps)") === "Artist - Title");
check("битрейт с пробелом",
  clean("Artist - Title 128 kbps") === "Artist - Title");
check("пометка формата",
  clean("Artist - Title [mp3]") === "Artist - Title");
check("official video",
  clean("Artist - Title (Official Video)") === "Artist - Title");
check("official music video",
  clean("Artist - Title [Official Music Video]") === "Artist - Title");
check("клип по-русски",
  clean("Исполнитель - Название (клип)") === "Исполнитель - Название");
check("премьера песни",
  clean("Исполнитель - Название (премьера песни)") === "Исполнитель - Название");
check("несколько видов мусора сразу",
  clean("hitmo.org - Artist_-_Title (Official Video) [320kbps] 81415262")
    === "Artist - Title");

/* ---------------------------------------------------------------- */
/* Left alone — the half that matters                                */
/* ---------------------------------------------------------------- */

// Version markers change which recording this is. Removing one turns a remix
// into its original and files the wrong track.
for (const marker of ["(Radio Edit)", "(Extended Mix)", "(VIP)", "(Instrumental)",
                      "(Acoustic)", "(Live)", "(Dub Mix)", "(Izzamuzzic Remix)"]) {
  check(`сохранена пометка версии ${marker}`,
    clean(`Artist - Title ${marker}`) === `Artist - Title ${marker}`);
}

// Numbers that are part of a name. Both of these are real titles from the
// library the original rules were derived on.
check("настоящее название с цифрами: 4 x 4 - JUJO",
  clean("4 x 4 - JUJO") === "4 x 4 - JUJO");
check("настоящее название с цифрами: 2 OU - 3 Robots",
  clean("2 OU - 3 Robots") === "2 OU - 3 Robots");
check("год не трогается", clean("Artist - Title (2019)") === "Artist - Title (2019)");
check("четырёхзначное число не считается номером закачки",
  clean("Artist - Title 1999") === "Artist - Title 1999");
check("bare (320) без единицы не трогается",
  clean("Artist - Title (320)") === "Artist - Title (320)");
check("номер тома сохраняется", clean("Artist - Title Vol. 44") === "Artist - Title Vol. 44");
check("темп в названии сохраняется", clean("Artist - 202 bpm") === "Artist - 202 bpm");

// A site name inside a real title, rather than tacked onto the end.
check("адрес внутри названия не вырезается",
  clean("Artist - Ode to vk.com and friends") === "Artist - Ode to vk.com and friends");

// "Live at ..." is a version marker, not a media label.
check("(Live at Wembley) сохраняется",
  clean("Artist - Title (Live at Wembley)") === "Artist - Title (Live at Wembley)");

/* ---------------------------------------------------------------- */
/* Never destructive                                                 */
/* ---------------------------------------------------------------- */

check("имя не превращается в пустое", clean("muzmo.ru") !== "");
check("имя из одного номера уцелеет", clean("81415262") === "81415262");
check("чистка сообщает о себе",
  mod.cleanFilename("Artist_-_Title (Official Video)").changes.length === 2);

console.log(results.join("\n"));
const passed = results.filter((x) => x.startsWith("  OK")).length;
console.log(`\n  пройдено ${passed}/${results.length}`);
if (passed !== results.length) process.exitCode = 1;
