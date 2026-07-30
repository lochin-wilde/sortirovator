/*
 * Round-trip checks for the Latin -> Cyrillic table.
 *
 * A library full of transliterated Russian filenames reaches MusicBrainz only
 * if the Latin form can be turned back into something close enough for its
 * fuzzy search. Nothing is renamed from this -- the result is a query, and the
 * similarity gates in identifyTrack() still have to accept whatever comes back.
 * So "close enough" is the standard, and this measures it rather than asserting
 * one right answer per word.
 *
 * The corpus is real Cyrillic titles from MusicBrainz. Each is written the way
 * this project's own toAscii() writes it -- which is what the filenames in the
 * library look like -- and converted back.
 *
 *   node tools/test_translit.mjs
 */
import { readFileSync } from "node:fs";

const results = [];
const check = (label, cond) => results.push(`  ${cond ? "OK  " : "МИМО"} ${label}`);

const src = readFileSync("web/js/identify.js", "utf8");
const cut = (from, to) => src.slice(src.indexOf(from), src.indexOf(to));
const mod = new Function(
  cut("const CYRILLIC_TO_LATIN",
      "/* ------------------------------------------------------------------ */\n/* Fuzzy similarity") +
  cut("function longestCommonSubstring", "function textSimilarity") +
  "; return { toAscii, toCyrillic, sequenceRatio, normalizeForCompare };"
)();

const { toAscii, toCyrillic, sequenceRatio, normalizeForCompare } = mod;

/* ---------------------------------------------------------------- */
/* The specific rules, on the cases that motivated them              */
/* ---------------------------------------------------------------- */

// "й" arrives as a bare "i" because toAscii writes it that way.
check("Voina -> Война", toCyrillic("Voina") === "Война");
check("Maika -> Майка", toCyrillic("Maika") === "Майка");
check("Vypusknoi -> Выпускной", toCyrillic("Vypusknoi") === "Выпускной");
check("Dai -> Дай", toCyrillic("Dai") === "Дай");

// The same rule mis-fires here, and is kept anyway because it is wrong less
// often than doing nothing. Asserted so the trade-off stays visible rather
// than being discovered again as a surprise.
check("известный промах: Naiznanku -> Найзнанку",
  toCyrillic("Naiznanku") === "Найзнанку");

// Version markers are Latin even on Russian releases.
check("(remix) не трогается", toCyrillic("Polozhenie (Izzamuzzic remix)")
  .endsWith("(Izzamuzzic remix)"));
check("(original version) не трогается",
  toCyrillic("Yuzhnaia noch (original version)").endsWith("(original version)"));
check("скобка без пометки переводится",
  toCyrillic("Pesnia (Zveri)").includes("Звери"));

/* ---------------------------------------------------------------- */
/* Corpus                                                            */
/* ---------------------------------------------------------------- */

const CORPUS = [
  "Война", "Майка", "Выпускной", "Бейби бой", "Белая ночь", "Ангел дождя",
  "Алюминиевые огурцы", "Бездельник", "Время любви пришло", "Всё решено",
  "Внутренний боец", "Будь моей тенью", "Без тебя", "Вечеринка", "Волна",
  "Город", "Гитара", "Героев", "Весна", "Вальс", "Витамин", "Визитка",
  "Банда Крыс", "Бабу буду", "Гангстер", "Во мне", "Акне", "Бошетунмай",
  "Ариведерчи", "Наизнанку", "Звуки пианино", "Чайный пьяница", "Самолет",
  "Молоко и мед", "Тридцать минут", "Южная ночь", "Положение", "Молнии",
];

let exact = 0;
let usable = 0;
for (const original of CORPUS) {
  const back = toCyrillic(toAscii(original));
  if (back.toLowerCase() === original.toLowerCase()) exact++;
  if (sequenceRatio(normalizeForCompare(original), normalizeForCompare(back)) >= 0.8) {
    usable++;
  }
}

/*
 * Thresholds sit below what is measured today (74.8% exact over 318 strings
 * from 19 artists) so that ordinary variation does not fail the suite, while a
 * real regression -- a rule removed, an ordering broken -- still does.
 */
const exactShare = exact / CORPUS.length;
const usableShare = usable / CORPUS.length;
check(`точных восстановлений ${exact}/${CORPUS.length} — не ниже 65%`, exactShare >= 0.65);
check(`пригодных для поиска ${usable}/${CORPUS.length} — не ниже 90%`, usableShare >= 0.90);

// The conversion must never empty a string: an empty query matches everything
// and is worse than a wrong one.
check("ни одна строка не превращается в пустую",
  CORPUS.every((s) => toCyrillic(toAscii(s)).trim().length > 0));

// Latin that is not transliterated Russian still passes through. It converts to
// nonsense, which is harmless -- it is only ever used as a fallback query that
// then finds nothing -- but it must not throw or empty out.
check("английское название не ломает преобразование",
  toCyrillic("Noisia - Stigma").length > 0);

console.log(results.join("\n"));
const passed = results.filter((x) => x.startsWith("  OK")).length;
console.log(`\n  пройдено ${passed}/${results.length}`);
console.log(`  на выборке: точно ${(exactShare * 100).toFixed(1)}%, пригодно ${(usableShare * 100).toFixed(1)}%`);
if (passed !== results.length) process.exitCode = 1;
