/*
 * Checks that a category name is safe to use as one folder inside the ZIP.
 *
 * Seven of the 51 categories read as a pair and carry a slash. A slash is the
 * path separator in a ZIP entry, so used as written they produced two nested
 * folders with a trailing and a leading space instead of one folder. Nothing
 * fails visibly when that happens -- the archive builds, the download works,
 * and the mistake only appears when someone unpacks it -- which is exactly why
 * it is worth a test.
 *
 *   node tools/test_paths.mjs
 */
import { readFileSync } from "node:fs";

const results = [];
const check = (label, cond) => results.push(`  ${cond ? "OK  " : "МИМО"} ${label}`);

// app.js is a plain script and assumes a browser, so the two functions under
// test are lifted out by name rather than by loading the whole file.
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

const genreFolderName = new Function(
  "FILENAME_UNSAFE_CHARS",
  cut("genreFolderName") + "; return genreFolderName;"
)(/[\\/:*?"<>|]/g);

check("парная категория становится одной папкой",
  genreFolderName("Funky / Disco House") === "Funky & Disco House");
check("обычная категория не меняется",
  genreFolderName("Afro House") === "Afro House");
check("косой черты в результате не остаётся",
  !genreFolderName("Reggae / Dancehall").includes("/"));
check("висячих пробелов не остаётся",
  genreFolderName("Funk / Soul").trim() === genreFolderName("Funk / Soul"));

// Windows drops a trailing dot or space from a directory name, which would make
// the folder in the archive and the folder on disk differ.
check("хвостовая точка убрана", genreFolderName("Genre.") === "Genre");
check("хвостовой пробел убран", genreFolderName("Genre ") === "Genre");

// No category contains "..", but the function is what stands between a lookup
// result and a path, so it is checked rather than assumed.
check("выход из каталога невозможен",
  !genreFolderName("../../etc").includes("/") &&
  !genreFolderName("..\\..\\etc").includes("\\"));
check("пустое имя не даёт пустую папку", genreFolderName("///") === "Unknown");

// Every real category must survive the conversion non-empty, or tracks would
// land in a folder called "Unknown" that nobody asked for.
const map = JSON.parse(readFileSync("web/data/genres_map.json", "utf8"));
const categories = [...new Set(Object.values(map))];
const emptied = categories.filter((c) => genreFolderName(c) === "Unknown" && c !== "Unknown");
const withSlash = categories.filter((c) => genreFolderName(c).includes("/"));
check(`все ${categories.length} категорий дают непустое имя`, emptied.length === 0);
check("ни одна категория не даёт вложенную папку", withSlash.length === 0);

console.log(results.join("\n"));
const passed = results.filter((x) => x.startsWith("  OK")).length;
console.log(`\n  пройдено ${passed}/${results.length}`);
if (passed !== results.length) process.exitCode = 1;
