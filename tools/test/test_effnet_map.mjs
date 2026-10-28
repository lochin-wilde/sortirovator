/*
 * Checks how tools/measure/compare_effnet.mjs puts Discogs-EffNet's styles
 * into our categories (categoryOf): the most likely style that names one,
 * skipping styles that do not, and the parent genre only when none of them
 * does. Falling back to the parent too early is what turned 24 of 25 drum and
 * bass tracks into Electronic in the first count.
 *
 *   node tools/test/test_effnet_map.mjs
 */
import { categoryOf } from "../measure/compare_effnet.mjs";

const results = [];
const check = (label, cond) => results.push(`  ${cond ? "OK  " : "МИМО"} ${label}`);

const map = { "dubstep": "Dubstep", "drum & bass": "Drum & Bass", "electronic": "Electronic", "hip hop": "Hip-Hop" };
const top = (...names) => names.map((name, i) => [name, 0.9 - i * 0.1]);

check("стиль без категории пропускается, берётся следующий",
  categoryOf(top("Electronic---Halftime", "Electronic---Dubstep"), map).genre === "Dubstep");
check("к общему жанру — только если ни один стиль не подошёл",
  categoryOf(top("Electronic---Halftime", "Electronic---Juke"), map).genre === "Electronic");
check("общий жанр — у самого вероятного стиля",
  categoryOf(top("Hip Hop---Gangsta", "Electronic---Halftime"), map).genre === "Hip-Hop");
check("вероятность выбранного стиля сохраняется",
  Math.abs(categoryOf(top("Electronic---Halftime", "Electronic---Dubstep"), map).p - 0.8) < 1e-9);
check("глубже пятнадцати стилей не смотрим",
  categoryOf(top(...Array(15).fill("Electronic---Halftime"), "Electronic---Dubstep"), map).genre === "Electronic");

console.log(results.join("\n"));
console.log(`\n  пройдено ${results.filter((x) => x.startsWith("  OK")).length}/${results.length}`);
