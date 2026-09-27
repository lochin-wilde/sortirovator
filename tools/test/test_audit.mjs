/*
 * Pins down the defects found in the September audit, so none of them can come
 * back unnoticed.
 *
 * Each was confirmed by running the code, not by reading it -- one candidate
 * that looked wrong on the page turned out fine when executed, and one that
 * looked fine was not. So each check here runs the real function lifted out of
 * the shipped file.
 *
 *   node tools/test/test_audit.mjs
 */
import { readFileSync } from "node:fs";

const results = [];
const check = (label, cond) => results.push(`  ${cond ? "OK  " : "МИМО"} ${label}`);

const lift = (path) => {
  const src = readFileSync(path, "utf8");
  return (name) => {
    const start = src.indexOf(`function ${name}(`);
    if (start < 0) throw new Error(`не найдена функция ${name} в ${path}`);
    let depth = 0;
    for (let i = src.indexOf("{", start); i < src.length; i++) {
      if (src[i] === "{") depth++;
      else if (src[i] === "}" && --depth === 0) return src.slice(start, i + 1);
    }
    throw new Error(`не удалось выделить ${name}`);
  };
};
const constant = (path, name) => {
  const line = readFileSync(path, "utf8").match(new RegExp(`^const ${name} = .*$`, "m"));
  if (!line) throw new Error(`не найдена константа ${name} в ${path}`);
  return line[0];
};

const app = lift("web/js/app.js");
const escapeHtml = (s) => String(s).replace(/[&<>"]/g,
  (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const A = new Function("escapeHtml", "t", [
  constant("web/js/app.js", "CAMELOT_KEY"),
  constant("web/js/app.js", "TRUE_PEAK_CEILING_DB"),
  app("camelotOrder"), app("resultCells"), app("sortValue"), app("safeGainDb"),
  "return { resultCells, sortValue, safeGainDb };",
].join("\n"))(escapeHtml, (key) => key);

/* ---------- таблица: тональности по кругу Camelot ---------- */

const byKey = ["2A", "10A", "1A", "12B", "8A", "1B"]
  .map((key) => ({ key }))
  .sort((a, b) => A.sortValue(a, "key") - A.sortValue(b, "key"))
  .map((r) => r.key).join(" ");
check("тональности идут по кругу: 1A 1B 2A 8A 10A 12B", byKey === "1A 1B 2A 8A 10A 12B");
check("трек без тональности уходит в конец",
  A.sortValue({ key: null }, "key") > A.sortValue({ key: "12B" }, "key"));

/* ---------- таблица: строка сломанного файла ---------- */

// Exactly the shape runOne() produces when processing throws.
const failed = { name: "broken.mp3", error: "не удалось декодировать", outputPath: null };
const cells = A.resultCells(failed, 0).split("</td>").slice(0, -1)
  .map((c) => c.replace(/<[^>]+>/g, "").trim());
check("у сломанного файла в BPM прочерк, а не «undefined»", cells[3] === "—");
check("ни в одной колонке нет «undefined»", !cells.join("|").includes("undefined"));
check("сломанный файл сортируется по BPM без NaN", A.sortValue(failed, "bpm") === -1);

/* ---------- жанр: догадка по артисту помечается ---------- */

const genreOf = (row) => A.resultCells(row, 0).split("</td>")[2];
const weak = genreOf({ name: "a.mp3", genre: "Afro House", genreWeak: true });
const strong = genreOf({ name: "a.mp3", genre: "Afro House", genreWeak: false });
check("догадка по артисту показана со знаком «?»", weak.includes('class="genre-weak"'));
check("ответ о самом треке без знака", !strong.includes("genre-weak"));
check("подсказка у знака берётся из переводов", weak.includes('title="table.genreWeak"'));

/* ---------- громкость: потолок усиления ---------- */

// Quiet track, peak at -3 dBTP, asked to go from -24 to -16: +8 dB wanted,
// only 2 dB of headroom below the -1 dBTP ceiling.
let g = A.safeGainDb(-16, -24, -3, false);
check("без лимитера усиление упирается в потолок пика", Math.abs(g.gainDb - 2) < 1e-9);
check("и об этом сообщается", g.limited === true);

g = A.safeGainDb(-16, -24, -3, true);
check("с лимитером усиление полное — пики гасит лимитер", g.gainDb === 8 && !g.limited);

g = A.safeGainDb(-16, -8, -0.1, false);
check("громкий трек просто приглушается, потолок не мешает", g.gainDb === -8 && !g.limited);

g = A.safeGainDb(-16, -20, -10, false);
check("запаса хватает — усиление полное", g.gainDb === 4 && !g.limited);

g = A.safeGainDb(-16, -24, 0.4, false);
check("пик уже выше потолка — не поднимать вовсе", g.gainDb === 0 && g.limited);

check("тишина без замера — никакого усиления",
  A.safeGainDb(-16, null, -3, false).gainDb === 0);
check("неизвестный пик — усиление без ограничения, как раньше",
  A.safeGainDb(-16, -24, null, false).gainDb === 8);

/* ---------- админка: однократное экранирование ---------- */

const adm = lift("web/js/admin.js");
const trackCell = new Function(adm("escapeHtml") + adm("trackCell") + "return trackCell;")();
const onlyFile = trackCell({ file: "Kraak & Smaak - Nothing.mp3" });
check("имя файла экранируется один раз", onlyFile.includes("Kraak &amp; Smaak")
  && !onlyFile.includes("&amp;amp;"));
check("имя файла не выводится дважды", (onlyFile.match(/Kraak/g) || []).length === 1);
const named = trackCell({ artist: "Kraak & Smaak", title: "Nothing", file: "x.mp3" });
check("с артистом — артист в строке, файл в подсказке",
  named.startsWith("Kraak &amp; Smaak") && named.includes('class="hint">x.mp3'));
check("разметка в названии не проходит",
  !trackCell({ title: "<img src=x onerror=alert(1)>" }).includes("<img"));

/* ---------- итог ---------- */

const failedChecks = results.filter((line) => line.includes("МИМО"));
for (const line of failedChecks) console.log(line);
console.log(`пройдено ${results.length - failedChecks.length}/${results.length}`);
process.exit(failedChecks.length === 0 ? 0 : 1);
