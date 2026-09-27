/*
 * Checks that the shipped genre map is exactly what its generator produces.
 *
 * web/data/genres_map.json is generated from tools/build/genres_map.source.json
 * by tools/build/build_genres.py and must never be edited by hand -- the README
 * says so, and a rule nothing enforces is a rule that erodes. A hand edit would
 * be silently lost the next time anyone rebuilt, and an edit to the generator
 * that nobody rebuilt after would ship rules that are not in effect.
 *
 * Rebuilds into a temporary file and compares byte for byte.
 *
 *   node tools/test/test_data.mjs
 */
import { readFileSync, mkdtempSync, rmSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";

const results = [];
const check = (label, cond) => results.push(`  ${cond ? "OK  " : "МИМО"} ${label}`);

const dir = mkdtempSync(join(tmpdir(), "genres-"));
const fresh = join(dir, "genres_map.json");
try {
  execFileSync("python3", ["tools/build/build_genres.py",
    "tools/build/genres_map.source.json", fresh], { stdio: "ignore" });
  const shipped = readFileSync("web/data/genres_map.json");
  const built = readFileSync(fresh);
  check("словарь в репозитории совпадает со свежей сборкой побайтно", shipped.equals(built));

  const map = JSON.parse(shipped.toString("utf8"));
  const categories = new Set(Object.values(map));
  check("в словаре больше 6000 тегов", Object.keys(map).length > 6000);
  check("все значения — непустые строки",
    Object.values(map).every((v) => typeof v === "string" && v.trim() !== ""));
  for (const needed of ["Nu Disco", "Soulful House", "Grime", "Afro House", "Jersey Club"]) {
    check(`категория «${needed}» на месте`, categories.has(needed));
  }
} finally {
  rmSync(dir, { recursive: true, force: true });
}

const failed = results.filter((line) => line.includes("МИМО"));
for (const line of failed) console.log(line);
console.log(`пройдено ${results.length - failed.length}/${results.length}`);
process.exit(failed.length === 0 ? 0 : 1);
