/*
 * Checks the decisions behind the page: presets, what mixes with what, what the
 * archive preview shows, and that every string the page asks for exists in
 * both languages.
 *
 * The translation check is here because a missing key does not fail anywhere:
 * t() shows the key itself, so "mix.title" would sit on the page in place of a
 * heading until someone happened to look. And a key written twice in one table
 * is legal JavaScript -- the second silently wins -- which is how the English
 * interface came to say "could not load the archive library" in Russian.
 *
 *   node tools/test/test_ui.mjs
 */
import { readFileSync } from "node:fs";

const results = [];
const check = (label, cond) => results.push(`  ${cond ? "OK  " : "МИМО"} ${label}`);

const views = new Function(readFileSync("web/js/views.js", "utf8") +
  "return { PRESETS, matchPreset, parseCamelot, camelotRelation, tempoDistance, mixNeighbours, archiveTree, MIX_TEMPO_TOLERANCE };")();
const html = readFileSync("web/index.html", "utf8");
const appSrc = readFileSync("web/js/app.js", "utf8");
const i18nSrc = readFileSync("web/js/i18n.js", "utf8");

/* ---------- Presets ---------- */

const off = { fixNames: false, sort: false, bpmKey: false, loudness: false };
check("«Разобрать библиотеку» = жанры + BPM/тональность",
  views.matchPreset({ ...off, sort: true, bpmKey: true }) === "library");
check("«Всё сразу» = все четыре", views.matchPreset({ fixNames: true, sort: true, bpmKey: true, loudness: true }) === "everything");
check("«Только BPM и тональность»", views.matchPreset({ ...off, bpmKey: true }) === "analyze");
check("«Только жанры»", views.matchPreset({ ...off, sort: true }) === "genres");
check("своя комбинация — без набора", views.matchPreset({ ...off, loudness: true }) === null);
check("ничего не выбрано — без набора", views.matchPreset(off) === null);

// The switches the page opens with have to be a preset, or the first thing a
// user sees is "your own combination" under a row of chips none of which is lit.
const checkedOnLoad = {
  fixNames: /id="step-fix-names" checked/.test(html),
  sort: /id="step-sort" checked/.test(html),
  bpmKey: /id="step-bpm-key" checked/.test(html),
  loudness: /id="step-loudness" checked/.test(html),
};
check("страница открывается на наборе «Разобрать библиотеку»", views.matchPreset(checkedOnLoad) === "library");
const chipIds = [...html.matchAll(/data-preset="([a-z]+)"/g)].map((m) => m[1]);
check("кнопки наборов = наборы из views.js, в том же порядке",
  JSON.stringify(chipIds) === JSON.stringify(views.PRESETS.map((p) => p.id)));

/* ---------- Camelot ---------- */

check("8A и 8A — та же", views.camelotRelation("8A", "8A") === "same");
check("8A и 8B — параллельная", views.camelotRelation("8A", "8B") === "relative");
check("8A → 9A — +1", views.camelotRelation("8A", "9A") === "up");
check("8A → 7A — −1", views.camelotRelation("8A", "7A") === "down");
check("12A → 1A — +1 через конец круга", views.camelotRelation("12A", "1A") === "up");
check("1B → 12B — −1 через начало круга", views.camelotRelation("1B", "12B") === "down");
check("8A и 9B — не по правилам", views.camelotRelation("8A", "9B") === null);
check("8A и 10A — не по правилам", views.camelotRelation("8A", "10A") === null);
check("регистр и пробелы не мешают", views.camelotRelation(" 8a", "8A ") === "same");
check("13A — не ключ", views.parseCamelot("13A") === null);
check("пустой ключ — не ключ", views.camelotRelation(null, "8A") === null);

/* ---------- Tempo ---------- */

const near = views.tempoDistance(124, 122);
check("124 и 122 — прямо, около +1.6%", near.factor === 1 && Math.abs(near.delta - 2 / 122) < 1e-9);
const half = views.tempoDistance(174, 87);
check("174 и 87 — в половинном темпе, без разницы", half.factor === 2 && Math.abs(half.delta) < 1e-9);
const double = views.tempoDistance(85, 172);
check("85 и 172 — в двойном темпе", double.factor === 0.5);
check("нет темпа — нет сравнения", views.tempoDistance(124, null) === null && views.tempoDistance(0, 120) === null);

/* ---------- Neighbours ---------- */

const rows = [
  { name: "target", key: "8A", bpm: 124 },
  { name: "same key, close", key: "8A", bpm: 125 },
  { name: "+1, closer tempo", key: "9A", bpm: 124 },
  { name: "relative", key: "8B", bpm: 122 },
  { name: "wrong key", key: "3A", bpm: 124 },
  { name: "too fast", key: "8A", bpm: 140 },
  { name: "half time", key: "7A", bpm: 62 },
  { name: "no key", key: null, bpm: 124 },
  { name: "failed", key: "8A", bpm: 124, error: "decode" },
  { name: "same key, exact", key: "8A", bpm: 124 },
];
const names = (list, from) => list.map((n) => from[n.index].name);
const found = views.mixNeighbours(rows, 0);
const foundNames = names(found, rows);
check("та же тональность идёт первой, ближайший темп раньше",
  foundNames[0] === "same key, exact" && foundNames[1] === "same key, close");
check("соседи по кругу и параллельная — в списке",
  ["+1, closer tempo", "relative", "half time"].every((n) => foundNames.includes(n)));
check("чужая тональность отсеяна", !foundNames.includes("wrong key"));
check("темп дальше допуска отсеян", !foundNames.includes("too fast"));
check("трек без тональности отсеян, когда у выбранного она есть", !foundNames.includes("no key"));
check("трек с ошибкой отсеян", !foundNames.includes("failed"));
check("сам трек не советует сам себя", !found.some((n) => n.index === 0));
const halfEntry = found.find((n) => rows[n.index].name === "half time");
check("половинный темп помечен множителем 2", halfEntry && halfEntry.factor === 2);
check("каждый найденный — в пределах ±6%",
  found.every((n) => Math.abs(n.delta) <= views.MIX_TEMPO_TOLERANCE));

const tempoOnly = views.mixNeighbours([{ key: null, bpm: 124 }, { key: "3A", bpm: 123 }, { key: null, bpm: 150 }], 0);
check("без тональности решает один темп", tempoOnly.length === 1 && tempoOnly[0].index === 1 && tempoOnly[0].relation === null);
check("ничего не измерено — пустой список", views.mixNeighbours([{ key: null, bpm: null }, { key: "8A", bpm: 120 }], 0).length === 0);
check("строка с ошибкой — пустой список", views.mixNeighbours([{ error: "x", key: "8A", bpm: 120 }, { key: "8A", bpm: 120 }], 0).length === 0);
const many = [{ key: "8A", bpm: 120 }, ...Array.from({ length: 30 }, () => ({ key: "8A", bpm: 120 }))];
check("список ограничен 12 треками", views.mixNeighbours(many, 0).length === 12);

/* ---------- Archive preview ---------- */

const tree = views.archiveTree([
  "House/A - One.mp3",
  "House/B - Two.mp3",
  "House/B - Two (2).mp3",
  "Techno/C - Three.wav",
  "Playlists/All tracks.m3u8",
  "Playlists/By BPM.m3u8",
  "Playlists/By key.m3u8",
  "Loose - Track.mp3",
  "Empty/",
], "Playlists");
check("самая большая папка первой", tree.folders[0].name === "House" && tree.folders[0].files.length === 3);
check("плейлисты в конце, хотя их больше", tree.folders[tree.folders.length - 1].name === "Playlists");
check("файл с (2) показан отдельно", tree.folders[0].files.includes("B - Two (2).mp3"));
check("файлы в корне собраны отдельно", tree.rootFiles.length === 1 && tree.rootFiles[0] === "Loose - Track.mp3");
check("запись-каталог без файлов не даёт пустой папки", !tree.folders.some((f) => f.name === "Empty"));
check("пустой архив — пустое дерево", views.archiveTree([], "Playlists").folders.length === 0);

/* ---------- macOS bookkeeping files ---------- */

const cut = (name) => {
  const start = appSrc.indexOf(`function ${name}(`);
  if (start < 0) throw new Error(`не найдена функция ${name} в web/js/app.js`);
  let depth = 0;
  for (let i = appSrc.indexOf("{", start); i < appSrc.length; i++) {
    if (appSrc[i] === "{") depth++;
    else if (appSrc[i] === "}" && --depth === 0) return appSrc.slice(start, i + 1);
  }
  throw new Error(`не удалось выделить ${name}`);
};
const isMacMetadata = new Function(cut("isMacMetadata") + "return isMacMetadata;")();
check("._трек.mp3 — служебный файл macOS", isMacMetadata({ name: "._Artist - Title.mp3" }));
check(".DS_Store — служебный файл macOS", isMacMetadata({ name: ".DS_Store" }));
check("обычный трек — не служебный", !isMacMetadata({ name: "Artist - Title.mp3" }));
check("точка в середине имени не мешает", !isMacMetadata({ name: "Mr._Oizo - Flat Beat.mp3" }));

/* ---------- Translations ---------- */

// Lines of one language's table, by its opening line, up to the next table.
function tableKeys(language) {
  const start = i18nSrc.indexOf(`  ${language}: {`);
  const end = i18nSrc.indexOf("\n  },", start);
  return [...i18nSrc.slice(start, end).matchAll(/^\s+"([\w.]+)":/gm)].map((m) => m[1]);
}
const en = tableKeys("en");
const ru = tableKeys("ru");
const duplicates = (keys) => keys.filter((k, i) => keys.indexOf(k) !== i);
check(`в английской таблице нет повторов (${duplicates(en).join(", ") || "—"})`, duplicates(en).length === 0);
check(`в русской таблице нет повторов (${duplicates(ru).join(", ") || "—"})`, duplicates(ru).length === 0);
const onlyEn = en.filter((k) => !ru.includes(k));
const onlyRu = ru.filter((k) => !en.includes(k));
check(`ключи есть в обоих языках (только en: ${onlyEn.join(", ") || "—"}; только ru: ${onlyRu.join(", ") || "—"})`,
  onlyEn.length === 0 && onlyRu.length === 0);

const pageKeys = [...html.matchAll(/data-i18n(?:-placeholder|-title|-html|-aria)?="([\w.]+)"/g)].map((m) => m[1]);
const missingOnPage = [...new Set(pageKeys)].filter((k) => !en.includes(k) || !ru.includes(k));
check(`каждый ключ из index.html переведён (нет: ${missingOnPage.join(", ") || "—"})`, missingOnPage.length === 0);

// Keys app.js asks for by literal name: t("…") and notify("…"). A prefix with
// the rest added in code -- t("mix." + relation) -- is not a key and is skipped.
const codeKeys = [...appSrc.matchAll(/\b(?:t|notify|rbSetStatus)\("([\w.]+)"\s*[,)]/g)].map((m) => m[1]);
const missingInCode = [...new Set(codeKeys)].filter((k) => !en.includes(k) || !ru.includes(k));
check(`каждый ключ из app.js переведён (нет: ${missingInCode.join(", ") || "—"})`, missingInCode.length === 0);

/* ---------- report ---------- */

const failed = results.filter((line) => line.includes("МИМО"));
console.log(results.join("\n"));
console.log(`\nпройдено ${results.length - failed.length}/${results.length}`);
process.exit(failed.length > 0 ? 1 : 0);
